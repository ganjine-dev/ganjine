import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadReactions, matches, reactor, type Reaction } from '../src/react.ts';

const event = (kind: string, tags: string[] = []) => ({ id: '1', kind, address: null, tags });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const file = (v: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), 'ganjine-react-')), 'reactions.json');
  writeFileSync(path, JSON.stringify(v));
  return path;
};

test('no file means no reactions', () => assert.deepEqual(loadReactions('/nonexistent/reactions.json'), []));
test('a reaction cannot follow pages', () => assert.throws(() => loadReactions(file([{ kind: 'page_version', run: ['x'] }])), /page_version/));
test('a reaction needs a command', () => assert.throws(() => loadReactions(file([{ kind: 'movement', run: [] }])), /kind and run/));

test('kind and tag must both match', () => {
  const r: Reaction = { kind: 'movement', tag: 'a', run: ['x'] };
  assert.equal(matches(r, event('movement', ['a'])), true);
  assert.equal(matches(r, event('movement')), false);
  assert.equal(matches(r, event('note', ['a'])), false);
});

test('a burst of events runs once', async () => {
  let runs = 0;
  const on = reactor([{ kind: 'movement', run: ['x'] }], async () => { runs++; }, 10);
  on(event('movement'));
  on(event('movement'));
  on(event('note'));
  await pause(40);
  assert.equal(runs, 1);
});

test('an event during a run causes one more run, not an overlap', async () => {
  let runs = 0;
  let active = 0;
  const on = reactor([{ kind: 'movement', run: ['x'] }], async () => {
    assert.equal(++active, 1);
    runs++;
    await pause(30);
    active--;
  }, 5);
  on(event('movement'));
  await pause(15);
  on(event('movement'));
  await pause(100);
  assert.equal(runs, 2);
});
