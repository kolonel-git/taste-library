import { spawn } from 'node:child_process';

export interface ClaudeRequest {
  prompt: string;
  schema: string;
  /** Folders Claude Code may read from (never written to: only the Read tool is enabled). */
  addDirs: string[];
  /** Working directory; keep it outside the source folder. */
  cwd: string;
  model?: string | null;
  timeoutMs?: number;
}

/** Runs `claude -p` and resolves with raw stdout. Injected in tests. */
export type ClaudeExec = (req: ClaudeRequest) => Promise<string>;

/** Failure that is worth one more attempt (bad shape), as opposed to infrastructure failures. */
export class OutputError extends Error {}

export const execClaude: ClaudeExec = (req) =>
  new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', req.schema,
      '--tools', 'Read',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--setting-sources', '',
    ];
    for (const dir of req.addDirs) args.push('--add-dir', dir);
    if (req.model) args.push('--model', req.model);

    const child = spawn('claude', args, { cwd: req.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude Code timed out after ${Math.round((req.timeoutMs ?? 240_000) / 1000)}s`));
    }, req.timeoutMs ?? 240_000);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'Claude Code CLI not found on PATH' : `Could not start Claude Code: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out);
      else reject(new Error(`Claude Code exited with code ${code}: ${err.trim().split('\n').slice(-2).join(' ') || 'no output'}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(req.prompt);
  });

/** Pull the structured result out of `claude -p --output-format json` stdout. */
export function parseClaudeOutput(stdout: string): unknown {
  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new OutputError('Claude Code returned something that was not JSON');
  }
  if (envelope?.is_error) {
    const msg = typeof envelope.result === 'string' && envelope.result ? envelope.result : envelope.subtype ?? 'unknown error';
    throw new Error(`Claude Code reported an error: ${String(msg).slice(0, 300)}`);
  }
  if (envelope?.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
  if (typeof envelope?.result === 'string') {
    try {
      return JSON.parse(envelope.result);
    } catch {
      /* fall through */
    }
  }
  throw new OutputError('Claude Code returned no structured result');
}
