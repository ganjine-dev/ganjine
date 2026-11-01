import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

/** A client or a pool. `tx` needs a client; read paths accept either. */
export type Db = Pick<pg.ClientBase, 'query'>;

export class GanjineError extends Error {}

export const databaseUrl = () => process.env.GANJINE_DATABASE_URL ?? 'postgres://ganjine:ganjine@localhost:5434/ganjine';

export async function connect(url = databaseUrl()) {
  const client = new pg.Client({ connectionString: url });
  await client.connect().catch((err) => {
    const { hostname, port } = new URL(url);
    throw new GanjineError(`cannot reach Postgres at ${hostname}:${port} (${err.code ?? err.message})`);
  });
  return client;
}

const open = new WeakMap<object, (() => Promise<void>)[]>();

/** Joins a transaction already open on this client. */
export async function tx<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  if (open.has(db)) return fn();
  const hooks: (() => Promise<void>)[] = [];
  open.set(db, hooks);
  await db.query('BEGIN');
  try {
    const result = await fn();
    for (const hook of hooks) await hook();
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    open.delete(db);
  }
}

/** The hooks of the open transaction. New for each transaction, so a rollback leaves nothing behind. */
export function openTx(db: Db) {
  const hooks = open.get(db);
  if (!hooks) throw new GanjineError('this needs an open transaction');
  return hooks;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Returns migrations applied by this call. Safe to run concurrently. */
export async function migrate(db: Db): Promise<string[]> {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await db.query('SELECT pg_advisory_lock(7267)');
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, dir), 'utf8');
      await tx(db, async () => {
        await db.query(sql);
        await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      applied.push(file);
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(7267)');
  }
  return applied;
}
