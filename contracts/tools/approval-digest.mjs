// 审批凭据 args_digest 的规范化实现（TypeScript/Node 侧）。
//
// 规则本体在 contracts/approval-digest.json；这里只**执行**规则，不重新定义规则。
// Python 侧实现是 robotd/src/robotd/approval_digest.py，两者必须逐字节一致。
// 契约变更顺序：openapi.yaml（x-requires-approval.params）→ 生成物 → 本实现 → 测试。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES_PATH = path.resolve(HERE, '..', 'approval-digest.json');

const SUPPORTED = {
  field_selection: ['approval_params_only'],
  unlisted_fields: ['exclude'],
  missing_fields: ['null'],
  key_order: ['unicode_code_point_ascending'],
  number_format: ['json_minimal_no_exponent'],
  string_normalization: ['none'],
  string_escaping: ['json_minimal'],
  encoding: ['utf-8'],
};

let cachedRules = null;

export function loadRules(file = RULES_PATH) {
  if (file === RULES_PATH && cachedRules) return cachedRules;
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateRules(rules);
  if (file === RULES_PATH) cachedRules = rules;
  return rules;
}

function validateRules(rules) {
  if (!rules || typeof rules !== 'object') throw new Error('approval-digest 规则必须是对象');
  if (rules.version !== 1) throw new Error(`approval-digest 规则 version 不受支持：${rules.version}`);
  if (typeof rules.algorithm !== 'string' || !rules.algorithm) {
    throw new Error('approval-digest 规则缺 algorithm');
  }
  if (typeof rules.digest_prefix !== 'string') throw new Error('approval-digest 规则缺 digest_prefix');
  for (const [key, allowed] of Object.entries(SUPPORTED)) {
    if (!allowed.includes(rules[key])) {
      throw new Error(`approval-digest 规则 ${key}=${JSON.stringify(rules[key])} 不受支持（允许：${allowed.join(', ')}）`);
    }
  }
}

/** 按 Unicode 码点排序（不是 UTF-16 代码单元）。 */
function compareCodePoints(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const ca = left[i].codePointAt(0);
    const cb = right[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return left.length - right.length;
}

function quoteString(value) {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('字符串含孤立的高位代理项，无法 UTF-8 编码');
      out += value[i] + value[i + 1];
      i += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('字符串含孤立的低位代理项，无法 UTF-8 编码');
    const ch = value[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (unit === 0x08) out += '\\b';
    else if (unit === 0x0c) out += '\\f';
    else if (unit === 0x0a) out += '\\n';
    else if (unit === 0x0d) out += '\\r';
    else if (unit === 0x09) out += '\\t';
    else if (unit < 0x20) out += `\\u${unit.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function expandExponent(text) {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) throw new Error(`无法展开科学计数法：${text}`);
  const [, sign, intPart, fracPart = '', expText] = match;
  const exp = Number(expText);
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) throw new Error(`args 含非有限数字 ${value}，JSON 无法表达`);
  if (value === 0) return '0';
  let text = String(value); // ECMAScript 的最短往返表示
  if (/[eE]/.test(text)) text = expandExponent(text);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

function canonicalValue(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return quoteString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys.map((key) => `${quoteString(key)}:${canonicalValue(value[key])}`).join(',')}}`;
  }
  throw new Error(`args 含不可序列化的值：${typeof value}`);
}

/**
 * 计算审批参数的规范化 JSON 文本。
 *
 * 只取 `approvalParams` 声明的字段；未声明的字段一律排除；缺失字段按 null 参与。
 */
export function canonicalApprovalArgs(args, approvalParams, rules = loadRules()) {
  validateRules(rules);
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('args 必须是对象');
  }
  if (!Array.isArray(approvalParams) || approvalParams.some((p) => typeof p !== 'string' || !p)) {
    throw new Error('approvalParams 必须是字符串数组（元素非空）');
  }
  const keys = [...approvalParams].sort(compareCodePoints);
  if (new Set(keys).size !== keys.length) throw new Error('approvalParams 含重复字段');
  const body = keys.map((key) => `${quoteString(key)}:${canonicalValue(args[key])}`).join(',');
  const canonical = `{${body}}`;
  // 规则文件负责编码；这里按规则声明的 UTF-8 编码，保证与 Python 侧同一字节串。
  Buffer.from(canonical, rules.encoding);
  return canonical;
}

/** 审批参数摘要：`sha256:<hex>`。 */
export function approvalArgsDigest(args, approvalParams, rules = loadRules()) {
  const canonical = canonicalApprovalArgs(args, approvalParams, rules);
  const hex = crypto.createHash(rules.algorithm).update(Buffer.from(canonical, rules.encoding)).digest('hex');
  return `${rules.digest_prefix}${hex}`;
}
