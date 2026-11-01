import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { connect, GanjineError } from './db.ts';
import { PUBLIC_KEY_PATH, socketPath } from './ledger.ts';
import { initKey, UNLOCK_PATH } from './signer.ts';
import { DEFAULT_PORT, holders, UP_FILE, upState } from './status.ts';

const root = new URL('../../', import.meta.url).pathname;
const ganjine = `${root}ganjine`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signerUp = () => new Promise<boolean>((resolve) => {
  const s = netConnect(socketPath());
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

function step(command: string, args: string[]) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new GanjineError(`${command} ${args.join(' ')} failed`);
  return r.stdout;
}

async function waitFor(check: () => Promise<boolean>, what: string, seconds: number, child: ChildProcess) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await check()) return;
    if (child.exitCode !== null) throw new GanjineError(`${what} did not start`);
    await pause(250);
  }
  throw new GanjineError(`${what} did not start in ${seconds}s`);
}

async function ledgerEntries() {
  const db = await connect();
  try {
    return (await db.query('SELECT count(*)::int AS n FROM ledger')).rows[0].n;
  } finally {
    await db.end();
  }
}

export async function up({ port = DEFAULT_PORT, open = true }: { port?: number; open?: boolean } = {}) {
  const show = (url: string) => { if (open) spawnSync('open', [url]); };
  const running = upState();
  if (running) {
    show(`http://127.0.0.1:${running.port}`);
    return;
  }
  process.env.GANJINE_PORT = String(port);
  const taken = holders().find((h) => h.role === 'Dashboard port');
  if (taken) throw new GanjineError(`port ${port} is held by pid ${taken.pid} (${taken.command}). See ./ganjine status`);
  if (!existsSync(UNLOCK_PATH)) throw new GanjineError('run deploy/macos/install.sh first');
  step('docker', ['compose', '-f', 'deploy/docker-compose.yml', 'up', '-d', '--wait']);
  step(ganjine, ['db', 'migrate']);
  if (!existsSync(PUBLIC_KEY_PATH)) initKey();

  const url = `http://127.0.0.1:${port}`;
  const faceUp = () => fetch(`${url}/items`).then((r) => r.ok, () => false);
  const children: ChildProcess[] = [];
  const stop = () => {
    children.forEach((c) => c.kill());
    rmSync(UP_FILE, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const start = (args: string[]) => {
    const child = spawn(ganjine, args, { cwd: root, stdio: 'inherit' });
    children.push(child);
    return child;
  };
  writeFileSync(UP_FILE, JSON.stringify({ pid: process.pid, port }));
  try {
    // A signer left by a crashed run keeps its key, so it needs no second prompt.
    if (!(await signerUp())) await waitFor(signerUp, 'the signer', 90, start(['signer', 'start']));
    if (!(await ledgerEntries())) {
      step(ganjine, ['ledger', 'seal-existing']);
      step(ganjine, ['ledger', 'anchor']);
    }
    await waitFor(faceUp, 'the face', 20, start(['serve', '--port', String(port)]));
  } catch (err) {
    children.forEach((c) => c.kill());
    rmSync(UP_FILE, { force: true });
    throw err;
  }
  children.forEach((c) => c.on('exit', () => stop()));
  show(url);
  console.log(`Ganjine is up on ${url}. Stop it with: ./ganjine down`);
  await new Promise(() => {});
}

export function down() {
  const running = upState();
  if (!running) return 'Ganjine is not running';
  process.kill(running.pid, 'SIGTERM');
  return 'Ganjine stopped';
}
