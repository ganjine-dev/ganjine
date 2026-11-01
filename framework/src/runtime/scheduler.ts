import type { BlobStore } from '../blobs.ts';
import { nextAfter } from '../cron.ts';
import type { Db } from '../db.ts';
import { tx, GanjineError } from '../db.ts';
import { putRecord } from '../records.ts';
import { checkInput, loadAgentInstruction, repoRoot } from './instructions.ts';
import type { Session } from './run.ts';
import { createRun, executeRun, reapStaleRuns } from './run.ts';

export async function createSchedule(db: Db, agent: string, cron: string, input: unknown, createdBy: string, root = repoRoot()) {
  const found = (await db.query('SELECT instruction_ref FROM agents WHERE name = $1', [agent])).rows[0];
  if (!found) throw new GanjineError(`agent not registered: ${agent}`);
  checkInput(loadAgentInstruction(root, found.instruction_ref), input);
  const next = nextAfter(cron, new Date());
  return tx(db, async () => {
    const { rows } = await db.query(
      `INSERT INTO schedules (agent_name, cron, input, created_by, next_run_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [agent, cron, JSON.stringify(input), createdBy, next],
    );
    await putRecord(db, { kind: 'schedule.created', payload: rows[0] });
    return rows[0];
  });
}

export const listSchedules = async (db: Db) =>
  (await db.query('SELECT * FROM schedules ORDER BY agent_name, created_at')).rows;

export async function disableSchedule(db: Db, id: string) {
  return tx(db, async () => {
    const { rows } = await db.query('UPDATE schedules SET enabled = false WHERE id::text = $1 AND enabled RETURNING *', [id]);
    if (!rows[0]) throw new GanjineError(`no enabled schedule: ${id}`);
    await putRecord(db, { kind: 'schedule.disabled', payload: { id } });
    return rows[0];
  });
}

/** Turns due schedules into scheduled runs. Missed firings collapse into one; a schedule never overlaps itself. */
export async function claimDue(db: Db, now = new Date()) {
  return tx(db, async () => {
    const { rows } = await db.query(
      `SELECT * FROM schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at FOR UPDATE SKIP LOCKED`,
      [now],
    );
    for (const s of rows) {
      await db.query('UPDATE schedules SET next_run_at = $1 WHERE id = $2', [nextAfter(s.cron, now), s.id]);
      const active = await db.query(`SELECT 1 FROM runs WHERE schedule_id = $1 AND status IN ('scheduled', 'running')`, [s.id]);
      if (active.rowCount) await putRecord(db, { kind: 'schedule.skipped', payload: { id: s.id, reason: 'previous run still active' } });
      else await createRun(db, s.agent_name, s.input, s.id, true);
    }
    return rows.length;
  });
}

export async function tick(db: Db, store: BlobStore, session: Session, root = repoRoot()) {
  await reapStaleRuns(db);
  await claimDue(db);
  const { rows } = await db.query(`SELECT id FROM runs WHERE status = 'scheduled' ORDER BY created_at`);
  for (const { id } of rows) await executeRun(db, store, id, session, root);
  return rows.length;
}
