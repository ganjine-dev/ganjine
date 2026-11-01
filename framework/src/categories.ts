import type { Db } from './db.ts';
import { isUuid, tx, GanjineError } from './db.ts';
import { resolveItem } from './items.ts';
import { putRecord } from './records.ts';

interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  meta: unknown;
}

const all = async (db: Db): Promise<Category[]> => (await db.query('SELECT * FROM categories')).rows;

function pathsOf(categories: Category[]) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const path = (c: Category): string => {
    const parent = c.parent_id && byId.get(c.parent_id);
    return parent ? `${path(parent)}/${c.name}` : c.name;
  };
  return new Map(categories.map((c) => [c.id, path(c)]));
}

export const categoryPaths = async (db: Db) => pathsOf(await all(db));

/** Accepts an id or a slash path from a root, e.g. `markets/europe`. */
export async function resolveCategory(db: Db, ref: string) {
  const categories = await all(db);
  const paths = pathsOf(categories);
  const found = categories.find((c) => paths.get(c.id) === ref || (isUuid(ref) && c.id === ref));
  if (!found) throw new GanjineError(`category not found: ${ref}`);
  return { ...found, path: paths.get(found.id)! };
}

export async function createCategory(db: Db, name: string, parent?: string, meta: unknown = {}) {
  if (name.includes('/') || !name) throw new GanjineError(`invalid category name: ${name} (slashes separate paths)`);
  const parentId = parent ? (await resolveCategory(db, parent)).id : null;
  return tx(db, async () => {
    const { rows } = await db.query(
      `INSERT INTO categories (name, parent_id, meta) VALUES ($1, $2, $3)
       ON CONFLICT (parent_id, name) DO NOTHING RETURNING *`,
      [name, parentId, JSON.stringify(meta)],
    );
    if (!rows[0]) throw new GanjineError(`category already exists: ${parent ? `${parent}/` : ''}${name}`);
    await putRecord(db, { kind: 'category.created', payload: { id: rows[0].id, name, parent_id: parentId, meta } });
    return rows[0];
  });
}

export async function linkCategories(db: Db, from: string, to: string, kind: string) {
  const [a, b] = [await resolveCategory(db, from), await resolveCategory(db, to)];
  if (a.id === b.id) throw new GanjineError('a category cannot link to itself');
  return tx(db, async () => {
    const { rowCount } = await db.query(
      'INSERT INTO category_edges (from_id, to_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [a.id, b.id, kind],
    );
    if (rowCount) await putRecord(db, { kind: 'category.linked', payload: { from_id: a.id, to_id: b.id, kind } });
    return { from: a.path, to: b.path, kind };
  });
}

export async function attachItem(db: Db, itemRef: string, categoryRef: string) {
  const [item, category] = [await resolveItem(db, itemRef), await resolveCategory(db, categoryRef)];
  return tx(db, async () => {
    const { rowCount } = await db.query(
      'INSERT INTO item_categories (item_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [item.id, category.id],
    );
    if (rowCount) await putRecord(db, { kind: 'category.attached', itemId: item.id, payload: { category_id: category.id } });
    return { item: item.name, category: category.path };
  });
}

export async function listCategories(db: Db) {
  const categories = await all(db);
  const paths = pathsOf(categories);
  return categories.map((c) => ({ ...c, path: paths.get(c.id)! })).sort((a, b) => a.path.localeCompare(b.path));
}

export async function categoryTree(db: Db) {
  const categories = await all(db);
  const paths = pathsOf(categories);
  const edges = (await db.query('SELECT * FROM category_edges ORDER BY kind')).rows;
  const items = (await db.query(
    'SELECT ic.category_id, i.name FROM item_categories ic JOIN items i ON i.id = ic.item_id ORDER BY i.name',
  )).rows;
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    const pad = '  '.repeat(depth);
    for (const c of categories.filter((x) => x.parent_id === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(pad + c.name);
      for (const e of edges.filter((x) => x.from_id === c.id)) lines.push(`${pad}  -[${e.kind}]-> ${paths.get(e.to_id)}`);
      for (const i of items.filter((x) => x.category_id === c.id)) lines.push(`${pad}  * ${i.name}`);
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}
