import type { BlobStore } from './blobs.ts';
import { blobRefs, checkContent, recordRefs } from './contract.ts';
import type { Db } from './db.ts';
import { isUuid, tx, GanjineError } from './db.ts';
import { parseDate } from './dates.ts';
import { resolveItem } from './items.ts';
import { authentic, requireAuthentic } from './ledger.ts';
import { putRecord } from './records.ts';

const VERSION = 'id, address, as_of::text, created_at, run_id, content';

async function checkRefs(db: Db, ids: string[], runId: string | undefined, blobs: string[], store: BlobStore) {
  const { rows } = await db.query('SELECT id::text FROM records WHERE id::text = ANY($1)', [ids]);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new GanjineError(`records not found: ${missing.join(', ')}`);
  if (runId && !(await db.query('SELECT 1 FROM runs WHERE id::text = $1', [runId])).rowCount) {
    throw new GanjineError(`run not found: ${runId}`);
  }
  for (const ref of blobs) if (!(await store.exists(ref))) throw new GanjineError(`blob not found: ${ref}`);
}

/** What a draft and a page both have to pass. */
export async function checkPage(db: Db, content: unknown, store: BlobStore) {
  const page = checkContent(content);
  await checkRefs(db, recordRefs(page), page.produced_by.run_id, blobRefs(page), store);
  return page;
}

export async function latestVersion(db: Db, address: string): Promise<{ id: string; agent: string } | null> {
  const { rows } = await db.query(
    `SELECT v.id, v.content->'produced_by'->>'agent' AS agent FROM pages p JOIN page_versions v ON v.id = p.latest_version_id WHERE p.address = $1`, [address]);
  return rows[0] ?? null;
}

export type Write = { base?: string | null; session?: string };

/** Who may write over what is there. Cooperation, not security: see `docs/adr/0009-drafts-and-page-ownership.md`. */
async function checkOwnership(db: Db, address: string, agent: string, { base, session }: Write) {
  const held = (await db.query('SELECT session FROM page_drafts WHERE address = $1', [address])).rows[0];
  if (held && held.session !== session) throw new GanjineError(`${address} is held by session ${held.session}`);
  const latest = await latestVersion(db, address);
  if (base !== undefined && base !== (latest?.id ?? null)) {
    throw new GanjineError(`${address} has moved on: built on ${base ?? 'nothing'}, latest is ${latest?.id ?? 'nothing'}. Read it, merge, and try again`);
  }
  if (base === undefined && latest && latest.agent !== agent) {
    throw new GanjineError(`${address} was last written by ${latest.agent}. Read it, then write with base ${latest.id}`);
  }
}

export async function putPage(db: Db, content: unknown, store: BlobStore, write: Write = {}) {
  const page = await checkPage(db, content, store);
  const runId = page.produced_by.run_id;
  const itemName = /^\/items\/([^/]+)/.exec(page.address)?.[1];
  const item = itemName ? await resolveItem(db, itemName) : null;

  return tx(db, async () => {
    await db.query('INSERT INTO pages (address, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [page.address, item?.id ?? null]);
    await db.query('SELECT 1 FROM pages WHERE address = $1 FOR UPDATE', [page.address]);
    await checkOwnership(db, page.address, page.produced_by.agent, write);
    const record = await putRecord(db, {
      kind: 'page_version',
      itemId: item?.id,
      runId,
      payload: { address: page.address, content: page },
    });
    const { rows } = await db.query(
      `INSERT INTO page_versions (id, address, as_of, created_at, run_id, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${VERSION}`,
      [record.id, page.address, page.as_of, record.created_at, runId ?? null, JSON.stringify(page)],
    );
    // Latest means the newest data date, so a backfill does not displace current content.
    await db.query(
      `UPDATE pages p SET latest_version_id = n.id FROM page_versions n
       WHERE n.id = $1 AND p.address = n.address AND (p.latest_version_id IS NULL
         OR ROW(n.as_of, n.created_at) >= (SELECT as_of, created_at FROM page_versions WHERE id = p.latest_version_id))`,
      [record.id],
    );
    return rows[0];
  });
}

const checked = async <T extends { id: string }>(db: Db, version: T) => {
  await requireAuthentic(db, version.id);
  return version;
};

/** Without asOf, the latest pointer. With asOf, the newest version whose data date is on or before it. */
export async function getPage(db: Db, address: string, asOf?: string) {
  const page = (await db.query('SELECT latest_version_id FROM pages WHERE address = $1', [address])).rows[0];
  if (!page) throw new GanjineError(`page not found: ${address}`);
  if (!asOf) return checked(db, (await db.query(`SELECT ${VERSION} FROM page_versions WHERE id = $1`, [page.latest_version_id])).rows[0]);
  const { rows } = await db.query(
    `SELECT ${VERSION} FROM page_versions WHERE address = $1 AND as_of <= $2
     ORDER BY as_of DESC, created_at DESC LIMIT 1`,
    [address, parseDate(asOf)],
  );
  if (!rows[0]) throw new GanjineError(`page has no version as of ${asOf}: ${address}`);
  return checked(db, rows[0]);
}

export async function getVersion(db: Db, address: string, id: string) {
  const { rows } = isUuid(id)
    ? await db.query(`SELECT ${VERSION} FROM page_versions WHERE address = $1 AND id = $2`, [address, id])
    : { rows: [] };
  if (!rows[0]) throw new GanjineError(`page version not found: ${id}`);
  return checked(db, rows[0]);
}

export async function pageHistory(db: Db, address: string) {
  const page = (await db.query('SELECT latest_version_id FROM pages WHERE address = $1', [address])).rows[0];
  if (!page) throw new GanjineError(`page not found: ${address}`);
  const { rows } = await db.query(
    `SELECT id, as_of::text, created_at, run_id, content->>'summary' AS summary FROM page_versions
     WHERE address = $1 ORDER BY as_of DESC, created_at DESC`,
    [address],
  );
  return (await authentic(db, rows)).map((r) => ({ ...r, latest: r.id === page.latest_version_id }));
}
