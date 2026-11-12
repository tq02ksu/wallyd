/**
 * 一句话 → run 还是澄清（`POST /api/run` 与语音 final 共用的业务决策）。
 *
 * ## 为什么澄清不建 run（GH-27）
 *
 * run 表示「要执行的一次任务」。路由返回 `clarify` / `ambiguous` 时没有任何执行意图，
 * 建出来的 run 永远不会被推进，却会被 `activeRun()` 当成活动任务——用户说一句需要
 * 澄清的话，机器人就一直「忙」，连「停」都进不来。
 *
 * ## 澄清闭环（GH-49）
 *
 * 澄清不建 run 不等于「问完就结束」。这里补三件事：
 *
 * 1. 追问走系统播报（`announceClarification` → `robot_announce kind=clarification`），
 *    正文由 robotd 固定模板从结构化 `missing` / `candidates` 渲染，不接受用户原文；
 * 2. `route.clarify` 事件带 `question`（与 `run.waiting_input.question` 同名）与结构化
 *    `reason`；
 * 3. `source: 'asr'` 的下一句在 30s 窗口内与上一句拼接后重新路由；窗口外、说「算了」、
 *    被完整新指令顶掉或被 STOP 关闭时，写一条带收尾原因的 `route.clarify`。
 *
 * ## 会话上下文（GH-12）
 *
 * `context` 只给 Harness 消歧，`previous` 只给规则的消歧判断；两者都不落库、不进事件，
 * 拼进 `prompt` 会同时污染 run 记录与事件正文。
 *
 * ## 停止是安全旁路
 *
 * `stop_robot` 标了 `protected`：即使已有活动 run，也允许提交并执行；澄清窗口也不能
 * 挡住它。其余请求仍遵守「活动 run 上限 1」，遇忙返回 `E_BUSY`——这里不放宽队列纪律。
 *
 * 规则表可通过 `rules` 注入（默认 `FAST_RULES`），让测试能构造缺参/歧义场景而不必
 * 修改生产规则；装配层永远使用默认值。
 */
import { FAST_RULES, matchRoute, ruleTag } from './router.ts';
import type { FastRule, MatchResult, RouteContext } from './router.ts';
import type { Route } from './runs.ts';
import type { RunService } from './runs.ts';
import type {
  ClarificationReason,
  ClarificationWindow,
} from './clarification-window.ts';
import { ApiError } from './http.ts';

/** 歧义时的兜底话术：候选连规则摘要都拿不到时才会用到。 */
export const AMBIGUOUS_QUESTION = '有多条快速规则同时命中，请说得更具体一些。';

/** 拼接后的 prompt 上限；防止一句话被无界累加。 */
export const MAX_COMBINED_PROMPT_CHARS = 500;

/** 用户在澄清窗口内用来结束追问的说法。只在这一种上下文里生效。 */
const CLARIFICATION_CANCEL = /^(算了|算了算了|不聊了|不用了|没事了|取消)$/u;

export interface RunRequestInput {
  prompt: string;
  session_id?: string;
  source?: 'text' | 'asr';
  idempotency_key?: string;
  /**
   * 仅供 Harness 消歧的会话上下文块（GH-12）。
   *
   * **不落库、不进事件**：直接给 `executeHarness`，由 harness 格式化进发给模型的
   * prompt。拼进 `prompt` 字段会同时污染 run 记录与事件正文。
   */
  context?: string | null;
  /**
   * 同回合上一轮的 run 结论（GH-12 路由消歧）。
   *
   * 只给 `matchRoute` 的消歧性规则用（如「慢一点」需要知道上一轮在跟随）；
   * **不落库、不进事件**，HTTP 入口不提供它（无状态请求没有「上一句」）。
   */
  previous?: { capability: string; args: Record<string, unknown> } | null;
}

/** 系统播报的结构化请求；正文由 robotd 固定模板渲染。 */
export interface ClarificationAnnouncement {
  kind: 'clarification';
  reason: ClarificationReason;
  action_label?: string;
  /** 参数字段名（不是用户原文）。 */
  missing: string[];
  /** 歧义候选的规则摘要（已截断）。 */
  candidates: string[];
  more: boolean;
}

export interface RunRequestDeps {
  runs: RunService;
  /** 对端已发布的能力名；null 表示还没探测到（不代表没有）。 */
  availableCapabilities: () => ReadonlySet<string> | null;
  /** 命中可执行规则后启动执行。装配层注入，**不阻塞响应**。 */
  executeFast: (runId: string, capability: string, args: Record<string, unknown>) => void;
  /** `route: harness` 的 run 交给 Harness 执行器。装配层注入，**不阻塞响应**。 */
  executeHarness: (runId: string, context?: string | null) => void;
  /** 澄清追问的系统播报；装配层注入，**不阻塞响应**。 */
  announceClarification?: (announcement: ClarificationAnnouncement) => void;
  /** 有界「等待补充」窗口；省略时不拼接语音补充（单测可只测路由）。 */
  clarificationWindow?: ClarificationWindow;
  /** 测试可注入的规则表；生产使用 `FAST_RULES`。 */
  rules?: readonly FastRule[];
  /** 拼接后的 prompt 上限；默认 `MAX_COMBINED_PROMPT_CHARS`。 */
  maxCombinedPromptChars?: number;
  /**
   * 结构化日志。装配层注入 `service.ts` 里同一个 `makeLogger` 实例，不另造日志设施；
   * 省略时静默（单测不需要构造 logger）。
   */
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** 与契约 `RunAccepted` 对齐：澄清响应没有 `run_id` / `status`。 */
export interface RunRequestResult {
  ok: true;
  route: Route;
  created_at: string;
  run_id?: string;
  status?: string;
  fast_rule?: string | null;
  duplicate?: boolean;
  ambiguous?: string[];
  clarify?: { question: string; missing: string[] };
  /**
   * **内部字段**：命中快速规则时实际下发的结构化参数，供装配层记回合上下文。
   * 不属于 `RunAccepted` 契约响应，HTTP 路由必须剔除（见 `service.ts`）。
   */
  fast_args?: Record<string, unknown>;
}

/** 一次澄清的完整描述：事件、窗口、播报共用。 */
interface ClarificationSpec {
  question: string;
  reason: ClarificationReason;
  /** 事件 `data.missing`（诊断标识符，如 `slot:target_track_id`）。 */
  missing: string[];
  /** 播报用的参数字段名（如 `target_track_id`）。 */
  announce_missing: string[];
  candidates: string[];
  more: boolean;
  action_label: string | null;
  fast_rule: string | null;
  /** 仅用于响应体：歧义时回显规则 ID@version。 */
  ambiguous_tags?: string[];
}

export function submitRunRequest(deps: RunRequestDeps, input: RunRequestInput): RunRequestResult {
  const rules = deps.rules ?? FAST_RULES;
  const busy = deps.runs.activeRun();
  const ctx: RouteContext = {
    available: deps.availableCapabilities(),
    // 传给规则的是真实状态，不是「反正前面会挡」的假设。
    busy: Boolean(busy),
    speaking: false,
    // 没有上一轮时是 null：消歧性规则（slow_down）不会参与匹配。
    previous: input.previous ?? null,
  };

  let prompt = input.prompt;

  // ---- 语音补充窗口：只消费 speech.final（source='asr'），HTTP 文本不拼接。
  if (input.source === 'asr' && deps.clarificationWindow) {
    const peeked = deps.clarificationWindow.peek();
    if (peeked.status === 'expired') {
      deps.clarificationWindow.clear();
      deps.runs.recordClarificationClosed({
        question: peeked.pending.question,
        reason: 'window_expired',
        session_id: peeked.pending.session_id,
        source: peeked.pending.source,
      });
      // 过期后这一句按新指令处理，不拼接。
    } else if (peeked.status === 'fresh') {
      const pending = peeked.pending;
      const text = input.prompt;

      if (isClarificationCancel(text)) {
        deps.clarificationWindow.clear();
        const created_at = deps.runs.recordClarificationClosed({
          question: pending.question,
          reason: 'user_cancelled',
          session_id: pending.session_id,
          prompt: text,
          source: 'asr',
        });
        return {
          ok: true,
          route: 'clarified',
          created_at,
          clarify: { question: pending.question, missing: pending.missing },
        };
      }

      if (isProtectedUtterance(text, rules, ctx)) {
        // STOP 是安全旁路：先关窗，再让「停」照常走受保护规则。
        deps.clarificationWindow.clear();
        deps.runs.recordClarificationClosed({
          question: pending.question,
          reason: 'stop',
          session_id: pending.session_id,
          source: pending.source,
        });
      } else {
        const solo = matchRoute(text, ctx, rules);
        // 单独就能执行，或单独是一句被守卫拦下的完整否定/疑问 → 都不是片段。
        const soloComplete =
          solo.kind === 'matched' || (solo.kind === 'none' && (solo.blocked?.length ?? 0) > 0);
        if (soloComplete) {
          // 完整的新指令不该被拼进上一句的半截话里。
          deps.clarificationWindow.clear();
          deps.runs.recordClarificationClosed({
            question: pending.question,
            reason: 'superseded',
            session_id: pending.session_id,
            source: pending.source,
          });
        } else {
          const combined = `${pending.prompt} ${text}`.trim();
          const max = deps.maxCombinedPromptChars ?? MAX_COMBINED_PROMPT_CHARS;
          deps.clarificationWindow.clear();
          if (combined.length > max) {
            deps.runs.recordClarificationClosed({
              question: pending.question,
              reason: 'prompt_too_long',
              session_id: pending.session_id,
              source: pending.source,
            });
            // 不拼接；用这一句重新问，避免无限累加。
            return issueClarification(deps, input, text, {
              question: pending.question,
              reason: pending.reason,
              missing: pending.missing,
              announce_missing: pending.announce_missing,
              candidates: pending.candidates,
              more: pending.more,
              action_label: pending.action_label,
              fast_rule: pending.fast_rule,
            });
          }
          prompt = combined;
        }
      }
    }
  }

  const matched = matchRoute(prompt, ctx, rules);

  // 被守卫拦下的命中：留一条可解释的原因（否定 / 疑问 / 词边界）。
  // 这三种都走 Harness，但排查时要能分开——判据是 `BlockedReason`，不回写规则表。
  if (matched.kind === 'none' && matched.blocked && matched.blocked.length > 0) {
    deps.log?.('router.blocked', { blocked: matched.blocked });
  }

  // 澄清与歧义都没有执行意图：不建 run，不占活动名额。
  if (matched.kind === 'clarify' || matched.kind === 'ambiguous') {
    return issueClarification(deps, input, prompt, specFromMatch(matched, rules));
  }

  // 受保护规则（STOP）是安全旁路：已有活动 run 也允许进入执行。
  const isProtected = matched.kind === 'matched' && matched.rule.protected === true;
  if (busy && !isProtected) {
    throw new ApiError('E_BUSY', '已有任务在进行中，请先等待或取消', {
      details: { run_id: busy.run_id, status: busy.status },
      hint: '不用排队等待——先看当前任务，或取消它',
    });
  }

  const route: Route = matched.kind === 'matched' ? 'fast' : 'harness';
  const fastRule = matched.kind === 'matched' ? ruleTag(matched.rule) : null;
  const result = deps.runs.submitRun({
    prompt,
    session_id: input.session_id,
    source: input.source,
    idempotency_key: input.idempotency_key,
    route,
    fast_rule: fastRule,
  });

  // 快速路由必须真的执行，不能只标一个 `route: fast` 就停在那儿。
  if (matched.kind === 'matched' && !result.duplicate) {
    deps.executeFast(result.run_id, matched.rule.capability, matched.args);
  }
  // Harness 同理：建了 run 就要推进，否则它会永远停在 accepted。
  if (route === 'harness' && !result.duplicate) {
    deps.executeHarness(result.run_id, input.context ?? null);
  }

  return {
    ok: true,
    run_id: result.run_id,
    status: result.status,
    route: result.route as Route,
    fast_rule: result.fast_rule,
    created_at: result.created_at,
    duplicate: result.duplicate,
    ...(matched.kind === 'matched' ? { fast_args: matched.args } : {}),
  };
}

/** 记录澄清、开窗、发起系统播报。事件 → 窗口 → 播报是同一个决定的三面。 */
function issueClarification(
  deps: RunRequestDeps,
  input: RunRequestInput,
  prompt: string,
  spec: ClarificationSpec,
): RunRequestResult {
  const created_at = deps.runs.recordClarification({
    prompt,
    session_id: input.session_id,
    source: input.source,
    question: spec.question,
    missing: spec.missing,
    fast_rule: spec.fast_rule,
    reason: spec.reason,
  });

  deps.clarificationWindow?.open({
    prompt,
    question: spec.question,
    reason: spec.reason,
    missing: spec.missing,
    announce_missing: spec.announce_missing,
    candidates: spec.candidates,
    more: spec.more,
    action_label: spec.action_label,
    fast_rule: spec.fast_rule,
    session_id: input.session_id,
    source: input.source,
  });

  deps.announceClarification?.({
    kind: 'clarification',
    reason: spec.reason,
    ...(spec.action_label ? { action_label: spec.action_label } : {}),
    missing: spec.announce_missing,
    candidates: spec.candidates,
    more: spec.more,
  });

  return {
    ok: true,
    route: 'clarified',
    created_at,
    // 歧义同时回显规则 ID（诊断）与面向用户的 question（UI/TTS 共用同一份文案）。
    ...(spec.ambiguous_tags ? { ambiguous: spec.ambiguous_tags } : {}),
    clarify: { question: spec.question, missing: spec.missing },
  };
}

function specFromMatch(
  matched: Extract<MatchResult, { kind: 'clarify' | 'ambiguous' }>,
  rules: readonly FastRule[],
): ClarificationSpec {
  if (matched.kind === 'clarify') {
    return {
      question: matched.question,
      reason: reasonForMissing(matched.missing),
      missing: matched.missing,
      announce_missing: matched.missing
        .filter((m) => m.startsWith('slot:'))
        .map((m) => m.slice('slot:'.length)),
      candidates: [],
      more: false,
      action_label: matched.rule.summary,
      fast_rule: ruleTag(matched.rule),
    };
  }

  const labels = matched.candidates.map((tag) => labelForRule(tag, rules));
  const spoken = speakableCandidates(labels);
  return {
    question: ambiguousQuestion(labels),
    reason: 'ambiguous',
    missing: [],
    announce_missing: [],
    candidates: spoken.candidates,
    more: spoken.more,
    action_label: null,
    fast_rule: null,
    ambiguous_tags: matched.candidates,
  };
}

function reasonForMissing(missing: readonly string[]): ClarificationReason {
  if (missing.some((m) => m.startsWith('capability:'))) return 'capability_unavailable';
  if (missing.includes('precondition')) return 'precondition';
  return 'missing_arguments';
}

function labelForRule(tag: string, rules: readonly FastRule[]): string {
  const rule = rules.find((r) => ruleTag(r) === tag);
  return rule?.summary ?? tag;
}

/** 候选超过 3 条时只念前两条 +「还是别的」；正好 3 条时三条都念。 */
export function speakableCandidates(labels: readonly string[]): { candidates: string[]; more: boolean } {
  if (labels.length <= 3) return { candidates: [...labels], more: false };
  return { candidates: labels.slice(0, 2), more: true };
}

/** 把候选规则摘要渲染成可念的问句。 */
export function ambiguousQuestion(labels: readonly string[]): string {
  if (labels.length === 0) return AMBIGUOUS_QUESTION;
  if (labels.length === 1) return `你是想${labels[0]}吗？`;
  if (labels.length === 2) return `你是想${labels[0]}，还是想${labels[1]}？`;
  if (labels.length === 3) return `你是想${labels[0]}、${labels[1]}，还是${labels[2]}？`;
  return `你是想${labels[0]}，还是想${labels[1]}，还是别的？`;
}

/**
 * 语音分发器把「算了」当作对话结束（GH-12），**不会**再进 `submitRunRequest`。
 * 所以澄清窗口的收尾必须发生在分发之前：由装配层调用这里，清空窗口并写一条
 * 带 `user_cancelled` 原因的 `route.clarify`，判据 4 才能在真实语音链路成立。
 *
 * 只处理**未过期**的窗口；已过期的窗口留给正常的路由路径记 `window_expired`。
 * 返回是否真的收尾了一个窗口。
 */
export function closeClarificationIfCancelled(
  deps: Pick<RunRequestDeps, 'runs' | 'clarificationWindow'>,
  text: string,
  source: 'text' | 'asr' = 'asr',
): boolean {
  const window = deps.clarificationWindow;
  if (!window || !isClarificationCancel(text)) return false;
  const peeked = window.peek();
  if (peeked.status !== 'fresh') return false;
  const pending = window.clear();
  if (!pending) return false;
  deps.runs.recordClarificationClosed({
    question: pending.question,
    reason: 'user_cancelled',
    session_id: pending.session_id,
    prompt: text,
    source,
  });
  return true;
}

/** 受保护规则（STOP）判定：用注入的规则表，避免测试规则与生产规则分叉。 */
function isProtectedUtterance(text: string, rules: readonly FastRule[], ctx: RouteContext): boolean {
  const matched = matchRoute(text, ctx, rules);
  return matched.kind === 'matched' && matched.rule.protected === true;
}

function isClarificationCancel(text: string): boolean {
  const normalized = text
    .normalize('NFKC')
    .trim()
    .replace(/[。．.！!？?，,、\s]+$/u, '');
  return CLARIFICATION_CANCEL.test(normalized);
}
