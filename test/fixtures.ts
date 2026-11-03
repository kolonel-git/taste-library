import type { Analysis } from '../src/shared/types.ts';
import type { ClaudeExec } from '../src/analysis/claude.ts';

export function goodAnalysis(over: Partial<Analysis> = {}): Analysis {
  return {
    title: 'Midnight Ledger Dashboard',
    description:
      'A dark analytics dashboard with a left navigation rail, a row of KPI cards and a wide line chart in the centre, with a table of recent transactions below.',
    styleGuide: [
      'Use the following design system for everything you build in this project.',
      '### Design principles\n- Quiet surfaces, one warm accent.\n- Data first; chrome recedes.\n- Consistent 8px rhythm.',
      '### Colour\n- Background #0E0E10, surface #17171A, raised #1F1F23.\n- Text #ECE9E3, muted #8B8881.\n- Accent #E6C07B used sparingly for active states and the primary chart line; success #5BC48A, warning #E6C07B, danger #E9806A, info #6AA7E9 (inferred).',
      '### Typography\nGrotesk sans (Inter-like). Scale: display 40/44, h1 28/34, h2 22/28, h3 18/24, body 14/22, small 12/18, caption 11/16, medium weight for numbers, tight tracking on headings.',
      '### Layout & grid\n12 column grid, 240px fixed sidebar, 1280px max content width, 24px gutters, breakpoints at 640, 960 and 1280.',
      '### Spacing & sizing\n8px base unit with a 4, 8, 12, 16, 24, 32, 48 scale. Controls are 36px high; touch targets at least 44px.',
      '### Shape, borders & elevation\nRadius scale 4, 8, 12, 999. 1px borders in #2A2A2F. Two shadow levels for popovers and modals.',
      '### Components\n- Buttons: primary filled with accent, secondary outlined, ghost text only; 150ms hover (inferred).\n- Inputs: 36px, 1px border, accent focus ring (inferred).\n- Cards: surface fill, 12px radius, no shadow.',
      '### Mood\nQuiet, confident, financial, and calm under heavy data density.',
      '### Do and don\'t\n- Do keep one accent per screen.\n- Don\'t add decorative gradients.',
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
