import type { Block } from '../contract.ts';
import { GanjineError } from '../db.ts';

const DAY = 86_400_000;
const REFERENCE = '#8a8982';
const PAST = { options: [30, 90, 180, 365, 730], value: 365 };
const NEXT = { options: [30, 90, 180, 365], value: 180 };

const label = (days: number) => {
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  if (days === 730) return '2 years';
  if (days % 30 === 0) return days === 30 ? '1 month' : `${days / 30} months`;
  return days === 1 ? '1 day' : `${days} days`;
};

/** One option needs no picker. */
const param = (name: string, title: string, w: { options: number[]; value?: number }) => ({
  name,
  value: w.value ?? w.options[0],
  ...(w.options.length > 1 && { bind: { input: 'select', options: w.options, labels: w.options.map(label), name: `${title} ` } }),
});

type Point = { date: string; value: number; low?: number; high?: number };
type Forecast = { input?: string; status?: string; reason?: string; forecaster?: { name?: string }; series?: { name: string; points: Point[] }[] };

/** What the next window can honestly say. A forecast that is for other data counts as none. */
function nextLabel(f: Forecast | undefined, input: string) {
  if (!f || f.input !== input) return 'No forecast';
  if (f.status === 'none' || !f.series?.some((s) => s.points?.length)) return 'No forecast';
  if (f.status === 'ok') return `Forecast: ${f.forecaster?.name ?? 'unnamed'}`;
  const last = f.series.flatMap((s) => s.points.map((p) => p.date)).sort().at(-1);
  return `Forecast: ${f.forecaster?.name ?? 'unnamed'}, to ${last}`;
}

/** The whole look lives here: agents give data, so every timeline reads the same. */
export function timelineSpec(b: Block, data: any, forecast: Forecast | undefined, asOf: string, input: string) {
  if (!Array.isArray(data?.values)) throw new GanjineError(`record ${input} has no values in its payload`);
  const today = Date.parse(`${asOf}T00:00:00Z`);
  const past = b.past ?? PAST;
  const next = b.next ?? NEXT;
  const longest = Math.max(...next.options);
  const reference = new Set<string>(b.reference ?? []);
  const lastActual = new Map<string, { date: string; value: number }>();
  const rows: Record<string, unknown>[] = [];
  for (const v of data.values) {
    rows.push({ date: v.date, series: v.series, value: v.value, f: 0 });
    const seen = lastActual.get(v.series);
    if (!seen || seen.date < v.date) lastActual.set(v.series, v);
  }
  const usable = forecast?.input === input ? (forecast.series ?? []) : [];
  for (const s of usable) {
    const from = lastActual.get(s.name);
    if (!from || reference.has(s.name) || !s.points?.length) continue;
    // The dotted line starts where the solid one ends.
    rows.push({ date: from.date, series: s.name, value: from.value, low: from.value, high: from.value, f: 1 });
    for (const p of s.points) rows.push({ date: p.date, series: s.name, value: p.value, low: p.low ?? null, high: p.high ?? null, f: 1 });
  }
  const names = [...lastActual.keys()].filter((n) => !reference.has(n)).sort();
  const scaled = (field: string) => (b.rebase === false ? `datum.${field}` : `datum.${field}/datum.base*100`);
  const transform = [
    { calculate: 'toDate(datum.date)', as: 't' },
    { filter: `time(datum.t)>=${today}-past*${DAY} && time(datum.t)<=${today}+next*${DAY}` },
    { window: [{ op: 'first_value', field: 'value', as: 'base' }], sort: [{ field: 't' }], groupby: ['series'], frame: [null, null] },
    { calculate: scaled('value'), as: 'y' },
    { calculate: `datum.low==null?null:${scaled('low')}`, as: 'y1' },
    { calculate: `datum.high==null?null:${scaled('high')}`, as: 'y2' },
  ];
  const scale = { domainMin: { expr: `${today}-past*${DAY}` }, domainMax: { expr: `${today}+next*${DAY}` } };
  const x = { field: 't', type: 'temporal', title: null, scale };
  const y = { field: 'y', type: 'quantitative', title: b.value_title ?? (b.rebase === false ? null : 'Start of window = 100'), scale: { zero: false } };
  const color = { field: 'series', type: 'nominal', title: null, scale: { domain: names }, legend: { orient: 'top', labelLimit: 0, symbolOpacity: 1 } }; // The band is faint, and the legend must not be.
  const tooltip = [{ field: 'series', title: 'Series' }, { field: 't', type: 'temporal', title: 'Date' }, { field: 'y', format: ',.1f', title: b.rebase === false ? 'Value' : 'Index' }];
  const only = (test: string) => [...transform, { filter: test }];
  return {
    width: 'container',
    height: 320,
    params: [param('past', 'Past', past), param('next', 'Next', next)],
    data: { values: rows },
    layer: [
      { data: { values: [{ a: today, b: today + longest * DAY }] }, mark: { type: 'rect', color: REFERENCE, opacity: 0.1, clip: true }, encoding: { x: { field: 'a', type: 'temporal', title: null, scale }, x2: { field: 'b' } } },
      { data: { values: [{ a: today }] }, mark: { type: 'rule', color: REFERENCE, strokeWidth: 1 }, encoding: { x: { field: 'a', type: 'temporal', scale } } },
      { data: { values: [{ a: today + 6 * DAY, l: nextLabel(forecast, input) }] }, mark: { type: 'text', align: 'left', baseline: 'top', dy: 6, color: REFERENCE, y: 0, clip: true }, encoding: { x: { field: 'a', type: 'temporal', scale }, text: { field: 'l' } } },
      { transform: only('datum.f==1 && datum.y1!=null && datum.y2!=null'), mark: { type: 'area', opacity: 0.14, clip: true }, encoding: { x, y: { field: 'y1', type: 'quantitative', title: y.title, scale: y.scale }, y2: { field: 'y2' }, color } },
      { transform: only(`indexof(${JSON.stringify([...reference])},datum.series)>=0`), mark: { type: 'line', strokeDash: [5, 4], strokeWidth: 1.5, color: REFERENCE, clip: true }, encoding: { x, y, tooltip } },
      { transform: only(`datum.f==0 && indexof(${JSON.stringify([...reference])},datum.series)<0`), mark: { type: 'line', strokeWidth: 2, clip: true, interpolate: 'monotone' }, encoding: { x, y, color, tooltip } },
      { transform: only('datum.f==1'), mark: { type: 'line', strokeWidth: 2, strokeDash: [2, 4], clip: true }, encoding: { x, y, color, tooltip } },
    ],
  };
}
