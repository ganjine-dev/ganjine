export class Raw {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export const escape = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const part = (v: unknown): string => {
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  return v === false || v === null || v === undefined ? '' : escape(v);
};

/** Tagged template: everything interpolated is escaped unless it is already Raw. */
export const html = (strings: TemplateStringsArray, ...values: unknown[]) =>
  new Raw(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ''), ''));

export const when = (t: Date | string | null | undefined) =>
  t ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—';

export const pageHref = (address: string, query = '') => `/pages${encodeURI(address).replace(/^\/$/, '')}${query}`;

const NAV = [['/items', 'Items'], ['/sessions', 'Sessions'], ['/categories', 'Categories'], ['/runs', 'Runs'], ['/health', 'Health']];
const CHART_LIBS = ['vega', 'vega-lite', 'vega-embed'];

export function layout(title: string, section: string, body: Raw, opts: { charts?: boolean; watch?: string; alarm?: string } = {}) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Ganjine</title>
<link rel="stylesheet" href="/assets/face.css">
${opts.charts && CHART_LIBS.map((lib) => html`<script src="/assets/${lib}.js" defer></script>`)}
<script src="/assets/face.js" defer></script>
</head>
<body data-address="${title}" ${opts.watch ? html`data-watch="${opts.watch}"` : ''}>
<header class="face">
  <a class="brand" href="/items">Ganjine</a>
  <nav>${NAV.map(([href, label]) => html`<a href="${href}" ${label === section ? new Raw('aria-current="page"') : ''}>${label}</a>`)}</nav>
</header>
<main>${opts.alarm && html`<p class="block-error" role="alert">${opts.alarm}</p>`}${body}</main>
</body>
</html>`.value;
}
