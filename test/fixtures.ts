import type { Analysis } from '../src/shared/types.ts';
import type { ClaudeExec } from '../src/analysis/claude.ts';

export function goodAnalysis(over: Partial<Analysis> = {}): Analysis {
  return {
    title: 'Midnight Ledger Dashboard',
    description:
      'A dark analytics dashboard with a left navigation rail, a row of KPI cards and a wide line chart in the centre, with a table of recent transactions below.',
    styleGuide: [
      '### Colour\nBackground #0E0E10, surface #17171A, accent #E6C07B used sparingly for active states and the primary chart line.',
      '### Typography\nGrotesk sans (Inter-like), 12 to 32px scale, medium weight for numbers, tight tracking on headings.',
      '### Layout & grid\n12 column grid with a 240px fixed sidebar.',
      '### Mood\nQuiet, confident, financial.',
    ].join('\n\n'),
    palette: [
      { hex: '#0e0e10', role: 'background' },
      { hex: '#17171A', role: 'surface', name: 'Ink' },
      { hex: '#E6C07B', role: 'accent' },
    ],
    keywords: ['dark ui', 'kpi cards', 'data density', 'soft borders', 'financial', 'Dark UI'],
    tags: ['Dashboard', 'dark-mode', 'minimal'],
    ...over,
  };
}

/** Wraps a payload the way `claude -p --output-format json` does. */
export const envelope = (structured: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured, ...extra });

export function stubExec(handler: (n: number, prompt: string) => string | Promise<string>): ClaudeExec & { calls: number; prompts: string[] } {
  const fn = (async (req) => {
    fn.calls++;
    fn.prompts.push(req.prompt);
    return handler(fn.calls, req.prompt);
  }) as ClaudeExec & { calls: number; prompts: string[] };
  fn.calls = 0;
  fn.prompts = [];
  return fn;
}
