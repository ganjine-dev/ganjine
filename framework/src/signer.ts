import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname } from 'node:path';
import { GanjineError } from './db.ts';
import type { Entry, Head, SignRequest } from './ledger.ts';
import { entryHash, GENESIS, HEAD_PATH, headMessage, PUBLIC_KEY_PATH, socketPath } from './ledger.ts';

export const UNLOCK_PATH = new URL('../../.ganjine/bin/ganjine-unlock', import.meta.url).pathname;
const PKCS8_ED25519 = '302e020100300506032b657004220420';

/** Holds the key and the head. It signs only what extends the head, so it cannot rewrite history. */
export class Signer {
  private head: Head = GENESIS;
  private before: Head | null = null; // The head under the latest batch, in case its commit was lost.
  private readonly key: KeyObject;
  private readonly headPath: string;

  constructor(key: KeyObject, headPath: string) {
    this.key = key;
    this.headPath = headPath;
    if (existsSync(headPath)) {
      const saved = JSON.parse(readFileSync(headPath, 'utf8'));
      this.head = { seq: saved.seq, hash: saved.hash };
      this.before = saved.before ?? null;
    }
  }

  private save() {
    mkdirSync(dirname(this.headPath), { recursive: true });
    const signature = sign(null, Buffer.from(headMessage(this.head)), this.key).toString('base64');
    const temp = `${this.headPath}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...this.head, before: this.before, signature, at: new Date().toISOString() }));
    renameSync(temp, this.headPath);
  }

  sign({ base, records }: SignRequest): Entry[] {
    const same = (a: Head | null) => a !== null && a.seq === base?.seq && a.hash === base?.hash;
    if (!same(this.head) && !same(this.before)) throw new GanjineError(`head is ${this.head.seq}, asked to extend ${base?.seq}`);
    if (!Array.isArray(records) || !records.length || !records.every((r) => /^[0-9a-f]{64}$/.test(r))) throw new GanjineError('bad record hashes');
    const start = base;
    let { seq, hash } = base;
    const entries = records.map((record) => {
      const entry_hash = entryHash(seq + 1, hash, record);
      const entry = { seq: seq + 1, prev_hash: hash, entry_hash, signature: sign(null, Buffer.from(entry_hash), this.key).toString('base64') };
      seq = entry.seq;
      hash = entry_hash;
      return entry;
    });
    this.before = start;
    this.head = { seq, hash };
    this.save();
    return entries;
  }
}

/** Newline-terminated JSON, one request per connection, on a socket only this user can open. */
export async function listen(signer: Signer, path: string): Promise<Server> {
  rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((socket) => {
    let text = '';
    socket.on('error', () => {});
    socket.on('data', (d) => {
      text += d;
      if (!text.includes('\n')) return;
      let reply;
      try {
        reply = { entries: signer.sign(JSON.parse(text)) };
      } catch (err) {
        reply = { error: (err as Error).message };
      }
      socket.end(JSON.stringify(reply));
    });
  });
  const mask = process.umask(0o177);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
  process.umask(mask);
  chmodSync(path, 0o600);
  return server;
}

/** The key reaches the helper over stdin, never through arguments or the screen. */
export function initKey() {
  if (existsSync(PUBLIC_KEY_PATH)) throw new GanjineError(`${PUBLIC_KEY_PATH} already exists: the ledger has a key`);
  if (!existsSync(UNLOCK_PATH)) throw new GanjineError('run deploy/macos/install.sh first');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16).toString('hex');
  const added = spawnSync(UNLOCK_PATH, ['add'], { input: seed, encoding: 'utf8' });
  if (added.status !== 0) throw new GanjineError(`could not store the key: ${added.stderr}`);
  mkdirSync(dirname(PUBLIC_KEY_PATH), { recursive: true });
  writeFileSync(PUBLIC_KEY_PATH, publicKey.export({ format: 'pem', type: 'spki' }));
  return { public_key: PUBLIC_KEY_PATH };
}

export async function startSigner() {
  if (!existsSync(PUBLIC_KEY_PATH)) throw new GanjineError('no key yet. Run: ./ganjine signer init');
  const seed = spawnSync(UNLOCK_PATH, ['read'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (seed.status !== 0) throw new GanjineError('the key was not released');
  const key = createPrivateKey({ key: Buffer.from(PKCS8_ED25519 + seed.stdout.trim(), 'hex'), format: 'der', type: 'pkcs8' });
  const expected = readFileSync(PUBLIC_KEY_PATH, 'utf8');
  if (createPublicKey(key).export({ format: 'pem', type: 'spki' }) !== expected) throw new GanjineError(`the Keychain key does not match ${PUBLIC_KEY_PATH}`);
  const path = socketPath();
  await listen(new Signer(key, HEAD_PATH), path);
  return path;
}
