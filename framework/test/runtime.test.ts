import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { nextAfter } from '../src/cron.ts';
import { getPage } from '../src/pages.ts';
import { queryRecords } from '../src/records.ts';
import { registerAgent, listAgents } from '../src/runtime/instructions.ts';
import type { Session } from '../src/runtime/run.ts';
import { createRun, executeRun, reapStaleRuns } from '../src/runtime/run.ts';
import { claimDue, createSchedule, disableSchedule, tick } from '../src/runtime/scheduler.ts';
import { testDb } from './helpers.ts';

let t: Awaited<ReturnType<typeof testDb>>;
let root: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe', encoding: 'utf8' });

function writeAgent(name: string, config: object, schema: object = { type: 'object' }) {
  const dir = join(root, 'agents/temporal', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'INSTRUCTION.md'), `You are ${name}.`);
  writeFileSync(join(dir, 'tools.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'input.schema.json'), JSON.stringify(schema));
  git('add', '-A');
  git('commit', '-qm', name);
}

const content = (address: string) => ({ address, as_of: '2026-11-01', summary: 'beat', blocks: [{ kind: 'markdown', text: 'x' }] });
const tool = (req: Parameters<Session>[0], name: string) => req.tools.find((x) => x.name === name)!;
const execute = async (name: string, session: Session, input: unknown = {}) => {
  const run = await createRun(t.db, name, input);
  return executeRun(t.db, t.store, run.id, session, root);
};

before(async () => {
  t = await testDb();
  root = mkdtempSync(join(tmpdir(), 'ganjine-repo-'));
  git('init', '-q');
  writeAgent('writer', { tools: ['write_page', 'write_record'], pages: ['/system/writer'], timeout_seconds: 1 });
  await registerAgent(t.db, 'temporal/writer', root);
});
after(() => t.close());

describe('cron', () => {
  const next = (c: string, at: string) => nextAfter(c, new Date(at)).toISOString();
  it('finds the next firing, in UTC', () => {
    assert.equal(next('0 * * * *', '2026-11-01T10:30:15Z'), '2026-11-01T11:00:00.000Z');
    assert.equal(next('0 * * * *', '2026-11-01T11:00:00Z'), '2026-11-01T12:00:00.000Z');
    assert.equal(next('*/15 9-10 * * *', '2026-11-01T10:50:00Z'), '2026-11-02T09:00:00.000Z');
    assert.equal(next('30 6 * * 1', '2026-11-01T00:00:00Z'), '2026-11-02T06:30:00.000Z');
    assert.equal(next('0 0 1,15 * *', '2026-11-02T00:00:00Z'), '2026-11-15T00:00:00.000Z');
  });
  it('treats restricted day fields as either-or', () => {
    assert.equal(next('0 0 15 * 1', '2026-11-03T00:00:00Z'), '2026-11-09T00:00:00.000Z');
  });
  it('rejects bad expressions and ones that never fire', () => {
    for (const c of ['* * * *', '61 * * * *', 'a * * * *', '5-1 * * * *', '*/0 * * * *']) assert.throws(() => nextAfter(c, new Date()), /invalid cron/);
    assert.throws(() => nextAfter('0 0 31 2 *', new Date()), /never fires/);
  });
});

describe('instruction registry', () => {
  it('pins an agent to name and git sha', async () => {
    const agent = (await listAgents(t.db)).find((a) => a.name === 'writer');
    assert.equal(agent.instruction_ref, `temporal/writer@${git('rev-parse', 'HEAD').trim()}`);
    assert.equal(agent.kind, 'temporal');
  });
  it('refuses uncommitted changes', async () => {
    writeAgent('dirty', { tools: [] });
    writeFileSync(join(root, 'agents/temporal/dirty/INSTRUCTION.md'), 'changed');
    await assert.rejects(registerAgent(t.db, 'temporal/dirty', root), /uncommitted/);
    git('checkout', '--', '.');
  });
  it('refuses unknown tools, which is how a shell would be asked for', async () => {
    writeAgent('greedy', { tools: ['bash'] });
    await assert.rejects(registerAgent(t.db, 'temporal/greedy', root), /unknown tools: bash/);
  });
  it('runs the committed instruction, not the working tree', async () => {
    writeAgent('pinned', { tools: [] });
    await registerAgent(t.db, 'temporal/pinned', root);
    writeFileSync(join(root, 'agents/temporal/pinned/INSTRUCTION.md'), 'tampered');
    let system = '';
    await execute('pinned', async (req) => { system = req.system; return {}; });
    assert.equal(system, 'You are pinned.');
    git('checkout', '--', '.');
  });
});

describe('run lifecycle', () => {
  const statuses = async (id: string) =>
    (await queryRecords(t.db, { kind: 'run.status', limit: 1000 })).filter((r) => r.run_id === id).reverse().map((r) => r.payload.status);

  it('a successful run records every transition and what it produced', async () => {
    const run = await execute('writer', async (req) => {
      await req.log('info', 'hello');
      await tool(req, 'write_page').run(content('/system/writer'));
      return { meta: { cost_usd: 0.01 } };
    });
    assert.equal(run.status, 'succeeded');
    assert.ok(run.started_at && run.ended_at);
    assert.equal(run.meta.cost_usd, 0.01);
    assert.deepEqual(await statuses(run.id), ['scheduled', 'running', 'succeeded']);
    const page = await getPage(t.db, '/system/writer');
    assert.deepEqual(page.content.produced_by, { agent: 'writer', run_id: run.id });
    assert.equal(page.run_id, run.id);
    const logs = await queryRecords(t.db, { kind: 'run.log' });
    assert.ok(logs.some((r) => r.run_id === run.id && r.payload.message === 'hello'));
  });
  it('a failure is a failed run with an error record', async () => {
    const run = await execute('writer', async () => { throw new Error('boom'); });
    assert.equal(run.status, 'failed');
    assert.equal(run.meta.error, 'boom');
    const errors = await queryRecords(t.db, { tags: ['error'] });
    assert.ok(errors.some((r) => r.run_id === run.id && r.payload.message === 'boom'));
    assert.deepEqual(await statuses(run.id), ['scheduled', 'running', 'failed']);
  });
  it('a hung session times out and is aborted', async () => {
    let aborted = false;
    const run = await execute('writer', (req) => new Promise(() => {
      req.signal.addEventListener('abort', () => { aborted = true; });
    }));
    assert.equal(run.status, 'timed_out');
    assert.ok(aborted);
  });
  it('rejects input that does not match the schema', async () => {
    writeAgent('typed', { tools: [] }, { type: 'object', required: ['x'] });
    await registerAgent(t.db, 'temporal/typed', root);
    const run = await execute('typed', async () => ({}));
    assert.equal(run.status, 'failed');
    assert.match(run.meta.error, /input\.schema\.json/);
  });
  it('a run cannot be executed twice', async () => {
    let calls = 0;
    const run = await createRun(t.db, 'writer', {});
    await executeRun(t.db, t.store, run.id, async () => { calls++; return {}; }, root);
    await executeRun(t.db, t.store, run.id, async () => { calls++; return {}; }, root);
    assert.equal(calls, 1);
  });
  it('reaps a run abandoned by a dead process', async () => {
    const run = await createRun(t.db, 'writer', {});
    await t.db.query(`UPDATE runs SET status = 'running', started_at = now() - interval '1 hour', meta = meta || '{"timeout_seconds": 1}' WHERE id = $1`, [run.id]);
    assert.equal(await reapStaleRuns(t.db), 1);
    assert.equal((await t.db.query('SELECT status FROM runs WHERE id = $1', [run.id])).rows[0].status, 'timed_out');
  });
});

describe('tool scope', () => {
  it('an agent gets only what tools.json grants', async () => {
    let names: string[] = [];
    await execute('writer', async (req) => { names = req.tools.map((x) => x.name); return {}; });
    assert.deepEqual(names, ['write_record', 'write_page']);
  });
  it('an agent cannot write outside its page scope', async () => {
    let error = '';
    await execute('writer', async (req) => {
      for (const address of ['/system/writer-evil', '/items/x/overview', '/system']) {
        await tool(req, 'write_page').run(content(address)).catch((e) => { error += e.message; });
      }
      return {};
    });
    assert.equal(error.match(/may not write/g)?.length, 3);
  });
  it('an agent cannot forge framework records', async () => {
    let error = '';
    await execute('writer', async (req) => {
      await tool(req, 'write_record').run({ kind: 'run.status', payload: {} }).catch((e) => { error = e.message; });
      return {};
    });
    assert.match(error, /reserved/);
  });
  it('tools called in parallel do not interleave transactions', async () => {
    const run = await execute('writer', async (req) => {
      const write = tool(req, 'write_page');
      await Promise.all([1, 2, 3, 4, 5].map(() => write.run(content('/system/writer/parallel'))));
      return {};
    });
    assert.equal(run.status, 'succeeded');
    const { rows } = await t.db.query(`SELECT count(*)::int AS n FROM page_versions WHERE run_id = $1`, [run.id]);
    assert.equal(rows[0].n, 5);
  });
});

describe('scheduler', () => {
  let id: string;
  beforeEach(async () => {
    await t.db.query(`UPDATE schedules SET enabled = false`);
    await t.db.query(`UPDATE runs SET status = 'failed' WHERE status IN ('scheduled', 'running')`);
    id = (await createSchedule(t.db, 'writer', '0 * * * *', {}, 'test', root)).id;
  });
  const makeDue = () => t.db.query(`UPDATE schedules SET next_run_at = now() - interval '5 hours' WHERE id = $1`, [id]);
  const runsOf = async () => (await t.db.query('SELECT * FROM runs WHERE schedule_id = $1', [id])).rows;

  it('sets the next firing and does nothing before it', async () => {
    assert.equal(await claimDue(t.db), 0);
    assert.equal(await tick(t.db, t.store, async () => ({}), root), 0);
  });
  it('runs a due schedule once, collapsing missed firings, and moves it on', async () => {
    await makeDue();
    let calls = 0;
    await tick(t.db, t.store, async () => { calls++; return {}; }, root);
    await tick(t.db, t.store, async () => { calls++; return {}; }, root);
    assert.equal(calls, 1);
    const { rows } = await t.db.query('SELECT next_run_at FROM schedules WHERE id = $1', [id]);
    assert.ok(rows[0].next_run_at > new Date());
    assert.equal((await runsOf())[0].status, 'succeeded');
  });
  it('never overlaps itself', async () => {
    await makeDue();
    await claimDue(t.db);
    await t.db.query(`UPDATE runs SET status = 'running' WHERE schedule_id = $1`, [id]);
    await makeDue();
    await claimDue(t.db);
    assert.equal((await runsOf()).length, 1);
    assert.equal((await queryRecords(t.db, { kind: 'schedule.skipped' })).length >= 1, true);
  });
  it('a disabled schedule does not fire', async () => {
    await makeDue();
    await disableSchedule(t.db, id);
    assert.equal(await claimDue(t.db), 0);
  });
  it('rejects unknown agents and bad cron', async () => {
    await assert.rejects(createSchedule(t.db, 'ghost', '* * * * *', {}, 't', root), /not registered/);
    await assert.rejects(createSchedule(t.db, 'writer', 'nope', {}, 't', root), /invalid cron/);
  });
});
