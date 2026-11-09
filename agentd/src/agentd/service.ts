/**
 * agentd 服务装配与入口。
 *
 * 这个文件只做三件事：
 *   1. 解析配置（拒绝非回环、拒绝线上调试开关混进生产）；
 *   2. 装配各模块（store → events → runs/models/overview → router）；
 *   3. 启停与优雅关闭。
 *
 * 业务语义一律不写在这里——它属于 runs/models/overview。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';

import { Store, nowIso, compactJson } from './store.ts';
import { EventLog, loadRegistry, decodeCursor } from './events.ts';
import { RobotdEventSubscriber } from './robotd-events.ts';
import { RobotdEventBridge } from './robotd-event-bridge.ts';
import { RobotdClient } from './robotd-client.ts';
import { RunService, RUN_STATUSES, approvalView } from './runs.ts';
import { submitRunRequest, type RunRequestDeps } from './run-request.ts';
import { ClarificationWindow } from './clarification-window.ts';
import { ModelService } from './models.ts';
import { Overview, type HarnessInfo } from './overview.ts';
import { codexHomePath } from './paths.ts';
import {
  HarnessExecutor,
  JsonlHarnessSink,
  computeHarnessStatus,
  probeHarnessVersion,
} from './harness.ts';
import { createCodexHarnessClient } from './harness-codex.ts';
import { ApprovalAnnouncer } from './approval-announcer.ts';
import { executeApprovedCapability } from './approval-executor.ts';
import { RunNarrator } from './run-narrator.ts';
import { FAST_RULES } from './router.ts';
import {
  ApiError,
  Router,
  compileRoute,
  checkHost,
  checkOrigin,
  checkCsrf,
  readBody,
  abortOversized,
  rejectUnknown,
  requireString,
  optionalInt,
  optionalNumber,
  optionalEnum,
  parseLimit,
  sendJson,
  sendNoCors,
  serveStatic,
  isApiPath,
  toApiError,
  MAX_BODY_BYTES,
} from './http.ts';
import { LiveHub, WS_PATHS, validateUpgrade, writeUpgradeResponse } from './ws.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// src/agentd/ → agentd/（agentd 自己的根，UI 与契约都在它下面）
const AGENTD_ROOT = path.resolve(HERE, '..', '..');
// agentd/ → 仓库根（work/ 这类跨进程共享的运行目录在仓库根）
const PROJECT_ROOT = path.resolve(AGENTD_ROOT, '..');

export const CONTRACT_VERSION = '1.0.0';

export interface AgentdConfig {
  httpPort: number;
  robotdUrl: string;
  dataDir: string;
  staticDir: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 只会由 CLI 的显式测试开关打开；health 里必须显示出来。 */
  allowManualApprove: boolean;
  harnessBinary: string | null;
}

export function defaultConfig(): AgentdConfig {
  return {
    httpPort: 8791,
    robotdUrl: 'http://127.0.0.1:8787',
    dataDir: path.join(PROJECT_ROOT, 'work', 'agentd'),
    staticDir: path.join(AGENTD_ROOT, 'ui'),
    logLevel: 'info',
    allowManualApprove: false,
    harnessBinary: null,
  };
}

// ------------------------------------------------------------------ 日志
const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function makeLogger(level: string): (msg: string, extra?: Record<string, unknown>) => void {
  const min = LEVELS[level] ?? 20;
  return (msg, extra) => {
    const record = { ts: nowIso(), level: min <= 10 ? 'debug' : 'info', msg, ...(extra ?? {}) };
    const line = JSON.stringify(record);
    if (min <= 20) process.stdout.write(`${line}\n`);
  };
}

// ------------------------------------------------------------------ 运行实例
export interface AgentdRuntime {
  server: http.Server;
  port: number;
  bootId: string;
  csrfToken: string;
  store: Store;
  events: EventLog;
  runs: RunService;
  models: ModelService;
  overview: Overview;
  hub: LiveHub;
  robotd: RobotdClient;
  /** robotd 事件订阅（R14）。状态经 `/api/state` 的 `subscription` 暴露。 */
  robotdEvents: RobotdEventSubscriber;
  robotdBridge: RobotdEventBridge;
  /**
   * 真实路由表。暴露它是为了让 `tests/contract/` 能断言「实现注册的路由 == 契约声明的路由」——
   * contract:check 只管「生成物 == 契约」，管不到实现，那半边由这里补上。
   */
  router: Router;
  close: () => Promise<void>;
}

export async function createRuntime(
  config: AgentdConfig,
  opts: { log?: (msg: string, extra?: Record<string, unknown>) => void } = {},
): Promise<AgentdRuntime> {
  const log = opts.log ?? makeLogger(config.logLevel);
  fs.mkdirSync(config.dataDir, { recursive: true });

  const bootId = `boot-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const startedAt = nowIso();

  const store = new Store(path.join(config.dataDir, 'agentd.sqlite'), { log: () => {} });
  const registry = loadRegistry();
  const events = new EventLog(store, registry, bootId);
  const robotd = new RobotdClient({ baseUrl: config.robotdUrl, log: (m, x) => log(m, x) });

  // robotd 事件订阅（R14）：在此之前 agentd 收不到任何 robotd 事件，
  // 页面时间线只有自己启动那一条。见 robotd-events.ts 的纪律说明。
  const robotdEvents = new RobotdEventSubscriber({
    baseUrl: config.robotdUrl,
    log: (m, x) => log(m, x),
  });
  let announcerRef: ApprovalAnnouncer | null = null;
  let narratorRef: RunNarrator | null = null;
  // 语音分发入口：桥收到 final 后交给 runs.dispatchUtterance（审批 → 忙 → 提交）。
  let utteranceDispatchRef:
    | ((input: { utterance_id: string; text: string; started_at?: string; echo: boolean }) => void)
    | null = null;
  const robotdBridge = new RobotdEventBridge({
    events,
    store,
    hooks: {
      log: (m, x) => log(m, x),
      onAnnouncementFinished: (outcome) => announcerRef?.onFinished(outcome),
      onUtteranceHeard: (input) => utteranceDispatchRef?.(input),
      onSpeechOutcome: (outcome) => narratorRef?.onSpeechOutcome(outcome),
    },
  });
  robotdEvents.on('event', (ev) => robotdBridge.handle(ev));
  robotdEvents.on('gap', (gap) => {
    // 断线留痕：宁可时间线上有一个明确的洞，也不假装那段时间什么都没发生。
    try {
      events.emitStandalone({
        type: 'observation.gap',
        severity: 'warning',
        source: 'agentd',
        params: {
          dependency: 'robotd_events',
          from: String(gap.from ?? 0),
          to: new Date().toISOString(),
          reason: 'ws_disconnected',
        },
      });
    } catch (e: any) {
      log('写 observation.gap 失败', { error: e.message });
    }
  });
  robotdEvents.on('resync_required', (r) => {
    // 契约：不得用残缺事件修补状态，必须重拉快照。这里只记录需要重建基线。
    log('robotd 事件流需要重建基线', { reason: r.reason });
    try {
      events.emitStandalone({
        type: 'observation.gap',
        severity: 'warning',
        source: 'agentd',
        params: {
          dependency: 'robotd_events',
          from: String(r.instance_id ?? 'unknown'),
          to: new Date().toISOString(),
          reason: r.reason === 'instance_changed' ? 'instance_changed' : 'cursor_expired',
        },
      });
    } catch (e: any) {
      log('写 observation.gap 失败', { error: e.message });
    }
  });

  // Harness 状态：未配置时如实报 not_configured；配置后探测版本，
  // 只有二进制真的可用才报 ready（models.ts 的 harness_bridge 靠这个版本转 pass）。
  const harnessHome = codexHomePath();
  let harnessVersionCache: { binary: string; version: string | null } | null = null;
  const harnessVersion = (binary: string): string | null => {
    if (harnessVersionCache?.binary === binary) return harnessVersionCache.version;
    const version = probeHarnessVersion(binary, { codexHome: harnessHome });
    harnessVersionCache = { binary, version };
    return version;
  };
  const harnessInfo = (): HarnessInfo => {
    // 无论 Harness 是否配置，都把隔离目录报出来：
    // 用户要能确认 agentd 没有在用主机 ~/.codex。
    const binary = config.harnessBinary;
    return computeHarnessStatus({
      binary,
      exists: binary ? fs.existsSync(binary) : false,
      version: binary ? harnessVersion(binary) : null,
      active: harnessExecutorRef?.activeCount() ?? 0,
      approvalMode: config.allowManualApprove ? 'manual_test' : 'voice',
      codexHome: harnessHome,
    });
  };

  // 执行器在 runs 之后创建；onCancel 钩子通过 ref 取到它。
  let harnessExecutorRef: HarnessExecutor | null = null;
  const harnessDataDir = path.join(config.dataDir, 'harness');

  // 事件提交后 → 广播给 WS 订阅者
  let hubRef: LiveHub | null = null;
  const broadcastByseq = (seq: number): void => {
    if (!hubRef) return;
    const row = events.get(seq);
    if (!row) return;
    const { events: views } = events.query({ limit: 1 });
    // 直接渲染这一条，避免依赖排序
    const view = views.find((v) => decodeCursor(v.cursor) === seq);
    if (view) hubRef.broadcast(view);
  };

  // 澄清窗口（GH-49）：只存最近一次追问，30s 后失效；不是 run，不占活动名额。
  const clarificationWindow = new ClarificationWindow();

  const runs: RunService = new RunService({
    store,
    events,
    log,
    onEvent: broadcastByseq,
    // run 进入终态（cancelled 除外）→ 结论播报。异步执行，不阻塞状态推进。
    onTerminal: (runId) => {
      void narratorRef?.narrate(runId);
    },
    // 取消先落库为 cancelled，再由执行器 abort 真正的 thread。
    onCancel: (runId) => harnessExecutorRef?.abort(runId),
    // 语音 final 走与 POST /api/run 同一条路径；幂等键用 utterance_id，
    // 断线重连补发同一条 final 不会产生第二个 run。
    submitUtterance: ({ text, utterance_id }): { run_id?: string } =>
      submitRunRequest(buildRunRequestDeps(), {
        prompt: text,
        source: 'asr',
        idempotency_key: `asr:${utterance_id}`,
      }),
  });
  const harnessExecutor = new HarnessExecutor({
    runs,
    store,
    events,
    log,
    config: {
      binary: config.harnessBinary,
      codexHome: harnessHome,
      workingDirectory: path.join(harnessDataDir, 'workspace'),
    },
    clientFactory: createCodexHarnessClient,
    sink: new JsonlHarnessSink(harnessDataDir),
    credentials: () => ({
      apiKey: process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
    }),
  });
  harnessExecutorRef = harnessExecutor;
  const approvalAnnouncer = new ApprovalAnnouncer({
    runs,
    robotd,
    log,
    noteSpeak: (taskId, text, runId) => robotdBridge.noteSpeak(taskId, text, runId),
  });
  announcerRef = approvalAnnouncer;
  const runNarrator = new RunNarrator({
    runs,
    robotd,
    events,
    log,
    noteSpeak: (taskId, text, runId) => robotdBridge.noteSpeak(taskId, text, runId),
  });
  narratorRef = runNarrator;

  // 语音分发：顺序在 runs.dispatchUtterance 里钉死，这里只消费结果。
  // 审批通过后的执行仍由 approval-executor 负责（携带 #11 签发的一次性凭据）。
  utteranceDispatchRef = (input) => {
    const dispatched = runs.dispatchUtterance({
      utterance_id: input.utterance_id,
      text: input.text,
      echo: input.echo,
      started_at: input.started_at ?? null,
    });
    const approved = dispatched.approval;
    if (dispatched.action === 'approval' && approved?.outcome === 'approved') {
      if (!approved.run_id || !approved.capability) return;
      void executeApprovedCapability(
        { runs, robotd, store, log },
        {
          approvalId: approved.approval_id,
          runId: approved.run_id,
          capability: approved.capability,
          args: approved.args ?? {},
          actionLabel: approved.action_label ?? approved.capability,
        },
      );
    }
  };

  /**
   * 「一句话 → run / 澄清」的依赖，POST /api/run 与语音 final 共用同一份。
   * 两条入口若各写一套，路由、审批门与忙判定迟早会漂移。
   */
  function buildRunRequestDeps(): RunRequestDeps {
    return {
      runs,
      clarificationWindow,
      availableCapabilities: () =>
        robotd.capabilities.current
          ? new Set(robotd.capabilities.current.map((c) => c.name))
          : null,
      // 守卫拦下的命中要能在日志里解释原因（否定 / 疑问 / 词边界）。
      log: (m: string, x?: Record<string, unknown>) => log(m, x),
      // 快速路由必须**真的执行**：规则命中后启动执行，不阻塞响应。
      // 纪律：同样过审批门（executeFastRun 从能力契约取审批要求）；
      // 失败如实记录，不把未执行过的动作显示成「已停止」。
      executeFast: (runId: string, capability: string, args: Record<string, unknown>) => {
        void executeFastRun(runId, capability, args);
      },
      // 复杂指令交给 Harness：不阻塞响应，失败/取消都写在 run 上。
      executeHarness: (runId: string) => {
        // 执行器内部已经把业务失败写成 run.failed；这里只兜住「连状态都没写成」的
        // 意外异常，绝不让它变成进程级 unhandledRejection。
        void harnessExecutor.run(runId).catch((e: unknown) => {
          log('harness executor crashed', {
            run_id: runId,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      },
      // 澄清必须被说出口：走免审批的系统播报，正文由 robotd 固定模板从结构化字段渲染。
      // 播报失败不阻塞响应；事件里的 question 仍是可查的真相。
      announceClarification: (a) => {
        void robotd
          .announce({
            kind: 'clarification',
            reason: a.reason,
            ...(a.action_label ? { action_label: a.action_label } : {}),
            missing: a.missing,
            candidates: a.candidates,
            more: a.more,
          })
          .then((accepted) => {
            // 让随后到达的 speech.tts_finished 能在时间线上显示出实际念出的追问。
            if (accepted.task_id) robotdBridge.noteSpeak(accepted.task_id, accepted.text);
            log('澄清播报已受理', { task_id: accepted.task_id, reason: a.reason });
          })
          .catch((e: unknown) => {
            log('澄清播报失败', {
              reason: a.reason,
              error: e instanceof Error ? e.message : String(e),
            });
          });
      },
    };
  }

  const models = new ModelService({
    store,
    events,
    log,
    harnessVersion: () => harnessInfo().version,
    onEvent: broadcastByseq,
  });
  const overview = new Overview({
    store,
    events,
    robotd,
    runs,
    models,
    bootId,
    startedAt,
    harness: harnessInfo,
    allowManualApprove: config.allowManualApprove,
    log,
    subscription: () => robotdEvents.getStatus() as unknown as Record<string, unknown>,
  });

  // ------------------------------------------------ 启动对账
  store.probeWritable();
  const rec = runs.reconcileOnStartup();
  events.emitStandalone({
    type: 'daemon.started',
    params: {
      pid: process.pid,
      contract_version: CONTRACT_VERSION,
      recovered_runs: rec.interrupted,
    },
  });
  if (rec.interrupted > 0 || rec.cancelledApprovals > 0) {
    events.emitStandalone({
      type: 'daemon.recovered',
      severity: 'warning',
      params: { interrupted_runs: rec.interrupted, cancelled_approvals: rec.cancelledApprovals },
    });
  }

  // ------------------------------------------------ 路由
  const router = new Router({
    allowedOrigins: new Set(), // listen 之后按实际端口填
    csrfToken,
    selfPort: null,
    bootId,
    staticDir: config.staticDir && fs.existsSync(config.staticDir) ? config.staticDir : null,
    log,
  });

  const stats = () => store.stats();

  router.add(
    compileRoute('GET', '/healthz', 'agentd_healthz', false, () => {
      const s = stats();
      return {
        ok: true,
        daemon: 'agentd',
        pid: process.pid,
        boot_id: bootId,
        started_at: startedAt,
        contract_version: CONTRACT_VERSION,
        store: { path: s.path, writable: s.writable, migrated_to: s.schema_version },
        test_mode: {
          allow_manual_approve: config.allowManualApprove,
          allow_auto_approve: false,
        },
      };
    }),
  );

  router.add(
    compileRoute('GET', '/api/session', 'agentd_session', false, (ctx) => ({
      ok: true,
      boot_id: bootId,
      csrf: csrfToken,
      origin: ctx.req.headers.host ? `http://${ctx.req.headers.host}` : undefined,
    })),
  );

  router.add(
    compileRoute('GET', '/api/state', 'agentd_state', false, async () => overview.build()),
  );

  router.add(
    compileRoute('GET', '/api/sessions', 'agentd_list_sessions', false, (ctx) =>
      runs.listSessions(ctx.query.cursor ?? null, parseLimit(ctx.query.limit ?? null)),
    ),
  );

  router.add(
    compileRoute('POST', '/api/sessions', 'agentd_create_session', true, (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      rejectUnknown(body, ['title']);
      const title = body.title === undefined ? null : requireString(body.title, 'title', { max: 120 });
      return runs.createSession(title);
    }),
  );

  router.add(
    compileRoute('GET', '/api/sessions/{session_id}', 'agentd_get_session', false, (ctx) =>
      runs.getSession(ctx.params.session_id, ctx.query.cursor ?? null, parseLimit(ctx.query.limit ?? null)),
    ),
  );

  router.add(
    compileRoute('POST', '/api/run', 'agentd_submit_run', true, (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      rejectUnknown(body, ['prompt', 'idempotency_key', 'session_id', 'source', 'asr_meta']);
      const prompt = requireString(body.prompt, 'prompt', { min: 1, max: 4000 });
      const idem =
        body.idempotency_key === undefined
          ? undefined
          : requireString(body.idempotency_key, 'idempotency_key', { max: 128 });
      const sessionId =
        body.session_id === undefined ? undefined : requireString(body.session_id, 'session_id', { max: 120 });
      const source = optionalEnum(body.source, 'source', ['text', 'asr'] as const) ?? 'text';

      // 「一句话 → run 还是澄清」的决策在 run-request.ts：
      // 澄清不建 run（否则会留下永不推进的活动任务），受保护的 STOP 不受忙限制。
      return submitRunRequest(buildRunRequestDeps(), {
        prompt,
        session_id: sessionId,
        source,
        idempotency_key: idem,
      });
    }),
  );

  /**
   * 执行一次快速路由命中的能力调用。
   *
   * 状态机：`accepted → executing → succeeded | failed | waiting_confirmation`
   *
   * **审批只从能力契约取**（`CapabilityInfo.approvalParams` 存在即需审批）。当前首版规则
   * （`robot.stop`）不需要审批；将来加需要审批的规则时，这里必须落到
   * `waiting_confirmation` 而不是直接执行——规则不能降低审批门。
   */
  async function executeFastRun(
    runId: string,
    capability: string,
    args: Record<string, unknown>,
    // 复述里念给用户的是规则的中文摘要（`FastRule.summary`），不是能力名。
    // 装配层只拿到能力名，这里按能力反查默认规则；找不到再退回能力名。
    actionLabel: string = FAST_RULES.find((r) => r.capability === capability)?.summary ?? capability,
  ): Promise<void> {
    try {
      // 能力表可能还没探测；探测失败不静默跳过审批，宁可失败
      let tools = robotd.capabilities.current;
      if (!tools) {
        try {
          tools = await robotd.discoverCapabilities(null);
        } catch (e: any) {
          runs.transition(runId, 'failed', { reason: 'capability_discovery_failed', detail: `无法确认能力：${e.message}` });
          return;
        }
      }
      const tool = tools.find((t) => t.name === capability);
      if (!tool) {
        runs.transition(runId, 'failed', {
          reason: 'capability_missing',
          detail: `对端没有提供能力 ${capability}，未执行任何动作`,
        });
        return;
      }
      if (tool.approvalParams !== undefined) {
        // 先持久化审批，再用系统播报复述，**播完**才开确认窗口（run.waiting_confirmation）。
        // 不能用需审批的 robot_speak：那会让「问用户确认」本身再进入一次等待确认。
        const summary = compactJson(args).slice(0, 200);
        const approval = runs.createApproval({
          runId,
          capability,
          actionLabel,
          argsSummary: summary,
          argsJson: compactJson(args),
        });
        // 失败会由 announcer 写 approval.unavailable + run.finished，不在这里重复收尾
        await approvalAnnouncer.announce(approval.approval_id);
        return;
      }

      runs.transition(runId, 'executing');
      // 步骤与工具调用都要落库：界面靠它们显示「实际做了什么」，
      // 只有状态没有步骤会出现「succeeded 但看不出执行过什么」。
      const res = await robotd.callCapability(capability, args);
      const detail = res.robot_task_id ? `robotd 任务 ${res.robot_task_id}` : '已下发';
      store.transaction((tx) => {
        const sid = runs.addStep(tx, runId, `执行 ${capability}`, 'active');
        tx.run('UPDATE run_steps SET state = ?, finished_at = ?, note = ? WHERE step_id = ?', 'done', nowIso(), detail, sid);
        runs.recordToolCall(tx, runId, capability, `执行 ${capability}`, compactJson(args), 'succeeded', {
          args,
          approvalParams: [],
        });
      });
      runs.transition(runId, 'succeeded', { reason: 'fast_rule', detail });
    } catch (e: any) {
      // 失败如实记录：不能把「没执行成」显示成「已停止」
      const detail = e?.message ? String(e.message) : String(e);
      try {
        runs.transition(runId, 'failed', { reason: 'capability_failed', detail });
      } catch (e2: any) {
        log('快速路由终态写入失败', { run_id: runId, error: e2.message });
      }
    }
  }

  router.add(
    compileRoute('GET', '/api/runs', 'agentd_list_runs', false, (ctx) => {
      const status = optionalEnum(ctx.query.status, 'status', RUN_STATUSES) ?? null;
      return runs.listRuns(status, ctx.query.cursor ?? null, parseLimit(ctx.query.limit ?? null));
    }),
  );

  router.add(
    compileRoute('GET', '/api/runs/{run_id}', 'agentd_get_run', false, (ctx) =>
      runs.getRunDetail(ctx.params.run_id),
    ),
  );

  router.add(
    compileRoute('POST', '/api/runs/{run_id}/cancel', 'agentd_cancel_run', true, async (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      rejectUnknown(body, ['reason']);
      const reason =
        body.reason === undefined ? null : requireString(body.reason, 'reason', { max: 200 });
      const res = runs.cancelRun(ctx.params.run_id, reason);
      return res.detail;
    }),
  );

  router.add(
    compileRoute('POST', '/api/stop', 'agentd_stop', true, async () => {
      const active = runs.activeRun();
      let cancelledRunId: string | null = null;
      let cancelledApprovals = 0;

      if (active) {
        const c = runs.cancelRun(active.run_id, '收到停止指令');
        cancelledRunId = active.run_id;
        cancelledApprovals = c.voidedApprovals;
      }

      // 直达 robotd：不等 Harness、不等模型、不走审批
      let bodyStop: Record<string, unknown>;
      try {
        const r = await robotd.stop('agentd_stop');
        if (r.board_ack === true) {
          bodyStop = { state: 'confirmed', detail: 'robotd 已确认板侧收到停止', board_ack: true };
        } else if (r.board_ack === false) {
          bodyStop = {
            state: 'requested',
            detail: 'robotd 已受理停止，但板侧未确认（链路可能已断）',
            board_ack: false,
          };
        } else {
          bodyStop = { state: 'requested', detail: 'robotd 已受理停止，未拿到板侧确认', board_ack: null };
        }
      } catch (e: any) {
        // 不可达时必须说 unknown，不能假装停了
        bodyStop = {
          state: 'unknown',
          detail: `无法确认停止是否生效：${e.message}`,
          board_ack: null,
        };
      }

      const emitType = 'safety.stop_requested';
      if (events.isRegistered(emitType)) {
        events.emitStandalone({
          type: emitType,
          severity: bodyStop.state === 'confirmed' ? 'info' : 'warning',
          run_id: cancelledRunId,
          params: {
            state: bodyStop.state as string,
            detail: String(bodyStop.detail),
            run_id: cancelledRunId ?? undefined,
          },
        });
      }

      return {
        ok: true,
        cancelled_run_id: cancelledRunId,
        cancelled_approvals: cancelledApprovals,
        revoked_authorizations: 0,
        body_stop: bodyStop,
        at: nowIso(),
      };
    }),
  );

  router.add(
    compileRoute('GET', '/api/events', 'agentd_list_events', false, (ctx) => {
      const limit = parseLimit(ctx.query.limit ?? null);
      const cursor = ctx.query.cursor ?? null;
      // 游标格式非法 → 410，要求从头加载
      if (cursor && decodeCursor(cursor) === null) {
        throw new ApiError('E_CURSOR_EXPIRED', '游标不合法，请从第一页重新加载', {
          details: { cursor },
        });
      }
      const page = events.query({
        since: ctx.query.since ?? null,
        until: ctx.query.until ?? null,
        severity: optionalEnum(ctx.query.severity, 'severity', ['info', 'warning', 'error'] as const) ?? null,
        source: optionalEnum(ctx.query.source, 'source', [
          'agentd',
          'robotd',
          'harness',
          'model',
          'store',
          'user',
        ] as const) ?? null,
        runId: ctx.query.run_id ?? null,
        q: ctx.query.q ?? null,
        cursor,
        limit,
      });
      return {
        ok: true,
        events: page.events,
        next_cursor: page.next_cursor,
        head_cursor: events.headCursor(),
        gap: null,
      };
    }),
  );

  // ------------------------------------------- 模型
  router.add(
    compileRoute('GET', '/api/model-profiles', 'agentd_list_model_profiles', false, () => models.list()),
  );

  router.add(
    compileRoute('POST', '/api/model-profiles', 'agentd_create_model_profile', true, (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      rejectUnknown(body, [
        'name',
        'provider',
        'endpoint',
        'model',
        'credential',
        'reasoning_effort',
        'max_output_tokens',
        'temperature',
        'request_timeout_ms',
        'budget_tokens',
        'data_boundary',
      ]);
      return models.create({
        name: requireString(body.name, 'name', { min: 1, max: 60 }),
        provider: requireString(body.provider, 'provider'),
        endpoint: requireString(body.endpoint, 'endpoint'),
        model: requireString(body.model, 'model', { min: 1, max: 200 }),
        credential: body.credential === undefined ? undefined : requireString(body.credential, 'credential'),
        reasoning_effort: body.reasoning_effort as string | undefined,
        max_output_tokens: optionalInt(body.max_output_tokens, 'max_output_tokens', { min: 1 }),
        temperature: optionalNumber(body.temperature, 'temperature', { min: 0, max: 2 }),
        request_timeout_ms: optionalInt(body.request_timeout_ms, 'request_timeout_ms', {
          min: 1000,
          max: 600000,
        }),
        budget_tokens: optionalInt(body.budget_tokens, 'budget_tokens', { min: 1 }) ?? null,
        data_boundary: body.data_boundary as string | undefined,
      });
    }),
  );

  router.add(
    compileRoute('GET', '/api/model-profiles/{profile_id}', 'agentd_get_model_profile', false, (ctx) =>
      models.get(ctx.params.profile_id),
    ),
  );

  router.add(
    compileRoute('PUT', '/api/model-profiles/{profile_id}', 'agentd_update_model_profile', true, (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      rejectUnknown(body, [
        'base_revision',
        'name',
        'provider',
        'endpoint',
        'model',
        'credential',
        'clear_credential',
        'reasoning_effort',
        'max_output_tokens',
        'temperature',
        'request_timeout_ms',
        'budget_tokens',
        'data_boundary',
      ]);
      return models.update(ctx.params.profile_id, body);
    }),
  );

  router.add(
    compileRoute(
      'POST',
      '/api/model-profiles/{profile_id}/validate',
      'agentd_validate_model_profile',
      true,
      async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        rejectUnknown(body, ['revision']);
        const revision = optionalInt(body.revision, 'revision', { min: 1 }) ?? null;
        return models.validate(ctx.params.profile_id, revision);
      },
    ),
  );

  router.add(
    compileRoute(
      'POST',
      '/api/model-profiles/{profile_id}/activate',
      'agentd_activate_model_profile',
      true,
      (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        rejectUnknown(body, ['revision', 'base_active_revision']);
        const revision = optionalInt(body.revision, 'revision', { min: 1 });
        if (revision === undefined) {
          throw new ApiError('E_VALIDATION', 'revision 必填', { details: { field: 'revision' } });
        }
        const base = optionalInt(body.base_active_revision, 'base_active_revision', { min: 1 }) ?? null;
        return models.activate(ctx.params.profile_id, revision, base);
      },
    ),
  );

  // ------------------------------------------- 审批（只读）
  router.add(
    compileRoute('GET', '/api/approvals', 'agentd_list_approvals', false, (ctx) => {
      const limit = parseLimit(ctx.query.limit ?? null);
      const status =
        optionalEnum(ctx.query.status, 'status', [
          'persisted',
          'announced',
          'waiting',
          'approved',
          'denied',
          'timeout',
          'cancelled',
        ] as const) ?? null;
      const where = status ? 'WHERE status = ?' : '';
      const rows = store.all<any>(
        `SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ?`,
        ...(status ? [status] : []),
        limit,
      );
      return {
        ok: true,
        approvals: rows.map(approvalView),
        // 正常界面没有批准写入口；这个标志位为 true 说明在测试模式
        manual_approve_enabled: config.allowManualApprove,
      };
    }),
  );

  // ------------------------------------------- WS 订阅中心
  const hub = new LiveHub({
    bootId,
    events,
    retainedFromSeq: () => 1, // 首版不裁剪；裁剪后这里要返回实际下界
    log,
  });
  hubRef = hub;

  // ------------------------------------------- HTTP 服务器
  const server = http.createServer();
  let selfPort = 0;

  server.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    sendNoCors(res);
    try {
      checkHost(req, selfPort);
      const { sameOrigin } = checkOrigin(req, router.config.allowedOrigins);
      const hit = router.match(req.method ?? 'GET', url.pathname);

      // CORS 预检：只回允许的方法，不给通配。必须在 `!hit` 之前处理——
      // OPTIONS 本身不是注册路由，否则会掉进 405/404 分支。
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { allow: [...router.allowedMethods(url.pathname), 'OPTIONS'].join(', ') });
        res.end();
        return;
      }

      if (!hit) {
        // 405 vs 404：同路径有其他方法就是 405，并给出 Allow
        const allowed = router.allowedMethods(url.pathname);
        if (allowed.length > 0) {
          res.setHeader('allow', [...allowed, 'OPTIONS'].join(', '));
          throw new ApiError('E_NOT_FOUND', `${url.pathname} 不支持 ${req.method}`, {
            details: { allowed },
          });
        }
        if (isApiPath(url.pathname)) {
          throw new ApiError('E_NOT_FOUND', `没有这个接口：${url.pathname}`);
        }
        if (router.config.staticDir && serveStatic(res, router.config.staticDir, url.pathname, log)) return;
        throw new ApiError('E_NOT_FOUND', `资源不存在：${url.pathname}`);
      }

      if (hit.route.write) checkCsrf(req, csrfToken);

      let body: unknown = undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            throw new ApiError('E_VALIDATION', '请求体不是合法 JSON');
          }
        }
      }

      const result = await hit.route.handler({
        req,
        res,
        params: hit.params,
        query: Object.fromEntries(url.searchParams),
        body,
        sameOrigin,
      });
      sendJson(res, 200, result);
    } catch (e) {
      const err = toApiError(e);
      const details = err.details as Record<string, unknown> | null;
      if (details && typeof details.max_bytes === 'number') {
        abortOversized(req, res, err, log);
        return;
      }
      if (!res.headersSent) {
        sendJson(res, err.status, err.toBody());
      } else {
        res.end();
      }
      if (err.status >= 500) log('request failed', { path: url.pathname, code: err.code, msg: err.message });
    }
  });

  // ------------------------------------------- WS 升级
  server.on('upgrade', (req: http.IncomingMessage, socket: Socket) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const reject = (status: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${status} Bad Request\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      log('ws upgrade rejected', { reason, path: url.pathname });
    };
    try {
      // WS 同样要过 Host/Origin 门禁
      checkHost(req, selfPort);
      checkOrigin(req, router.config.allowedOrigins);
    } catch (e) {
      reject(403, (e as Error).message);
      return;
    }
    if (!WS_PATHS.includes(url.pathname)) {
      reject(404, '不是 WS 端点');
      return;
    }
    const check = validateUpgrade(req);
    if (!check.ok) {
      reject(check.status ?? 400, check.reason ?? '非法升级');
      return;
    }
    writeUpgradeResponse(socket, req.headers['sec-websocket-key'] as string);
    hub.attach(socket, req);
  });

  // 监听：只允许回环
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  selfPort = typeof addr === 'object' && addr ? addr.port : config.httpPort;
  router.config.selfPort = selfPort;
  router.config.allowedOrigins = new Set([
    `http://127.0.0.1:${selfPort}`,
    `http://localhost:${selfPort}`,
    `http://[::1]:${selfPort}`,
  ]);

  log('agentd listening', {
    port: selfPort,
    boot_id: bootId,
    robotd: config.robotdUrl,
    store: store.stats().path,
    static: router.config.staticDir,
  });

  // 事件订阅在监听之后启动：**失败不影响服务可用**，只在 /api/state 里如实降级。
  robotdEvents.start();

  const close = async (): Promise<void> => {
    harnessExecutor.dispose();
    runs.dispose();
    robotdEvents.stop();
    hub.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  };

  return {
    server,
    port: selfPort,
    bootId,
    csrfToken,
    router,
    store,
    events,
    runs,
    models,
    overview,
    hub,
    robotd,
    robotdEvents,
    robotdBridge,
    close,
  };
}

export { MAX_BODY_BYTES };
