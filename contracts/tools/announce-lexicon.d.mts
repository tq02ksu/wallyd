/** Type declarations for announce-lexicon.mjs (imported by agentd). */

export interface AnnounceLexicon {
  version: number;
  name: string;
  args_summary: {
    max_chars: number;
    max_fields: number;
    field_separator: string;
    text_separator: string;
    max_decimals: number;
    max_abs: number;
    number_format: string;
    negative_prefix: string;
    decimal_point: string;
    forbidden_phrases: string[];
  };
  digits: Record<string, string>;
  small_units: Record<string, string>;
  large_units: Record<string, string>;
  booleans: Record<string, string>;
  units: Record<string, string>;
  fields: Record<string, { label: string; type: 'text' | 'number'; unit?: string }>;
  repeat: { max_attempts: number };
  implementations: Record<string, string>;
}

export const LEXICON_PATH: string;
export class LexiconError extends Error {
  code: string;
}
export function loadLexicon(file?: string): AnnounceLexicon;
export function formatArgsSummary(
  args: Record<string, unknown>,
  fields: string[],
  lex?: AnnounceLexicon,
): string;
export function validateArgsSummary(summary: string, lex?: AnnounceLexicon): string;
export function announceLimits(lex?: AnnounceLexicon): {
  max_args_summary_chars: number;
  max_repeats: number;
};
