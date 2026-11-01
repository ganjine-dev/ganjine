import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { GanjineError } from './db.ts';

const schema = JSON.parse(readFileSync(new URL('../../docs/content-contract.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validate = ajv.compile(schema);

export interface PageContent {
  contract_version: 1;
  address: string;
  as_of: string;
  produced_by: { agent: string; run_id?: string };
  inputs_used: string[];
  summary: string;
  blocks: Block[];
}

export type Block = { kind: string; [field: string]: any };

/** Schema plus what the schema cannot express locally. */
export function checkContent(content: unknown): PageContent {
  if (!validate(content)) {
    const blocks = validate.errors!.filter((e) => e.instancePath.startsWith('/blocks/'));
    const detail = (blocks.length ? blocks : validate.errors!).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message}`);
    throw new GanjineError(`content contract violation:\n  ${detail.join('\n  ')}`);
  }
  const page = content as PageContent;
  page.blocks.forEach((b, i) => {
    if (b.kind !== 'table' || !b.rows) return;
    const width = b.columns.length;
    const bad = b.rows.findIndex((r: unknown[]) => r.length !== width);
    if (bad >= 0) throw new GanjineError(`content contract violation: /blocks/${i} row ${bad} does not have ${width} cells`);
  });
  return page;
}

/** Every record id a page version depends on. */
export function recordRefs(page: PageContent): string[] {
  const refs = new Set(page.inputs_used);
  for (const b of page.blocks) {
    if (b.kind === 'table' && b.record) refs.add(b.record);
    if (b.kind === 'chart' && b.data?.record) refs.add(b.data.record);
  }
  return [...refs];
}

export const blobRefs = (page: PageContent): string[] =>
  page.blocks.filter((b) => b.kind === 'embed').map((b) => b.blob);
