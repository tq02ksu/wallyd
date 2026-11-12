/**
 * 事件 payload 的契约校验。
 *
 * 登记表（`agentd/contracts/events.json`）除了「这个类型允许写」之外，还声明了
 * 每个字段的 `type / required / enum / minimum / maximum`。`EventLog.emit` 只查
 * 类型是否登记，会把「少了必填字段」「可选字段塞了 null」这类漂移放过去；
 * 本模块把这些声明变成可执行的校验。
 *
 * 为什么可选字段要在这里被拒绝成 `null`：契约约定「未实现时省略」。
 * 填 null 会让下游无法区分「没有这个事实」与「有事实但值是空」，
 * 而窗口期内的 `speaker_id` 恰好两种都可能。
 */

/** 登记表里单个 payload 字段的机器可读声明（多余键如 note/description 忽略）。 */
export interface PayloadFieldSpec {
  type?: string;
  required?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  /** 嵌套对象字段（如 bbox）的逐字段声明。 */
  properties?: Record<string, PayloadFieldSpec>;
  [extra: string]: unknown;
}

export type PayloadSpec = Record<string, PayloadFieldSpec>;

const KNOWN_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);

function typeProblem(field: string, value: unknown, type: string): string | null {
  if (!KNOWN_TYPES.has(type)) return `${field} 使用了未知类型 ${type}`;
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : `${field} 必须是 string`;
    case 'integer':
      return Number.isInteger(value) ? null : `${field} 必须是 integer`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field} 必须是 number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field} 必须是 boolean`;
    case 'array':
      return Array.isArray(value) ? null : `${field} 必须是 array`;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? null
        : `${field} 必须是 object`;
    default:
      return null;
  }
}

function validateValue(field: string, def: PayloadFieldSpec, value: unknown): string[] {
  const problems: string[] = [];
  if (def?.type) {
    const problem = typeProblem(field, value, def.type);
    if (problem) return [problem];
  }
  if (Array.isArray(def?.enum) && !def.enum.some((allowed) => allowed === value)) {
    problems.push(`${field} 不在契约枚举里（${String(value)}）`);
  }
  if (typeof value === 'number') {
    if (typeof def?.minimum === 'number' && value < def.minimum) {
      problems.push(`${field} 小于 minimum ${def.minimum}`);
    }
    if (typeof def?.maximum === 'number' && value > def.maximum) {
      problems.push(`${field} 大于 maximum ${def.maximum}`);
    }
  }
  if (def?.properties && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    problems.push(...validateEventPayload(def.properties, value as Record<string, unknown>, `${field}.`));
  }
  return problems;
}

/**
 * 校验一份 payload。返回问题列表；空数组表示通过。
 *
 * - `undefined` 视为「没提供」：必填缺失报错，可选字段直接跳过；
 * - `null` 是提供了值，但类型不符（例如 optional string 填 null 会被拒）；
 * - 契约没声明的额外字段不在这里拒绝——登记表不是 JSON Schema 的封闭模型，
 *   现有事件里存在实现侧补充的诊断字段。字段级形状由声明的字段自己负责。
 */
export function validateEventPayload(
  spec: PayloadSpec | null | undefined,
  params: Record<string, unknown> | null | undefined,
  prefix = '',
): string[] {
  if (!spec) return [];
  const payload = params ?? {};
  const problems: string[] = [];
  for (const [field, def] of Object.entries(spec)) {
    if (!def || typeof def !== 'object') {
      problems.push(`${prefix}${field} 的契约声明不是对象`);
      continue;
    }
    const value = payload[field];
    if (value === undefined) {
      if (def.required === true) problems.push(`${prefix}${field} 必填但缺失`);
      continue;
    }
    problems.push(...validateValue(`${prefix}${field}`, def, value));
  }
  return problems;
}
