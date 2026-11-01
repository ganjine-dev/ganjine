import { GanjineError } from './db.ts';

const FIELDS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
  ['day of week', 0, 6],
] as const;

export interface Cron {
  sets: Set<number>[];
  dayOfMonthAny: boolean;
  dayOfWeekAny: boolean;
}

function parseField(text: string, [name, min, max]: (typeof FIELDS)[number]) {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new GanjineError(`invalid cron ${name}: ${text}`);
    const [low, high] = m[1] === '*' ? [min, max] : m[1].split('-').map(Number);
    const end = high ?? (m[2] ? max : low);
    const step = m[2] ? Number(m[2]) : 1;
    if (low < min || end > max || low > end || step < 1) throw new GanjineError(`invalid cron ${name}: ${text}`);
    for (let v = low; v <= end; v += step) values.add(v);
  }
  return values;
}

/** Five fields, UTC: minute hour day-of-month month day-of-week. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new GanjineError(`invalid cron: ${expression} (expected 5 fields)`);
  return {
    sets: parts.map((p, i) => parseField(p, FIELDS[i])),
    dayOfMonthAny: parts[2] === '*',
    dayOfWeekAny: parts[4] === '*',
  };
}

function matches(c: Cron, d: Date) {
  const [minute, hour, dom, month, dow] = c.sets;
  if (!minute.has(d.getUTCMinutes()) || !hour.has(d.getUTCHours()) || !month.has(d.getUTCMonth() + 1)) return false;
  const byMonth = dom.has(d.getUTCDate());
  const byWeek = dow.has(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  return c.dayOfMonthAny || c.dayOfWeekAny ? byMonth && byWeek : byMonth || byWeek;
}

/** The first matching minute strictly after `after`. */
export function nextAfter(expression: string, after: Date): Date {
  const cron = parseCron(expression);
  const t = new Date(after);
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 366 * 5 * 1440; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (matches(cron, t)) return t;
  }
  throw new GanjineError(`cron never fires: ${expression}`);
}
