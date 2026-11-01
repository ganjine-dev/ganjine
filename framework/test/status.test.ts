import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { freePort, holders, killHolder, status } from '../src/status.ts';
import { upState } from '../src/status.ts';
import { up } from '../src/up.ts';

const port = freePort(4700);
let child: ReturnType<typeof spawn>;

before(async () => {
  process.env.GANJINE_PORT = String(port);
  child = spawn('node', ['-e', `require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !holders().some((h) => h.pid === child.pid); i++) await new Promise((r) => setTimeout(r, 100));
});
after(() => { child.kill('SIGKILL'); });

describe('a busy dashboard port', () => {
  it('is read, not assumed to be Ganjine', async () => {
    const s = await status();
    const h = s.holders.find((x) => x.pid === child.pid)!;
    assert.equal(h.ours, false);
    assert.match(h.command, /createServer/);
    assert.ok(h.user && h.started);
    assert.equal(s.services.find((x) => x.name === 'Dashboard')!.ok, false);
    assert.ok(s.issues.some((i) => i.title === `Port ${port} is taken` && i.check.length));
    assert.equal(s.state === 'running', false);
  });
  it('stops up before it touches anything', { skip: upState() ? 'Ganjine is running here' : false }, async () => {
    await assert.rejects(up({ port, open: false }), new RegExp(`port ${port} is held by pid ${child.pid}`));
  });
  it('offers the next free port', () => {
    assert.equal(freePort(port), port + 1);
  });
});

describe('ganjine kill', () => {
  it('refuses a process that holds nothing of Ganjine', () => {
    assert.throws(() => killHolder(process.pid), /refused/);
  });
  it('refuses the container runtime', () => {
    const runtime = holders().find((h) => h.protected);
    if (runtime) assert.throws(() => killHolder(runtime.pid), /container runtime/);
  });
  it('stops a process it has just read as the holder', async () => {
    assert.equal(killHolder(child.pid!).signal, 'SIGTERM');
    for (let i = 0; i < 40 && holders().some((h) => h.pid === child.pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(holders().some((h) => h.pid === child.pid), false);
  });
});
