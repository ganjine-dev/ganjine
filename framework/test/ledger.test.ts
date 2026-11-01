import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { LocalDiskBlobStore } from '../src/blobs.ts';
import { tx, GanjineError } from '../src/db.ts';
import { checkLedger, handler } from '../src/face/server.ts';
import { createItem } from '../src/items.ts';
import type { Entry, SignRequest } from '../src/ledger.ts';
import { canonical, GENESIS, sealExisting, setLedger, TamperError, verifyChain } from '../src/ledger.ts';
import { getPage, putPage } from '../src/pages.ts';
import { getRecord, putRecord, queryRecords } from '../src/records.ts';
import { getSession, noteSession, startSession } from '../src/sessions.ts';
import { listen, Signer } from '../src/signer.ts';
import { page, testDb } from './helpers.ts';

type T = Awaited<ReturnType<typeof testDb>>;
let t: T;
let signer: Signer;
let sock: Server;
let dir: string;
let headPath: string;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const viaSocket = (path: string) => (request: SignRequest) => new Promise<Entry[]>((resolve, reject) => {
  const s = netConnect(path);
  let reply = '';
  s.on('connect', () => s.write(`${JSON.stringify(request)}\n`));
  s.on('data', (d) => { reply += d; });
  s.on('error', () => reject(new GanjineError('the signer is not running')));
  s.on('end', () => {
    const r = JSON.parse(reply);
    if (r.error) reject(new GanjineError(r.error));
    else resolve(r.entries);
  });
});

/** What a Postgres superuser can do. */
const asSuperuser = async (sql: string, args: unknown[] = []) => {
  await t.db.query('SET session_replication_role = replica');
  await t.db.query(sql, args);
  await t.db.query('SET session_replication_role = DEFAULT');
};
const verdict = () => verifyChain(t.db);

before(async () => {
  t = await testDb();
  dir = await mkdtemp(join(tmpdir(), 'ganjine-ledger-'));
  headPath = join(dir, 'head.json');
  signer = new Signer(privateKey, headPath);
  sock = await listen(signer, join(dir, 's.sock'));
  setLedger({ publicKey, sign: viaSocket(join(dir, 's.sock')), headPath });
});
after(async () => {
  sock.close();
  setLedger(null);
  await t.close();
});

describe('canonical form', () => {
  it('keeps extending past 99 entries', async () => {
    for (let i = 0; i < 101; i++) await putRecord(t.db, { kind: 'note', payload: { i } });
    const verdict = await verifyChain(t.db);
    assert.equal(verdict.status, 'ok');
    assert.equal(verdict.seq, 101);
  });

  it('does not depend on key order', () => {
    assert.equal(canonical({ b: 1, a: [{ d: null, c: 'x' }] }), canonical({ a: [{ c: 'x', d: null }], b: 1 }));
  });
});

describe('a healthy chain', () => {
  it('signs writes, including several in one transaction, and survives jsonb reordering', async () => {
    await createItem(t.db, 'acme');
    await putRecord(t.db, { kind: 'x', payload: { zebra: 1, apple: { b: 1.5, a: 'ف' }, big: 7527568560 } });
    await tx(t.db, async () => {
      await putRecord(t.db, { kind: 'x', payload: { n: 1 } });
      await putRecord(t.db, { kind: 'x', payload: { n: 2 } });
    });
    await putPage(t.db, page({ address: '/items/acme/a' }), t.store);
    const v = await verdict();
    assert.deepEqual(v.problems, []);
    assert.equal(v.status, 'ok');
    assert.equal(v.seq, v.records);
  });
  it('leaves no gap when a transaction rolls back, even after it signed', async () => {
    await assert.rejects(tx(t.db, async () => {
      await putRecord(t.db, { kind: 'x' });
      throw new Error('boom');
    }), /boom/);
    await putRecord(t.db, { kind: 'x', payload: { after: 'rollback' } });
    assert.equal((await verdict()).status, 'ok');
  });
  it('recovers when the signer signed but the commit was lost', async () => {
    const head = JSON.parse(await readFile(headPath, 'utf8'));
    signer.sign({ base: { seq: head.seq, hash: head.hash }, records: ['c'.repeat(64)] });
    await putRecord(t.db, { kind: 'x', payload: { after: 'lost commit' } });
    assert.equal((await verdict()).status, 'ok');
  });
  it('fails closed: no signer, no write', async () => {
    const n = (await t.db.query('SELECT count(*)::int AS n FROM records')).rows[0].n;
    setLedger({ publicKey, sign: viaSocket(join(dir, 'nothing.sock')), headPath });
    await assert.rejects(putRecord(t.db, { kind: 'x' }), /signer is not running/);
    setLedger({ publicKey, sign: viaSocket(join(dir, 's.sock')), headPath });
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM records')).rows[0].n, n);
  });
});

describe('the signer', () => {
  it('refuses to fork history', () => {
    assert.throws(() => signer.sign({ base: GENESIS, records: ['a'.repeat(64)] }), /asked to extend 0/);
  });
  it('refuses a head it never issued', () => {
    assert.throws(() => signer.sign({ base: { seq: 1, hash: 'f'.repeat(64) }, records: ['a'.repeat(64)] }), /asked to extend/);
  });
  it('refuses anything that is not a hash', async () => {
    const head = JSON.parse(await readFile(headPath, 'utf8'));
    assert.throws(() => signer.sign({ base: { seq: head.seq, hash: head.hash }, records: ['not a hash'] }), /bad record hashes/);
  });
  it('keeps its socket private', async () => {
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(join(dir, 's.sock'))).mode & 0o077, 0);
  });
});

describe('an attacker with superuser and no key', () => {
  // Each attack runs on its own database, since a tampered row cannot be taken back.
  beforeEach(async () => {
    await t.close();
    t = await testDb();
    const d = await mkdtemp(join(tmpdir(), 'ganjine-ledger-'));
    const s = new Signer(privateKey, join(d, 'head.json'));
    const server = await listen(s, join(d, 's.sock'));
    server.unref();
    headPath = join(d, 'head.json');
    setLedger({ publicKey, sign: viaSocket(join(d, 's.sock')), headPath });
    await createItem(t.db, 'acme');
  });

  it('cannot edit a record: the read is refused and the chain fails', async () => {
    const r = await putRecord(t.db, { kind: 'snapshot', payload: { total: 100 } });
    await asSuperuser(`UPDATE records SET payload = '{"total": 999}' WHERE id = $1`, [r.id]);
    await assert.rejects(getRecord(t.db, r.id), TamperError);
    assert.deepEqual(await queryRecords(t.db, { kind: 'snapshot' }), []);
    assert.match((await verdict()).problems.join(), /hash mismatch/);
  });
  it('cannot insert a record: it is not in the ledger', async () => {
    const { rows } = await t.db.query(`INSERT INTO records (kind, payload) VALUES ('snapshot', '{"total": 1}') RETURNING id`);
    await assert.rejects(getRecord(t.db, rows[0].id), TamperError);
    assert.match((await verdict()).problems.join(), /records but/);
  });
  it('cannot forge an entry: it has no key', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const forger = new Signer(other, join(dir, `forger-${Date.now()}.json`));
    const r = await putRecord(t.db, { kind: 'snapshot', payload: { total: 100 } });
    await asSuperuser(`UPDATE records SET payload = '{"total": 999}' WHERE id = $1`, [r.id]);
    const row = (await t.db.query('SELECT prev_hash, seq::int FROM ledger WHERE record_id = $1', [r.id])).rows[0];
    const [forged] = forger.sign({ base: GENESIS, records: ['b'.repeat(64)] });
    await asSuperuser('UPDATE ledger SET signature = $1, entry_hash = $2 WHERE record_id = $3', [forged.signature, forged.entry_hash, r.id]);
    assert.ok(row);
    await assert.rejects(getRecord(t.db, r.id), TamperError);
  });
  it('cannot delete a record: the chain breaks', async () => {
    await putRecord(t.db, { kind: 'x' });
    const r = await putRecord(t.db, { kind: 'x' });
    await putRecord(t.db, { kind: 'x' });
    await asSuperuser('DELETE FROM ledger WHERE record_id = $1', [r.id]);
    await asSuperuser('DELETE FROM records WHERE id = $1', [r.id]);
    assert.equal((await verdict()).status, 'failed');
  });
  it('cannot cut the tail: the signer head remembers', async () => {
    await putRecord(t.db, { kind: 'x' });
    const r = await putRecord(t.db, { kind: 'x' });
    await asSuperuser('DELETE FROM ledger WHERE record_id = $1', [r.id]);
    await asSuperuser('DELETE FROM records WHERE id = $1', [r.id]);
    assert.match((await verdict()).problems.join(), /signer head is at \d+, the database at \d+/);
  });
  it('cannot rewrite a rendered page: its row must match the signed record', async () => {
    const v = await putPage(t.db, page({ address: '/items/acme/a', summary: 'true' }), t.store);
    await asSuperuser(`UPDATE page_versions SET content = jsonb_set(content, '{summary}', '"false"') WHERE id = $1`, [v.id]);
    await assert.rejects(getPage(t.db, '/items/acme/a'), TamperError);
  });
  it('cannot add to a session: the note is dropped', async () => {
    const s = await startSession(t.db, 'A sitting');
    await noteSession(t.db, s.id, 'finding', 'real');
    await t.db.query(`INSERT INTO records (kind, tags, payload) VALUES ('session.note', $1, '{"kind":"decision","text":"sell everything"}')`, [[`session:${s.id}`]]);
    assert.deepEqual((await getSession(t.db, s.id)).notes.map((n) => n.text), ['real']);
  });
  it('cannot swap the head file for one signed by another key', async () => {
    await putRecord(t.db, { kind: 'x' });
    const head = JSON.parse(await readFile(headPath, 'utf8'));
    await writeFile(headPath, JSON.stringify({ ...head, signature: Buffer.alloc(64).toString('base64') }));
    assert.match((await verdict()).problems.join(), /bad signature/);
  });
  it('is shown on the face: 409 for the page, and an alarm everywhere', async () => {
    const v = await putPage(t.db, page({ address: '/items/acme/a' }), t.store);
    await asSuperuser(`UPDATE page_versions SET content = jsonb_set(content, '{summary}', '"forged"') WHERE id = $1`, [v.id]);
    await asSuperuser(`UPDATE records SET payload = jsonb_set(payload, '{content,summary}', '"forged"') WHERE id = $1`, [v.id]);
    await checkLedger(t.db);
    const server = createServer(handler(t.db, t.store));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/pages/items/acme/a`);
    const text = await res.text();
    assert.equal(res.status, 409);
    assert.doesNotMatch(text, /<h1>forged/);
    assert.match(await (await fetch(`${base}/items`)).text(), /role="alert"/);
    assert.doesNotMatch(await (await fetch(`${base}/items/acme`)).text(), /forged/);
    server.close();
    await t.db.query(`DELETE FROM health WHERE component = 'ledger'`);
    setLedger(null);
    await checkLedger(t.db);
    setLedger({ publicKey, sign: async () => [], headPath });
  });
});

describe('sealing existing rows', () => {
  it('takes everything once, and refuses a second time', async () => {
    setLedger(null);
    const fresh = await testDb();
    await putRecord(fresh.db, { kind: 'old', payload: { a: 1 } });
    await putRecord(fresh.db, { kind: 'old', payload: { a: 2 } });
    const d = await mkdtemp(join(tmpdir(), 'ganjine-ledger-'));
    const s = new Signer(privateKey, join(d, 'head.json'));
    const server = await listen(s, join(d, 's.sock'));
    setLedger({ publicKey, sign: viaSocket(join(d, 's.sock')), headPath: join(d, 'head.json') });
    assert.deepEqual(await tx(fresh.db, () => sealExisting(fresh.db)), { sealed: 2 });
    await assert.rejects(tx(fresh.db, () => sealExisting(fresh.db)), /already has entries/);
    assert.equal((await verifyChain(fresh.db)).status, 'ok');
    assert.equal((await queryRecords(fresh.db, { kind: 'old' })).length, 2);
    server.close();
    await fresh.close();
  });
});

describe('blobs', () => {
  it('refuses a file swapped on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ganjine-blobs-'));
    const store = new LocalDiskBlobStore(root);
    const ref = await store.put(Buffer.from('real'));
    await writeFile(join(root, 'sha256', ref.slice('blob:sha256:'.length)), 'forged');
    await assert.rejects(store.get(ref), /failed verification/);
  });
});

