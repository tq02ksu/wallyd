// 审批复述安全词表的唯一可执行实现（TypeScript/Node 侧）。
//
// 规则本体在 `contracts/announce-lexicon.json`；本文件只执行规则，不重新定义规则。
// Python 侧实现是 `robotd/src/robotd/announce_lexicon.py`，两端必须逐字节一致。
// 契约变更顺序：openapi.yaml / announce-lexicon.json → 生成物 → 本实现 → 测试。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEXICON_PATH = path.resolve(HERE, '..', 'announce-lexicon.json');

let cached = null;

export class LexiconError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LexiconError';
    this.code = 'E_ANNOUNCE_LEXICON';
  }
}

export function loadLexicon(file = LEXICON_PATH) {
  if (file === LEXICON_PATH && cached) return cached;
  const lex = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateLexicon(lex);
  if (file === LEXICON_PATH) cached = lex;
  return lex;
}

function validateLexicon(lex) {
  if (!lex || typeof lex !== 'object') throw new LexiconError('announce-lexicon 必须是对象');
  if (lex.version !== 1) throw new LexiconError(`announce-lexicon version 不受支持：${lex.version}`);
  const rules = lex.args_summary ?? {};
  if (rules.number_format !== 'chinese_numeral') {
    throw new LexiconError(`不支持的 number_format：${JSON.stringify(rules.number_format)}`);
  }
  for (const n of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    if (typeof lex.digits?.[n] !== 'string' || !lex.digits[n]) {
      throw new LexiconError(`digits 缺 ${n} 的读法`);
    }
  }
  if (!Number.isInteger(rules.max_chars) || rules.max_chars <= 0) {
    throw new LexiconError('args_summary.max_chars 必须是正整数');
  }
  if (!Number.isInteger(rules.max_fields) || rules.max_fields <= 0) {
    throw new LexiconError('args_summary.max_fields 必须是正整数');
  }
  if (!Array.isArray(rules.forbidden_phrases)) {
    throw new LexiconError('args_summary.forbidden_phrases 必须是数组');
  }
  if (!lex.fields || typeof lex.fields !== 'object') throw new LexiconError('缺 fields');
  if (!Number.isInteger(lex.repeat?.max_attempts) || lex.repeat.max_attempts <= 0) {
    throw new LexiconError('repeat.max_attempts 必须是正整数');
  }
}

function intToChinese(n, lex) {
  const d = lex.digits;
  if (n === 0) return d['0'];
  const four = (value) => {
    const units = [lex.small_units['1000'], lex.small_units['100'], lex.small_units['10'], ''];
    let out = '';
    let zeroPending = false;
    for (let i = 0; i < 4; i += 1) {
      const digit = Math.floor(value / 10 ** (3 - i)) % 10;
      if (digit === 0) {
        if (out) zeroPending = true;
        continue;
      }
      if (zeroPending) {
        out += d['0'];
        zeroPending = false;
      }
      out += d[String(digit)] + units[i];
    }
    // 标准读法是「十五」而不是「一十五」；只在没有更高位时省略。
    return out.startsWith(`${d['1']}${lex.small_units['10']}`) ? out.slice(1) : out;
  };
  if (lex.large_units?.['10000'] && n >= 10000) {
    const high = Math.floor(n / 10000);
    const low = n % 10000;
    let out = `${intToChinese(high, lex)}${lex.large_units['10000']}`;
    if (low > 0) out += `${low < 1000 ? d['0'] : ''}${four(low)}`;
    return out;
  }
  return four(n);
}

function numberToChinese(value, lex) {
  const rules = lex.args_summary;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LexiconError('参数不是有限数字，无法口播');
  }
  if (Math.abs(value) > rules.max_abs) {
    throw new LexiconError(`数字 ${value} 超过词表上限 ${rules.max_abs}`);
  }
  let text = String(value);
  if (/[eE]/.test(text)) {
    throw new LexiconError(`数字 ${value} 是科学计数法，审批复述不接受`);
  }
  if (text === '-0') text = '0';
  let sign = '';
  if (text.startsWith('-')) {
    sign = rules.negative_prefix;
    text = text.slice(1);
  }
  const [intPart, fracPart = ''] = text.split('.');
  if (fracPart.length > rules.max_decimals) {
    throw new LexiconError(`数字 ${value} 小数位超过 ${rules.max_decimals} 位，无法安全口播`);
  }
  let out = `${sign}${intToChinese(Number(intPart), lex)}`;
  const trimmedFrac = fracPart.replace(/0+$/, '');
  if (trimmedFrac) out += `${rules.decimal_point}${Array.from(trimmedFrac, (c) => lex.digits[c]).join('')}`;
  return out;
}

function renderValue(value, field, lex) {
  const rules = lex.args_summary;
  if (field.type === 'number') {
    return `${field.label}${numberToChinese(value, lex)}${field.unit ? lex.units[field.unit] ?? '' : ''}`;
  }
  if (typeof value === 'boolean') {
    return `${field.label}${rules.text_separator}${lex.booleans[String(value)]}`;
  }
  if (typeof value !== 'string') {
    throw new LexiconError(`字段 ${field.label} 的值类型无法口播：${typeof value}`);
  }
  const text = value.trim();
  if (!text) throw new LexiconError(`字段 ${field.label} 为空，无法口播`);
  if (/[\x00-\x1f\x7f]/u.test(text)) throw new LexiconError(`字段 ${field.label} 含控制字符`);
  if (text.includes(rules.field_separator) || text.includes(rules.text_separator)) {
    throw new LexiconError(`字段 ${field.label} 含分隔符，无法保证口播边界`);
  }
  if (Array.from(text).length > rules.max_chars) {
    throw new LexiconError(`字段 ${field.label} 超过 ${rules.max_chars} 字，无法一次听完`);
  }
  return `${field.label}${rules.text_separator}${text}`;
}

/**
 * 把需要用户听见的参数拼成一句可口播、可校验的中文摘要。
 *
 * `fields` 必须来自能力契约的 `approvalParams`；不在词表里的字段一律拒绝，
 * 因为没人为它定义过单位/读法，猜一个就是在制造「听错」。
 */
export function formatArgsSummary(args, fields, lex = loadLexicon()) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new LexiconError('args 必须是对象');
  }
  if (!Array.isArray(fields) || fields.some((f) => typeof f !== 'string' || !f)) {
    throw new LexiconError('fields 必须是非空字符串数组');
  }
  const keys = fields.length ? fields : Object.keys(args);
  const rendered = [];
  for (const key of keys) {
    const value = Object.hasOwn(args, key) ? args[key] : null;
    if (value === null || value === undefined) continue;
    const field = lex.fields[key];
    if (!field) throw new LexiconError(`字段 ${key} 没有词表读法，拒绝拼复述`);
    rendered.push(renderValue(value, field, lex));
  }
  if (!rendered.length) throw new LexiconError('没有可播报的参数');
  if (rendered.length > lex.args_summary.max_fields) {
    throw new LexiconError(`参数项 ${rendered.length} 个，超过 ${lex.args_summary.max_fields} 项上限`);
  }
  const summary = rendered.join(lex.args_summary.field_separator);
  return validateArgsSummary(summary, lex);
}

/** 校验一条已拼好的 `args_summary`；返回 trim 后的文本，失败抛 LexiconError。 */
export function validateArgsSummary(summary, lex = loadLexicon()) {
  if (typeof summary !== 'string') throw new LexiconError('args_summary 必须是字符串');
  const rules = lex.args_summary;
  const text = summary.trim();
  if (!text) throw new LexiconError('args_summary 不能为空');
  if (/[\x00-\x1f\x7f]/u.test(text)) throw new LexiconError('args_summary 含控制字符/换行');
  if (Array.from(text).length > rules.max_chars) {
    throw new LexiconError(`args_summary 超过 ${rules.max_chars} 字，必须压缩到一次听完`);
  }
  for (const phrase of rules.forbidden_phrases) {
    if (text.includes(phrase)) throw new LexiconError(`args_summary 含不确定词「${phrase}」，审批复述必须是确定值`);
  }
  // 独立的阿拉伯数字说明调用方没走数字读法（0.15 / 2.0 / 1e-3 都在这里被拦）。
  if (/(?<![A-Za-z0-9_.:/-])[0-9]+(?:\.[0-9]+)?/u.test(text)) {
    throw new LexiconError('args_summary 含未按词表读法的阿拉伯数字（禁止科学计数法与 2.0 这类写法）');
  }
  // Python 的 \d 会匹配全角/阿拉伯-印度数字，JS 不会；显式拒绝所有非 ASCII 数字，
  // 否则「０.１５」会在一端被放行、在另一端被拒绝，TTS 的读法也无法保证。
  if (Array.from(text).some((c) => /\p{N}/u.test(c) && !/[0-9]/u.test(c))) {
    throw new LexiconError('args_summary 含非 ASCII 数字字符，无法保证两端读法一致');
  }
  // 只在「中文数字 + 英文单位」这种写法上拦；目标 ID 可能是 m7 / t7，不能被误伤。
  if (/(?:[零一二三四五六七八九十百千万点负])\s*(?:m\/s|mps|cm|mm|km|deg|ms|m|s)(?![A-Za-z0-9])/iu.test(text)) {
    throw new LexiconError('args_summary 含英文单位缩写，必须用词表里的中文单位');
  }
  if (text.split(rules.field_separator).length > rules.max_fields) {
    throw new LexiconError(`args_summary 参数项超过 ${rules.max_fields} 项`);
  }
  return text;
}

/** 供测试/工具读取的派生常量。 */
export function announceLimits(lex = loadLexicon()) {
  return {
    max_args_summary_chars: lex.args_summary.max_chars,
    max_repeats: lex.repeat.max_attempts,
  };
}
