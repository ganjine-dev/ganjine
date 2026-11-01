import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { BlobStore } from '../blobs.ts';
import { blobStore } from '../blobs.ts';
import { categoryPaths } from '../categories.ts';
import type { Db } from '../db.ts';
import { databaseUrl, GanjineError } from '../db.ts';
import { resolveItem, showItem } from '../items.ts';
import { authentic, rejected, verifyChain } from '../ledger.ts';
import { getPage, getVersion, pageHistory } from '../pages.ts';
import { getSession, listSessions } from '../sessions.ts';
import { getDraft } from '../drafts.ts';
import { renderBlocks } from './blocks.ts';
import { subscribe, type GanjineEvent } from '../events.ts';
import { html, layout, pageHref, Raw, when } from './html.ts';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // Vega sets inline styles.
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-src 'self'",
  "form-action 'self'",
  "connect-src 'self'", // The live stream, its own origin only.
  "base-uri 'none'",
].join('; ');

// An embed is client-side only: no network, opaque origin.
const EMBED_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox allow-scripts";

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

const file = (spec: string) => new URL(spec, import.meta.url);
const ASSETS: Record<string, [URL, string]> = {
  'face.css': [file('../../public/face.css'), 'text/css'],
  'face.js': [file('../../public/face.js'), 'text/javascript'],
  'inter.woff2': [file('../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'), 'font/woff2'],
  'vazirmatn.woff2': [file('../../node_modules/vazirmatn/fonts/webfonts/Vazirmatn%5Bwght%5D.woff2'), 'font/woff2'],
  'vega.js': [file('../../node_modules/vega/build/vega.min.js'), 'text/javascript'],
  'vega-lite.js': [file('../../node_modules/vega-lite/build/vega-lite.min.js'), 'text/javascript'],
  'vega-embed.js': [file('../../node_modules/vega-embed/build/vega-embed.min.js'), 'text/javascript'],
};

class NotFound extends Error {}

const streams = new Set<ServerResponse>();
/** Re-serialized from known fields, so nothing from the database can shape the stream. */
export const broadcast = (e: GanjineEvent) => {
  for (const res of streams) res.write(`data: ${JSON.stringify(e)}\n\n`);
};

type Ctx = { db: Db; store: BlobStore; url: URL };
type View = { title: string; section: string; body: Raw; charts?: boolean; status?: number; watch?: string };

const empty = (text: string) => html`<p class="empty">${text}</p>`;

const pageSql = `SELECT v.id, p.address, p.item_id, v.as_of::text, v.created_at, v.content->>'summary' AS summary, v.content->'blocks' AS blocks
  FROM pages p JOIN page_versions v ON v.id = p.latest_version_id`;

const titleOf = (address: string) => {
  const last = address.split('/').filter(Boolean).at(-1) ?? 'home';
  return last.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
};

/** The first summary block of a page, whatever the page is about. */
const tiles = (blocks: any[], count: number) => {
  // A row the contract never checked must cost its own card, not the whole list.
  const kv = Array.isArray(blocks) ? blocks.find((b) => b?.kind === 'kv')?.items : null;
  const items = (Array.isArray(kv) ? kv : []).filter(Boolean).slice(0, count);
  return items.length ? html`<dl class="mini">${items.map((i: any) => html`<div><dt>${i.key}</dt><dd>${i.value}${i.unit && html` <small>${i.unit}</small>`}</dd></div>`)}</dl>` : '';
};
const chips = (values: string[]) => (values.length ? html`<ul class="chips">${values.map((v) => html`<li>${v}</li>`)}</ul>` : '');

async function itemsView({ db }: Ctx): Promise<View> {
  const paths = await categoryPaths(db);
  const { rows: items } = await db.query(`SELECT i.id, i.name,
      ARRAY(SELECT category_id::text FROM item_categories c WHERE c.item_id = i.id) AS categories
    FROM items i ORDER BY i.name`);
  const pages = await authentic(db, (await db.query(`${pageSql} WHERE p.item_id IS NOT NULL ORDER BY v.created_at DESC`)).rows);
  const groups = new Map<string, Raw[]>();
  for (const item of items) {
    const cats = item.categories.map((c: string) => paths.get(c)!).sort();
    const own = pages.filter((p) => p.item_id === item.id);
    const lead = own.find((p) => p.address.endsWith('/overview')) ?? own[0];
    const group = cats[0]?.split('/')[0] ?? 'Uncategorized';
    const card = html`<a class="card" href="/items/${encodeURIComponent(item.name)}">
      <h3>${item.name}</h3>
      ${chips(cats)}
      ${lead ? html`<p class="card-summary">${lead.summary}</p>${tiles(lead.blocks, 3)}
        <p class="card-foot">${own.length} ${own.length === 1 ? 'page' : 'pages'} · as of ${lead.as_of}</p>`
    : html`<p class="card-empty">Nothing written yet</p>`}
    </a>`;
    groups.set(group, [...(groups.get(group) ?? []), card]);
  }
  return {
    title: 'Items',
    section: 'Items',
    body: html`<h1>Items</h1>
    <p class="meta">${items.length} tracked</p>
    ${items.length ? [...groups].sort().map(([name, cards]) => html`<h2 class="group">${name.replace(/^./, (c) => c.toUpperCase())}</h2><div class="cards">${cards}</div>`)
    : empty('No items yet. Create one with: ganjine item create <name>')}`,
  };
}

async function itemView({ db }: Ctx, name: string): Promise<View> {
  await resolveItem(db, name).catch(() => { throw new NotFound(); });
  const item = await showItem(db, name);
  const pages = await authentic(db, (await db.query(`${pageSql} WHERE p.item_id = $1 ORDER BY p.address LIKE '%/overview' DESC, p.address`, [item.id])).rows);
  const { rows: kinds } = await db.query(
    `SELECT kind, count(*)::int AS n, max(created_at) AS last FROM records WHERE item_id = $1 GROUP BY kind ORDER BY last DESC`, [item.id]);
  const last = kinds[0]?.last;
  return {
    title: item.name,
    section: 'Items',
    body: html`<div class="page-head"><div>
      <p class="address"><a href="/items">Items</a> /</p>
      <h1>${item.name}</h1>
      ${chips(item.categories)}
    </div></div>
    <dl class="kv item-stats">
      <div><dt>Pages</dt><dd>${pages.length}</dd></div>
      <div><dt>Records</dt><dd>${item.record_count}</dd></div>
      <div><dt>Last activity</dt><dd class="small">${when(last)}</dd></div>
    </dl>
    <h2 class="group">Pages</h2>
    ${pages.length ? html`<div class="cards">${pages.map((p) => html`<a class="card" href="${pageHref(p.address)}">
      <h3>${titleOf(p.address)}</h3>
      <p class="card-summary">${p.summary}</p>
      ${tiles(p.blocks, 3)}
      <p class="card-foot">as of ${p.as_of} · ${p.blocks?.length ?? 0} blocks</p>
    </a>`)}</div>` : empty('No pages yet. An agent writes these.')}
    <h2 class="group">What is stored</h2>
    ${kinds.length ? html`<div class="stored">${kinds.map((k) => html`<div><strong>${k.n}</strong><code>${k.kind}</code><small>${when(k.last)}</small></div>`)}</div>` : empty('No records yet.')}`,
  };
}

async function categoriesView({ db }: Ctx): Promise<View> {
  const paths = await categoryPaths(db);
  const { rows: categories } = await db.query('SELECT id, name, parent_id FROM categories ORDER BY name');
  const { rows: edges } = await db.query('SELECT * FROM category_edges ORDER BY kind');
  const { rows: joined } = await db.query(`SELECT c.category_id, i.name, v.id, v.content->>'summary' AS summary
    FROM item_categories c JOIN items i ON i.id = c.item_id
    LEFT JOIN pages p ON p.address = '/items/' || i.name || '/overview'
    LEFT JOIN page_versions v ON v.id = p.latest_version_id ORDER BY i.name`);
  const bad = await rejected(db, joined.map((m) => m.id).filter(Boolean));
  const members = joined.map((m) => (bad.has(m.id) ? { ...m, summary: null } : m));
  const contents = (id: string): Raw => {
    const links = edges.filter((e) => e.from_id === id || e.to_id === id);
    const items = members.filter((m) => m.category_id === id);
    const children = categories.filter((c) => c.parent_id === id);
    return html`
      ${links.length > 0 && html`<ul class="links">${links.map((e) => html`<li>${e.from_id === id ? html`${e.kind.replace(/-/g, ' ')} → ${paths.get(e.to_id)}` : html`← ${paths.get(e.from_id)} ${e.kind.replace(/-/g, ' ')}`}</li>`)}</ul>`}
      ${items.map((m) => html`<a class="member" href="/items/${encodeURIComponent(m.name)}"><strong>${m.name}</strong>${m.summary && html`<small>${m.summary}</small>`}</a>`)}
      ${children.map((c) => html`<section class="sub"><h4>${c.name}</h4>${contents(c.id)}</section>`)}`;
  };
  const count = (id: string): number => members.filter((m) => m.category_id === id).length
    + categories.filter((c) => c.parent_id === id).reduce((n, c) => n + count(c.id), 0);
  const roots = categories.filter((c) => !c.parent_id);
  return {
    title: 'Categories',
    section: 'Categories',
    body: html`<h1>Categories</h1>
    <p class="meta">${categories.length} categories, ${edges.length} ${edges.length === 1 ? 'link' : 'links'}</p>
    ${roots.length ? html`<div class="cards cats">${roots.map((c) => html`<section class="card cat">
      <h3>${c.name.replace(/^./, (x: string) => x.toUpperCase())}</h3>
      <p class="card-summary">${count(c.id)} ${count(c.id) === 1 ? 'item' : 'items'}</p>
      ${contents(c.id)}
    </section>`)}</div>` : empty('No categories yet. Create one with: ganjine category create <name>')}`,
  };
}

async function sessionsView({ db }: Ctx): Promise<View> {
  const sessions = await listSessions(db);
  return {
    title: 'Sessions',
    section: 'Sessions',
    body: html`<h1>Sessions</h1>
    <p class="meta">${sessions.length} so far</p>
    ${sessions.length ? html`<div class="cards">${sessions.map((x) => html`<a class="card" href="/sessions/${x.id}">
      <h3>${x.title}</h3>
      <ul class="chips"><li class="${x.status}">${x.status}</li></ul>
      ${x.conclusion && html`<p class="card-summary">${x.conclusion}</p>`}
      <p class="card-foot">${x.pages} pages · ${x.notes} notes · ${x.data} data · ${when(x.started_at)}</p>
    </a>`)}</div>` : empty('No sessions yet. Open Claude Code in this repo and run /analyze with a question.')}`,
  };
}

async function sessionView({ db, store }: Ctx, id: string): Promise<View> {
  const s = await getSession(db, id).catch((err) => {
    if (err instanceof GanjineError) throw new NotFound();
    throw err;
  });
  const stream = [
    ...s.notes.map((n) => ({ at: +new Date(n.at), body: html`<div class="note ${n.kind}"><small>${n.kind}</small>${n.text}</div>` })),
    ...await Promise.all(s.pages.map(async (p) => ({
      at: +new Date(p.first_at),
      body: html`<section class="answer"><h2><a href="${pageHref(p.address)}">${p.content.summary}</a></h2>
        <div class="blocks">${await renderBlocks(p.content, { db, store })}</div></section>`,
    }))),
    ...await Promise.all(s.drafts.map(async (d) => ({
      at: +new Date(d.updated_at),
      body: html`<section class="answer draft"><p class="notice">Draft. Not signed yet, and it may change.</p><h2><a href="/drafts${d.address}">${d.content.summary}</a></h2>
        <div class="blocks">${await renderBlocks(d.content, { db, store })}</div></section>`,
    }))),
  ].sort((a, b) => a.at - b.at);
  return {
    title: s.title,
    section: 'Sessions',
    charts: [...s.pages, ...s.drafts].some((p) => p.content.blocks.some((b: { kind: string }) => b.kind === 'chart')),
    watch: `session:${id}`,
    body: html`<p class="address"><a href="/sessions">Sessions</a> /</p>
    <h1>${s.title}</h1>
    <ul class="chips"><li class="${s.status}">${s.status}</li></ul>
    <p class="meta session-meta">Started ${when(s.started_at)} · ${s.data.length} data records</p>
    ${s.conclusion && html`<div class="conclusion"><small>Conclusion</small>${s.conclusion}</div>`}
    ${stream.length ? stream.map((x) => x.body) : empty('Waiting for the first answer.')}`,
  };
}

/** Unsigned, so it is only ever shown here and in its session, and always says so. */
async function draftView({ db, store }: Ctx, address: string, res: ServerResponse): Promise<View | null> {
  const draft = await getDraft(db, address);
  if (!draft) {
    res.writeHead(302, { location: pageHref(address) }).end(); // Finalized while open: the page takes over.
    return null;
  }
  const c = draft.content;
  return {
    title: `Draft of ${address}`,
    section: 'Sessions',
    charts: c.blocks.some((b: { kind: string }) => b.kind === 'chart'),
    watch: `session:${draft.session}`,
    body: html`<p class="address">${address}</p><h1>${c.summary}</h1>
    <p class="notice">Draft by session <a href="/sessions/${draft.session}">${draft.session}</a>. Not signed yet, not part of the record, and it may change.</p>
    <div class="blocks">${await renderBlocks(c, { db, store })}</div>`,
  };
}

async function runsView({ db }: Ctx): Promise<View> {
  const { rows } = await db.query(`SELECT id, agent_name, status, started_at, ended_at,
    extract(epoch FROM ended_at - started_at)::float AS seconds FROM runs ORDER BY created_at DESC LIMIT 200`);
  return {
    title: 'Runs',
    section: 'Runs',
    body: html`<h1>Runs</h1>
    ${rows.length ? html`<div class="scroll"><table>
      <thead><tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Duration</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td><a href="/runs/${r.id}">${r.agent_name}</a></td><td><span class="status ${r.status}">${r.status}</span></td>
        <td>${when(r.started_at)}</td><td class="number">${r.seconds === null ? '—' : `${r.seconds.toFixed(1)}s`}</td></tr>`)}</tbody>
    </table></div>` : empty('No runs yet. Start one with: ganjine run <agent>')}`,
  };
}

async function runView({ db }: Ctx, id: string): Promise<View> {
  const run = (await db.query(`SELECT *, extract(epoch FROM ended_at - started_at)::float AS seconds FROM runs WHERE id = $1`, [id])).rows[0];
  if (!run) throw new NotFound();
  const logs = (await db.query('SELECT ts, level, message FROM run_logs WHERE run_id = $1 ORDER BY ts', [id])).rows;
  const pages = (await db.query(`SELECT id, address, as_of::text FROM page_versions WHERE run_id = $1 ORDER BY created_at`, [id])).rows;
  const records = (await db.query(`SELECT kind, count(*)::int AS n FROM records WHERE run_id = $1 GROUP BY kind ORDER BY kind`, [id])).rows;
  const cost = run.meta.cost_usd;
  return {
    title: `Run ${run.agent_name}`,
    section: 'Runs',
    body: html`<p class="address">${run.id}</p>
    <h1>${run.agent_name}</h1>
    <p class="meta"><span class="status ${run.status}">${run.status}</span> · started ${when(run.started_at)} · ${run.seconds === null ? 'not finished' : `${run.seconds.toFixed(1)}s`}${typeof cost === 'number' && ` · $${cost.toFixed(4)}`}${run.meta.instruction_ref && html` · ${run.meta.instruction_ref}`}</p>
    ${run.meta.error && html`<p class="block-error">${run.meta.error}</p>`}
    <h2>Pages produced</h2>
    ${pages.length ? html`<ul>${pages.map((p) => html`<li><a href="${pageHref(p.address, `?version=${p.id}`)}">${p.address}</a> as of ${p.as_of}</li>`)}</ul>` : empty('None.')}
    <h2>Records produced</h2>
    ${records.length ? html`<ul>${records.map((r) => html`<li><code>${r.kind}</code> × ${r.n}</li>`)}</ul>` : empty('None.')}
    <h2>Log</h2>
    ${logs.length ? html`<ol class="log">${logs.map((l) => html`<li class="${l.level}"><time>${new Date(l.ts).toISOString().slice(11, 19)}</time> ${l.message}</li>`)}</ol>` : empty('No log lines.')}`,
  };
}

async function healthView({ db }: Ctx): Promise<View> {
  const { rows } = await db.query('SELECT * FROM health ORDER BY component');
  return {
    title: 'Health',
    section: 'Health',
    body: html`<h1>Health</h1>
    ${rows.length ? html`<div class="scroll"><table>
      <thead><tr><th scope="col">Component</th><th scope="col">Status</th><th scope="col">Last checked</th><th scope="col">Last ok</th><th scope="col">Last error</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td>${r.component}</td><td><span class="status ${r.status}">${r.status}</span></td>
        <td>${when(r.checked_at)}</td><td>${when(r.last_ok_at)}</td><td>${r.last_error ?? '—'}</td></tr>`)}</tbody>
    </table></div>` : empty('No health checks recorded.')}`,
  };
}

async function pageView({ db, store, url }: Ctx, address: string): Promise<View> {
  const history = await pageHistory(db, address).catch((err) => {
    if (err instanceof GanjineError) throw new NotFound();
    throw err;
  });
  const asOf = url.searchParams.get('as_of') || undefined;
  const versionId = url.searchParams.get('version');
  let version: any;
  let missing: string | undefined;
  try {
    version = versionId ? await getVersion(db, address, versionId) : await getPage(db, address, asOf);
  } catch (err) {
    if (!(err instanceof GanjineError)) throw err;
    missing = err.message;
  }
  const c = version?.content;
  const latest = version && history.find((v) => v.id === version.id)?.latest;
  const timeline = html`<details class="timeline" aria-label="Version timeline">
    <summary>History · ${history.length} ${history.length === 1 ? 'version' : 'versions'}</summary>
    <div class="timeline-panel">
    <form method="get" action="${pageHref(address)}">
      <label for="as_of">As of</label>
      <input type="date" id="as_of" name="as_of" value="${asOf ?? ''}">
      <button type="submit">Go</button>
      <a href="${pageHref(address)}">Latest</a>
    </form>
    <ol>${history.map((v) => html`<li ${v.id === version?.id ? new Raw('aria-current="true"') : ''}>
      <a href="${pageHref(address, `?version=${v.id}`)}"><time>${v.as_of}</time>${v.latest && html` <small>latest</small>`}<span>${v.summary}</span></a>
      <small>written ${when(v.created_at)}</small>
    </li>`)}</ol>
    </div>
  </details>`;
  if (!c) {
    return {
      title: address,
      section: 'Items',
      status: missing?.includes('failed verification') ? 409 : 404,
      body: html`<h1>${address}</h1><p class="notice">${missing}</p>${timeline}`,
    };
  }
  return {
    title: address,
    section: 'Items',
    charts: c.blocks.some((b: { kind: string }) => b.kind === 'chart'),
    body: html`<div class="page-head"><div><p class="address">${address}</p>
    <h1>${c.summary}</h1>
    <p class="meta">As of ${version.as_of} · written ${when(version.created_at)} · by ${c.produced_by.agent}${version.run_id && html` · <a href="/runs/${version.run_id}">view run</a>`}</p></div>${timeline}</div>
    ${!latest && html`<p class="notice">You are viewing a past version. <a href="${pageHref(address)}">Go to latest</a></p>`}
    <div class="blocks">${await renderBlocks(c, { db, store })}</div>
    ${c.inputs_used.length > 0 && html`<details class="inputs"><summary>${c.inputs_used.length} inputs used</summary>
      <ul>${c.inputs_used.map((id: string) => html`<li><code>${id}</code></li>`)}</ul></details>`}`,
  };
}

async function route(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<View | null> {
  const path = ctx.url.pathname;
  if (path === '/') {
    res.writeHead(302, { location: '/items' }).end();
    return null;
  }
  if (path === '/items') return itemsView(ctx);
  if (path === '/categories') return categoriesView(ctx);
  if (path === '/runs') return runsView(ctx);
  if (path === '/health') return healthView(ctx);
  if (path === '/sessions') return sessionsView(ctx);
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.write(': open\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return null;
  }
  const session = /^\/sessions\/([\w-]+)$/.exec(path)?.[1];
  if (session) return sessionView(ctx, session);
  const run = /^\/runs\/([0-9a-f-]{36})$/.exec(path)?.[1];
  if (run) return runView(ctx, run);
  const item = /^\/items\/([^/]+)$/.exec(path);
  if (item) return itemView(ctx, decodeURIComponent(item[1]));
  if (path.startsWith('/drafts/')) return draftView(ctx, decodeURI(path.slice('/drafts'.length)), res);
  if (path === '/pages' || path.startsWith('/pages/')) return pageView(ctx, decodeURI(path.slice('/pages'.length)) || '/');

  const asset = /^\/assets\/([\w.-]+)$/.exec(path)?.[1];
  if (asset && Object.hasOwn(ASSETS, asset)) {
    const [location, type] = ASSETS[asset];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    createReadStream(fileURLToPath(location)).pipe(res);
    return null;
  }
  const blob = /^\/blobs\/([0-9a-f]{64})$/.exec(path)?.[1];
  if (blob) {
    const ref = `blob:sha256:${blob}`;
    if (!(await ctx.store.exists(ref))) throw new NotFound();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': EMBED_CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(await ctx.store.get(ref));
    return null;
  }
  throw new NotFound();
}

export function handler(db: Db, store: BlobStore) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, page: string) =>
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      }).end(page);
    const message = (status: number, title: string, text: string) =>
      send(status, layout(title, '', html`<h1>${title}</h1><p class="notice">${text}</p>`));
    // Loopback alone does not stop DNS rebinding: a remote site can resolve its own name to 127.0.0.1.
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return message(421, 'Wrong host', 'The face answers on loopback names only.');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return message(405, 'Method not allowed', 'The face is read-only.');
    }
    try {
      const url = new URL(req.url ?? '/', 'http://face');
      const view = await route({ db, store, url }, req, res);
      if (view) send(view.status ?? 200, layout(view.title, view.section, view.body, { charts: view.charts, watch: view.watch, alarm: ledgerAlarm }));
    } catch (err) {
      if (err instanceof NotFound || err instanceof URIError) return message(404, 'Not found', 'Nothing lives at this address.');
      console.error(err);
      message(500, 'Something went wrong', (err as Error).message);
    }
  };
}

let ledgerAlarm: string | undefined;

/** Walks the chain, because a single read cannot see a deletion. */
export async function checkLedger(db: Db) {
  const v = await verifyChain(db);
  ledgerAlarm = v.status === 'failed' ? `The ledger failed verification: ${v.problems[0]}` : undefined;
  const ok = v.status === 'ok';
  const status = ok ? 'ok' : v.status === 'off' ? 'degraded' : 'failed';
  const error = ok ? null : v.status === 'off' ? 'Ledger is off: records are not signed' : v.problems.slice(0, 3).join('; ');
  await db.query(`INSERT INTO health (component, status, checked_at, last_ok_at, last_error) VALUES ('ledger', $1, now(), CASE WHEN $2 THEN now() END, $3)
    ON CONFLICT (component) DO UPDATE SET status = $1, checked_at = now(), last_ok_at = COALESCE(EXCLUDED.last_ok_at, health.last_ok_at), last_error = $3`, [status, ok, error]);
  return v;
}

const beat = (db: Db) =>
  db.query(`INSERT INTO health (component, status, checked_at, last_ok_at) VALUES ('face', 'ok', now(), now())
    ON CONFLICT (component) DO UPDATE SET status = 'ok', checked_at = now(), last_ok_at = now(), last_error = NULL`);

/** Listens on loopback only: the face has no auth until Phase 5. */
export async function serve(port: number) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new GanjineError(`invalid port: ${port}`);
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  pool.on('error', (err) => console.error(`ganjine: ${err.message}`));
  await beat(pool).catch((err) => { throw new GanjineError(`cannot reach Postgres (${err.code ?? err.message}); is it running and migrated?`); });
  const heartbeat = () => Promise.all([beat(pool), checkLedger(pool)]).catch((err) => console.error(`ganjine: ${err.message}`));
  await heartbeat();
  setInterval(heartbeat, 60_000).unref();
  await subscribe(databaseUrl(), broadcast);
  const server = createServer(handler(pool, blobStore()));
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
