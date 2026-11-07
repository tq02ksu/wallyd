/**
 * 审批凭据的**签发侧**（#11）。robotd 的拒绝侧见 docs/design/GH-18.md。
 *
 * 三道门不能互换：
 * - 人工确认只在语音层（本模块的调用时机由 settle 决定）；
 * - 签发把「同意」压成机器可验的窄凭据（本模块）；
 * - robotd 只校验凭据是否真实、是否绑定这组参数、是否过期/重放。
 *
 * `args_digest` 的规范化**只**由 `contracts/tools/approval-digest.mjs` 决定，
 * 本模块不另写一份规则。签名覆盖 payload 段的原样 ASCII 文本，与 robotd 的
 * `approval.py` 一致。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { approvalArgsDigest } from '../../../contracts/tools/approval-digest.mjs';
import { approvalSecretPath } from './paths.ts';

/** robotd 允许的最长凭据寿命；我们只签更短的窗口。 */
export const DEFAULT_CREDENTIAL_TTL_MS = 60_000;

const HEX_KEY = /^[0-9a-f]{64}$/;

export interface MintApprovalCredentialInput {
  capability: string;
  /** 本次调用真实发送给 robotd 的参数（摘要只覆盖 approvalParams）。 */
  args: Record<string, unknown>;
  approvalParams: string[];
  ttlMs?: number;
  now?: Date;
}

export interface MintedApprovalCredential {
  /** 单行 `X-Wally-Approval` 头值。 */
  header: string;
  capability: string;
  args_digest: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
}

function readSigningKey(): Buffer {
  const file = approvalSecretPath();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (e: any) {
    throw new Error(`无法读取共享审批秘密 ${file}：${e?.message ?? e}`);
  }
  if (!HEX_KEY.test(text)) {
    throw new Error(`共享审批秘密格式非法（期望 64 位小写 hex）：${file}`);
  }
  return Buffer.from(text, 'hex');
}

export function mintApprovalCredential(input: MintApprovalCredentialInput): MintedApprovalCredential {
  if (!input.capability) throw new Error('capability 不能为空');
  if (!Array.isArray(input.approvalParams)) throw new Error('approvalParams 必须是数组');
  const ttl = input.ttlMs ?? DEFAULT_CREDENTIAL_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 300_000) {
    throw new Error(`凭据有效期必须在 1..300000ms 内：${ttl}`);
  }

  const now = input.now ?? new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const argsDigest = approvalArgsDigest(input.args, input.approvalParams);

  const payload = {
    issuer: 'agentd',
    capability: input.capability,
    args_digest: argsDigest,
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce,
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', readSigningKey())
    .update(payloadSegment, 'ascii')
    .digest('base64url');

  return {
    header: `${payloadSegment}.${signature}`,
    capability: input.capability,
    args_digest: argsDigest,
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce,
  };
}

/** 把已签发的凭据写进 approvals.authorization_json（审计用，不含秘密）。 */
export function authorizationRecord(cred: MintedApprovalCredential): Record<string, unknown> {
  return {
    scope: cred.capability,
    args_digest: cred.args_digest,
    issued_at: cred.issued_at,
    expires_at: cred.expires_at,
    nonce: cred.nonce,
    consumed: false,
  };
}
