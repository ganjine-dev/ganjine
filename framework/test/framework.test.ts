import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { attachItem, categoryTree, createCategory, linkCategories, resolveCategory } from '../src/categories.ts';
import { migrate } from '../src/db.ts';
import { toBound } from '../src/dates.ts';
import { createItem, showItem } from '../src/items.ts';
import { getPage, pageHistory, putPage } from '../src/pages.ts';
import { getRecord, putRecord, queryRecords } from '../src/records.ts';
import { page, testDb } from './helpers.ts';

let t: Awaited<ReturnType<typeof testDb>>;
before(async () => {
  t = await testDb();
  await createItem(t.db, 'acme');
});
after(() => t.close());

const put = (o: Record<string, unknown>) => putPage(t.db, page(o), t.store);

describe('as-of resolution', () => {
  const address = '/items/acme/as-of';
  before(async () => {
    await put({ address, as_of: '2026-10-01', summary: 'first' });
    await put({ address, as_of: '2026-10-10', summary: 'second' });
    await put({ address, as_of: '2026-10-10', summary: 'second, corrected' });
    await put({ address, as_of: '2026-09-15', summary: 'backfill' });
  });
  const summary = async (asOf?: string) => (await getPage(t.db, address, asOf)).content.summary;

  it('resolves to the newest data date on or before the date', async () => {
    assert.equal(await summary('2026-10-01'), 'first');
    assert.equal(await summary('2026-10-05'), 'first');
    assert.equal(await summary('2026-09-20'), 'backfill');
  });
  it('prefers the latest write for the same data date', async () => {
    assert.equal(await summary('2026-10-10'), 'second, corrected');
  });
  it('fails before the first data date, rather than returning something later', async () => {
    await assert.rejects(getPage(t.db, address, '2026-09-14'), /no version as of/);
  });
  it('a backfill does not move latest', async () => {
    assert.equal(await summary(), 'second, corrected');
    assert.equal(await summary('2030-01-01'), await summary());
  });
  it('history keeps every version and marks latest', async () => {
    const history = await pageHistory(t.db, address);
    assert.deepEqual(history.map((v) => v.summary), ['second, corrected', 'second', 'first', 'backfill']);
    assert.deepEqual(history.map((v) => v.latest), [true, false, false, false]);
  });
  it('rejects impossible dates', async () => {
    await assert.rejects(getPage(t.db, address, '2026-02-31'), /invalid date/);
  });
});

describe('append-only guarantees', () => {
  let recordId: string;
  let versionId: string;
  before(async () => {
    recordId = (await putRecord(t.db, { kind: 'test' })).id;
    versionId = (await put({ address: '/items/acme/locked' })).id;
  });
  for (const [table, id] of [['records', () => recordId], ['page_versions', () => versionId]] as const) {
    it(`${table} rejects UPDATE, DELETE and TRUNCATE`, async () => {
      await assert.rejects(t.db.query(`UPDATE ${table} SET created_at = now() WHERE id = $1`, [id()]), /append-only/);
      await assert.rejects(t.db.query(`DELETE FROM ${table} WHERE id = $1`, [id()]), /append-only/);
      await assert.rejects(t.db.query(`TRUNCATE ${table} CASCADE`), /append-only/);
    });
  }
  it('run_logs rejects UPDATE and DELETE', async () => {
    await t.db.query(`INSERT INTO agents VALUES ('a', 'temporal', 'ref')`);
    const run = (await t.db.query(`INSERT INTO runs (agent_name, status) VALUES ('a', 'running') RETURNING id`)).rows[0];
    await t.db.query(`INSERT INTO run_logs (run_id, level, message) VALUES ($1, 'info', 'm')`, [run.id]);
    await assert.rejects(t.db.query(`UPDATE run_logs SET level = 'x'`), /append-only/);
    await assert.rejects(t.db.query(`DELETE FROM run_logs`), /append-only/);
  });
  it('every page version is also a record with the same content', async () => {
    const version = await getPage(t.db, '/items/acme/locked');
    assert.deepEqual((await getRecord(t.db, version.id)).payload.content, version.content);
  });
});

describe('page writes', () => {
  it('enforces the content contract', async () => {
    await assert.rejects(put({ address: '/items/acme/bad', blocks: [{ kind: 'html' }] }), /contract violation/);
    await assert.rejects(put({ address: '/items/acme/bad', as_of: '2026-13-01' }), /contract violation/);
  });
  it('checks row width', async () => {
    const blocks = [{ kind: 'table', columns: [{ name: 'a', type: 'number' }], rows: [[1, 2]] }];
    await assert.rejects(put({ address: '/items/acme/bad', blocks }), /does not have 1 cells/);
  });
  it('requires referenced records, runs, blobs and items to exist', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(put({ address: '/items/acme/bad', inputs_used: [missing] }), /records not found/);
    await assert.rejects(put({ address: '/items/acme/bad', blocks: [{ kind: 'chart', spec: {}, data: { record: 'nope' } }] }), /records not found/);
    await assert.rejects(put({ address: '/items/acme/bad', produced_by: { agent: 'x', run_id: missing } }), /run not found/);
    await assert.rejects(put({ address: '/items/acme/bad', blocks: [{ kind: 'embed', blob: `blob:sha256:${'0'.repeat(64)}` }] }), /blob not found/);
    await assert.rejects(put({ address: '/items/nobody/overview' }), /item not found/);
  });
  it('leaves nothing behind when rejected', async () => {
    await assert.rejects(getPage(t.db, '/items/acme/bad'), /page not found/);
  });
  it('accepts an embed whose blob exists', async () => {
    const blob = await t.store.put(Buffer.from('<html>'));
    assert.deepEqual(await t.store.get(blob), Buffer.from('<html>'));
    const version = await put({ address: '/items/acme/embed', blocks: [{ kind: 'embed', blob }] });
    assert.equal(version.content.blocks[0].blob, blob);
  });
  it('allows pages that belong to no item', async () => {
    assert.ok((await put({ address: '/about' })).id);
  });
});

describe('records', () => {
  it('queries by kind, item, tag and date range', async () => {
    const item = await createItem(t.db, 'query-item');
    const r = await putRecord(t.db, { kind: 'quote', itemId: item.id, tags: ['eu', 'daily'], payload: { p: 1 } });
    await putRecord(t.db, { kind: 'quote', itemId: item.id, tags: ['us'] });
    assert.deepEqual((await queryRecords(t.db, { itemId: item.id, tags: ['eu', 'daily'] })).map((x) => x.id), [r.id]);
    assert.equal((await queryRecords(t.db, { kind: 'quote', itemId: item.id })).length, 2);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal((await queryRecords(t.db, { kind: 'quote', from: today, to: today })).length, 2);
    assert.equal((await queryRecords(t.db, { kind: 'quote', to: '2000-01-01' })).length, 0);
  });
  it('a date upper bound includes the whole UTC day', () => {
    assert.equal(toBound('2026-11-01').toISOString(), '2026-11-02T00:00:00.000Z');
  });
});

describe('items and categories', () => {
  it('rejects duplicate and address-unsafe item names', async () => {
    await assert.rejects(createItem(t.db, 'acme'), /already exists/);
    await assert.rejects(createItem(t.db, 'a b'), /invalid item name/);
  });
  it('builds a tree, a graph and item membership', async () => {
    await createCategory(t.db, 'markets');
    await createCategory(t.db, 'europe', 'markets');
    await createCategory(t.db, 'capital');
    await createCategory(t.db, 'europe', 'capital');
    assert.equal((await resolveCategory(t.db, 'capital/europe')).name, 'europe');
    await linkCategories(t.db, 'capital/europe', 'markets/europe', 'trades-in');
    await attachItem(t.db, 'acme', 'capital/europe');
    await attachItem(t.db, 'acme', 'markets');
    await attachItem(t.db, 'acme', 'markets');
    const shown = await showItem(t.db, 'acme');
    assert.deepEqual(shown.categories, ['capital/europe', 'markets']);
    const tree = await categoryTree(t.db);
    assert.match(tree, /capital\n {2}europe\n {4}-\[trades-in\]-> markets\/europe\n {4}\* acme/);
    assert.equal((await queryRecords(t.db, { kind: 'category.attached', itemId: shown.id })).length, 2);
  });
  it('rejects a duplicate sibling and a self link', async () => {
    await assert.rejects(createCategory(t.db, 'markets'), /already exists/);
    await assert.rejects(linkCategories(t.db, 'markets', 'markets', 'x'), /itself/);
  });
});

it('migrate is idempotent', async () => {
  assert.deepEqual(await migrate(t.db), []);
});
