const number = (text) => parseFloat(text.replaceAll(',', '')) || 0;

for (const table of document.querySelectorAll('table.sortable')) {
  const headers = [...table.tHead.rows[0].cells];
  headers.forEach((th, index) => {
    th.querySelector('button').addEventListener('click', () => {
      const ascending = th.getAttribute('aria-sort') !== 'ascending';
      headers.forEach((h) => h.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
      const value = (row) => row.cells[index]?.textContent ?? '';
      const compare = th.dataset.type === 'number'
        ? (a, b) => number(value(a)) - number(value(b))
        : (a, b) => value(a).localeCompare(value(b));
      const body = table.tBodies[0];
      const rows = [...body.rows].sort(compare);
      body.append(...(ascending ? rows : rows.reverse()));
    });
  });
}

const css = getComputedStyle(document.documentElement);
const token = (name) => css.getPropertyValue(name).trim();
const font = 'Inter, Vazirmatn, system-ui, sans-serif';
const chartTheme = {
  background: 'transparent',
  font,
  view: { stroke: null },
  axis: {
    labelColor: token('--muted'), titleColor: token('--muted'), gridColor: token('--line'), domain: false, ticks: false,
    labelFontSize: 13, titleFontSize: 13, titleFontWeight: 500, labelFont: font, titleFont: font, labelPadding: 8,
  },
  legend: { labelColor: token('--muted'), titleColor: token('--muted'), labelFontSize: 13, titleFontSize: 13 },
  text: { color: token('--ink'), fontSize: 13 },
  bar: { color: token('--series'), cornerRadiusEnd: 4 },
  point: { color: token('--series') },
  circle: { color: token('--series') },
  title: { color: token('--ink'), fontSize: 15, font },
};

// Charts measure text, so they wait for the fonts.
document.fonts.ready.then(() => {
  // A chart draws from the data on the page: no loads, and no mark that navigates when clicked.
  const loader = window.vega?.loader();
  if (loader) loader.sanitize = () => Promise.reject(new Error('charts do not load or link'));
  for (const chart of document.querySelectorAll('[data-chart]')) {
    const target = chart.querySelector('.chart-body');
    const spec = JSON.parse(chart.querySelector('script').textContent);
    // ast: true evaluates expressions without eval, which the CSP forbids.
    vegaEmbed(target, spec, { mode: 'vega-lite', actions: false, ast: true, loader, renderer: 'svg', config: chartTheme, tooltip: { theme: 'custom' } })
      .catch((err) => {
        target.className = 'block-error';
        target.textContent = `This block could not be rendered: ${err.message}`;
      });
  }
});

for (const menu of document.querySelectorAll('details.timeline')) {
  document.addEventListener('click', (event) => { if (!menu.contains(event.target)) menu.open = false; });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') menu.open = false; });
}

// Agents commit; open pages follow. Closed while hidden, because a browser allows few streams per origin.
const { address, watch } = document.body.dataset;
const follows = (e) => (watch ? e.tags.includes(watch) || e.address?.startsWith(`/${watch.replace(':', 's/')}/`) : e.kind === 'page_version' && (!address.startsWith('/') || e.address === address));
let stream;
let timer;
const follow = () => {
  stream?.close();
  stream = undefined;
  if (document.hidden) return;
  stream = new EventSource('/events');
  stream.onmessage = ({ data }) => {
    if (!follows(JSON.parse(data))) return;
    clearTimeout(timer);
    timer = setTimeout(() => location.reload(), 800); // Several commits arrive as one reload.
  };
};
document.addEventListener('visibilitychange', follow);
follow();
