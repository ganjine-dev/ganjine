import { execFileSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Db } from '../db.ts';
import { tx, GanjineError } from '../db.ts';
import { putRecord } from '../records.ts';

export const TOOL_NAMES = ['read_records', 'write_record', 'write_page', 'read_categories'] as const;

export interface AgentConfig {
  tools: string[];
  /** Page address prefixes this agent may write. */
  pages: string[];
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeout_seconds: number;
  max_turns: number;
  max_budget_usd: number;
}

export interface Instruction {
  system: string;
  config: AgentConfig;
  inputSchema: object;
}

const DEFAULTS = { pages: [], model: 'claude-opus-5-5', effort: 'medium', timeout_seconds: 300, max_turns: 20, max_budget_usd: 1 };

export const repoRoot = () => new URL('../../../', import.meta.url).pathname;

const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function parseConfig(text: string): AgentConfig {
  const config = { ...DEFAULTS, ...JSON.parse(text) };
  if (!Array.isArray(config.tools)) throw new GanjineError('tools.json: tools must be a list');
  const unknown = config.tools.filter((t: string) => !(TOOL_NAMES as readonly string[]).includes(t));
  if (unknown.length) throw new GanjineError(`tools.json: unknown tools: ${unknown.join(', ')}`);
  return config;
}

/** Reads the instruction exactly as committed at `sha`, whatever the working tree holds. */
export function readInstruction(root: string, ref: string, sha: string): Instruction {
  const read = (file: string) => {
    try {
      return git(root, 'show', `${sha}:agents/${ref}/${file}`);
    } catch {
      throw new GanjineError(`agents/${ref}/${file} is not committed at ${sha}`);
    }
  };
  const inputSchema = JSON.parse(read('input.schema.json'));
  new Ajv2020({ strict: false }).compile(inputSchema);
  return { system: read('INSTRUCTION.md'), config: parseConfig(read('tools.json')), inputSchema };
}

export function checkInput(instruction: Instruction, input: unknown) {
  const validate = new Ajv2020({ strict: false }).compile(instruction.inputSchema);
  if (!validate(input)) throw new GanjineError(`input does not match input.schema.json: ${validate.errors![0].instancePath} ${validate.errors![0].message}`);
}

/** Pins an agent to the current commit. Registering again moves it to a newer commit. */
export async function registerAgent(db: Db, ref: string, root = repoRoot()) {
  const m = /^(temporal|asset)\/([a-z0-9][a-z0-9-]*)$/.exec(ref);
  if (!m) throw new GanjineError(`invalid agent ref: ${ref} (expected temporal/<name> or asset/<name>)`);
  if (git(root, 'status', '--porcelain', '--', `agents/${ref}`).trim()) {
    throw new GanjineError(`agents/${ref} has uncommitted changes; commit first so the run is reproducible`);
  }
  const sha = git(root, 'rev-parse', 'HEAD').trim();
  readInstruction(root, ref, sha);
  const [, kind, name] = m;
  const instructionRef = `${ref}@${sha}`;
  return tx(db, async () => {
    const { rows } = await db.query(
      `INSERT INTO agents (name, kind, instruction_ref) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET kind = $2, instruction_ref = $3 RETURNING *`,
      [name, kind, instructionRef],
    );
    await putRecord(db, { kind: 'agent.registered', payload: { name, kind, instruction_ref: instructionRef } });
    return rows[0];
  });
}

export function loadAgentInstruction(root: string, instructionRef: string) {
  const [ref, sha] = instructionRef.split('@');
  return readInstruction(root, ref, sha);
}

export const listAgents = async (db: Db) => (await db.query('SELECT * FROM agents ORDER BY name')).rows;
