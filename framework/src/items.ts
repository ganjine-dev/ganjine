import type { Db } from './db.ts';
import { isUuid, tx, GanjineError } from './db.ts';
import { categoryPaths } from './categories.ts';
import { putRecord } from './records.ts';

export async function createItem(db: Db, name: string, meta: unknown = {}) {
  if (!/^[^\s/]+$/.test(name)) throw new GanjineError(`invalid item name: ${name} (no spaces or slashes; it appears in addresses)`);
  return tx(db, async () => {
    const { rows } = await db.query(
      'INSERT INTO items (name, meta) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING *',
      [name, JSON.stringify(meta)],
    );
    if (!rows[0]) throw new GanjineError(`item already exists: ${name}`);
    await putRecord(db, { kind: 'item.created', itemId: rows[0].id, payload: { name, meta } });
    return rows[0];
  });
}

export const listItems = async (db: Db) => (await db.query('SELECT * FROM items ORDER BY name')).rows;

export async function resolveItem(db: Db, ref: string) {
  const { rows } = await db.query(`SELECT * FROM items WHERE name = $1 ${isUuid(ref) ? 'OR id = $1::uuid' : ''}`, [ref]);
  if (!rows[0]) throw new GanjineError(`item not found: ${ref}`);
  return rows[0];
}

export async function showItem(db: Db, ref: string) {
  const item = await resolveItem(db, ref);
  const paths = await categoryPaths(db);
  const categories = (await db.query('SELECT category_id FROM item_categories WHERE item_id = $1', [item.id])).rows
    .map((r) => paths.get(r.category_id)!)
    .sort();
  const pages = (await db.query('SELECT address FROM pages WHERE item_id = $1 ORDER BY address', [item.id])).rows.map((r) => r.address);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM records WHERE item_id = $1', [item.id]);
  return { ...item, categories, pages, record_count: rows[0].n };
}
