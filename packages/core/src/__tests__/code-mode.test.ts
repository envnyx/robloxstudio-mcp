import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CODE_MODE_MAX_PARALLEL_CALLS, runCode, schemaToTs, searchTools } from '../code-mode.js';
import { createToolServer, publicToolDefinition } from '../mcp-runtime.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import type { RobloxStudioTools } from '../tools/index.js';

async function connect(invoke: Parameters<typeof createToolServer>[0]['invoke'], codeMode: boolean) {
  const server = createToolServer({
    config: { name: 'test', version: '1.0.0', tools: TOOL_DEFINITIONS },
    getTools: () => ({}) as RobloxStudioTools,
    invoke,
    era: 'modern',
    codeMode,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const text = (result: { content?: unknown }) =>
  (result.content as Array<{ type: string; text?: string }>).find((block) => block.type === 'text')?.text ?? '';

describe('code mode', () => {
  test('renders JSON Schema as TypeScript', () => {
    expect(schemaToTs({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Instance path' },
        mode: { enum: ['a', 'b'] },
        ids: { type: 'array', items: { type: 'integer' } },
      },
      required: ['path'],
    })).toBe('{\n  /** Instance path */\n  path: string;\n  mode?: "a" | "b";\n  ids?: number[];\n}');
  });

  test('search ranks name matches and returns signatures', () => {
    const catalog = TOOL_DEFINITIONS.map(publicToolDefinition);
    const found = searchTools(catalog, 'script source', 3);
    expect(found).toContain('get_script_source(input:');
    expect(found.match(/\): Promise<any>;/g)).toHaveLength(3);
    expect(searchTools(catalog, 'zzzz-nothing')).toMatch(/No tools match/);
  });

  test('runs code with only studio and console in scope', async () => {
    const run = await runCode(
      'console.log("hi", {a: 1}); return [typeof process, typeof require, await studio.echo({ x: 2 })];',
      async (_name, input) => input.x,
      new Set(['echo']),
      1000,
    );
    expect(run).toEqual({ result: ['undefined', 'undefined', 2], logs: ['hi {"a":1}'] });
    expect((await runCode('async () => 7', async () => 0, new Set(), 1000)).result).toBe(7);
    expect((await runCode('while (true) {}', async () => 0, new Set(), 50)).error).toMatch(/timed out/);
    expect((await runCode('throw new TypeError("boom")', async () => 0, new Set(), 1000)).error).toBe('TypeError: boom');
  });

  test('exposes only search and execute, and execute chains tool calls', async () => {
    const calls: string[] = [];
    const { client, close } = await connect(async (_tools, name, args) => {
      calls.push(name);
      if (name === 'get_place_info') return { content: [{ type: 'text', text: JSON.stringify({ placeId: 123, placeName: 'Run' }) }] };
      if (name === 'get_script_source') return { content: [{ type: 'text', text: JSON.stringify({ error: `missing ${String(args.instancePath)}` }) }], isError: true };
      throw new Error(`unexpected ${name}`);
    }, true);
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toEqual(['search', 'execute']);

      const ok = await client.callTool({ name: 'execute', arguments: { code: 'const p = await studio.get_place_info({}); return p.placeId;' } });
      expect(ok.isError).toBeFalsy();
      expect(text(ok)).toBe('123');

      const failed = await client.callTool({ name: 'execute', arguments: { code: 'try { await studio.get_script_source({ instancePath: "game.X" }); } catch (e) { return e.message; }' } });
      expect(text(failed)).toContain('missing game.X');

      const invalid = await client.callTool({ name: 'execute', arguments: { code: 'await studio.get_script_source({});' } });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain('invalid input');
      expect(calls).toEqual(['get_place_info', 'get_script_source']);
    } finally {
      await close();
    }
  });

  test('search returns several exact tool names in one call, ignoring limit', () => {
    const catalog = TOOL_DEFINITIONS.map(publicToolDefinition);
    const found = searchTools(catalog, 'get_script_source edit_script_lines grep_scripts', 1);
    for (const name of ['get_script_source', 'edit_script_lines', 'grep_scripts']) {
      expect(found).toContain(`${name}(input:`);
    }
    expect(found.match(/\): Promise<any>;/g)).toHaveLength(3);
  });

  test('runs independent calls in parallel up to the cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let total = 0;
    const { client, close } = await connect(async () => {
      total++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { content: [{ type: 'text', text: JSON.stringify({ placeId: 1 }) }] };
    }, true);
    try {
      const result = await client.callTool({ name: 'execute', arguments: { code: 'const r = await Promise.all(Array.from({ length: 40 }, () => studio.get_place_info({}))); return r.length;' } });
      expect(text(result)).toBe('40');
      expect(total).toBe(40);
      expect(maxInFlight).toBe(CODE_MODE_MAX_PARALLEL_CALLS);
    } finally {
      await close();
    }
  });

  test('Promise.allSettled keeps results when one parallel call fails', async () => {
    const { client, close } = await connect(async (_tools, name) => (name === 'get_script_source'
      ? { content: [{ type: 'text', text: JSON.stringify({ error: 'missing' }) }], isError: true }
      : { content: [{ type: 'text', text: JSON.stringify({ placeId: 1 }) }] }), true);
    try {
      const result = await client.callTool({ name: 'execute', arguments: { code: 'const r = await Promise.allSettled([studio.get_place_info({}), studio.get_script_source({ instancePath: "game.X" })]); return r.map(x => x.status);' } });
      expect(text(result)).toBe('["fulfilled","rejected"]');
    } finally {
      await close();
    }
  });

  test('cuts the tools/list payload by over 90%', async () => {
    const size = async (codeMode: boolean) => {
      const { client, close } = await connect(async () => ({ content: [] }), codeMode);
      try {
        return JSON.stringify((await client.listTools()).tools).length;
      } finally {
        await close();
      }
    };
    const full = await size(false);
    const code = await size(true);
    console.log(`tools/list JSON: ${full} chars full, ${code} chars code mode`);
    expect(code / full).toBeLessThan(0.1);
  });
});
