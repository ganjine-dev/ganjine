import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { blobStore } from './blobs.ts';
import { attachItem, categoryTree, createCategory, linkCategories, listCategories } from './categories.ts';
import type { Db } from './db.ts';
import { connect, databaseUrl, migrate, tx, GanjineError } from './db.ts';
import { serve } from './face/server.ts';
import { createItem, listItems, resolveItem, showItem } from './items.ts';
import { ledger, sealExisting, verifyChain, HEAD_PATH, ANCHOR_PATH } from './ledger.ts';
import { getPage, pageHistory, putPage } from './pages.ts';
import { getRecord, putRecord, queryRecords } from './records.ts';
import { checkInput, listAgents, loadAgentInstruction, registerAgent, repoRoot } from './runtime/instructions.ts';
import { createRun, executeRun } from './runtime/run.ts';
import { createSchedule, disableSchedule, listSchedules, tick } from './runtime/scheduler.ts';
import { claudeSession } from './runtime/session.ts';
import { startSigner } from './signer.ts';
import { down, up } from './up.ts';
import { freePort, killHolder, status } from './status.ts';
import { subscribe } from './events.ts';
import { execute, loadReactions, reactor } from './react.ts';
import { closeSession, getSession, listSessions, noteSession, reopenSession, startSession } from './sessions.ts';

/** What a bug report needs, and nothing about the install's data. */
async function version() {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return { version, content_contract: 1, node: process.version, platform: `${process.platform}-${process.arch}` };
}

const USAGE = `ganjine — capital-management framework

  ganjine version
  ganjine db migrate
  ganjine item create <name> [--meta <json>]
  ganjine item list
  ganjine item show <name|id>
  ganjine category create <name> [--parent <path>] [--meta <json>]
  ganjine category link <from> <to> [--kind <kind>]
  ganjine category attach <item> <category>
  ganjine category list
  ganjine category tree
  ganjine record put --kind <kind> [--item <name>] [--tag <t>]... [--payload <json>] [--file <path>]
  ganjine record get <id>
  ganjine record query [--kind <k>] [--item <name>] [--tag <t>]... [--from <date>] [--to <date>] [--limit <n>]
  ganjine page put <file|->
  ganjine page get <address> [--as-of <date>]
  ganjine page history <address>
  ganjine serve [--port <port>]
  ganjine agent register <temporal/name|asset/name>
  ganjine agent list
  ganjine schedule create --agent <name> --cron "<expr>" [--input <json>]
  ganjine schedule list
  ganjine schedule disable <id>
  ganjine run <agent> [--input <json>]
  ganjine runner [--once]
  ganjine session start <title>
  ganjine session list
  ganjine session show <id>
  ganjine session note <id> <text> --kind <question|finding|feedback|decision>
  ganjine session close <id> --conclusion <text>
  ganjine session reopen <id>
  ganjine blob put <file>
  ganjine blob get <ref> [--out <path>]
  ganjine up [--port <port>|--free-port] [--no-open]
  ganjine down
  ganjine status
  ganjine kill <pid> [--force]
  ganjine watch [--kind <k>] [--tag <t>]
  ganjine react
  ganjine signer start
  ganjine ledger seal-existing
  ganjine ledger verify
  ganjine ledger anchor

Dates are YYYY-MM-DD in UTC. Output is JSON unless noted.
Env: GANJINE_DATABASE_URL, GANJINE_BLOB_DIR, GANJINE_DEBUG.`;

type Options = NonNullable<ParseArgsConfig['options']>;
type Parsed = { args: string[]; opts: Record<string, any> };
type Command = { options?: Options; args: number; run: (db: Db, p: Parsed) => Promise<unknown> };

const str = { type: 'string' } as const;
const many = { type: 'string', multiple: true } as const;

function json(text: string | undefined, name: string): unknown {
  if (text === undefined) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GanjineError(`--${name} is not valid JSON`);
  }
}

const itemId = async (db: Db, ref?: string) => (ref ? (await resolveItem(db, ref)).id : undefined);

const COMMANDS: Record<string, Command> = {
  'db migrate': { args: 0, run: async (db) => ({ applied: await migrate(db) }) },
  'item create': { args: 1, options: { meta: str }, run: (db, p) => createItem(db, p.args[0], json(p.opts.meta, 'meta')) },
  'item list': { args: 0, run: (db) => listItems(db) },
  'item show': { args: 1, run: (db, p) => showItem(db, p.args[0]) },
  'category create': {
    args: 1,
    options: { parent: str, meta: str },
    run: (db, p) => createCategory(db, p.args[0], p.opts.parent, json(p.opts.meta, 'meta')),
  },
  'category link': {
    args: 2,
    options: { kind: str },
    run: (db, p) => linkCategories(db, p.args[0], p.args[1], p.opts.kind ?? 'related'),
  },
  'category attach': { args: 2, run: (db, p) => attachItem(db, p.args[0], p.args[1]) },
  'category list': { args: 0, run: (db) => listCategories(db) },
  'category tree': { args: 0, run: (db) => categoryTree(db) },
  'record put': {
    args: 0,
    options: { kind: str, item: str, tag: many, payload: str, file: str },
    run: async (db, p) => {
      if (!p.opts.kind) throw new GanjineError('--kind is required');
      const blobRef = p.opts.file ? await blobStore().put(await readFile(p.opts.file)) : null;
      return putRecord(db, {
        kind: p.opts.kind,
        itemId: await itemId(db, p.opts.item),
        tags: p.opts.tag,
        payload: json(p.opts.payload, 'payload'),
        blobRef,
      });
    },
  },
  'ledger seal-existing': { args: 0, run: (db) => tx(db, () => sealExisting(db)) },
  'ledger verify': {
    args: 0,
    run: async (db) => {
      const verdict = await verifyChain(db);
      if (verdict.status === 'failed') process.exitCode = 1;
      return verdict;
    },
  },
  'record get': { args: 1, run: (db, p) => getRecord(db, p.args[0]) },
  'record query': {
    args: 0,
    options: { kind: str, item: str, tag: many, from: str, to: str, limit: str },
    run: async (db, p) => {
      const limit = p.opts.limit === undefined ? undefined : Number(p.opts.limit);
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new GanjineError('--limit must be a positive integer');
      return queryRecords(db, { ...p.opts, itemId: await itemId(db, p.opts.item), tags: p.opts.tag, limit });
    },
  },
  'agent register': { args: 1, run: (db, p) => registerAgent(db, p.args[0]) },
  'agent list': { args: 0, run: (db) => listAgents(db) },
  'schedule create': {
    args: 0,
    options: { agent: str, cron: str, input: str },
    run: (db, p) => {
      if (!p.opts.agent || !p.opts.cron) throw new GanjineError('--agent and --cron are required');
      return createSchedule(db, p.opts.agent, p.opts.cron, json(p.opts.input, 'input'), 'operator');
    },
  },
  'schedule list': { args: 0, run: (db) => listSchedules(db) },
  'schedule disable': { args: 1, run: (db, p) => disableSchedule(db, p.args[0]) },
  'session start': { args: 1, run: (db, p) => startSession(db, p.args[0]) },
  'session list': { args: 0, run: (db) => listSessions(db) },
  'session show': { args: 1, run: (db, p) => getSession(db, p.args[0]) },
  'session note': { args: 2, options: { kind: str }, run: (db, p) => noteSession(db, p.args[0], p.opts.kind ?? 'finding', p.args[1]) },
  'session close': {
    args: 1,
    options: { conclusion: str },
    run: (db, p) => closeSession(db, p.args[0], p.opts.conclusion ?? ''),
  },
  'session reopen': { args: 1, run: (db, p) => reopenSession(db, p.args[0]) },
  'page put': {
    args: 1,
    run: async (db, p) => {
      const text = await readFile(p.args[0] === '-' ? '/dev/stdin' : p.args[0], 'utf8');
      return putPage(db, json(text, 'file'), blobStore());
    },
  },
  'page get': { args: 1, options: { 'as-of': str }, run: (db, p) => getPage(db, p.args[0], p.opts['as-of']) },
  'page history': { args: 1, run: (db, p) => pageHistory(db, p.args[0]) },
};

const LOCAL: Record<string, Omit<Command, 'run'> & { run: (p: Parsed) => Promise<unknown> }> = {
  'blob put': { args: 1, run: async (p) => ({ ref: await blobStore().put(await readFile(p.args[0])) }) },
  'blob get': {
    args: 1,
    options: { out: str },
    run: async (p) => {
      const bytes = await blobStore().get(p.args[0]);
      if (p.opts.out) await writeFile(p.opts.out, bytes);
      else process.stdout.write(bytes);
      return undefined;
    },
  },
};

function parse(command: Pick<Command, 'options' | 'args'>, name: string, argv: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: command.options ?? {}, allowPositionals: true });
  } catch (err) {
    throw new GanjineError((err as Error).message);
  }
  if (parsed.positionals.length !== command.args) throw new GanjineError(`ganjine ${name}: expected ${command.args} argument(s)\n\n${USAGE}`);
  return { args: parsed.positionals, opts: parsed.values };
}

async function runAgent(argv: string[]) {
  const { args, opts } = parse({ args: 1, options: { input: str } }, 'run', argv);
  const input = json(opts.input, 'input');
  const db = await connect();
  try {
    const agent = (await db.query('SELECT instruction_ref FROM agents WHERE name = $1', [args[0]])).rows[0];
    if (!agent) throw new GanjineError(`agent not registered: ${args[0]}`);
    checkInput(loadAgentInstruction(repoRoot(), agent.instruction_ref), input);
    const run = await createRun(db, args[0], input);
    const done = await executeRun(db, blobStore(), run.id, claudeSession);
    print(done);
    if (done.status !== 'succeeded') process.exitCode = 1;
  } finally {
    await db.end();
  }
}

async function runner(argv: string[]) {
  const { opts } = parse({ args: 0, options: { once: { type: 'boolean' } } }, 'runner', argv);
  const db = await connect();
  try {
    if (opts.once) return print({ runs: await tick(db, blobStore(), claudeSession) });
    console.log('Ganjine runner started');
    for (;;) {
      await tick(db, blobStore(), claudeSession).catch((err) => console.error(`ganjine: ${err.message}`));
      await new Promise((r) => setTimeout(r, 30_000));
    }
  } finally {
    await db.end();
  }
}

function print(result: unknown) {
  if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

async function main() {
  const [group, sub, ...rest] = process.argv.slice(2);
  if (group === 'serve') {
    const { opts } = parse({ args: 0, options: { port: str } }, 'serve', process.argv.slice(3));
    const port = await serve(opts.port === undefined ? 4400 : Number(opts.port));
    return console.log(`Ganjine face on http://127.0.0.1:${port}`);
  }
  if (group === 'up') {
    const { opts } = parse({ args: 0, options: { port: str, 'free-port': { type: 'boolean' }, 'no-open': { type: 'boolean' } } }, 'up', process.argv.slice(3));
    return up({ port: opts['free-port'] ? freePort() : opts.port ? Number(opts.port) : undefined, open: !opts['no-open'] });
  }
  if (group === 'status') return print(await status());
  if (group === 'kill') {
    const { args, opts } = parse({ args: 1, options: { force: { type: 'boolean' } } }, 'kill', process.argv.slice(3));
    return print(killHolder(Number(args[0]), opts.force));
  }
  if (group === 'down') return print(down());
  if (group === 'react') {
    const reactions = loadReactions();
    await subscribe(databaseUrl(), reactor(reactions, execute));
    console.error(`Ganjine is following ${reactions.length} reactions`);
    return new Promise(() => {});
  }
  if (group === 'watch') {
    const { opts } = parse({ args: 0, options: { kind: str, tag: str } }, 'watch', process.argv.slice(3));
    await subscribe(databaseUrl(), (e) => {
      if ((!opts.kind || e.kind === opts.kind) && (!opts.tag || e.tags.includes(opts.tag))) console.log(JSON.stringify(e));
    });
    return new Promise(() => {});
  }
  if (group === 'version' || group === '--version') return print(await version());
  if (group === 'signer' && sub === 'start') return console.log(`Ganjine signer on ${await startSigner()}. Leave this running.`);
  if (group === 'ledger' && sub === 'anchor') {
    if (!ledger() || !existsSync(HEAD_PATH)) throw new GanjineError('no signer head yet');
    const { seq, hash, signature } = JSON.parse(await readFile(HEAD_PATH, 'utf8'));
    await writeFile(ANCHOR_PATH, `${JSON.stringify({ seq, hash, signature }, null, 2)}\n`);
    return print({ anchored: seq, file: ANCHOR_PATH });
  }
  if (group === 'run') return runAgent(process.argv.slice(3));
  if (group === 'runner') return runner(process.argv.slice(3));
  const name = `${group} ${sub}`;
  if (LOCAL[name]) return print(await LOCAL[name].run(parse(LOCAL[name], name, rest)));
  const command = COMMANDS[name];
  if (!command) {
    console.log(USAGE);
    process.exitCode = group && !['help', '--help', '-h'].includes(group) ? 1 : 0;
    return;
  }
  const parsed = parse(command, name, rest);
  const db = await connect();
  try {
    print(await command.run(db, parsed));
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(`ganjine: ${process.env.GANJINE_DEBUG && !(err instanceof GanjineError) ? err.stack : err.message}`);
  process.exitCode = 1;
});
