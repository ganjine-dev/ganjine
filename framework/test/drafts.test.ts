import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { discardDraft, finalizeDraft, getDraft, listDrafts, putDraft } from '../src/drafts.ts';
import { getPage, pageHistory, putPage } from '../src/pages.ts';
import { closeSession, getSession, startSession } from '../src/sessions.ts';
import { page, testDb } from './helpers.ts';

type T = Awaited<ReturnType<typeof testDb>>;
let t: T;
let a: string;
let b: string;
let n = 0;
const address = () => `/reports/r${++n}`;
const draft = (at: string, summary: string, session = a, base?: string) => putDraft(t.db, page({ address: at, summary }), session, t.store, base);

before(async () => {
  t = await testDb();
  a = (await startSession(t.db, 'first')).id;
  b = (await startSession(t.db, 'second')).id;
});
after(() => t.close());

describe('a draft', () => {
  it('is not a page and leaves no record until finalized', async () => {
    const at = address();
    const records = async () => (await t.db.query('SELECT count(*)::int AS n FROM records')).rows[0].n;
    const start = await records();
    await draft(at, 'one');
    await draft(at, 'two');
    assert.equal(await records(), start);
    await assert.rejects(getPage(t.db, at), /page not found/);
    assert.equal((await getDraft(t.db, at)).content.summary, 'two');
  });

  it('finalizes into one version, however many steps came first', async () => {
    const at = address();
    await draft(at, 'one');
    await draft(at, 'two');
    await draft(at, 'three');
    await finalizeDraft(t.db, at, a, t.store);
    const history = await pageHistory(t.db, at);
    assert.equal(history.length, 1);
    assert.equal(history[0].summary, 'three');
    assert.equal(await getDraft(t.db, at), null);
  });

  it('is refused for a closed session', async () => {
    const closed = (await startSession(t.db, 'closed')).id;
    await closeSession(t.db, closed, 'done');
    await assert.rejects(draft(address(), 'late', closed), /is closed/);
  });

  it('is shown in its session', async () => {
    const at = address();
    await draft(at, 'shown');
    assert.ok((await getSession(t.db, a)).drafts.some((d) => d.address === at));
  });
});

describe('a hold', () => {
  it('keeps every other writer out', async () => {
    const at = address();
    await draft(at, 'mine');
    await assert.rejects(draft(at, 'theirs', b), /held by session/);
    await assert.rejects(finalizeDraft(t.db, at, b, t.store), /held by session/);
    await assert.rejects(discardDraft(t.db, at, b), /held by session/);
    await assert.rejects(putPage(t.db, page({ address: at }), t.store), /held by session/);
  });

  it('can be freed by the operator', async () => {
    const at = address();
    await draft(at, 'stuck');
    await discardDraft(t.db, at);
    await draft(at, 'free', b);
    assert.equal((await getDraft(t.db, at)).session, b);
    await discardDraft(t.db, at, b);
  });

  it('stops a session closing until it is resolved', async () => {
    const s = (await startSession(t.db, 'open work')).id;
    const at = address();
    await draft(at, 'open', s);
    await assert.rejects(closeSession(t.db, s, 'done'), /drafts to finalize or discard/);
    await discardDraft(t.db, at, s);
    await closeSession(t.db, s, 'done');
  });
});

describe('a base', () => {
  it('refuses to finalize over a page that moved on', async () => {
    const at = address();
    await putPage(t.db, page({ address: at, summary: 'first' }), t.store);
    const { base_version_id: seen } = await draft(at, 'stale');
    await discardDraft(t.db, at); // Freed by the operator, so another writer gets in.
    const newer = await putPage(t.db, page({ address: at, summary: 'second', as_of: '2026-10-02' }), t.store);
    await draft(at, 'stale', a, seen);
    await assert.rejects(finalizeDraft(t.db, at, a, t.store), /has moved on/);
    assert.ok(await getDraft(t.db, at), 'the work survives a refusal');
    await putDraft(t.db, page({ address: at, summary: 'merged', as_of: '2026-10-03' }), a, t.store, newer.id);
    await finalizeDraft(t.db, at, a, t.store);
    assert.equal((await getPage(t.db, at)).content.summary, 'merged');
  });

  it('is needed to write over another agent', async () => {
    const at = address();
    const first = await putPage(t.db, page({ address: at, produced_by: { agent: 'one' } }), t.store);
    const other = page({ address: at, as_of: '2026-10-02', produced_by: { agent: 'two' } });
    await assert.rejects(putPage(t.db, other, t.store), new RegExp(`write with base ${first.id}`));
    await putPage(t.db, other, t.store, { base: first.id });
    await assert.rejects(putPage(t.db, page({ address: at, as_of: '2026-10-03', produced_by: { agent: 'one' } }), t.store, { base: first.id }), /has moved on/);
  });

  it('is not needed to refresh your own page', async () => {
    const at = address();
    await putPage(t.db, page({ address: at }), t.store);
    await putPage(t.db, page({ address: at, as_of: '2026-10-02' }), t.store);
    assert.equal((await pageHistory(t.db, at)).length, 2);
  });
});

describe('drafts in a list', () => {
  it('filter by session', async () => {
    const s = (await startSession(t.db, 'listed')).id;
    const at = address();
    await draft(at, 'listed', s);
    assert.deepEqual((await listDrafts(t.db, s)).map((d) => d.address), [at]);
    assert.ok((await listDrafts(t.db)).length > 1);
  });
});
