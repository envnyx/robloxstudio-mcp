// Code Mode: expose the whole tool catalog through two tools, `search` and
// `execute`, instead of one MCP tool per Studio operation. The model searches
// for the TypeScript signatures it needs, then writes JavaScript that calls
// `studio.<tool>(input)` and returns only what matters. Design follows
// Cloudflare's "Code Mode" (https://blog.cloudflare.com/code-mode/) and its
// two-tool search/execute server (https://blog.cloudflare.com/code-mode-mcp/).
import { types } from 'node:util';
import vm from 'node:vm';

type JsonSchema = Record<string, unknown>;

export interface CodeModeTool {
  name: string;
  description: string;
  inputSchema: object;
}

export const CODE_MODE_INSTRUCTIONS = 'Code mode: Studio tools are not listed individually. Call search with keywords to get TypeScript signatures, then call execute with JavaScript that awaits studio.<tool_name>(input) and returns or console.logs only what you need. Tool names below are those studio methods.';

export function codeModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.ROBLOX_MCP_CODE_MODE ?? '');
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function docComment(text: unknown, indent: string): string {
  return typeof text === 'string' && text ? `${indent}/** ${text.replace(/\*\//g, '*\\/')} */\n` : '';
}

/** Renders the subset of JSON Schema the tool catalog uses as a TypeScript type. */
export function schemaToTs(schema: unknown, indent = ''): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  const s = schema as JsonSchema;
  if (Array.isArray(s.enum)) return s.enum.map((value) => JSON.stringify(value)).join(' | ');
  if ('const' in s) return JSON.stringify(s.const);
  const union = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(union)) return union.map((branch) => schemaToTs(branch, indent)).join(' | ');
  if (Array.isArray(s.type)) return s.type.map((type) => schemaToTs({ ...s, type }, indent)).join(' | ');

  switch (s.type) {
    case 'string': return 'string';
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': {
      const item = schemaToTs(s.items, indent);
      return /^[\w"]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
    }
  }
  const properties = s.properties as Record<string, unknown> | undefined;
  if (!properties || Object.keys(properties).length === 0) {
    return s.type === 'object' || s.additionalProperties !== undefined ? 'Record<string, unknown>' : 'unknown';
  }
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const inner = `${indent}  `;
  const fields = Object.entries(properties).map(([name, child]) => {
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    const optional = required.has(name) ? '' : '?';
    return `${docComment((child as JsonSchema | undefined)?.description, inner)}${inner}${key}${optional}: ${schemaToTs(child, inner)};`;
  });
  return `{\n${fields.join('\n')}\n${indent}}`;
}

export function toolDeclaration(tool: CodeModeTool): string {
  return `${docComment(tool.description, '')}${tool.name}(input: ${schemaToTs(tool.inputSchema)}): Promise<any>;`;
}

/** Keyword search over tool names and descriptions; an empty query lists every tool. */
export function searchTools(tools: readonly CodeModeTool[], query: string, limit = 8): string {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (terms.length === 0) {
    return tools.map((tool) => `${tool.name}: ${tool.description}`).join('\n');
  }
  const ranked = tools
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      const score = terms.reduce((sum, term) =>
        sum + (name.includes(term) ? 3 : 0) + (description.includes(term) ? 1 : 0), 0);
      return { tool, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
  if (ranked.length === 0) return `No tools match "${query}". Call search with an empty query to list every tool.`;
  return `declare const studio: {\n${ranked.map(({ tool }) => toolDeclaration(tool)).join('\n\n')}\n};`;
}

export interface CodeRunResult {
  result?: unknown;
  error?: string;
  logs: string[];
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  // isNativeError also matches errors created inside the vm context's realm.
  if (types.isNativeError(value)) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Runs model-written JavaScript with only `studio` and `console` in scope.
 * Accepts either a function body (`return await studio.x({})`) or an async
 * arrow/function expression, the shape Cloudflare's execute tool takes.
 *
 * shortcut: node:vm is not a security boundary (Node docs say so) and a
 * synchronous infinite loop after an `await` is not interrupted. Code mode is
 * opt-in for that reason; move to an isolate (isolated-vm, a worker with a
 * hard kill, or a Workers isolate) if untrusted clients ever get this tool.
 */
export async function runCode(
  code: string,
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  toolNames: ReadonlySet<string>,
  timeoutMs: number,
): Promise<CodeRunResult> {
  const logs: string[] = [];
  const log = (...values: unknown[]) => { logs.push(values.map(formatLogValue).join(' ')); };
  const studio = new Proxy(Object.create(null), {
    get: (_target, name) => (typeof name === 'string' && toolNames.has(name)
      ? (input: Record<string, unknown> = {}) => call(name, input)
      : undefined),
  });
  const context = vm.createContext(
    { studio, console: { log, info: log, warn: log, error: log } },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const source = /^\s*async\b/.test(code) ? `(${code})()` : `(async () => {\n${code}\n})()`;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Code timed out after ${timeoutMs} ms.`)), timeoutMs);
  });
  try {
    const script = new vm.Script(source, { filename: 'code-mode.js' });
    // The vm timeout covers synchronous code; the race covers awaited tool calls.
    const running = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
    return { result: await Promise.race([running, timeout]), logs };
  } catch (error) {
    return { error: formatLogValue(error), logs };
  } finally {
    clearTimeout(timer);
  }
}
