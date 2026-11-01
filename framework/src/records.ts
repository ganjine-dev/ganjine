import type { Db } from './db.ts';
import { isUuid, tx, GanjineError } from './db.ts';
import { fromBound, toBound } from './dates.ts';
import { authentic, requireAuthentic, seal } from './ledger.ts';

export interface NewRecord {
  kind: string;
  itemId?: string | null;
  runId?: string | null;
  tags?: string[];
  payload?: unknown;
  blobRef?: string | null;
}

export async function putRecord(db: Db, r: NewRecord) {
  return tx(db, async () => {
    const { rows } = await db.query(
      `INSERT INTO records (kind, item_id, run_id, tags, payload, blob_ref)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [r.kind, r.itemId ?? null, r.runId ?? null, r.tags ?? [], JSON.stringify(r.payload ?? {}), r.blobRef ?? null],
    );
    seal(db, rows[0].id);
    return rows[0];
  });
}

export async function getRecord(db: Db, id: string) {
  const row = isUuid(id) ? (await db.query('SELECT * FROM records WHERE id = $1', [id])).rows[0] : undefined;
  if (!row) throw new GanjineError(`record not found: ${id}`);
  await requireAuthentic(db, id);
  return row;
}

export interface RecordQuery {
  kind?: string;
  itemId?: string;
  tags?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

/** Newest first. Tags must all match. `from` and `to` filter on created_at. */
export async function queryRecords(db: Db, q: RecordQuery) {
  const args: unknown[] = [];
  const where: string[] = [];
  const add = (clause: (n: number) => string, value: unknown) => {
    args.push(value);
    where.push(clause(args.length));
  };
  if (q.kind) add((n) => `kind = $${n}`, q.kind);
  if (q.itemId) add((n) => `item_id = $${n}`, q.itemId);
  if (q.tags?.length) add((n) => `tags @> $${n}`, q.tags);
  if (q.from) add((n) => `created_at >= $${n}`, fromBound(q.from));
  if (q.to) add((n) => `created_at < $${n}`, toBound(q.to));
  args.push(q.limit ?? 100);
  const { rows } = await db.query(
    `SELECT * FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT $${args.length}`,
    args,
  );
  return authentic(db, rows);
}
