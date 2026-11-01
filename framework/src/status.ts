import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { connect, databaseUrl, GanjineError } from './db.ts';
import { PUBLIC_KEY_PATH, socketPath } from './ledger.ts';

const root = new URL('../../', import.meta.url).pathname;
export const UP_FILE = `${root}.ganjine/up.json`;
export const LOG_FILE = `${root}.ganjine/up.log`;
const UNLOCK = `${root}.ganjine/bin/ganjine-unlock`;
export const DEFAULT_PORT = 4400;
const PG_PORT = () => Number(new URL(databaseUrl()).port || 5432);

export type Holder = { pid: number; role: string; port: number | null; command: string; user: string; started: string; cwd: string; ours: boolean; protected: boolean };

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout ?? '';

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function upState(): { pid: number; port: number } | null {
  if (!existsSync(UP_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(UP_FILE, 'utf8'));
    return alive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

export const facePort = () => Number(process.env.GANJINE_PORT) || upState()?.port || DEFAULT_PORT;

function describe(pid: number, role: string, port: number | null): Holder {
  const [user = '', ...rest] = run('ps', ['-o', 'user=,lstart=,command=', '-p', String(pid)]).trim().split(/\s+/);
  const started = rest.slice(0, 5).join(' ');
  const command = rest.slice(5).join(' ');
  const cwd = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
  const ours = command.includes('framework/src/cli.ts') && (command.includes(root) || cwd.startsWith(root.slice(0, -1)));
  return { pid, role, port, command, user, started, cwd, ours, protected: /orbstack|docker/i.test(command) };
}

const pids = (text: string) => [...new Set(text.split('\n').filter(Boolean).map(Number))];
const onPort = (port: number) => pids(run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));

export function holders() {
  const port = facePort();
  const signer = existsSync(socketPath()) ? pids(run('lsof', ['-t', socketPath()])) : [];
  return [
    ...onPort(port).map((p) => describe(p, 'Dashboard port', port)),
    ...onPort(PG_PORT()).map((p) => describe(p, 'Database port', PG_PORT())),
    ...signer.filter((p) => p !== process.pid).map((p) => describe(p, 'Signer', null)),
  ];
}

const signerUp = () => new Promise<boolean>((resolve) => {
  const s = netConnect(socketPath());
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

/** Only a process just read as holding Ganjine's ports or socket, and never the container runtime. */
export function killHolder(pid: number, force = false) {
  const h = holders().find((x) => x.pid === pid);
  if (!h) throw new GanjineError(`pid ${pid} does not hold a Ganjine port or the signer socket: refused`);
  if (h.protected) throw new GanjineError(`pid ${pid} is the container runtime (${h.command}): stop it there, not here`);
  process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  return { pid, signal: force ? 'SIGKILL' : 'SIGTERM', command: h.command };
}

async function numbers() {
  const db = await connect().catch(() => null);
  if (!db) return null;
  try {
    const n = async (sql: string) => (await db.query(sql)).rows[0];
    // A new install reaches this before its first migration.
    if (!(await n(`SELECT to_regclass('health') IS NOT NULL AS yes`)).yes) return { records: 0, pages: 0, items: 0, sessions: 0, sealed: 0, last_commit: null, ledger: null, ledger_error: null };
    const has = (await n(`SELECT to_regclass('ledger') IS NOT NULL AS yes`)).yes;
    const { rows: health } = await db.query(`SELECT status, last_error FROM health WHERE component = 'ledger'`);
    return {
      records: (await n('SELECT count(*)::int AS n FROM records')).n,
      pages: (await n('SELECT count(*)::int AS n FROM pages')).n,
      items: (await n('SELECT count(*)::int AS n FROM items')).n,
      sessions: (await n(`SELECT count(*)::int AS n FROM records WHERE kind = 'session.started'`)).n,
      sealed: has ? (await n('SELECT count(*)::int AS n FROM ledger')).n : 0,
      last_commit: (await n('SELECT max(created_at) AS at FROM records')).at,
      ledger: health[0]?.status ?? null,
      ledger_error: health[0]?.last_error ?? null,
    };
  } finally {
    await db.end();
  }
}

export async function status() {
  const port = facePort();
  const up = upState();
  const held = holders();
  const signer = await signerUp();
  const n = await numbers();
  const web = held.filter((h) => h.role === 'Dashboard port');
  const foreign = web.filter((h) => !h.ours || !up);
  const face = web.length > 0 && foreign.length === 0;
  const issues: { title: string; why: string; check: string[]; fix: string[] }[] = [];
  if (!n) {
    issues.push({
      title: 'The database is not reachable',
      why: `Nothing answered as Postgres on port ${PG_PORT()}. OrbStack or Docker may be stopped.`,
      check: ['docker context show', 'docker compose -f deploy/docker-compose.yml ps', `lsof -nP -iTCP:${PG_PORT()} -sTCP:LISTEN`],
      fix: ['docker compose -f deploy/docker-compose.yml up -d'],
    });
  }
  if (!existsSync(UNLOCK)) issues.push({ title: 'The unlock helper is missing', why: 'Ganjine cannot ask for Touch ID without it.', check: [`ls -l ${UNLOCK}`], fix: ['deploy/macos/install.sh'] });
  for (const h of foreign) {
    issues.push({
      title: `Port ${h.port} is taken`,
      why: h.ours ? 'A dashboard from an earlier run is still there, with no Ganjine managing it.' : 'Another program is using the dashboard port.',
      check: [`lsof -nP -iTCP:${h.port} -sTCP:LISTEN`, `ps -o pid,user,lstart,command -p ${h.pid}`],
      fix: [],
    });
  }
  if (up && !signer) issues.push({ title: 'The signer is down', why: 'Commits are refused until it returns.', check: ['tail -20 .ganjine/up.log'], fix: ['./ganjine down', './ganjine up'] });
  if (n?.ledger === 'failed') issues.push({ title: 'The ledger failed verification', why: n.ledger_error ?? 'A record does not match its signature.', check: ['./ganjine ledger verify'], fix: [] });
  const running = Boolean(up && signer && face);
  const state = running ? (n?.ledger === 'failed' ? 'alarm' : 'running') : up ? 'starting' : issues.length ? 'blocked' : 'stopped';
  const log = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-12) : [];
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    port,
    keyed: existsSync(PUBLIC_KEY_PATH),
    services: [
      { name: 'Database', ok: Boolean(n), detail: n ? `port ${PG_PORT()}` : 'not reachable' },
      { name: 'Signer', ok: signer, detail: signer ? 'key unlocked' : 'locked' },
      { name: 'Dashboard', ok: face, detail: face ? `port ${port}` : foreign.length ? 'port taken' : 'stopped' },
      { name: 'Ledger', ok: n?.ledger === 'ok', detail: n?.ledger === 'ok' ? (face ? 'verified' : 'passed last check') : n?.ledger === 'failed' ? 'failed' : existsSync(PUBLIC_KEY_PATH) ? 'not checked yet' : 'no key yet' },
    ],
    numbers: n,
    holders: held,
    issues,
    log,
  };
}

/** The next port with no listener, for starting beside something the operator wants to keep. */
export function freePort(from = DEFAULT_PORT + 1) {
  for (let p = from; p < from + 50; p++) if (!onPort(p).length) return p;
  throw new GanjineError('no free port found');
}
