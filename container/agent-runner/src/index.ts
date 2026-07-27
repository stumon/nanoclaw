/**
 * NanoClaw Agent Runner (OpenAI-compatible)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses OpenAI-compatible API for LLM calls with tool-use agent loop.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionContentPart, ChatCompletionTool, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const MAX_TOOL_ITERATIONS = 50;
const MAX_TOOL_OUTPUT_CHARS = 30000;
const CWD = '/workspace/group';
const SESSION_HISTORY_PATH = path.join(CWD, '.session_history.json');
const COMPACTION_TOKEN_THRESHOLD = 60000;
const COMPACTION_KEEP_RATIO = 0.2;

// ─── Multi-Agent State ───────────────────────────────────────────────────────

interface BackgroundTask {
  id: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
}
const backgroundTasks = new Map<string, BackgroundTask>();

interface TeammateState {
  name: string;
  role: string;
  status: 'active' | 'stopped';
  conversationHistory: ChatCompletionMessageParam[];
  pendingInbox: string[];
  outbox: string[];
  processing: boolean;
}
const teammates = new Map<string, TeammateState>();

// Module-level references set in main(), used by team/background tool execution
let moduleClient: OpenAI;
let moduleModelName: string;
let moduleMcpClient: McpClient | null = null;
let moduleGmailClient: McpClient | null = null;
let moduleTools: ChatCompletionTool[] = [];

const TEAM_EXCLUDED_TOOLS = ['Task', 'TeamCreate', 'SendMessage', 'ReadTeamMessages', 'TeamShutdown', 'BackgroundTaskStatus'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ─── MCP Client ──────────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpClient {
  process: ChildProcess;
  tools: McpTool[];
  nextId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
  buffer: string;
}

function startMcpServer(mcpServerPath: string, env: Record<string, string>, command?: string, args?: string[]): Promise<McpClient> {
  return new Promise((resolve, reject) => {
    const cmd = command || 'node';
    const cmdArgs = args || [mcpServerPath];
    const proc = spawn(cmd, cmdArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    const client: McpClient = {
      process: proc,
      tools: [],
      nextId: 1,
      pending: new Map(),
      buffer: '',
    };

    proc.stderr?.on('data', (data: Buffer) => {
      log(`[mcp-stderr] ${data.toString().trim()}`);
    });

    proc.stdout?.on('data', (data: Buffer) => {
      client.buffer += data.toString();
      let newlineIdx: number;
      while ((newlineIdx = client.buffer.indexOf('\n')) !== -1) {
        const line = client.buffer.slice(0, newlineIdx).trim();
        client.buffer = client.buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && client.pending.has(msg.id)) {
            const { resolve: res } = client.pending.get(msg.id)!;
            client.pending.delete(msg.id);
            res(msg);
          }
        } catch {
          log(`[mcp] non-JSON line: ${line.slice(0, 200)}`);
        }
      }
    });

    proc.on('error', (err) => {
      log(`MCP server error: ${err.message}`);
      reject(err);
    });

    // Initialize MCP protocol
    const initMsg = {
      jsonrpc: '2.0',
      id: client.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nanoclaw-agent', version: '1.0.0' },
      },
    };

    const initPromise = new Promise<unknown>((res, rej) => {
      client.pending.set(initMsg.id, { resolve: res, reject: rej });
    });

    proc.stdin?.write(JSON.stringify(initMsg) + '\n');

    initPromise.then(async () => {
      // Send initialized notification
      proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // List tools
      const listId = client.nextId++;
      const listPromise = new Promise<unknown>((res, rej) => {
        client.pending.set(listId, { resolve: res, reject: rej });
      });
      proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} }) + '\n');

      const listResult = listPromise as Promise<{ result?: { tools?: McpTool[] } }>;
      const result = await listResult;
      client.tools = (result as { result?: { tools?: McpTool[] } }).result?.tools || [];
      log(`MCP tools discovered: ${client.tools.map(t => t.name).join(', ')}`);
      resolve(client);
    }).catch(reject);

    setTimeout(() => reject(new Error('MCP init timeout')), 10000);
  });
}

async function callMcpTool(client: McpClient, toolName: string, args: Record<string, unknown>): Promise<string> {
  const id = client.nextId++;
  const callPromise = new Promise<unknown>((resolve, reject) => {
    client.pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (client.pending.has(id)) {
        client.pending.delete(id);
        reject(new Error(`MCP tool call timeout: ${toolName}`));
      }
    }, 30000);
  });

  client.process.stdin?.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  }) + '\n');

  const result = await callPromise as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
  if (result.error) {
    return `Error: ${result.error.message || JSON.stringify(result.error)}`;
  }
  const content = result.result?.content || [];
  return content.map((c: { text?: string }) => c.text || '').join('\n');
}

function closeMcpClient(client: McpClient): void {
  try {
    client.process.stdin?.end();
    client.process.kill();
  } catch { /* ignore */ }
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const BUILTIN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a bash command in the working directory. Use for running scripts, installing packages, git operations, file manipulation, etc. Commands run as the container user. Timeout: 120 seconds.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file from the filesystem. Returns the file contents. For large files, use offset and limit to read specific sections.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path to read' },
          offset: { type: 'number', description: 'Line number to start reading from (1-based). Optional.' },
          limit: { type: 'number', description: 'Maximum number of lines to read. Optional.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path to write' },
          content: { type: 'string', description: 'The content to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Edit a file by replacing an exact string with a new string. The old_string must match exactly (including whitespace and indentation). Use for targeted edits without rewriting the whole file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          old_string: { type: 'string', description: 'The exact string to find and replace' },
          new_string: { type: 'string', description: 'The replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Search for files matching a glob pattern. Returns matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.json")' },
          cwd: { type: 'string', description: 'Directory to search in. Defaults to working directory.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'File or directory to search in. Defaults to working directory.' },
          include: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: 'Search the web using Tavily API. Returns AI-generated answer and source links. Use for current events, news, real-time information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Max results (default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'FetchURL',
      description: 'Fetch and extract the main text content from any URL. Works with WeChat articles (mp.weixin.qq.com), blogs, news sites, and most web pages. Returns the page title and article text. Use this when a user sends a URL and asks about its content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          max_chars: { type: 'number', description: 'Maximum characters to return (default 30000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Task',
      description: 'Launch a sub-agent to handle a specific task independently. The sub-agent has access to all tools (Bash, Read, Write, WebSearch, etc.) but cannot launch further sub-agents. Use this to parallelize work — call multiple Task tools in a single turn and they will execute concurrently. Set run_in_background=true to launch asynchronously and check results later with BackgroundTaskStatus.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short description of what this sub-agent should do (3-5 words)' },
          prompt: { type: 'string', description: 'Detailed instructions for the sub-agent. Include all necessary context — the sub-agent has no access to the parent conversation.' },
          run_in_background: { type: 'string', description: 'Set to "true" to launch the sub-agent in the background and return immediately with a task_id. Use BackgroundTaskStatus to check results later. Default: not set (synchronous).' },
        },
        required: ['description', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'BackgroundTaskStatus',
      description: 'Check the status and results of background tasks launched with Task(run_in_background=true). Returns status (running/completed/failed) and result text for completed tasks. Call with task_id for a specific task or without arguments for all tasks.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Specific task ID to check. If omitted, returns status of all background tasks.' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TeamCreate',
      description: 'Create a persistent teammate agent. Teammates maintain their own conversation history across multiple messages, unlike Task which is one-shot. Use SendMessage to communicate with teammates, ReadTeamMessages to get their replies, and TeamShutdown to dismiss them.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name for the teammate (e.g. "researcher", "coder", "reviewer")' },
          role: { type: 'string', description: 'Description of the teammate\'s role and expertise. This becomes part of their system prompt.' },
        },
        required: ['name', 'role'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'SendMessage',
      description: 'Send a message to a teammate. The teammate will process the message asynchronously using their own agent loop and tools. Their reply will be available via ReadTeamMessages.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Name of the teammate to send the message to' },
          message: { type: 'string', description: 'The message content to send' },
        },
        required: ['to', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ReadTeamMessages',
      description: 'Read all unread messages from teammates. Returns messages from all teammates that have replied since the last read. Messages are cleared after reading.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Teammate name to filter messages from. If set to "all" or omitted, returns messages from all teammates.' },
        },
        required: ['filter'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TeamShutdown',
      description: 'Shut down a teammate. Their conversation history is discarded. Use when a teammate\'s task is complete.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the teammate to shut down' },
        },
        required: ['name'],
      },
    },
  },
];

// ─── Schema Sanitizer ────────────────────────────────────────────────────────

function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...schema };
  delete cleaned['default'];
  delete cleaned['$schema'];
  delete cleaned['additionalProperties'];
  if (cleaned.properties && typeof cleaned.properties === 'object') {
    const props = { ...(cleaned.properties as Record<string, unknown>) };
    for (const [key, val] of Object.entries(props)) {
      if (val && typeof val === 'object') {
        props[key] = sanitizeSchema(val as Record<string, unknown>);
      }
    }
    cleaned.properties = props;
  }
  return cleaned;
}

// ─── Tool Execution ──────────────────────────────────────────────────────────

const SECRET_ENV_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n...[truncated, ${text.length - maxLen} more chars]`;
}

function resolvePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(CWD, p);
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'Bash': {
        const command = args.command as string;
        if (!command) return 'Error: command is required';
        const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
        try {
          const result = execSync(unsetPrefix + command, {
            cwd: CWD,
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return truncate(result || '(no output)', MAX_TOOL_OUTPUT_CHARS);
        } catch (err: unknown) {
          const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
          const stdout = execErr.stdout || '';
          const stderr = execErr.stderr || '';
          return truncate(
            `Exit code: ${execErr.status || 1}\nStdout:\n${stdout}\nStderr:\n${stderr}`,
            MAX_TOOL_OUTPUT_CHARS,
          );
        }
      }

      case 'Read': {
        const filePath = resolvePath(args.path as string);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const offset = (args.offset as number) || 1;
        const limit = (args.limit as number) || lines.length;
        const startIdx = Math.max(0, offset - 1);
        const selected = lines.slice(startIdx, startIdx + limit);
        const numbered = selected.map((line, i) => `${String(startIdx + i + 1).padStart(6)}|${line}`);
        return truncate(numbered.join('\n'), MAX_TOOL_OUTPUT_CHARS);
      }

      case 'Write': {
        const filePath = resolvePath(args.path as string);
        const content = args.content as string;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return `Successfully wrote ${content.length} bytes to ${filePath}`;
      }

      case 'Edit': {
        const filePath = resolvePath(args.path as string);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
        const content = fs.readFileSync(filePath, 'utf-8');
        const oldStr = args.old_string as string;
        const newStr = args.new_string as string;
        const idx = content.indexOf(oldStr);
        if (idx === -1) return 'Error: old_string not found in file. Make sure it matches exactly.';
        const secondIdx = content.indexOf(oldStr, idx + oldStr.length);
        if (secondIdx !== -1) return 'Error: old_string appears multiple times. Provide more context to make it unique.';
        const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
        fs.writeFileSync(filePath, updated);
        return `Successfully edited ${filePath}`;
      }

      case 'Glob': {
        const pattern = args.pattern as string;
        const searchCwd = resolvePath((args.cwd as string) || CWD);
        try {
          const result = execSync(
            `find . -path './.git' -prune -o -path './node_modules' -prune -o -name '${pattern.replace(/'/g, "\\'")}' -print 2>/dev/null | head -200`,
            { cwd: searchCwd, encoding: 'utf-8', timeout: 10_000 },
          );
          return result.trim() || '(no matches)';
        } catch {
          try {
            const result = execSync(
              `find . -path './.git' -prune -o -path './node_modules' -prune -o -print 2>/dev/null | grep -E '${pattern}' | head -200`,
              { cwd: searchCwd, encoding: 'utf-8', timeout: 10_000 },
            );
            return result.trim() || '(no matches)';
          } catch {
            return '(no matches)';
          }
        }
      }

      case 'Grep': {
        const pattern = args.pattern as string;
        const searchPath = resolvePath((args.path as string) || CWD);
        const include = args.include as string | undefined;
        let cmd = `grep -rn --color=never`;
        if (include) cmd += ` --include='${include.replace(/'/g, "\\'")}'`;
        cmd += ` -e '${pattern.replace(/'/g, "\\'")}' '${searchPath}' 2>/dev/null | head -100`;
        try {
          const result = execSync(cmd, { encoding: 'utf-8', timeout: 15_000, cwd: CWD });
          return truncate(result.trim() || '(no matches)', MAX_TOOL_OUTPUT_CHARS);
        } catch {
          return '(no matches)';
        }
      }

      case 'WebSearch': {
        const query = args.query as string;
        const maxResults = (args.max_results as number) || 5;
        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) return 'Error: TAVILY_API_KEY not configured';

        // Derive proxy base from OPENAI_BASE_URL (already rewritten to
        // http://192.168.64.1:8462/... by the host). The /__tavily/ prefix
        // tells the proxy to forward to api.tavily.com.
        const proxyOrigin = process.env.OPENAI_BASE_URL
          ? new URL(process.env.OPENAI_BASE_URL).origin
          : null;
        const tavilyUrl = proxyOrigin
          ? `${proxyOrigin}/__tavily/search`
          : 'https://api.tavily.com/search';

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const res = await fetch(tavilyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              query,
              max_results: maxResults,
              search_depth: 'advanced',
              include_answer: true,
              include_raw_content: false,
            }),
            signal: controller.signal,
          });

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            return `Search API error: HTTP ${res.status} ${text.slice(0, 200)}`;
          }

          const data = await res.json() as {
            answer?: string;
            results?: Array<{ title?: string; url?: string; content?: string }>;
          };

          const parts: string[] = [];
          if (data.answer) {
            parts.push('Answer:', data.answer, '');
          }
          parts.push('Sources:');
          for (const r of data.results || []) {
            parts.push(`  - ${r.title || 'No title'}`);
            parts.push(`    ${r.url || ''}`);
            if (r.content) parts.push(`    ${r.content.slice(0, 300)}`);
            parts.push('');
          }
          return truncate(parts.join('\n'), MAX_TOOL_OUTPUT_CHARS);
        } finally {
          clearTimeout(timeout);
        }
      }

      case 'FetchURL': {
        const url = args.url as string;
        const maxChars = (args.max_chars as number) || 30000;
        if (!url) return 'Error: url is required';

        const proxyOrigin = process.env.OPENAI_BASE_URL
          ? new URL(process.env.OPENAI_BASE_URL).origin
          : null;
        const fetchEndpoint = proxyOrigin
          ? `${proxyOrigin}/__fetch/`
          : null;

        if (!fetchEndpoint) {
          return 'Error: FetchURL requires the host proxy (OPENAI_BASE_URL not set)';
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 35_000);
        try {
          const res = await fetch(fetchEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, maxChars }),
            signal: controller.signal,
          });

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            return `FetchURL error: HTTP ${res.status} ${text.slice(0, 300)}`;
          }

          const data = await res.json() as { title?: string; content?: string; error?: string };
          if (data.error) return `FetchURL error: ${data.error}`;

          const parts: string[] = [];
          if (data.title) parts.push(`Title: ${data.title}`, '');
          if (data.content) parts.push(data.content);
          return truncate(parts.join('\n') || '(empty page)', MAX_TOOL_OUTPUT_CHARS);
        } finally {
          clearTimeout(timeout);
        }
      }

      case 'BackgroundTaskStatus': {
        const taskId = args.task_id as string | undefined;
        if (taskId) {
          const task = backgroundTasks.get(taskId);
          if (!task) return `No background task found with id: ${taskId}`;
          return JSON.stringify(task);
        }
        if (backgroundTasks.size === 0) return 'No background tasks.';
        const all = Array.from(backgroundTasks.values()).map(t => ({
          id: t.id, description: t.description, status: t.status,
          result: t.status !== 'running' ? t.result?.slice(0, 500) : undefined,
        }));
        return JSON.stringify(all, null, 2);
      }

      case 'TeamCreate': {
        const tmName = args.name as string;
        const role = args.role as string;
        if (!tmName || !role) return 'Error: name and role are required';
        if (teammates.has(tmName)) return `Teammate "${tmName}" already exists. Use SendMessage to communicate.`;
        teammates.set(tmName, {
          name: tmName,
          role,
          status: 'active',
          conversationHistory: [],
          pendingInbox: [],
          outbox: [],
          processing: false,
        });
        log(`Teammate "${tmName}" created with role: ${role}`);
        return `Teammate "${tmName}" created. Use SendMessage to assign tasks.`;
      }

      case 'SendMessage': {
        const to = args.to as string;
        const message = args.message as string;
        if (!to || !message) return 'Error: to and message are required';
        const tm = teammates.get(to);
        if (!tm) return `Teammate "${to}" not found. Available: ${Array.from(teammates.keys()).join(', ') || '(none)'}`;
        if (tm.status === 'stopped') return `Teammate "${to}" has been shut down.`;
        tm.pendingInbox.push(message);
        log(`Message queued to teammate "${to}" (${message.length} chars)`);
        processTeammateMessage(to).catch(err => log(`Teammate "${to}" processing error: ${err}`));
        return `Message sent to "${to}". Their reply will be available via ReadTeamMessages.`;
      }

      case 'ReadTeamMessages': {
        const collected: string[] = [];
        for (const [name, tm] of teammates) {
          while (tm.outbox.length > 0) {
            collected.push(tm.outbox.shift()!);
          }
          if (tm.processing) {
            collected.push(`[${name}]: (still processing...)`);
          }
        }
        if (collected.length === 0) return 'No unread messages from teammates.';
        return collected.join('\n\n');
      }

      case 'TeamShutdown': {
        const tmName = args.name as string;
        if (!tmName) return 'Error: name is required';
        const tm = teammates.get(tmName);
        if (!tm) return `Teammate "${tmName}" not found.`;
        tm.status = 'stopped';
        tm.pendingInbox.length = 0;
        log(`Teammate "${tmName}" shut down`);
        const remaining = tm.outbox.length > 0
          ? ` They had ${tm.outbox.length} unread message(s) — use ReadTeamMessages to retrieve them.`
          : '';
        return `Teammate "${tmName}" has been shut down.${remaining}`;
      }

      default:
        return `Error: Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Teammate Processing ─────────────────────────────────────────────────────

async function processTeammateMessage(name: string): Promise<void> {
  const tm = teammates.get(name);
  if (!tm || tm.processing || tm.status === 'stopped') return;
  tm.processing = true;

  try {
    while (tm.pendingInbox.length > 0) {
      const msg = tm.pendingInbox.shift()!;
      tm.conversationHistory.push({ role: 'user', content: `[Message from leader]: ${msg}` });

      const subSystemPrompt = `You are "${tm.name}", a team member with role: ${tm.role}.\nWorking directory: ${CWD}\nYou work as part of a team. Process the leader's request and return a concise result. You cannot create sub-agents or teams.`;
      const apiMessages: ChatCompletionMessageParam[] = [
        { role: 'system', content: subSystemPrompt },
        ...tm.conversationHistory,
      ];
      const toolsForTeammate = moduleTools.filter(t => !TEAM_EXCLUDED_TOOLS.includes(t.function.name));

      const result = await runAgentLoop(moduleClient, moduleModelName, apiMessages, toolsForTeammate, moduleMcpClient, moduleGmailClient);

      tm.conversationHistory.length = 0;
      for (let i = 1; i < apiMessages.length; i++) {
        tm.conversationHistory.push(apiMessages[i]);
      }

      tm.outbox.push(`[${tm.name}]: ${result || '(no output)'}`);
      log(`Teammate "${tm.name}" produced response (${(result || '').length} chars)`);
    }
  } catch (err) {
    tm.outbox.push(`[${tm.name}] Error: ${err instanceof Error ? err.message : String(err)}`);
    log(`Teammate "${tm.name}" error: ${err}`);
  } finally {
    tm.processing = false;
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(containerInput: ContainerInput): string {
  const parts: string[] = [];

  parts.push(`You are a helpful AI assistant running inside a sandboxed container. You have access to tools to interact with the filesystem, run commands, and communicate with the user.

Working directory: ${CWD}
Group: ${containerInput.groupFolder}
${containerInput.assistantName ? `Your name: ${containerInput.assistantName}` : ''}

You can use tools to accomplish tasks. When done, provide your final response as plain text.
Keep responses concise and actionable. Use tools proactively to complete tasks rather than just suggesting what to do.`);

  // Load group CLAUDE.md
  const groupClaudeMd = path.join(CWD, 'CLAUDE.md');
  if (fs.existsSync(groupClaudeMd)) {
    try {
      parts.push('\n--- Group Memory (CLAUDE.md) ---\n' + fs.readFileSync(groupClaudeMd, 'utf-8'));
    } catch { /* ignore */ }
  }

  // Load global CLAUDE.md (shared instructions for all groups)
  {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      try {
        parts.push('\n--- Global Memory ---\n' + fs.readFileSync(globalClaudeMd, 'utf-8'));
      } catch { /* ignore */ }
    }
  }

  // Load extra directory CLAUDE.md files
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const extraClaudeMd = path.join(extraBase, entry, 'CLAUDE.md');
      if (fs.existsSync(extraClaudeMd)) {
        try {
          parts.push(`\n--- ${entry} Context ---\n` + fs.readFileSync(extraClaudeMd, 'utf-8'));
        } catch { /* ignore */ }
      }
    }
  }

  return parts.join('\n');
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────

async function runAgentLoop(
  client: OpenAI,
  modelName: string,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  mcpClient: McpClient | null,
  gmailClient: McpClient | null = null,
): Promise<string | null> {
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    log(`Agent iteration ${iterations}, messages: ${messages.length}`);

    let response: OpenAI.Chat.Completions.ChatCompletion | undefined;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await client.chat.completions.create({
          model: modelName,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          max_tokens: 8192,
        });
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRetryable = /connect|network|timeout|econnre|socket|fetch failed/i.test(errMsg);
        if (isRetryable && attempt < maxRetries) {
          log(`API error (attempt ${attempt}/${maxRetries}), retrying in 3s: ${errMsg}`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        log(`API error (attempt ${attempt}/${maxRetries}): ${errMsg}`);
        return `Error calling LLM API: ${errMsg}`;
      }
    }

    if (!response) {
      log('All retry attempts exhausted with no response');
      return 'Error calling LLM API: all retries failed';
    }

    const choice = response.choices[0];
    if (!choice) {
      log('No choices in response');
      return null;
    }

    const assistantMsg = choice.message;
    messages.push(assistantMsg as ChatCompletionMessageParam);

    if (choice.finish_reason === 'tool_calls' || (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0)) {
      const toolCalls = assistantMsg.tool_calls || [];
      log(`Tool calls: ${toolCalls.map((tc: ChatCompletionMessageToolCall) => tc.function.name).join(', ')}`);

      const taskCalls: ChatCompletionMessageToolCall[] = [];
      const regularCalls: ChatCompletionMessageToolCall[] = [];
      for (const tc of toolCalls) {
        if (tc.function.name === 'Task') {
          taskCalls.push(tc);
        } else {
          regularCalls.push(tc);
        }
      }

      const executeOneToolCall = async (toolCall: ChatCompletionMessageToolCall): Promise<{ id: string; result: string }> => {
        const fnName = toolCall.function.name;
        let fnArgs: Record<string, unknown>;
        try {
          fnArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          fnArgs = {};
          log(`Failed to parse args for ${fnName}: ${toolCall.function.arguments}`);
        }

        let result: string;

        if (fnName.startsWith('mcp__nanoclaw__') && mcpClient) {
          const mcpToolName = fnName.replace('mcp__nanoclaw__', '');
          log(`Calling MCP tool: ${mcpToolName}`);
          try {
            result = await callMcpTool(mcpClient, mcpToolName, fnArgs);
          } catch (err) {
            result = `MCP tool error: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else if (fnName.startsWith('mcp__gmail__') && gmailClient) {
          const mcpToolName = fnName.replace('mcp__gmail__', '');
          log(`Calling Gmail MCP tool: ${mcpToolName}`);
          try {
            result = await callMcpTool(gmailClient, mcpToolName, fnArgs);
          } catch (err) {
            result = `Gmail MCP tool error: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          log(`Executing tool: ${fnName}`);
          result = await executeTool(fnName, fnArgs);
        }

        log(`Tool ${fnName} result: ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`);
        return { id: toolCall.id, result };
      };

      const executeTaskCall = async (toolCall: ChatCompletionMessageToolCall): Promise<{ id: string; result: string }> => {
        let fnArgs: Record<string, unknown>;
        try {
          fnArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          fnArgs = {};
        }
        const desc = (fnArgs.description as string) || 'sub-task';
        const prompt = (fnArgs.prompt as string) || '';
        const runInBackground = fnArgs.run_in_background === 'true' || fnArgs.run_in_background === true;

        const toolsForSub = tools.filter(t => !TEAM_EXCLUDED_TOOLS.includes(t.function.name));
        const subSystemPrompt = `You are a sub-agent working on a specific task. You have access to all tools except launching further sub-agents or teams.\n\nWorking directory: ${CWD}\n\nComplete the task below and return a concise result.`;
        const subMessages: ChatCompletionMessageParam[] = [
          { role: 'system', content: subSystemPrompt },
          { role: 'user', content: prompt },
        ];

        if (runInBackground) {
          const taskId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          backgroundTasks.set(taskId, { id: taskId, description: desc, status: 'running' });
          log(`Launching background sub-agent: "${desc}" (${taskId})`);

          runAgentLoop(client, modelName, subMessages, toolsForSub, mcpClient, gmailClient)
            .then(result => {
              const task = backgroundTasks.get(taskId);
              if (task) { task.status = 'completed'; task.result = result || '(no output)'; }
              log(`Background task "${desc}" (${taskId}) completed`);
            })
            .catch(err => {
              const task = backgroundTasks.get(taskId);
              if (task) { task.status = 'failed'; task.result = err instanceof Error ? err.message : String(err); }
              log(`Background task "${desc}" (${taskId}) failed: ${err}`);
            });

          return { id: toolCall.id, result: JSON.stringify({ status: 'launched', task_id: taskId, description: desc }) };
        }

        log(`Launching sync sub-agent: "${desc}"`);
        try {
          const subResult = await runAgentLoop(client, modelName, subMessages, toolsForSub, mcpClient, gmailClient);
          log(`Sub-agent "${desc}" completed`);
          return { id: toolCall.id, result: subResult || '(sub-agent returned no output)' };
        } catch (err) {
          const errMsg = `Sub-agent "${desc}" failed: ${err instanceof Error ? err.message : String(err)}`;
          log(errMsg);
          return { id: toolCall.id, result: errMsg };
        }
      };

      // Execute regular tools sequentially
      for (const tc of regularCalls) {
        const { id, result } = await executeOneToolCall(tc);
        messages.push({ role: 'tool', tool_call_id: id, content: result });
      }

      // Execute Task calls in parallel
      if (taskCalls.length > 0) {
        log(`Executing ${taskCalls.length} Task call(s) in parallel`);
        const taskResults = await Promise.all(taskCalls.map(tc => executeTaskCall(tc)));
        for (const { id, result } of taskResults) {
          messages.push({ role: 'tool', tool_call_id: id, content: result });
        }
      }

      continue;
    }

    // No more tool calls — return the final text response
    const textResult = assistantMsg.content || null;
    log(`Final response: ${textResult ? textResult.slice(0, 200) : '(empty)'}${textResult && textResult.length > 200 ? '...' : ''}`);
    return textResult;
  }

  log(`Max iterations (${MAX_TOOL_ITERATIONS}) reached`);
  return 'I reached the maximum number of tool iterations. Here is what I accomplished so far.';
}

// ─── Multimodal (Vision) Support ─────────────────────────────────────────────

const IMAGE_TAG_RE = /\[Image:\s*([^\]]+)\]/g;

function loadImageAsBase64(relativePath: string): { base64: string; mime: string } | null {
  const absPath = path.isAbsolute(relativePath)
    ? relativePath
    : path.resolve(CWD, relativePath);
  try {
    const buf = fs.readFileSync(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    };
    log(`Loaded image: ${absPath} (${buf.length} bytes)`);
    return { base64: buf.toString('base64'), mime: mimeMap[ext] || 'image/jpeg' };
  } catch (err) {
    log(`Failed to load image ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

let _visionClient: OpenAI | null = null;
let _visionModel: string = '';

function getVisionConfig(secrets: Record<string, string>): { client: OpenAI; model: string } | null {
  const model = secrets.VISION_MODEL || process.env.VISION_MODEL;
  if (!model) return null;
  if (_visionClient && _visionModel === model) return { client: _visionClient, model };
  const apiKey = secrets.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = secrets.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL;
  if (!apiKey) return null;
  _visionClient = new OpenAI({ apiKey, baseURL: baseURL || undefined });
  _visionModel = model;
  return { client: _visionClient, model };
}

async function analyzeImageWithVL(
  visionClient: OpenAI,
  visionModel: string,
  base64: string,
  mime: string,
): Promise<string> {
  try {
    const res = await visionClient.chat.completions.create({
      model: visionModel,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请详细分析这张金融/券商APP截图。列出所有可见的持仓信息，包括：平台名称、每只股票/基金的名称、持仓数量、当前价格/市值、现金余额。用结构化格式输出，尽量精确。',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      }],
      max_tokens: 2000,
    });
    return res.choices[0]?.message?.content || '[Image analysis returned empty]';
  } catch (err) {
    log(`Vision analysis error: ${err instanceof Error ? err.message : String(err)}`);
    return `[Image analysis failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

async function parseMultimodalContent(
  text: string,
  secrets: Record<string, string>,
): Promise<ChatCompletionContentPart[] | string> {
  const matches = [...text.matchAll(IMAGE_TAG_RE)];
  if (matches.length === 0) return text;

  // If a dedicated vision model is configured, use it to pre-analyze images
  // and return text-only content (for models that don't support vision natively)
  const visionCfg = getVisionConfig(secrets);
  if (visionCfg) {
    log(`Using vision model ${visionCfg.model} to analyze ${matches.length} image(s)`);
    let result = text;
    for (const match of matches) {
      const relativePath = match[1].trim();
      const img = loadImageAsBase64(relativePath);
      if (img) {
        const analysis = await analyzeImageWithVL(visionCfg.client, visionCfg.model, img.base64, img.mime);
        result = result.replace(match[0], `[Screenshot Analysis - ${relativePath}]:\n${analysis}\n[End Analysis]`);
        log(`Vision analysis done for ${relativePath} (${analysis.length} chars)`);
      } else {
        result = result.replace(match[0], `[Image not found: ${relativePath}]`);
      }
    }
    return result;
  }

  // Fallback: embed images directly as multimodal content (requires vision-capable main model)
  const parts: ChatCompletionContentPart[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) {
      parts.push({ type: 'text', text: before.trim() });
    }

    const relativePath = match[1].trim();
    const img = loadImageAsBase64(relativePath);
    if (img) {
      parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } });
    } else {
      parts.push({ type: 'text', text: `[Image not found: ${relativePath}]` });
    }

    lastIndex = (match.index || 0) + match[0].length;
  }

  const after = text.slice(lastIndex);
  if (after.trim()) {
    parts.push({ type: 'text', text: after.trim() });
  }

  return parts.length === 1 && parts[0].type === 'text' ? (parts[0] as { type: 'text'; text: string }).text : parts;
}

// ─── Compaction ──────────────────────────────────────────────────────────────

function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part) chars += (part as { text: string }).text.length;
      }
    }
    if ('tool_calls' in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls as ChatCompletionMessageToolCall[]) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

async function compactHistory(
  client: OpenAI,
  modelName: string,
  history: ChatCompletionMessageParam[],
): Promise<ChatCompletionMessageParam[]> {
  const estimated = estimateTokens(history);
  if (estimated < COMPACTION_TOKEN_THRESHOLD || history.length < 6) {
    return history;
  }

  log(`Compaction triggered: ~${estimated} tokens, ${history.length} messages`);

  const keepCount = Math.max(4, Math.ceil(history.length * COMPACTION_KEEP_RATIO));
  const toCompact = history.slice(0, history.length - keepCount);
  const toKeep = history.slice(history.length - keepCount);

  const summaryLines: string[] = [];
  for (const msg of toCompact) {
    const role = msg.role;
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content.slice(0, 500);
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as Array<{ text?: string }>)
        .filter(p => p.text)
        .map(p => p.text!.slice(0, 300))
        .join(' ');
    }
    if ('tool_calls' in msg && msg.tool_calls) {
      const calls = (msg.tool_calls as ChatCompletionMessageToolCall[])
        .map(tc => tc.function.name)
        .join(', ');
      text += ` [tools: ${calls}]`;
    }
    if (text) summaryLines.push(`${role}: ${text}`);
  }

  try {
    const res = await client.chat.completions.create({
      model: modelName,
      messages: [
        {
          role: 'system',
          content: 'You are a conversation summarizer. Summarize the following conversation history into a concise summary preserving key facts, decisions, and context. Output only the summary in the same language as the conversation. Keep it under 800 words.',
        },
        {
          role: 'user',
          content: summaryLines.join('\n'),
        },
      ],
      max_tokens: 2048,
    });

    const summary = res.choices[0]?.message?.content || '';
    if (!summary) {
      log('Compaction: LLM returned empty summary, falling back to truncation');
      return history.slice(-keepCount);
    }

    log(`Compaction complete: ${toCompact.length} messages → summary (${summary.length} chars), kept ${toKeep.length} recent messages`);

    return [
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      { role: 'assistant', content: 'Understood, I have the context from our previous conversation.' },
      ...toKeep,
    ];
  } catch (err) {
    log(`Compaction LLM call failed: ${err instanceof Error ? err.message : String(err)}, falling back to truncation`);
    return history.slice(-keepCount);
  }
}

// ─── Session Persistence ─────────────────────────────────────────────────────

function saveSessionHistory(history: ChatCompletionMessageParam[]): void {
  try {
    const serializable = history.map(msg => {
      if (typeof msg.content === 'string' || msg.content === null) return msg;
      if (Array.isArray(msg.content)) {
        const textParts = (msg.content as Array<{ type: string; text?: string }>)
          .filter(p => p.type === 'text' && p.text)
          .map(p => p.text)
          .join('\n');
        return { ...msg, content: textParts };
      }
      return msg;
    });
    fs.writeFileSync(SESSION_HISTORY_PATH, JSON.stringify(serializable, null, 0));
    log(`Session history saved (${history.length} messages)`);
  } catch (err) {
    log(`Failed to save session history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadSessionHistory(): ChatCompletionMessageParam[] {
  try {
    if (!fs.existsSync(SESSION_HISTORY_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(SESSION_HISTORY_PATH, 'utf-8'));
    if (!Array.isArray(data)) return [];
    log(`Restored session history: ${data.length} messages`);
    return data;
  } catch (err) {
    log(`Failed to load session history: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ─── Run Query ───────────────────────────────────────────────────────────────

async function runQuery(
  prompt: string,
  containerInput: ContainerInput,
  client: OpenAI,
  modelName: string,
  allTools: ChatCompletionTool[],
  conversationHistory: ChatCompletionMessageParam[],
  systemPrompt: string,
  mcpClient: McpClient | null,
  gmailClient: McpClient | null = null,
): Promise<{ closedDuringQuery: boolean }> {
  // Poll IPC for _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query');
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // Add user message (with vision support for embedded images)
  const parsedContent = await parseMultimodalContent(prompt, containerInput.secrets || {});
  conversationHistory.push({ role: 'user', content: parsedContent as any });

  // Build messages for API call (system + conversation history)
  const apiMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
  ];

  try {
    const result = await runAgentLoop(client, modelName, apiMessages, allTools, mcpClient, gmailClient);

    // Sync conversation history with what the agent loop produced
    // (apiMessages[0] is system prompt, rest maps to conversationHistory)
    conversationHistory.length = 0;
    for (let i = 1; i < apiMessages.length; i++) {
      conversationHistory.push(apiMessages[i]);
    }

    // Compact conversation history if approaching token limit
    const compacted = await compactHistory(client, modelName, conversationHistory);
    if (compacted !== conversationHistory) {
      conversationHistory.length = 0;
      conversationHistory.push(...compacted);
    }

    // Save session to disk for resume
    saveSessionHistory(conversationHistory);

    writeOutput({
      status: 'success',
      result,
      newSessionId: containerInput.sessionId || `session-${Date.now()}`,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Query error: ${errMsg}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errMsg,
    });
  }

  ipcPolling = false;
  return { closedDuringQuery };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Build SDK env
  const secrets = containerInput.secrets || {};
  const apiKey = secrets.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = secrets.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL;
  const modelName = secrets.MODEL_NAME || process.env.MODEL_NAME || 'gpt-4o';

  // Export credentials so Bash tools and built-in tools (WebSearch) can read them
  if (secrets.APPID) process.env.APPID = secrets.APPID;
  if (secrets.APPSecret) process.env.APPSecret = secrets.APPSecret;
  if (secrets.TAVILY_API_KEY) process.env.TAVILY_API_KEY = secrets.TAVILY_API_KEY;
  if (baseURL) process.env.OPENAI_BASE_URL = baseURL;

  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'OPENAI_API_KEY not configured' });
    process.exit(1);
  }

  log(`Using model: ${modelName}, base URL: ${baseURL || '(default)'}`);

  const client = new OpenAI({
    apiKey,
    baseURL: baseURL || undefined,
  });

  // Start MCP server for NanoClaw IPC tools
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  let mcpClient: McpClient | null = null;

  try {
    mcpClient = await startMcpServer(mcpServerPath, {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    });
    log(`MCP server started with ${mcpClient.tools.length} tools`);
  } catch (err) {
    log(`MCP server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Start Gmail MCP server (if credentials exist)
  let gmailClient: McpClient | null = null;
  const gmailCredPath = '/home/node/.gmail-mcp/credentials.json';
  if (fs.existsSync(gmailCredPath)) {
    try {
      gmailClient = await startMcpServer(
        '',
        {},
        'npx',
        ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
      );
      log(`Gmail MCP: ${gmailClient.tools.length} tools`);
    } catch (err) {
      log(`Gmail MCP failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log('Gmail MCP skipped (no credentials at /home/node/.gmail-mcp/)');
  }

  // Build tool list: built-in + MCP tools
  const allTools: ChatCompletionTool[] = [...BUILTIN_TOOLS];
  if (mcpClient) {
    for (const tool of mcpClient.tools) {
      allTools.push({
        type: 'function',
        function: {
          name: `mcp__nanoclaw__${tool.name}`,
          description: tool.description,
          parameters: sanitizeSchema(tool.inputSchema as Record<string, unknown>),
        },
      });
    }
  }
  if (gmailClient) {
    for (const tool of gmailClient.tools) {
      allTools.push({
        type: 'function',
        function: {
          name: `mcp__gmail__${tool.name}`,
          description: tool.description,
          parameters: sanitizeSchema(tool.inputSchema as Record<string, unknown>),
        },
      });
    }
  }

  // Expose to module-level for team/background agent access
  moduleClient = client;
  moduleModelName = modelName;
  moduleMcpClient = mcpClient;
  moduleGmailClient = gmailClient;
  moduleTools = allTools;

  const systemPrompt = buildSystemPrompt(containerInput);
  const restoredHistory = loadSessionHistory();
  const conversationHistory: ChatCompletionMessageParam[] = restoredHistory;

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → repeat
  try {
    while (true) {
      log(`Starting query...`);

      const queryResult = await runQuery(
        prompt, containerInput, client, modelName,
        allTools, conversationHistory, systemPrompt, mcpClient, gmailClient,
      );

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update
      writeOutput({ status: 'success', result: null, newSessionId: containerInput.sessionId || `session-${Date.now()}` });

      // Post-result polling: process teammate messages and background task completions
      const hasActiveWork = () => {
        for (const tm of teammates.values()) {
          if (tm.status === 'active' && (tm.processing || tm.outbox.length > 0 || tm.pendingInbox.length > 0)) return true;
        }
        for (const task of backgroundTasks.values()) {
          if (task.status === 'running') return true;
        }
        return false;
      };

      let closedDuringPolling = false;
      while (hasActiveWork()) {
        await new Promise(r => setTimeout(r, 500));
        if (shouldClose()) { closedDuringPolling = true; break; }

        const teamReplies: string[] = [];
        for (const tm of teammates.values()) {
          while (tm.outbox.length > 0) {
            teamReplies.push(tm.outbox.shift()!);
          }
        }

        const completedBg: string[] = [];
        for (const [id, task] of backgroundTasks) {
          if (task.status === 'completed' || task.status === 'failed') {
            completedBg.push(`[Background task "${task.description}" (${id}): ${task.status}] ${task.result?.slice(0, 1000) || ''}`);
            backgroundTasks.delete(id);
          }
        }

        const notifications = [...teamReplies, ...completedBg];
        if (notifications.length > 0) {
          log(`Polling: injecting ${notifications.length} notification(s) into leader`);
          prompt = notifications.join('\n\n');
          const pollResult = await runQuery(
            prompt, containerInput, client, modelName,
            allTools, conversationHistory, systemPrompt, mcpClient, gmailClient,
          );
          if (pollResult.closedDuringQuery) { closedDuringPolling = true; break; }
          writeOutput({ status: 'success', result: null, newSessionId: containerInput.sessionId || `session-${Date.now()}` });
        }
      }

      if (closedDuringPolling) {
        log('Close sentinel consumed during polling, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    if (mcpClient) closeMcpClient(mcpClient);
    if (gmailClient) closeMcpClient(gmailClient);
  }
}

main();
