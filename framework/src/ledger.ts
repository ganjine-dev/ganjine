import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { Db } from './db.ts';
import { openTx, GanjineError } from './db.ts';

/** The chain. Why it looks like this: `docs/adr/0006-signed-ledger.md`. */

export const GENESIS = { seq: 0, hash: '0'.repeat(64) };
export type Head = { seq: number; hash: string };
export type Entry = { seq: number; prev_hash: string; entry_hash: string; signature: string };
export type SignRequest = { base: Head; records: string[] };

export interface Ledger {
  publicKey: KeyObject;
  sign: (request: SignRequest) => Promise<Entry[]>;
  headPath?: string;
  anchorPath?: string;
}

export class TamperError extends GanjineError {}

const root = new URL('../../', import.meta.url).pathname;
// Belongs to one install, so it never ships. Point this at a private repo to keep the key and anchor under git.
export const LEDGER_DIR = process.env.GANJINE_LEDGER_DIR ?? `${root}.ganjine/ledger`;
export const PUBLIC_KEY_PATH = `${LEDGER_DIR}/ledger.pub`;
export const HEAD_PATH = `${root}.ganjine/ledger/head.json`;
export const ANCHOR_PATH = `${LEDGER_DIR}/ledger.anchor.json`;
export const socketPath = () => process.env.GANJINE_SIGNER_SOCK ?? `${root}.ganjine/signer.sock`;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
// These two labels are the chain format. They keep the project's first name, because changing them invalidates every signed chain.
export const entryHash = (seq: number, prev: string, record: string) => sha256(`vault-ledger-v1\n${seq}\n${prev}\n${record}`);
export const headMessage = (head: Head) => `vault-ledger-head-v1\n${head.seq}\n${head.hash}`;

/** Stable whatever order Postgres hands the keys back in. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const ROW = `r.id::text, r.kind, r.item_id::text, r.run_id::text,
  to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created, r.tags, r.payload, r.blob_ref`;
const FULL = `SELECT ${ROW}, l.seq::text, l.prev_hash, l.entry_hash, l.signature,
    v.id::text AS version_id, v.address, v.as_of::text, v.content
  FROM records r LEFT JOIN ledger l ON l.record_id = r.id LEFT JOIN page_versions v ON v.id = r.id`;

const recordHash = (r: any) => sha256(canonical({
  id: r.id, kind: r.kind, item_id: r.item_id, run_id: r.run_id, created: r.created, tags: r.tags, payload: r.payload, blob_ref: r.blob_ref,
}));

const verifySignature = (key: KeyObject, message: string, signature: string) => {
  try {
    return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
};

/** The page_versions row is what gets rendered, so it has to agree with the record that was signed. */
function versionProblem(r: any) {
  if (r.kind !== 'page_version') return r.version_id ? 'page version on a record of another kind' : null;
  if (!r.version_id) return 'page version row is missing';
  const c = r.payload?.content;
  if (canonical(r.content) !== canonical(c) || r.address !== c?.address || r.as_of !== c?.as_of) return 'page version differs from its record';
  return null;
}

function rowProblem(r: any, ledger: Ledger) {
  if (r.seq === null) return 'not in the ledger';
  if (entryHash(Number(r.seq), r.prev_hash, recordHash(r)) !== r.entry_hash) return 'hash mismatch';
  if (!verifySignature(ledger.publicKey, r.entry_hash, r.signature)) return 'bad signature';
  return versionProblem(r);
}

const socketSign = (request: SignRequest) => new Promise<Entry[]>((resolve, reject) => {
  const socket = netConnect(socketPath());
  let reply = '';
  socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on('data', (d) => { reply += d; });
  socket.on('error', () => reject(new GanjineError('the signer is not running. Open Ganjine, or run ./ganjine up')));
  socket.on('end', () => {
    try {
      const r = JSON.parse(reply);
      if (r.error) reject(new GanjineError(`signer refused: ${r.error}`));
      else resolve(r.entries);
    } catch {
      reject(new GanjineError('the signer sent no usable reply'));
    }
  });
});

let override: Ledger | null | undefined;
let resolved: Ledger | null | undefined;

/** For tests. null turns the ledger off, undefined goes back to `ledger.pub`. */
export function setLedger(ledger: Ledger | null | undefined) {
  override = ledger;
}

export function ledger(): Ledger | null {
  if (override !== undefined) return override;
  if (resolved === undefined) {
    resolved = existsSync(PUBLIC_KEY_PATH)
      ? { publicKey: createPublicKey(readFileSync(PUBLIC_KEY_PATH, 'utf8')), sign: socketSign, headPath: HEAD_PATH, anchorPath: ANCHOR_PATH }
      : null;
  }
  return resolved;
}

const headOf = async (db: Db): Promise<Head> => {
  const { rows } = await db.query('SELECT seq::text, entry_hash FROM ledger ORDER BY seq DESC LIMIT 1');
  return rows[0] ? { seq: Number(rows[0].seq), hash: rows[0].entry_hash } : GENESIS;
};

async function sealIds(db: Db, l: Ledger, ids: string[]) {
  await db.query('SELECT pg_advisory_xact_lock(7268)');
  const base = await headOf(db);
  const { rows } = await db.query(`SELECT ${ROW} FROM records r WHERE r.id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const entries = await l.sign({ base, records: ids.map((id) => recordHash(byId.get(id))) });
  for (const [i, e] of entries.entries()) {
    await db.query('INSERT INTO ledger (seq, record_id, prev_hash, entry_hash, signature) VALUES ($1, $2, $3, $4, $5)',
      [e.seq, ids[i], e.prev_hash, e.entry_hash, e.signature]);
  }
}

const queued = new WeakMap<object, string[]>();

/** Call inside `tx`. Everything queued is signed in one batch, just before COMMIT. */
export function seal(db: Db, id: string) {
  const l = ledger();
  if (!l) return;
  const hooks = openTx(db);
  const ids = queued.get(hooks);
  if (ids) {
    ids.push(id);
    return;
  }
  const batch = [id];
  queued.set(hooks, batch);
  hooks.push(() => sealIds(db, l, batch));
}

/** Ids that must not be shown. An id with no record behind it counts: a forged page_versions row. */
export async function rejected(db: Db, ids: string[]) {
  const l = ledger();
  if (!l || !ids.length) return new Set<string>();
  const { rows } = await db.query(`${FULL} WHERE r.id = ANY($1::uuid[])`, [ids]);
  const good = new Set(rows.filter((r) => !rowProblem(r, l)).map((r) => r.id));
  return new Set(ids.filter((id) => !good.has(id)));
}

export async function requireAuthentic(db: Db, id: string) {
  if ((await rejected(db, [id])).size) throw new TamperError(`failed verification, refused: ${id}`);
}

/** Keeps the rows that verify. */
export async function authentic<T extends { id: string }>(db: Db, rows: T[]): Promise<T[]> {
  const bad = await rejected(db, rows.map((r) => r.id));
  return bad.size ? rows.filter((r) => !bad.has(r.id)) : rows;
}

const readJson = (path?: string) => (path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

export type Verdict = { status: 'off' | 'ok' | 'failed'; seq: number; records: number; problems: string[] };

/** The whole chain. This is what notices a deletion, which no single read can see. */
export async function verifyChain(db: Db): Promise<Verdict> {
  const l = ledger();
  const records = (await db.query('SELECT count(*)::int AS n FROM records')).rows[0].n;
  if (!l) return { status: 'off', seq: 0, records, problems: [] };
  const problems: string[] = [];
  const hashes = new Map<number, string>();
  let expected = GENESIS;
  const size = 200;
  for (;;) {
    const { rows } = await db.query(
      `${FULL.replace('LEFT JOIN ledger l ON l.record_id = r.id', 'JOIN ledger l ON l.record_id = r.id')} WHERE l.seq > $1 ORDER BY l.seq LIMIT $2`,
      [expected.seq, size],
    );
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq !== expected.seq + 1) problems.push(`entries ${expected.seq + 1} to ${seq - 1} are missing`);
      if (r.prev_hash !== expected.hash) problems.push(`entry ${seq} does not follow the one before it`);
      const problem = rowProblem(r, l);
      if (problem) problems.push(`entry ${seq}: ${problem}`);
      hashes.set(seq, r.entry_hash);
      expected = { seq, hash: r.entry_hash };
    }
    if (rows.length < size) break;
  }
  const { rows: strays } = await db.query(`SELECT count(*)::int AS n FROM ledger l LEFT JOIN records r ON r.id = l.record_id WHERE r.id IS NULL`);
  if (strays[0].n) problems.push(`${strays[0].n} ledger entries have no record`);
  const sealed = (await db.query('SELECT count(*)::int AS n FROM ledger')).rows[0].n;
  if (records !== sealed) problems.push(`${records} records but ${sealed} ledger entries`);
  const { rows: orphans } = await db.query(`SELECT count(*)::int AS n FROM page_versions v LEFT JOIN records r ON r.id = v.id WHERE r.id IS NULL`);
  if (orphans[0].n) problems.push(`${orphans[0].n} page versions have no record`);

  const head = readJson(l.headPath);
  if (head) {
    if (!verifySignature(l.publicKey, headMessage(head), head.signature)) problems.push('the signer head has a bad signature');
    else if (head.seq !== expected.seq || head.hash !== expected.hash) problems.push(`the signer head is at ${head.seq}, the database at ${expected.seq}`);
  }
  const anchor = readJson(l.anchorPath);
  if (anchor) {
    if (!verifySignature(l.publicKey, headMessage(anchor), anchor.signature)) problems.push('the anchor has a bad signature');
    else if (hashes.get(anchor.seq) !== anchor.hash) problems.push(`the chain no longer contains anchor ${anchor.seq}`);
  }
  return { status: problems.length ? 'failed' : 'ok', seq: expected.seq, records, problems };
}

/** One time only: the first batch of a new ledger takes the rows that already exist. */
export async function sealExisting(db: Db) {
  const l = ledger();
  if (!l) throw new GanjineError('the ledger is off: run ./ganjine signer init first');
  if ((await headOf(db)).seq) throw new GanjineError('the ledger already has entries: unsealed rows now are forgeries');
  const { rows } = await db.query(`${FULL} ORDER BY r.created_at, r.id`);
  for (const r of rows) {
    const problem = versionProblem(r);
    if (problem) throw new GanjineError(`record ${r.id}: ${problem}`);
  }
  if (rows.length) await sealIds(db, l, rows.map((r) => r.id));
  return { sealed: rows.length };
}
