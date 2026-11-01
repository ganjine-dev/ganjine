import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskBlobStore } from '../src/blobs.ts';
import { connect, migrate } from '../src/db.ts';
import { setLedger } from '../src/ledger.ts';

// Off unless a test turns it on: `ledger.test.ts` tests the chain itself.
setLedger(null);

const ADMIN = process.env.GANJINE_DATABASE_URL ?? 'postgres://ganjine:ganjine@localhost:5434/ganjine';

/** A throwaway migrated database. The ganjine tables are append-only, so tests never clean up inside one. */
export async function testDb() {
  const name = `ganjine_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await connect(ADMIN);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN);
  url.pathname = `/${name}`;
  const db = await connect(url.href);
  await migrate(db);
  return {
    url: url.href,
    db,
    store: new LocalDiskBlobStore(await mkdtemp(join(tmpdir(), 'ganjine-blobs-'))),
    async close() {
      await db.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    },
  };
}

export const page = (overrides: Record<string, unknown> = {}) => ({
  contract_version: 1,
  address: '/items/acme/overview',
  as_of: '2026-10-01',
  produced_by: { agent: 'test' },
  inputs_used: [],
  summary: 'a version',
  blocks: [{ kind: 'markdown', text: 'hello' }],
  ...overrides,
});
