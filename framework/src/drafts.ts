import type { BlobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { tx, GanjineError } from './db.ts';
import { checkPage, latestVersion, putPage } from './pages.ts';
import { requireOpen } from './sessions.ts';

/** Work in progress, outside the chain. Why: `docs/adr/0009-drafts-and-page-ownership.md`. */

const COLUMNS = 'address, session, base_version_id, content, updated_at';

export async function getDraft(db: Db, address: string) {
  return (await db.query(`SELECT ${COLUMNS} FROM page_drafts WHERE address = $1`, [address])).rows[0] ?? null;
}

export async function listDrafts(db: Db, session?: string) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM page_drafts WHERE $1::text IS NULL OR session = $1 ORDER BY updated_at`, [session ?? null]);
  return rows;
}

const heldBy = (address: string, session: string) => new GanjineError(`${address} is held by session ${session}`);

export async function putDraft(db: Db, content: unknown, session: string, store: BlobStore, base?: string) {
  const page = await checkPage(db, content, store);
  await requireOpen(db, session);
  return tx(db, async () => {
    const held = await getDraft(db, page.address);
    if (held && held.session !== session) throw heldBy(page.address, held.session);
    const opened = base ?? held?.base_version_id ?? (await latestVersion(db, page.address))?.id ?? null;
    const { rows, rowCount } = await db.query(
      `INSERT INTO page_drafts (address, session, base_version_id, content) VALUES ($1, $2, $3, $4)
       ON CONFLICT (address) DO UPDATE SET base_version_id = $3, content = $4, updated_at = now()
       WHERE page_drafts.session = $2 RETURNING ${COLUMNS}`,
      [page.address, session, opened, JSON.stringify(page)],
    );
    if (!rowCount) throw new GanjineError(`${page.address} was just taken by another session`);
    return rows[0];
  });
}

/** Signs the draft as one version and removes it, so the steps before it leave no trace. */
export async function finalizeDraft(db: Db, address: string, session: string, store: BlobStore) {
  return tx(db, async () => {
    const { rows: [draft] } = await db.query(`SELECT ${COLUMNS} FROM page_drafts WHERE address = $1 FOR UPDATE`, [address]);
    if (!draft) throw new GanjineError(`no draft of ${address}`);
    if (draft.session !== session) throw heldBy(address, draft.session);
    const version = await putPage(db, draft.content, store, { base: draft.base_version_id, session });
    await db.query('DELETE FROM page_drafts WHERE address = $1', [address]);
    return version;
  });
}

/** Without a session this is the operator freeing a hold, and the draft is lost. */
export async function discardDraft(db: Db, address: string, session?: string) {
  const draft = await getDraft(db, address);
  if (!draft) throw new GanjineError(`no draft of ${address}`);
  if (session && draft.session !== session) throw heldBy(address, draft.session);
  await db.query('DELETE FROM page_drafts WHERE address = $1', [address]);
  return { discarded: address, session: draft.session };
}
