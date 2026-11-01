import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from './db.ts';
import { GanjineError } from './db.ts';
import { getRecord, putRecord } from './records.ts';

/** See `docs/adr/0011-forecast-layer.md` and `docs/forecasting.md`. */
export const PROTOCOL = 1;
export const FORECASTER_PATH = process.env.GANJINE_FORECASTER ?? new URL('../../agents/local/forecaster.json', import.meta.url).pathname;
const root = new URL('../../', import.meta.url).pathname;
const TIMEOUT = 15 * 60_000;
const MAX_OUTPUT = 64 * 1024 * 1024;

export type Step = 'day' | 'week';
export type Forecaster = { name: string; run: string[]; timeout_ms?: number };
export type SeriesRow = { date: string; series: string; value: number };
export type ForecastRequest = { protocol: number; step: Step; series: { name: string; dates: string[]; values: number[] }[]; future: string[]; quantiles: number[] };

const num = z.number().finite();
const response = z.object({
  model: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
  reason: z.string().optional(),
  series: z.array(z.object({ name: z.string(), values: z.array(num.nullable()), low: z.array(num.nullable()).optional(), high: z.array(num.nullable()).optional() })).default([]),
});
const rowSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), series: z.string().min(1), value: num });

export function loadForecaster(path = FORECASTER_PATH): Forecaster | null {
  if (!existsSync(path)) return null;
  const f = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof f.name !== 'string' || !Array.isArray(f.run) || !f.run.length || !f.run.every((a: unknown) => typeof a === 'string')) throw new GanjineError('a forecaster needs name and run');
  return f;
}

export function seriesRows(payload: any, id = 'payload'): SeriesRow[] {
  const parsed = z.array(rowSchema).min(1).safeParse(payload?.values);
  if (!parsed.success) throw new GanjineError(`${id} is not a series: it needs values of { date, series, value }`);
  return parsed.data;
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Markets skip days and models want a regular step, so each step takes the last value seen. */
export function buildRequest(rows: SeriesRow[], o: { step: Step; count: number; exclude?: string[] }): ForecastRequest {
  const width = o.step === 'week' ? 7 : 1;
  const bySeries = new Map<string, SeriesRow[]>();
  for (const r of rows) if (!o.exclude?.includes(r.series)) bySeries.set(r.series, [...(bySeries.get(r.series) ?? []), r]);
  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const series = [...bySeries].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => {
    const sorted = list.sort((a, b) => a.date.localeCompare(b.date));
    const dates: string[] = [];
    const values: number[] = [];
    for (let d = last, i = sorted.length - 1; d >= sorted[0].date; d = addDays(d, -width)) {
      while (sorted[i].date > d) i--;
      dates.unshift(d);
      values.unshift(sorted[i].value);
    }
    return { name, dates, values };
  });
  return { protocol: PROTOCOL, step: o.step, series, future: Array.from({ length: o.count }, (_, i) => addDays(last, width * (i + 1))), quantiles: [0.1, 0.9] };
}

/** Any failure is an answer: the caller stores `none` and keeps going. */
export function callForecaster(f: Forecaster, request: ForecastRequest) {
  return new Promise<{ output?: unknown; reason?: string }>((resolve) => {
    const [command, ...args] = f.run;
    const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ reason: 'forecaster timed out' }); }, f.timeout_ms ?? TIMEOUT);
    child.on('error', (e) => { clearTimeout(timer); resolve({ reason: `forecaster did not start: ${e.message}` }); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_OUTPUT) { child.kill(); clearTimeout(timer); resolve({ reason: 'forecaster output is too large' }); } else out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => { err = (err + d).slice(-500); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ reason: `forecaster exited ${code}: ${err.trim().split('\n').at(-1) ?? ''}`.trim() });
      try {
        resolve({ output: JSON.parse(Buffer.concat(out).toString('utf8')) });
      } catch {
        resolve({ reason: 'forecaster output is not JSON' });
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** A model may answer with less than was asked. Whatever it gave is kept up to the first gap, and the rest stays empty. */
export function shapeForecast(request: ForecastRequest, output: unknown, reason?: string) {
  const parsed = reason ? null : response.safeParse(output);
  if (parsed && !parsed.success) reason = 'forecaster output does not follow the protocol';
  const answer = parsed?.success ? parsed.data : undefined;
  const series = request.series.map(({ name }) => {
    const s = answer?.series.find((a) => a.name === name);
    const points: { date: string; value: number; low?: number; high?: number }[] = [];
    for (const [i, date] of request.future.entries()) {
      const value = s?.values[i];
      if (value === undefined || value === null) break;
      const low = s?.low?.[i] ?? undefined;
      const high = s?.high?.[i] ?? undefined;
      const band = low !== undefined && high !== undefined && low <= value && value <= high;
      points.push({ date, value, ...(band && { low, high }) });
    }
    return { name, status: points.length === request.future.length ? 'ok' : points.length ? 'partial' : 'none', points };
  });
  const status = series.length && series.every((s) => s.status === 'ok') ? 'ok' : series.some((s) => s.points.length) ? 'partial' : 'none';
  return { status, reason: (reason ?? answer?.reason)?.slice(0, 300), model: answer?.model, series };
}

export type ForecastOptions = { step?: Step; count?: number; exclude?: string[]; tags?: string[] };

/** Ask once for the longest horizon and store the answer next to the data. Charts read this and never call a model. */
export async function produceForecast(db: Db, inputId: string, o: ForecastOptions = {}, forecaster = loadForecaster()) {
  const input = await getRecord(db, inputId);
  const step = o.step ?? 'week';
  const request = buildRequest(seriesRows(input.payload, `record ${inputId}`), { step, count: o.count ?? 52, exclude: o.exclude });
  const reply = forecaster ? await callForecaster(forecaster, request) : { reason: 'no forecaster is set' as string, output: undefined };
  const shaped = shapeForecast(request, reply.output, reply.reason);
  return putRecord(db, {
    kind: 'forecast',
    itemId: input.item_id,
    tags: o.tags ?? input.tags,
    payload: {
      protocol: PROTOCOL,
      input: inputId,
      step,
      from: request.future[0],
      to: request.future.at(-1),
      forecaster: { name: forecaster?.name ?? 'none', model: shaped.model },
      status: shaped.status,
      ...(shaped.reason && { reason: shaped.reason }),
      series: shaped.series,
    },
  });
}

/** The standard pipeline: fetched data goes in, and the forecast lands beside it. */
export async function putSeries(db: Db, r: { itemId?: string; tags?: string[]; payload: unknown }, o: ForecastOptions = {}) {
  seriesRows(r.payload);
  const record = await putRecord(db, { kind: 'series', itemId: r.itemId, tags: r.tags, payload: r.payload });
  const forecast = await produceForecast(db, record.id, { ...o, tags: r.tags });
  return { record: record.id, forecast: forecast.id, status: forecast.payload.status };
}
