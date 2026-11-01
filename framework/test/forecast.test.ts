import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, callForecaster, loadForecaster, produceForecast, putSeries, seriesRows, shapeForecast } from '../src/forecast.ts';
import { getRecord } from '../src/records.ts';
import { timelineSpec } from '../src/face/timeline.ts';
import { testDb } from './helpers.ts';

const rows = [
  { date: '2026-01-01', series: 'a', value: 1 },
  { date: '2026-01-08', series: 'a', value: 2 },
  { date: '2026-01-16', series: 'a', value: 3 },
  { date: '2026-01-15', series: 'b', value: 9 },
  { date: '2026-01-16', series: 'ref', value: 5 },
];
const script = async (body: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'ganjine-forecaster-'));
  const file = join(dir, 'f.mjs');
  await writeFile(file, `let t='';for await(const c of process.stdin)t+=c;const q=JSON.parse(t);${body}`);
  return { name: 'stub', run: ['node', file] };
};

describe('forecast request', () => {
  it('puts every series on a regular step, ending at the last date, with its own length', () => {
    const r = buildRequest(rows, { step: 'week', count: 2, exclude: ['ref'] });
    assert.deepEqual(r.series.map((s) => s.name), ['a', 'b']);
    assert.deepEqual(r.series[0].dates, ['2026-01-02', '2026-01-09', '2026-01-16']);
    assert.deepEqual(r.series[0].values, [1, 2, 3]);
    assert.deepEqual(r.series[1].values, [9]);
    assert.deepEqual(r.future, ['2026-01-23', '2026-01-30']);
  });

  it('refuses data that is not a series', () => {
    assert.throws(() => seriesRows({ values: [{ a: 1 }] }), /not a series/);
    assert.throws(() => seriesRows({}), /not a series/);
  });
});

describe('forecast answers', () => {
  const request = { ...buildRequest(rows, { step: 'day', count: 3, exclude: ['ref'] }) };

  it('keeps a full answer as ok', () => {
    const s = shapeForecast(request, { model: { name: 'm' }, series: [{ name: 'a', values: [1, 2, 3], low: [0, 1, 2], high: [2, 3, 4] }, { name: 'b', values: [1, 2, 3] }] });
    assert.equal(s.status, 'ok');
    assert.deepEqual(s.series[0].points[1], { date: request.future[1], value: 2, low: 1, high: 3 });
    assert.deepEqual(Object.keys(s.series[1].points[0]), ['date', 'value']);
  });

  it('calls a short answer or a missing series partial', () => {
    const s = shapeForecast(request, { series: [{ name: 'a', values: [1] }] });
    assert.equal(s.status, 'partial');
    assert.deepEqual(s.series.map((x) => x.status), ['partial', 'none']);
  });

  it('stops at the first gap, and ignores series nobody asked for', () => {
    const s = shapeForecast(request, { series: [{ name: 'a', values: [1, null, 3] }, { name: 'x', values: [1, 2, 3] }] });
    assert.equal(s.series[0].points.length, 1);
    assert.equal(s.series.length, 2);
  });

  it('drops a band that does not hold the value', () => {
    const s = shapeForecast(request, { series: [{ name: 'a', values: [5, 5, 5], low: [6, 0, 0], high: [7, 9, 9] }, { name: 'b', values: [1, 1, 1] }] });
    assert.equal(s.series[0].points[0].low, undefined);
    assert.equal(s.series[0].points[1].low, 0);
  });

  it('treats nothing, and output off the protocol, as none', () => {
    assert.equal(shapeForecast(request, { series: [] }).status, 'none');
    const bad = shapeForecast(request, { series: 'no' });
    assert.equal(bad.status, 'none');
    assert.match(bad.reason!, /protocol/);
  });
});

describe('forecasters', () => {
  const request = buildRequest(rows, { step: 'week', count: 2 });

  it('turns every failure into a reason', async () => {
    assert.match((await callForecaster(await script('process.exit(3)'), request)).reason!, /exited 3/);
    assert.match((await callForecaster(await script('console.log("nope")'), request)).reason!, /not JSON/);
    assert.match((await callForecaster({ name: 'x', run: ['/no/such/command'] }, request)).reason!, /did not start/);
    assert.match((await callForecaster({ ...(await script('await new Promise(()=>setTimeout(()=>{},1e6))')), timeout_ms: 100 }, request)).reason!, /timed out/);
  });

  it('has no forecaster without a file, and refuses a bad one', async () => {
    assert.equal(loadForecaster('/no/such/file'), null);
    const dir = await mkdtemp(join(tmpdir(), 'ganjine-forecaster-'));
    await writeFile(join(dir, 'f.json'), '{"name":"x"}');
    assert.throws(() => loadForecaster(join(dir, 'f.json')), /needs name and run/);
  });
});

describe('forecast records', () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  before(async () => { t = await testDb(); });
  after(() => t.close());

  it('stores data and its forecast together', async () => {
    const f = await script('console.log(JSON.stringify({model:{name:"stub"},series:q.series.map(s=>({name:s.name,values:q.future.slice(0,1).map(()=>7)}))}))');
    const { putRecord } = await import('../src/records.ts');
    const input = await putRecord(t.db, { kind: 'series', payload: { values: rows }, tags: ['x'] });
    const r = await produceForecast(t.db, input.id, { count: 2, exclude: ['ref'] }, f);
    assert.equal(r.kind, 'forecast');
    assert.equal(r.payload.input, input.id);
    assert.equal(r.payload.status, 'partial');
    assert.deepEqual(r.tags, ['x']);
  });

  it('still stores the data when nothing can forecast', async () => {
    const r = await putSeries(t.db, { payload: { values: rows } }, { count: 2 });
    assert.equal(r.status, 'none');
    assert.equal((await getRecord(t.db, r.record)).kind, 'series');
    assert.equal((await getRecord(t.db, r.forecast)).payload.reason, 'no forecaster is set');
  });
});

describe('timeline spec', () => {
  const data = { values: rows };
  const block = { kind: 'timeline', reference: ['ref'] };
  const label = (s: any) => s.layer[2].data.values[0].l;
  const forecast = (status: string) => ({ input: 'r', status, forecaster: { name: 'm' }, series: [{ name: 'a', points: [{ date: '2026-02-01', value: 4, low: 3, high: 5 }, { date: '2026-02-08', value: 5 }] }] });

  it('always leaves room for the next window, and says what is in it', () => {
    assert.equal(label(timelineSpec(block, data, undefined, '2026-01-16', 'r')), 'No forecast');
    assert.equal(label(timelineSpec(block, data, { input: 'r', status: 'none', series: [] }, '2026-01-16', 'r')), 'No forecast');
    assert.equal(label(timelineSpec(block, data, forecast('ok'), '2026-01-16', 'r')), 'Forecast: m');
    assert.equal(label(timelineSpec(block, data, forecast('partial'), '2026-01-16', 'r')), 'Forecast: m, to 2026-02-08');
  });

  it('ignores a forecast made for other data', () => {
    const s = timelineSpec(block, data, forecast('ok'), '2026-01-16', 'other') as any;
    assert.equal(label(s), 'No forecast');
    assert.equal(s.data.values.filter((r: any) => r.f === 1).length, 0);
  });

  it('starts the dotted line where the solid one ends', () => {
    const s = timelineSpec(block, data, forecast('ok'), '2026-01-16', 'r') as any;
    assert.deepEqual(s.data.values.find((r: any) => r.f === 1), { date: '2026-01-16', series: 'a', value: 3, low: 3, high: 3, f: 1 });
  });

  it('gives one option no picker', () => {
    const s = timelineSpec({ ...block, past: { options: [365] }, next: { options: [90] } }, data, undefined, '2026-01-16', 'r') as any;
    assert.equal(s.params[0].bind, undefined);
    assert.equal(s.params[0].value, 365);
  });

  it('keeps reference lines out of the legend', () => {
    const s = timelineSpec(block, data, undefined, '2026-01-16', 'r') as any;
    assert.deepEqual(s.layer[5].encoding.color.scale.domain, ['a', 'b']);
  });

  it('draws markers only when given, and keeps their labels apart', () => {
    assert.equal((timelineSpec(block, data, undefined, '2026-01-16', 'r') as any).layer.length, 7);
    const s = timelineSpec({ ...block, markers: [{ date: '2026-01-20', label: 'One' }, { date: '2026-01-21', label: 'Two', detail: 'More' }] }, data, undefined, '2026-01-16', 'r') as any;
    assert.equal(s.layer.length, 9);
    const [one, two] = s.layer[3].data.values;
    assert.notEqual(one.py, two.py);
    assert.equal(one.detail, 'One');
    assert.equal(two.detail, 'More');
  });

  it('refuses a record with no values', () => {
    assert.throws(() => timelineSpec(block, {}, undefined, '2026-01-16', 'r'), /no values/);
  });
});
