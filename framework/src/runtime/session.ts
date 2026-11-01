import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GanjineError } from '../db.ts';
import type { Session } from './run.ts';

/** Optional, because it is not free software. Only agent runs need it. See NOTICE. */
const loadSdk = async () => {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new GanjineError('agent runs need @anthropic-ai/claude-agent-sdk, an optional package: run npm install in framework/');
  }
};

const clip = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A real Claude session with nothing but the granted Ganjine tools: no shell, files, web, user settings or other MCP servers. */
export const claudeSession: Session = async ({ system, prompt, config, tools, log, signal }) => {
  const { createSdkMcpServer, query, tool } = await loadSdk();
  const server = createSdkMcpServer({
    name: 'ganjine',
    tools: tools.map((t) =>
      tool(t.name, t.description, t.shape, async (args) => {
        try {
          const result = await t.run(args);
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
        }
      })),
  });
  const abortController = new AbortController();
  signal.addEventListener('abort', () => abortController.abort());
  const cwd = await mkdtemp(join(tmpdir(), 'ganjine-run-'));
  const { PATH, HOME, ANTHROPIC_API_KEY, USER, TMPDIR } = process.env;
  try {
    let meta: Record<string, unknown> = {};
    for await (const message of query({
      prompt,
      options: {
        systemPrompt: system,
        model: config.model,
        effort: config.effort,
        maxTurns: config.max_turns,
        maxBudgetUsd: config.max_budget_usd,
        tools: [],
        mcpServers: { ganjine: server },
        strictMcpConfig: true,
        allowedTools: tools.map((t) => `mcp__ganjine__${t.name}`),
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        cwd,
        env: { PATH, HOME, ANTHROPIC_API_KEY, USER, TMPDIR },
        abortController,
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        await log('info', `session started: ${message.model}, tools: ${message.tools.join(', ') || 'none'}`);
      } else if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) await log('info', clip(block.text));
          if (block.type === 'tool_use') await log('info', clip(`tool ${block.name.replace('mcp__ganjine__', '')} ${JSON.stringify(block.input)}`));
        }
      } else if (message.type === 'result') {
        meta = { cost_usd: message.total_cost_usd, turns: message.num_turns };
        if (message.subtype !== 'success') {
          throw new GanjineError(`session ended with ${message.subtype}: ${'errors' in message ? message.errors.join('; ') : ''}`);
        }
        if (message.is_error) throw new GanjineError(`session failed: ${clip(message.result, 500)}`);
      }
    }
    return { meta };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
