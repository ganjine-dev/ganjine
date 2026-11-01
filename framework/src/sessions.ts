import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { GanjineError } from './db.ts';
import { authentic } from './ledger.ts';
import { putRecord } from './records.ts';

export const NOTE_KINDS = ['question', 'finding', 'feedback', 'decision'] as const;

const tagOf = (id: string) => `session:${id}`;

function slug(title: string) {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return ascii || randomBytes(3).toString('hex');
}

const statusOf = (rows: { kind: string }[]) =>
  rows.filter((r) => ['session.started', 'session.closed', 'session.reopened'].includes(r.kind)).at(-1)?.kind === 'session.closed' ? 'closed' : 'open';

const trail = async (db: Db, id: string) =>
  authentic(db, (await db.query('SELECT * FROM records WHERE tags @> $1 ORDER BY created_at, id', [[tagOf(id)]])).rows);

export async function startSession(db: Db, title: string) {
  if (!title.trim()) throw new GanjineError('a session needs a title');
  const base = `${new Date().toISOString().slice(0, 10)}-${slug(title)}`;
  const taken = (await db.query(`SELECT count(*)::int AS n FROM records WHERE kind = 'session.started' AND payload->>'id' LIKE $1`, [`${base}%`])).rows[0].n;
  const id = taken ? `${base}-${taken + 1}` : base;
  await putRecord(db, { kind: 'session.started', tags: [tagOf(id)], payload: { id, title } });
  return { id, title, status: 'open' };
}

export async function getSession(db: Db, id: string) {
  const records = await trail(db, id);
  const started = records.find((r) => r.kind === 'session.started');
  if (!started) throw new GanjineError(`session not found: ${id}`);
  const pages = await authentic(db, (await db.query(
    `SELECT v.id, p.address, v.as_of::text, v.created_at, v.content,
       (SELECT min(f.created_at) FROM page_versions f WHERE f.address = p.address) AS first_at
     FROM pages p JOIN page_versions v ON v.id = p.latest_version_id
     WHERE p.address LIKE $1 ORDER BY first_at`, [`/sessions/${id}/%`])).rows);
  const closed = records.filter((r) => r.kind === 'session.closed').at(-1);
  const status = statusOf(records);
  return {
    id,
    title: started.payload.title,
    status,
    started_at: started.created_at,
    conclusion: status === 'closed' ? closed.payload.conclusion : null,
    notes: records.filter((r) => r.kind === 'session.note').map((r) => ({ at: r.created_at, kind: r.payload.kind, text: r.payload.text })),
    data: records.filter((r) => !r.kind.startsWith('session.')).map((r) => ({ id: r.id, kind: r.kind, at: r.created_at })),
    pages,
  };
}

async function requireStatus(db: Db, id: string, status: string) {
  const session = await getSession(db, id);
  if (session.status !== status) throw new GanjineError(`session ${id} is ${session.status}`);
}

export async function noteSession(db: Db, id: string, kind: string, text: string) {
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) throw new GanjineError(`note kind must be one of: ${NOTE_KINDS.join(', ')}`);
  await requireStatus(db, id, 'open');
  await putRecord(db, { kind: 'session.note', tags: [tagOf(id)], payload: { kind, text } });
  return { id, kind, text };
}

export async function closeSession(db: Db, id: string, conclusion: string) {
  if (!conclusion.trim()) throw new GanjineError('closing a session needs a conclusion');
  await requireStatus(db, id, 'open');
  await putRecord(db, { kind: 'session.closed', tags: [tagOf(id)], payload: { conclusion } });
  return { id, status: 'closed', conclusion };
}

export async function reopenSession(db: Db, id: string) {
  await requireStatus(db, id, 'closed');
  await putRecord(db, { kind: 'session.reopened', tags: [tagOf(id)] });
  return { id, status: 'open' };
}

export async function listSessions(db: Db) {
  const { rows } = await db.query(`SELECT payload->>'id' AS id FROM records WHERE kind = 'session.started' ORDER BY created_at DESC`);
  const sessions = await Promise.all(rows.map((r) => getSession(db, r.id)));
  return sessions.map(({ id, title, status, started_at, conclusion, notes, data, pages }) => ({
    id, title, status, started_at, conclusion, notes: notes.length, data: data.length, pages: pages.length,
  }));
}
