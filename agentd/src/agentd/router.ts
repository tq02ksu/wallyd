/**
 * 输入路由（A11）：把一句话变成「走确定性快速路径」还是「交给 Harness 理解」。
 *
 * ## 为什么需要它
 *
 * 在此之前 `service.ts` 把 `route: 'harness'` 写死，所有请求都标成「交给模型」，
 * 于是快速路由等于不存在：说「停」也要先过一遍模型。规格（`doc/spec/agentd-functional-design.md`
 * §3.1）要求的是**确定性优先**：
 *
 * - 「停止」走受保护的优先路径，不等模型；
 * - 只有**唯一匹配且前提满足**时才快速执行；
 * - 缺参 / 歧义 / 规则冲突 → 澄清，**不按「第一条命中」执行**；
 * - 无匹配 → Harness。
 *
 * ## 纪律
 *
 * 1. **不用模型判断「是否明确」**。判断依据是规则与当前证据，不是置信度分数。
 *    （这是规格原话；也让快速路由在模型离线时仍然可用。）
 * 2. **审批要求只从能力契约取**（`CapabilityInfo.requiresApproval`），规则不能降低它。
 *    规则里**不写**审批标志——写进规则就变成了第二份真值。
 * 3. **参数来自明确的表达**，不从自由文本里猜。规则匹配的是整个输入（可含少量前缀/后缀），
 *    不做子串模糊匹配——子串会把「不要停」误判成「停」。
 * 4. **命中要留痕**：返回稳定的 `id@version`，写进 run 的 `fast_rule`，可追溯是哪个版本做的决定。
 *    停用规则不改写历史——历史记录的是当时命中的那条。
 * 5. **规则只能映射到已发布能力**：目标能力不在对端能力表里 → 澄清（并说明缺什么能力），
 *    不是硬着头皮执行。
 */

export type Route = 'fast' | 'harness' | 'clarified';

export type MatchResult =
  | { kind: 'none' }
  /**
   * 命中唯一规则，可以直接执行。
   *
   * **注意这里没有 `requires_approval`**：审批要求只存在于能力契约
   * （`CapabilityInfo.requiresApproval`）。执行层必须自己从契约取，
   * 不要把「路由命中」当成「不用审批」——规格原话是「快速路由也经过同一权限与审批门」。
   */
  | { kind: 'matched'; rule: FastRule; args: Record<string, unknown> }
  /** 命中多条不同规则，或同一条规则命中多次 → 不执行，先问清楚 */
  | { kind: 'ambiguous'; candidates: string[] }
  /** 命中了规则，但缺参数或上下文前提不满足 */
  | { kind: 'clarify'; rule: FastRule; question: string; missing: string[] };

/** 判断某条规则的前提时能看到的证据。**只用已经观测到的事实**，不推测。 */
export interface RouteContext {
  /** 对端已发布的能力名（来自 robotd 能力表）；null 表示还没探测到 */
  available: ReadonlySet<string> | null;
  /** 当前是否有活动任务 */
  busy?: boolean;
  /** 当前是否在播报（用于「停」的语义区分） */
  speaking?: boolean;
}

export interface FastRule {
  /** 稳定 ID，snake_case；与版本一起构成可追溯的标识 */
  id: string;
  /** 规则版本：表达或语义变化就递增，历史记录靠它区分 */
  version: number;
  /**
   * 目标能力，用**对端公开工具名**（`contracts/generated/mcp-tools.json` 里的 `name`，
   * 例如 `robot_stop`）。注意这是下划线形式，不是契约里的 `operationId`
   * （`robot_stop` 恰好同名，但 `robot_calibration_get` 之类要对齐工具名而不是路径）。
   */
  capability: string;
  /**
   * 受保护的优先规则（STOP）。扩展规则**不能覆盖或延迟**它：
   * 只要有受保护规则命中，其余规则一律让路。
   */
  protected?: boolean;
  /** 认可的表达。整串匹配（忽略首尾空白与语气词），不做子串匹配。 */
  patterns: RegExp[];
  /** 操作说明，用于事件摘要与界面展示 */
  summary: string;
  /** 可选的参数抽取：从匹配结果生成能力参数 */
  args?: (m: RegExpMatchArray) => Record<string, unknown>;
  /** 可选的前提检查：返回 null 表示满足，否则返回缺失原因 */
  precondition?: (ctx: RouteContext) => string | null;
}

/** 匹配前做的归一化：全角转半角、去首尾空白、去句末标点。**不做同义词替换**。 */
export function normalizeInput(text: string): string {
  let s = text.normalize('NFKC').trim();
  // 句末标点：ASR 常带「。」「？」「！」，不影响语义
  s = s.replace(/[。．.！!？?，,、\s]+$/u, '');
  // 开头语气词：**只在后面还有内容时才剥**。
  // 「嗯，停」→「停」；但「你好」本身就是一句完整表达，剥成空串会把指令吃掉。
  s = s.replace(/^(那个|嗯|呃|你好|嘿)[，,\s]+/u, '');
  return s.trim();
}

/**
 * 首版规则表。
 *
 * 只放**高确定性**的少量指令；场景需求明确后按 §3.1「增量扩展」补，
 * 每条新增都要过正例 / 反例 / 歧义 / 冲突测试。
 */
export const FAST_RULES: readonly FastRule[] = [
  {
    // 停止是安全旁路：不等模型、不排队、不受「忙」限制。
    // 这里用 `^停` 而不是精确匹配，是因为 ASR 常带尾巴（「停下来」「停止」「停一下」）；
    // 但**必须**排除「不要停」「别停」这类否定 —— 见下面的 negative guard。
    id: 'stop_robot',
    version: 1,
    capability: 'robot_stop',
    protected: true,
    summary: '停止机器人',
    patterns: [/^(停下来|停止|快停|停一下|立即停止|紧急停止)$/u, /^停$/u],
  },
];

/**
 * 否定/疑问守卫：这些输入**绝不能被任何规则命中**。
 *
 * 「不要停」「能停吗」如果被 stop 规则吃掉，就会产生一次真实且无法撤销的动作。
 * 宁可交给 Harness 或澄清，也不能猜。
 */
const NEGATION_GUARD = /(不要|不用|别|甭|无需|不必|能不能|可不可以|可以吗|是不是|要不要)/u;

/**
 * 匹配规则。
 *
 * 顺序纪律：
 * 1. 否定守卫先跑 —— 命中即返回 `none`（交给 Harness），不进入任何规则；
 * 2. 受保护规则（STOP）单独一轮：命中即决，不让扩展规则延迟它；
 * 3. 其余规则求候选集：0 条 → none；1 条 → 检查前提；≥2 条 → ambiguous。
 */
export function matchRoute(rawText: string, ctx: RouteContext, rules: readonly FastRule[] = FAST_RULES): MatchResult {
  const text = normalizeInput(rawText);
  if (text.length === 0) return { kind: 'none' };
  if (NEGATION_GUARD.test(text)) return { kind: 'none' };

  const hit = (r: FastRule): RegExpMatchArray | null => {
    for (const p of r.patterns) {
      const m = text.match(p);
      if (m) return m;
    }
    return null;
  };

  // ---- 2. 受保护规则优先
  const protectedHits: { rule: FastRule; m: RegExpMatchArray }[] = [];
  for (const r of rules) {
    if (!r.protected) continue;
    const m = hit(r);
    if (m) protectedHits.push({ rule: r, m });
  }
  if (protectedHits.length > 1) {
    // 两条受保护规则同时命中 → 不能猜，先问
    return { kind: 'ambiguous', candidates: protectedHits.map((h) => `${h.rule.id}@${h.rule.version}`) };
  }
  if (protectedHits.length === 1) {
    return resolve(protectedHits[0].rule, protectedHits[0].m, ctx);
  }

  // ---- 3. 其余规则
  const hits: { rule: FastRule; m: RegExpMatchArray }[] = [];
  for (const r of rules) {
    if (r.protected) continue;
    const m = hit(r);
    if (m) hits.push({ rule: r, m });
  }
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length > 1) {
    return { kind: 'ambiguous', candidates: hits.map((h) => `${h.rule.id}@${h.rule.version}`) };
  }
  return resolve(hits[0].rule, hits[0].m, ctx);
}

function resolve(rule: FastRule, m: RegExpMatchArray, ctx: RouteContext): MatchResult {
  // 目标能力必须已发布：规则映射到不存在的能力 → 澄清并说明缺什么
  if (ctx.available && !ctx.available.has(rule.capability)) {
    return {
      kind: 'clarify',
      rule,
      question: `这台机器人现在没有「${rule.summary}」这个能力，不会假装执行。`,
      missing: [`capability:${rule.capability}`],
    };
  }
  if (rule.precondition) {
    const why = rule.precondition(ctx);
    if (why !== null) {
      return { kind: 'clarify', rule, question: why, missing: ['precondition'] };
    }
  }
  // 审批要求由执行层从能力契约取（见 MatchResult.matched 的注释），这里只负责「能不能路由」
  return { kind: 'matched', rule, args: rule.args ? rule.args(m) : {} };
}

/** 规则的可追溯标识：`id@version`。 */
export function ruleTag(rule: FastRule): string {
  return `${rule.id}@${rule.version}`;
}
