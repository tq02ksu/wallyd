/** Type declarations for approval-digest.mjs (imported by agentd's credential issuer). */

export interface ApprovalDigestRules {
  version: number;
  algorithm: string;
  digest_prefix: string;
  encoding: string;
  field_selection: string;
  unlisted_fields: string;
  missing_fields: string;
  key_order: string;
  number_format: string;
  string_normalization: string;
  string_escaping: string;
  implementations: Record<string, string>;
  [key: string]: unknown;
}

export const RULES_PATH: string;
export function loadRules(file?: string): ApprovalDigestRules;
export function canonicalApprovalArgs(
  args: Record<string, unknown>,
  approvalParams: string[],
  rules?: ApprovalDigestRules,
): string;
export function approvalArgsDigest(
  args: Record<string, unknown>,
  approvalParams: string[],
  rules?: ApprovalDigestRules,
): string;
