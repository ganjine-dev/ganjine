import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, it } from 'node:test';
import { handler } from '../src/face/server.ts';
import { putPage } from '../src/pages.ts';
import { putRecord } from '../src/records.ts';
import { closeSession, getSession, listSessions, noteSession, reopenSession, startSession } from '../src/sessions.ts';
import { page, testDb } from './helpers.ts';

let t: Awaited<ReturnType<typeof testDb>>;
let server: ReturnType<typeof createServer>;
let base: string;
before(async () => {
  t = await testDb();
  server = createServer(handler(t.db, t.store));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await t.close();
});

it('a session keeps its notes, data, pages and conclusion, and can be reopened', async () => {
  const { id } = await startSession(t.db, 'How are my investments?');
  assert.match(id, /^\d{4}-\d{2}-\d{2}-how-are-my-investments$/);
  await noteSession(t.db, id, 'question', 'How did we do?');
  const data = await putRecord(t.db, { kind: 'prices', tags: [`session:${id}`], payload: { p: 1 } });
  await putPage(t.db, page({ address: `/sessions/${id}/answer`, inputs_used: [data.id], summary: 'The answer' }), t.store);
  await closeSession(t.db, id, 'Done');
  await assert.rejects(noteSession(t.db, id, 'finding', 'late'), /is closed/);
  const closed = await getSession(t.db, id);
  assert.equal(closed.conclusion, 'Done');
  assert.equal(closed.notes[0].text, 'How did we do?');
  assert.deepEqual(closed.data.map((d) => d.id), [data.id]);
  assert.equal(closed.pages[0].content.summary, 'The answer');
  await reopenSession(t.db, id);
  assert.equal((await getSession(t.db, id)).conclusion, null);
  await closeSession(t.db, id, 'Done again');
  assert.equal((await listSessions(t.db)).find((s) => s.id === id)?.conclusion, 'Done again');
});

it('titles that repeat or have no latin letters still get unique ids', async () => {
  const a = await startSession(t.db, 'Repeat');
  const b = await startSession(t.db, 'Repeat');
  assert.notEqual(a.id, b.id);
  assert.match((await startSession(t.db, 'سرمایه من')).id, /-[0-9a-f]{6}$/);
});

it('rejects a bad note kind, an unknown session and an empty conclusion', async () => {
  const { id } = await startSession(t.db, 'Rules');
  await assert.rejects(noteSession(t.db, id, 'gossip', 'x'), /note kind/);
  await assert.rejects(noteSession(t.db, 'nope', 'finding', 'x'), /not found/);
  await assert.rejects(closeSession(t.db, id, ' '), /conclusion/);
});

it('the face shows sessions, and only an open session may poll', async () => {
  const { id } = await startSession(t.db, 'Live one');
  await noteSession(t.db, id, 'question', '<b>escaped?</b>');
  await putPage(t.db, page({ address: `/sessions/${id}/a`, summary: 'First answer' }), t.store);
  assert.match(await (await fetch(`${base}/sessions`)).text(), /Live one/);
  const open = await fetch(`${base}/sessions/${id}`);
  const text = await open.text();
  assert.match(text, /First answer/);
  assert.doesNotMatch(text, /hello/);
  assert.match(text, new RegExp(`href="/pages/sessions/${id}/a"`));
  assert.match(text, new RegExp(`data-watch="session:${id}"`));
  assert.doesNotMatch(text, /<b>escaped/);
  assert.match(open.headers.get('content-security-policy')!, /connect-src 'self'/);
  await closeSession(t.db, id, 'Finished');
  assert.equal((await fetch(`${base}/sessions/nope`)).status, 404);
});
