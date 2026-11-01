import MarkdownIt from 'markdown-it';
import type { BlobStore } from '../blobs.ts';
import { blobHash } from '../blobs.ts';
import type { Block, PageContent } from '../contract.ts';
import type { Db } from '../db.ts';
import { GanjineError } from '../db.ts';
import { getRecord } from '../records.ts';
import { html, pageHref, Raw } from './html.ts';

const md = new MarkdownIt({ html: false });

/** Page text can link anywhere, so a link leaving Ganjine names where it goes. */
const hostOf = (href: string) => {
  try {
    return /^https?:/i.test(href) ? new URL(href).host : null;
  } catch {
    return null;
  }
};
md.renderer.rules.link_open = (tokens, i, options, _env, self) => {
  if (hostOf(String(tokens[i].attrGet('href') ?? ''))) tokens[i].attrSet('rel', 'noopener noreferrer nofollow');
  return self.renderToken(tokens, i, options);
};
md.renderer.rules.link_close = (tokens, i, options, _env, self) => {
  let open = i;
  while (tokens[open].type !== 'link_open') open--;
  const host = hostOf(String(tokens[open].attrGet('href') ?? ''));
  return self.renderToken(tokens, i, options) + (host ? html` <small class="external">↗ ${host}</small>`.value : '');
};
const json = (v: unknown) => new Raw(JSON.stringify(v).replace(/</g, '\\u003c'));

type Context = { db: Db; store: BlobStore };
type Renderer = (b: Block, ctx: Context) => Raw | Promise<Raw>;

const blocksV1: Record<string, Renderer> = {
  markdown: (b) => html`<div class="prose">${new Raw(md.render(b.text))}</div>`,

  kv: (b) => html`<dl class="kv">${b.items.map((i: Block) => html`<div>
    <dt>${i.key}</dt>
    <dd>${i.value}${i.unit && html` <small>${i.unit}</small>`}</dd>
    ${typeof i.delta === 'number' && html`<dd class="delta">${i.delta >= 0 ? '▲ +' : '▼ '}${i.delta}</dd>`}
  </div>`)}</dl>`,

  table: async (b, { db }) => {
    const rows = b.rows ?? (await getRecord(db, b.record)).payload.rows;
    if (!Array.isArray(rows)) throw new GanjineError(`record ${b.record} has no rows in its payload`);
    return html`<div class="scroll"><table class="sortable">
      <thead><tr>${b.columns.map((c: Block) => html`<th scope="col" data-type="${c.type}"><button type="button">${c.name}</button></th>`)}</tr></thead>
      <tbody>${rows.map((r: unknown[]) => html`<tr>${r.map((v, i) => html`<td class="${b.columns[i]?.type}">${v === null ? '—' : b.columns[i]?.type === 'number' && typeof v === 'number' ? v.toLocaleString('en-US') : String(v)}</td>`)}</tr>`)}</tbody>
    </table></div>`;
  },

  chart: async (b, { db }) => {
    let spec = { width: 'container', ...b.spec };
    if (Array.isArray(b.data)) spec = { ...spec, data: { values: b.data } };
    else if (b.data) {
      const values = (await getRecord(db, b.data.record)).payload.values;
      if (!Array.isArray(values)) throw new GanjineError(`record ${b.data.record} has no values in its payload`);
      spec = { ...spec, data: { values } };
    }
    return html`<div class="chart" data-chart><div class="chart-body"></div><script type="application/json">${json(spec)}</script></div>`;
  },

  embed: async (b, { store }) => {
    if (!(await store.exists(b.blob))) throw new GanjineError(`blob not found: ${b.blob}`);
    return html`<iframe class="embed" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy"
      title="${b.title ?? 'Embedded view'}" src="/blobs/${blobHash(b.blob)}" height="${b.height ?? 480}"></iframe>`;
  },

  ref: async (b, { db }) => {
    const exists = (await db.query('SELECT 1 FROM pages WHERE address = $1', [b.address])).rowCount;
    const query = b.as_of ? `?as_of=${b.as_of}` : '';
    return html`<p class="ref">→ ${exists ? html`<a href="${pageHref(b.address, query)}">${b.address}</a>` : html`${b.address} <small>(no such page)</small>`}${b.as_of && html` <small>as of ${b.as_of}</small>`}</p>`;
  },
};

// Old contract versions keep their renderers here, so old page versions keep rendering.
const CONTRACTS: Record<number, Record<string, Renderer>> = { 1: blocksV1 };

async function renderBlock(b: Block, blocks: Record<string, Renderer>, ctx: Context) {
  let body: Raw;
  try {
    const render = blocks[b.kind];
    if (!render) throw new GanjineError(`no renderer for block kind ${b.kind}`);
    body = await render(b, ctx);
  } catch (err) {
    body = html`<p class="block-error">This block could not be rendered: ${(err as Error).message}</p>`;
  }
  const heading = b.kind !== 'embed' || !b.title;
  return html`<section class="block block-${b.kind}" ${b.id ? new Raw(`id="${html`${b.id}`.value}"`) : ''}>
    ${b.title && heading && html`<h2>${b.title}</h2>`}
    ${body}
  </section>`;
}

export async function renderBlocks(content: PageContent, ctx: Context) {
  const blocks = CONTRACTS[content.contract_version];
  if (!blocks) return html`<p class="block-error">No renderer for contract version ${content.contract_version}.</p>`;
  return html`${await Promise.all(content.blocks.map((b) => renderBlock(b, blocks, ctx)))}`;
}
