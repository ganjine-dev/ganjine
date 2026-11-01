import type { BlobStore } from '../blobs.ts';
import type { Db } from '../db.ts';
import { tx, GanjineError } from '../db.ts';
import { putRecord } from '../records.ts';
import type { AgentConfig } from './instructions.ts';
import { checkInput, loadAgentInstruction, repoRoot } from './instructions.ts';
import type { GanjineTool } from './tools.ts';
import { buildTools } from './tools.ts';

export type Level = 'info' | 'error';

export interface SessionRequest {
  system: string;
  prompt: string;
  config: AgentConfig;
  tools: GanjineTool[];
  log: (level: Level, message: string) => Promise<void>;
  signal: AbortSignal;
}
export interface SessionResult {
  meta?: Record<string, unknown>;
}
export type Session = (request: SessionRequest) => Promise<SessionResult>;

type Status = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'timed_out';

async function record(db: Db, runId: string, status: Status) {
  await putRecord(db, { kind: 'run.status', runId, payload: { status } });
}

export async function createRun(db: Db, agent: string, input: unknown, scheduleId: string | null = null, inTx = false) {
  const insert = async () => {
    const { rows } = await db.query(
      `INSERT INTO runs (agent_name, schedule_id, status, meta) VALUES ($1, $2, 'scheduled', $3) RETURNING *`,
      [agent, scheduleId, JSON.stringify({ input })],
    );
    await record(db, rows[0].id, 'scheduled');
    return rows[0];
  };
  return inTx ? insert() : tx(db, insert);
}

export async function logRun(db: Db, runId: string, level: Level, message: string) {
  await db.query('INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3)', [runId, level, message]);
  await putRecord(db, { kind: 'run.log', runId, tags: level === 'error' ? ['error'] : [], payload: { level, message } });
}

/** Moves a run on from `from`. Returns false if another process got there first. */
async function transition(db: Db, runId: string, from: Status, to: Status, meta: Record<string, unknown> = {}) {
  return tx(db, async () => {
    const stamp = to === 'running' ? 'started_at = now(),' : 'ended_at = now(),';
    const { rowCount } = await db.query(
      `UPDATE runs SET ${stamp} status = $1, meta = meta || $2 WHERE id = $3 AND status = $4`,
      [to, JSON.stringify(meta), runId, from],
    );
    if (rowCount) await record(db, runId, to);
    return Boolean(rowCount);
  });
}

/** One operation at a time on the run's connection: tools may be called in parallel, and a transaction must not interleave. */
function serializer() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

export const loggedTools = (tools: GanjineTool[], serial: ReturnType<typeof serializer>, log: SessionRequest['log']): GanjineTool[] =>
  tools.map((t) => ({
    ...t,
    run: async (args) => {
      try {
        return await serial(() => t.run(args));
      } catch (err) {
        await log('error', `tool ${t.name} failed: ${(err as Error).message}`);
        throw err;
      }
    },
  }));

export async function executeRun(db: Db, store: BlobStore, runId: string, session: Session, root = repoRoot()) {
  const { rows } = await db.query(
    'SELECT r.*, a.instruction_ref FROM runs r JOIN agents a ON a.name = r.agent_name WHERE r.id = $1',
    [runId],
  );
  const run = rows[0];
  if (!run) throw new GanjineError(`run not found: ${runId}`);
  if (!(await transition(db, runId, 'scheduled', 'running'))) return getRun(db, runId);

  const serial = serializer();
  const log: SessionRequest['log'] = (level, message) => serial(() => logRun(db, runId, level, message));
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const instruction = loadAgentInstruction(root, run.instruction_ref);
    const { config } = instruction;
    checkInput(instruction, run.meta.input);
    await db.query('UPDATE runs SET meta = meta || $1 WHERE id = $2', [JSON.stringify({ timeout_seconds: config.timeout_seconds, instruction_ref: run.instruction_ref }), runId]);
    timeout = setTimeout(() => controller.abort(), config.timeout_seconds * 1000);
    const tools = loggedTools(buildTools({ db, store, runId, agent: run.agent_name, config }), serial, log);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new GanjineError(`timed out after ${config.timeout_seconds}s`)));
    });
    const result = await Promise.race([
      session({
        system: instruction.system,
        prompt: `Now: ${new Date().toISOString()}\nRun: ${runId}\nInput: ${JSON.stringify(run.meta.input)}`,
        config,
        tools,
        log,
        signal: controller.signal,
      }),
      aborted,
    ]);
    await serial(async () => {});
    await transition(db, runId, 'running', 'succeeded', result.meta ?? {});
  } catch (err) {
    const message = (err as Error).message;
    await log('error', message).catch(() => {});
    await transition(db, runId, 'running', controller.signal.aborted ? 'timed_out' : 'failed', { error: message });
  } finally {
    clearTimeout(timeout);
  }
  return getRun(db, runId);
}

export const getRun = async (db: Db, id: string) => (await db.query('SELECT * FROM runs WHERE id = $1', [id])).rows[0];

/** Runs left `running` by a dead process. Without this they would block their schedule for ever. */
export async function reapStaleRuns(db: Db) {
  const { rows } = await db.query(`SELECT id FROM runs WHERE status = 'running'
    AND started_at + make_interval(secs => coalesce((meta->>'timeout_seconds')::int, 3600) + 60) < now()`);
  for (const { id } of rows) {
    await logRun(db, id, 'error', 'runner died: run exceeded its timeout with no process attached');
    await transition(db, id, 'running', 'timed_out', { error: 'runner died' });
  }
  return rows.length;
}
