import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { attachItem, createCategory } from '../src/categories.ts';
import { subscribe } from '../src/events.ts';
import { broadcast, handler } from '../src/face/server.ts';
import { createItem } from '../src/items.ts';
import { putPage } from '../src/pages.ts';
import { putRecord } from '../src/records.ts';
import { page, testDb } from './helpers.ts';

let t: Awaited<ReturnType<typeof testDb>>;
let server: ReturnType<typeof createServer>;
let base: string;
const get = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  return { res, text: await res.text() };
};
const put = (o: Record<string, unknown>) => putPage(t.db, page(o), t.store);
const XSS = '<script>alert(1)</script>';

before(async () => {
  t = await testDb();
  await createItem(t.db, 'acme');
  await createCategory(t.db, 'markets');
  await attachItem(t.db, 'acme', 'markets');
  server = createServer(handler(t.db, t.store));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await t.close();
});

describe('trust boundary', () => {
  const withHost = (host: string) => new Promise<number>((resolve, reject) => {
    const url = new URL(base);
    request({ host: url.hostname, port: url.port, path: '/items', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on('error', reject).end();
  });
  it('answers only on loopback names, which stops DNS rebinding', async () => {
    assert.equal(await withHost('evil.example:4400'), 421);
    assert.equal(await withHost('127.0.0.1.evil.example'), 421);
    for (const host of ['127.0.0.1:4400', 'localhost:4400', '[::1]:4400']) assert.equal(await withHost(host), 200, host);
  });
  it('names the host of a link that leaves Ganjine, and not of one that stays', async () => {
    await put({ address: '/items/acme/links', blocks: [{ kind: 'markdown', text: '[report](https://evil.example/run.sh) [home](/items)' }] });
    const { text } = await get('/pages/items/acme/links');
    assert.match(text, /<a href="https:\/\/evil\.example\/run\.sh" rel="noopener noreferrer nofollow">report<\/a> <small class="external">↗ evil\.example<\/small>/);
    assert.match(text, /<a href="\/items">home<\/a><\/p>/);
  });
  it('renders a row written straight into the database as text', async () => {
    await put({ address: '/items/acme/direct', blocks: [{ kind: 'markdown', text: 'clean' }] });
    const content = { ...page({ address: '/items/acme/direct' }), summary: XSS, blocks: [{ kind: 'nope' }, { kind: 'kv', items: XSS }, { kind: 'markdown', text: XSS }] };
    // What a superuser can do: the append-only trigger is no defence against them.
    await t.db.query('ALTER TABLE page_versions DISABLE TRIGGER USER');
    await t.db.query('UPDATE page_versions SET content = $1 WHERE address = $2', [content, '/items/acme/direct']);
    await t.db.query('ALTER TABLE page_versions ENABLE TRIGGER USER');
    const { res, text } = await get('/pages/items/acme/direct');
    assert.equal(res.status, 200);
    assert.ok(text.includes('&#60;script&#62;alert(1)'));
    assert.doesNotMatch(text, /<script>alert/);
  });
});

describe('live events', () => {
  it('streams a commit, and only known fields of a forged notification', async () => {
    const listener = await subscribe(t.url, broadcast);
    const res = await fetch(`${base}/events`);
    const reader = res.body!.getReader();
    const text = new TextDecoder();
    let seen = '';
    const until = async (needle: string) => {
      while (!seen.includes(needle)) seen += text.decode((await reader.read()).value);
    };
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    await until(': open');
    const r = await putRecord(t.db, { kind: 'note', tags: ['session:a'], payload: { address: '/items/acme/x' } });
    await until(r.id);
    assert.match(seen, /"address":"\/items\/acme\/x"/);
    await t.db.query(`SELECT pg_notify('ganjine_events', $1)`, ['not json\n\ndata: evil']);
    await t.db.query(`SELECT pg_notify('ganjine_events', $1)`, [JSON.stringify({ id: 'forged', kind: 'k', evil: '<script>' })]);
    await until('forged');
    assert.doesNotMatch(seen, /evil/);
    await reader.cancel();
    await listener.end();
  });
});

describe('shell', () => {
  it('serves every section with the same navigation', async () => {
    for (const path of ['/items', '/sessions', '/categories', '/runs', '/health', '/items/acme']) {
      const { res, text } = await get(path);
      assert.equal(res.status, 200, path);
      for (const link of ['/items', '/sessions', '/categories', '/runs', '/health']) assert.ok(text.includes(`href="${link}"`), link);
      assert.match(res.headers.get('content-security-policy')!, /default-src 'none'/);
    }
  });
  it('redirects the root and 404s unknown paths', async () => {
    assert.equal((await get('/')).res.headers.get('location'), '/items');
    for (const path of ['/nope', '/items/nobody', '/pages/items/acme/nothing', '/assets/../package.json', '/assets/constructor', '/pages/%E0%A4%A']) {
      assert.equal((await get(path)).res.status, 404, path);
    }
  });
  it('is read-only', async () => {
    assert.equal((await get('/items', { method: 'POST' })).res.status, 405);
  });
  it('shows items, categories, health and runs from the database', async () => {
    assert.match((await get('/items')).text, /href="\/items\/acme"[\s\S]*markets/);
    await put({ address: '/items/acme/overview', summary: 'Card summary', blocks: [{ kind: 'kv', items: [{ key: 'Headline', value: '42' }] }] });
    const cards = (await get('/items')).text;
    assert.match(cards, /Card summary[\s\S]*Headline[\s\S]*42/);
    const item = (await get('/items/acme')).text;
    assert.match(item, /href="\/pages\/items\/acme\/overview"[\s\S]*Overview[\s\S]*Card summary/);
    assert.match(item, /item\.created/);
    assert.match((await get('/categories')).text, /Markets[\s\S]*\/items\/acme/);
    assert.match((await get('/runs')).text, /No runs yet/);
    assert.match((await get('/health')).text, /No health checks/);
    await t.db.query(`INSERT INTO health (component, status, checked_at, last_error) VALUES ('source', 'failed', now(), 'boom')`);
    await t.db.query(`INSERT INTO agents VALUES ('a', 'temporal', 'ref')`);
    await t.db.query(`INSERT INTO runs (agent_name, status, started_at, ended_at) VALUES ('a', 'succeeded', now() - interval '2 seconds', now())`);
    assert.match((await get('/health')).text, /source[\s\S]*failed[\s\S]*boom/);
    assert.match((await get('/runs')).text, /succeeded[\s\S]*2\.0s/);
    const run = (await t.db.query('SELECT id FROM runs LIMIT 1')).rows[0];
    await t.db.query(`INSERT INTO run_logs (run_id, level, message) VALUES ($1, 'error', $2)`, [run.id, XSS]);
    await put({ address: '/items/acme/by-run', produced_by: { agent: 'a', run_id: run.id } });
    const detail = await get(`/runs/${run.id}`);
    assert.match(detail.text, /\/items\/acme\/by-run/);
    assert.match(detail.text, /page_version/);
    assert.ok(detail.text.includes('&#60;script&#62;alert(1)'));
    assert.match((await get('/pages/items/acme/by-run')).text, new RegExp(`href="/runs/${run.id}"`));
    assert.equal((await get('/runs/00000000-0000-0000-0000-000000000000')).res.status, 404);
  });
  it('serves every asset', async () => {
    for (const a of ['face.css', 'face.js', 'inter.woff2', 'vazirmatn.woff2', 'vega.js', 'vega-lite.js', 'vega-embed.js']) {
      assert.equal((await get(`/assets/${a}`)).res.status, 200, a);
    }
  });
});

describe('page view', () => {
  const address = '/items/acme/view';
  it('switches between latest, as-of and a specific version', async () => {
    const first = await put({ address, as_of: '2026-10-01', summary: 'First' });
    await put({ address, as_of: '2026-10-10', summary: 'Second' });
    const latest = await get(`/pages${address}`);
    assert.match(latest.text, /<h1>Second<\/h1>/);
    assert.doesNotMatch(latest.text, /past version/);
    const past = await get(`/pages${address}?as_of=2026-10-05`);
    assert.match(past.text, /<h1>First<\/h1>/);
    assert.match(past.text, /past version/);
    assert.match(past.text, /value="2026-10-05"/);
    assert.match((await get(`/pages${address}?version=${first.id}`)).text, /<h1>First<\/h1>/);
  });
  it('shows the timeline when no version exists at that date', async () => {
    const { res, text } = await get(`/pages${address}?as_of=2020-01-01`);
    assert.equal(res.status, 404);
    assert.match(text, /no version as of/);
    assert.match(text, /2026-10-10/);
  });
  it('rejects an impossible date without failing', async () => {
    const { res, text } = await get(`/pages${address}?as_of=2026-02-31`);
    assert.equal(res.status, 404);
    assert.match(text, /invalid date/);
  });
  it('says which agent produced a version and when', async () => {
    const { text } = await get(`/pages${address}`);
    assert.match(text, /As of 2026-10-10 · written \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · by test/);
  });
});

describe('block rendering', () => {
  it('draws a timeline from a version 2 page, with its forecast as data', async () => {
    const data = await putRecord(t.db, { kind: 'series', payload: { values: [{ date: '2026-09-01', series: 'a', value: 1 }, { date: '2026-10-01', series: 'a', value: 2 }] } });
    const forecast = await putRecord(t.db, { kind: 'forecast', payload: { input: data.id, status: 'partial', forecaster: { name: 'm' }, series: [{ name: 'a', points: [{ date: '2026-10-08', value: 3 }] }] } });
    await put({ contract_version: 2, address: '/items/acme/time', as_of: '2026-10-01', blocks: [{ kind: 'timeline', title: 'Over time', data: { record: data.id }, forecast: { record: forecast.id } }] });
    const { text } = await get('/pages/items/acme/time');
    assert.match(text, /data-chart/);
    assert.match(text, /Forecast: m, to 2026-10-08/);
  });

  it('refuses a timeline in a version 1 page', async () => {
    const data = await putRecord(t.db, { kind: 'series', payload: { values: [] } });
    await assert.rejects(put({ address: '/items/acme/old', blocks: [{ kind: 'timeline', data: { record: data.id } }] }), /needs contract_version 2/);
  });

  it('renders every block kind', async () => {
    const values = await putRecord(t.db, { kind: 'v', payload: { values: [{ a: 1 }] } });
    const rows = await putRecord(t.db, { kind: 'r', payload: { rows: [['from-record', 9]] } });
    const blob = await t.store.put(Buffer.from('<p>hi</p>'));
    const columns = [{ name: 'n', type: 'string' }, { name: 'v', type: 'number' }];
    await put({
      address: '/items/acme/all',
      blocks: [
        { kind: 'markdown', text: '# Head\n\n| a |\n|---|\n| 1 |' },
        { kind: 'kv', items: [{ key: 'K', value: 'V', unit: 'u', delta: -2 }] },
        { kind: 'table', columns, rows: [['inline', null]] },
        { kind: 'table', columns, record: rows.id },
        { kind: 'chart', spec: { mark: 'bar' }, data: { record: values.id } },
        { kind: 'chart', spec: { mark: 'bar' }, data: [{ a: 2 }] },
        { kind: 'embed', blob, height: 300, title: 'Sim' },
        { kind: 'ref', address: '/items/acme/all', as_of: '2026-01-01' },
        { kind: 'ref', address: '/items/acme/gone' },
      ],
    });
    const { text } = await get('/pages/items/acme/all');
    assert.match(text, /<h1>Head<\/h1>/);
    assert.match(text, /<table>/);
    assert.match(text, /▼ -2/);
    assert.match(text, /inline/);
    assert.match(text, /from-record/);
    assert.match(text, /"values":\[\{"a":1\}\]/);
    assert.match(text, /"values":\[\{"a":2\}\]/);
    assert.match(text, /src="\/assets\/vega-embed\.js"/);
    assert.match(text, /sandbox="allow-scripts"/);
    assert.doesNotMatch(text, /allow-same-origin/);
    assert.match(text, /href="\/pages\/items\/acme\/all\?as_of=2026-01-01"/);
    assert.match(text, /\(no such page\)/);
  });
  it('serves an embed sandboxed, with no network', async () => {
    const blob = await t.store.put(Buffer.from('<p>sandboxed</p>'));
    const { res, text } = await get(`/blobs/${blob.split(':')[2]}`);
    assert.equal(text, '<p>sandboxed</p>');
    const csp = res.headers.get('content-security-policy')!;
    assert.match(csp, /sandbox allow-scripts/);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /allow-same-origin|connect-src/);
  });
  it('escapes agent content everywhere', async () => {
    await put({
      address: '/items/acme/xss',
      summary: XSS,
      produced_by: { agent: XSS },
      blocks: [
        { kind: 'markdown', text: `${XSS}\n\n[x](javascript:alert(1))` },
        { kind: 'kv', id: `"><img src=x>`, title: XSS, items: [{ key: XSS, value: XSS }] },
        { kind: 'table', columns: [{ name: XSS, type: 'string' }], rows: [[XSS]] },
        { kind: 'chart', spec: { mark: 'bar', title: `</script>${XSS}` } },
      ],
    });
    const { text } = await get('/pages/items/acme/xss');
    assert.doesNotMatch(text, /<script>alert/);
    assert.doesNotMatch(text, /<\/script><script>alert/);
    assert.ok(text.includes('\\u003c/script>'));
    assert.doesNotMatch(text, /href="javascript:/);
    assert.doesNotMatch(text, /<img src=x>/);
  });
  it('one bad block does not take the page down', async () => {
    const bad = await putRecord(t.db, { kind: 'x', payload: { nothing: true } });
    await put({
      address: '/items/acme/partial',
      blocks: [
        { kind: 'chart', spec: { mark: 'bar' }, data: { record: bad.id } },
        { kind: 'markdown', text: 'survivor' },
      ],
    });
    const { res, text } = await get('/pages/items/acme/partial');
    assert.equal(res.status, 200);
    assert.match(text, /could not be rendered/);
    assert.match(text, /survivor/);
  });
});
