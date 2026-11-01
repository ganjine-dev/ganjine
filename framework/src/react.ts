import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { GanjineEvent } from './events.ts';
import { GanjineError } from './db.ts';

/** A trigger as data. See `docs/adr/0005-triggers-and-trust-boundary.md`. */
export type Reaction = { kind: string; tag?: string; run: string[] };

export const REACTIONS_PATH = new URL('../../agents/local/reactions.json', import.meta.url).pathname;
const root = new URL('../../', import.meta.url).pathname;

export function loadReactions(path = REACTIONS_PATH): Reaction[] {
  if (!existsSync(path)) return [];
  const list = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(list)) throw new GanjineError('reactions must be a list');
  for (const r of list) {
    if (typeof r.kind !== 'string' || !Array.isArray(r.run) || !r.run.length || !r.run.every((a: unknown) => typeof a === 'string')) throw new GanjineError('a reaction needs kind and run');
    // A rebuild writes pages, so reacting to a page would never stop.
    if (r.kind === 'page_version') throw new GanjineError('a reaction cannot follow page_version');
  }
  return list;
}

export const matches = (r: Reaction, e: GanjineEvent) => e.kind === r.kind && (!r.tag || e.tags.includes(r.tag));

/** Several events arrive as one run, and a reaction never overlaps itself. The command is fixed: nothing from an event reaches it. */
export function reactor(reactions: Reaction[], execute: (r: Reaction) => Promise<void>, wait = 1000) {
  const state = reactions.map(() => ({ timer: undefined as NodeJS.Timeout | undefined, running: false, again: false }));
  const fire = async (i: number) => {
    const s = state[i];
    if (s.running) {
      s.again = true;
      return;
    }
    s.running = true;
    try {
      await execute(reactions[i]);
    } finally {
      s.running = false;
      if (s.again) {
        s.again = false;
        void fire(i);
      }
    }
  };
  return (e: GanjineEvent) => reactions.forEach((r, i) => {
    if (!matches(r, e)) return;
    clearTimeout(state[i].timer);
    state[i].timer = setTimeout(() => void fire(i), wait);
  });
}

/** A failed reaction is logged and leaves Ganjine running. */
export const execute = (r: Reaction) => new Promise<void>((resolve) => {
  const [command, ...args] = r.run;
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('error', (err) => { console.error(`reaction to ${r.kind} failed: ${err.message}`); resolve(); });
  child.on('exit', (code) => {
    console.error(`reaction to ${r.kind}: ${r.run.join(' ')} exited ${code}`);
    resolve();
  });
});
