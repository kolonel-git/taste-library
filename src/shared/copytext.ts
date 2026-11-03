import type { Analysis } from './types.ts';

interface Copyable {
  title: string | null;
  tags: string[];
  effective: Partial<Analysis>;
}

export const descriptionText = (item: Copyable): string => (item.effective.description ?? '').trim();

export const keywordsText = (item: Copyable): string => (item.effective.keywords ?? []).join(', ');

export const styleGuideText = (item: Copyable): string => (item.effective.styleGuide ?? '').trim();

export const stylePromptText = (item: Copyable): string => (item.effective.stylePrompt ?? '').trim();

/** One line per colour: `#0E0E10: background (Ink)`. */
export const paletteText = (item: Copyable): string =>
  (item.effective.palette ?? []).map((c) => `${c.hex.toUpperCase()}: ${c.role}${c.name ? ` (${c.name})` : ''}`).join('\n');

/** The whole entry as Markdown, ready to paste into a design brief. */
export function everythingText(item: Copyable): string {
  const e = item.effective;
  const parts: string[] = [`# ${e.title ?? item.title ?? 'Untitled'}`];
  if (item.tags.length) parts.push(`Tags: ${item.tags.join(', ')}`);
  if (e.description) parts.push(`## Description\n\n${descriptionText(item)}`);
  if (e.palette?.length) parts.push(`## Palette\n\n${paletteText(item).replace(/^/gm, '- ')}`);
  if (e.keywords?.length) parts.push(`## Keywords\n\n${keywordsText(item)}`);
  if (e.styleGuide) parts.push(`## Style guide\n\n${styleGuideText(item)}`);
  if (e.stylePrompt) parts.push(`## Style prompt\n\n${stylePromptText(item)}`);
  return `${parts.join('\n\n')}\n`;
}
