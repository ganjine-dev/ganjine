import { GanjineError } from './db.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a calendar date. Dates are UTC throughout Ganjine. */
export function parseDate(s: string): string {
  const d = new Date(`${s}T00:00:00Z`);
  if (!DATE.test(s) || isNaN(+d) || d.toISOString().slice(0, 10) !== s) {
    throw new GanjineError(`invalid date: ${s} (expected YYYY-MM-DD)`);
  }
  return s;
}

/** Lower bound: a date means the start of that UTC day. */
export function fromBound(s: string): Date {
  if (DATE.test(s)) return new Date(`${parseDate(s)}T00:00:00Z`);
  return timestamp(s);
}

/** Exclusive upper bound: a date includes the whole UTC day. */
export function toBound(s: string): Date {
  if (DATE.test(s)) return new Date(+new Date(`${parseDate(s)}T00:00:00Z`) + 86_400_000);
  return new Date(+timestamp(s) + 1);
}

function timestamp(s: string): Date {
  const d = new Date(s);
  if (isNaN(+d)) throw new GanjineError(`invalid date or timestamp: ${s}`);
  return d;
}
