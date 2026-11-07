/**
 * 一句话 → run 还是澄清（`POST /api/run` 的业务决策）。
 *
 * ## 为什么澄清不建 run（GH-27）
 *
 * run 表示「要执行的一次任务」。路由返回 `clarify` / `ambiguous` 时没有任何执行意图，
 * 建出来的 run 永远不会被推进，却会被 `activeRun()` 当成活动任务——用户说一句需要
 * 澄清的话，机器人就一直「忙」，连「停」都进不来。
 *
 * 所以这里的分支是：
 * - `clarify` / `ambiguous`：不建 run，只写一条 `route.clarify` 事件（有会话时同时落
 *   用户消息），不占活动名额；
 * - `matched` / `none`：建 run；`matched` 时由装配层注入的 `executeFast` 真正执行。
 *
 * ## 停止是安全旁路
 *
 * `stop_robot` 标了 `protected`：即使已有活动 run，也允许提交并执行。其余请求仍遵守
 * 「活动 run 上限 1」，遇忙返回 `E_BUSY`——这里不放宽队列纪律。
 *
 * 规则表可通过 `rules` 注入（默认 `FAST_RULES`），让测试能构造缺参/歧义场景而不必
 * 修改生产规则；装配层永远使用默认值。
 */
import { FAST_RULES, matchRoute, ruleTag } from './router.ts';
import type { FastRule } from './router.ts';
import type { Route } from './runs.ts';
import type { RunService } from './runs.ts';
import { ApiError } from './http.ts';

/** 歧义时的追问话术：不猜是哪一条规则，直接问清楚。 */
export const AMBIGUOUS_QUESTION = '有多条快速规则同时命中，请说得更具体一些。';

export interface RunRequestInput {
  prompt: string;
  session_id?: string;
  source?: 'text' | 'asr';
  idempotency_key?: string;
}

export interface RunRequestDeps {
  runs: RunService;
  /** 对端已发布的能力名；null 表示还没探测到（不代表没有）。 */
  availableCapabilities: () => ReadonlySet<string> | null;
  /** 命中可执行规则后启动执行。装配层注入，**不阻塞响应**。 */
  executeFast: (runId: string, capability: string, args: Record<string, unknown>) => void;
  /** 测试可注入的规则表；生产使用 `FAST_RULES`。 */
  rules?: readonly FastRule[];
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
}

export function submitRunRequest(deps: RunRequestDeps, input: RunRequestInput): RunRequestResult {
  const busy = deps.runs.activeRun();
  const matched = matchRoute(
    input.prompt,
    {
      available: deps.availableCapabilities(),
      // 传给规则的是真实状态，不是「反正前面会挡」的假设。
      busy: Boolean(busy),
      speaking: false,
    },
    deps.rules ?? FAST_RULES,
  );

  // 被守卫拦下的命中：留一条可解释的原因（否定 / 疑问 / 词边界）。
  // 这三种都走 Harness，但排查时要能分开——判据是 `BlockedReason`，不回写规则表。
  if (matched.kind === 'none' && matched.blocked && matched.blocked.length > 0) {
    deps.log?.('router.blocked', { blocked: matched.blocked });
  }

  // 澄清与歧义都没有执行意图：不建 run，不占活动名额。
  if (matched.kind === 'clarify' || matched.kind === 'ambiguous') {
    const question = matched.kind === 'clarify' ? matched.question : AMBIGUOUS_QUESTION;
    const missing = matched.kind === 'clarify' ? matched.missing : [];
    const fastRule = matched.kind === 'clarify' ? ruleTag(matched.rule) : null;
    const created_at = deps.runs.recordClarification({
      prompt: input.prompt,
      session_id: input.session_id,
      source: input.source,
      question,
      missing,
      fast_rule: fastRule,
    });
    return {
      ok: true,
      route: 'clarified',
      created_at,
      ...(matched.kind === 'ambiguous'
        ? { ambiguous: matched.candidates }
        : { clarify: { question, missing } }),
    };
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
    prompt: input.prompt,
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

  return {
    ok: true,
    run_id: result.run_id,
    status: result.status,
    route: result.route as Route,
    fast_rule: result.fast_rule,
    created_at: result.created_at,
    duplicate: result.duplicate,
  };
}
