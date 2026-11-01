import { z } from 'zod';
import type { BlobStore } from '../blobs.ts';
import { categoryTree } from '../categories.ts';
import type { Db } from '../db.ts';
import { GanjineError } from '../db.ts';
import { resolveItem } from '../items.ts';
import { putPage } from '../pages.ts';
import { putRecord, queryRecords } from '../records.ts';
import type { AgentConfig } from './instructions.ts';

export interface GanjineTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (args: any) => Promise<unknown>;
}

interface Scope {
  db: Db;
  store: BlobStore;
  runId: string;
  agent: string;
  config: AgentConfig;
}

// Framework-owned record kinds an agent may not forge.
const RESERVED = /^(run\.|agent\.|schedule\.|item\.|category\.|session\.|page_version$)/;

const itemId = async (db: Db, ref?: string) => (ref ? (await resolveItem(db, ref)).id : undefined);

/** Every tool is bound to one run: agents cannot choose their run, identity or scope. */
export function buildTools({ db, store, runId, agent, config }: Scope): GanjineTool[] {
  const all: GanjineTool[] = [
    {
      name: 'read_records',
      description: 'Read stored records, newest first. Dates are YYYY-MM-DD in UTC.',
      shape: {
        kind: z.string().optional(),
        item: z.string().optional().describe('Item name'),
        tags: z.array(z.string()).optional().describe('All must match'),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      run: async (a) => queryRecords(db, { ...a, itemId: await itemId(db, a.item) }),
    },
    {
      name: 'write_record',
      description: 'Store one immutable record, attributed to this run.',
      shape: {
        kind: z.string().min(1),
        item: z.string().optional().describe('Item name'),
        tags: z.array(z.string()).optional(),
        payload: z.record(z.string(), z.unknown()),
      },
      run: async (a) => {
        if (RESERVED.test(a.kind)) throw new GanjineError(`record kind is reserved: ${a.kind}`);
        const record = await putRecord(db, { kind: a.kind, itemId: await itemId(db, a.item), runId, tags: a.tags, payload: a.payload });
        return { id: record.id };
      },
    },
    {
      name: 'write_page',
      description: 'Write a new version of a page. Blocks follow docs/content-contract.md.',
      shape: {
        address: z.string(),
        as_of: z.string().describe('The data date, YYYY-MM-DD'),
        summary: z.string().describe('One line for the version timeline'),
        inputs_used: z.array(z.string()).optional().describe('Record ids this content depends on'),
        blocks: z.array(z.record(z.string(), z.unknown())),
      },
      run: async (a) => {
        if (!config.pages.some((prefix) => a.address === prefix || a.address.startsWith(`${prefix.replace(/\/$/, '')}/`))) {
          throw new GanjineError(`this agent may not write ${a.address}`);
        }
        const version = await putPage(db, {
          contract_version: 1,
          address: a.address,
          as_of: a.as_of,
          produced_by: { agent, run_id: runId },
          inputs_used: a.inputs_used ?? [],
          summary: a.summary,
          blocks: a.blocks,
        }, store);
        return { id: version.id, address: version.address, as_of: version.as_of };
      },
    },
    {
      name: 'read_categories',
      description: 'Read the category tree, its edges and which items belong where.',
      shape: {},
      run: () => categoryTree(db),
    },
  ];
  return all.filter((t) => config.tools.includes(t.name));
}
