/**
 * 最小 Harness 执行器（GH-10）。
 *
 * ## 为什么单独一层
 *
 * `runs.ts` 是纯状态机 + SQLite，必须能在没有模型 SDK、没有 codex 二进制的环境里测试。
 * 所以这里只依赖一个**结构化**的 `HarnessClient` 接口：
 *
 *   startThread() / resumeThread(id) → Thread.runStreamed(input, { signal })
 *
 * 真正的 `@openai/codex-sdk` 适配放在 `harness-codex.ts`；单测注入假客户端，
 * 覆盖 thread 复用、重建、工具调用映射、取消与超时。
 *
 * ## 三条硬纪律
 *
 * 1. **一个会话复用一个 thread**：thread_id 存 sessions 表；resume 失败必须新建并留痕，
 *    不静默假装续上。
 * 2. **原始事件不进 EventLog**：`item.*` / reasoning / 思考流只落
 *    `<dataDir>/harness/<run_id>.jsonl`；事件库只收 run 状态迁移、tool_calls 表与最终摘要。
 * 3. **取消即 abort**：`cancelRun` 之后由装配层调用 `abort(runId)`；被 abort 的执行器
 *    看到 run 已是 `cancelled` 就安静退出，绝不把终态改写成 `failed`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { Store, Tx } from './store.ts';
import { compactJson, nowIso } from './store.ts';
import type { EventLog } from './events.ts';
import type { RunService } from './runs.ts';
import { isTerminal } from './runs.ts';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** SDK `ThreadEvent` 的结构化子集：只声明执行器真正读的字段。 */
export interface HarnessEvent {
  type: string;
  thread_id?: string | null;
  item?: {
    id?: string;
    type?: string;
    server?: string;
    tool?: string;
    arguments?: unknown;
    status?: string;
    text?: string;
    message?: string;
    error?: { message?: string };
  };
  error?: { message?: string };
  message?: string;
  [key: string]: unknown;
}

export interface HarnessStream {
  events: AsyncIterable<HarnessEvent>;
}

export interface HarnessThreadLike {
  readonly id: string | null;
  runStreamed(input: string, opts?: { signal?: AbortSignal }): Promise<HarnessStream>;
}

export interface HarnessClientLike {
  startThread(): HarnessThreadLike;
  resumeThread(threadId: string): HarnessThreadLike;
}

export interface HarnessClientOptions {
  binary: string;
  codexHome: string;
  apiKey: string;
  workingDirectory: string;
  model?: string;
}

export type HarnessClientFactory = (opts: HarnessClientOptions) => Promise<HarnessClientLike>;

/** raw thread 事件的落点。单测可注入内存实现，默认写 jsonl。 */
export interface HarnessEventSink {
  write(runId: string, event: HarnessEvent): void;
}

export interface HarnessConfig {
  /** `--harness <path>`；null 表示未配置。 */
  binary: string | null;
  /** `codexHomePath()` 的结果，显式传给子进程。 */
  codexHome: string;
  /** 模型可见的工作目录；默认 `<dataDir>/harness/workspace`。 */
  workingDirectory: string;
  model?: string;
  timeoutMs?: number;
}

export interface HarnessExecutorDeps {
  runs: RunService;
  store: Store;
  events: EventLog;
  log: Log;
  config: HarnessConfig;
  clientFactory: HarnessClientFactory;
  sink: HarnessEventSink;
  /** 每次 run 现读凭证：测试可注入 null，生产读 process.env。 */
  credentials: () => { apiKey: string | null };
  now?: () => number;
}

export type HarnessOutcome = 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export const DEFAULT_HARNESS_TIMEOUT_MS = 120_000;

const RESUMABLE_FAILURE =
  /no rollout found|thread .*not found|failed to (load|resume) thread|thread .*(does not exist|not exist)|session .*not found/i;

/** 判断 resume 失败是否属于「历史不可用，可安全重建」，而不是配置/网络错误。 */
export function isResumeFailure(message: string): boolean {
  return RESUMABLE_FAILURE.test(message);
}

/**
 * `codex --version` 的输出解析。返回第一行非空文本；读不到时 null。
 *
 * 不做「猜版本号」：把整行原样报给用户比截一个数字更不容易骗人。
 */
export function parseHarnessVersion(raw: string): string | null {
  const line = String(raw ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return line ?? null;
}

/** 探测可执行文件版本；失败返回 null（由调用方如实报 error）。 */
export function probeHarnessVersion(
  binary: string,
  opts: { codexHome: string; env?: NodeJS.ProcessEnv } = { codexHome: '' },
): string | null {
  try {
    const out = execFileSync(binary, ['--version'], {
      env: buildCodexEnv(opts.env ?? process.env, opts.codexHome, null),
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseHarnessVersion(out);
  } catch {
    return null;
  }
}

/**
 * 子进程环境白名单。
 *
 * SDK 收到 `env` 后**不再继承** `process.env`，这是隔离成立的关键。因此这里显式
 * 只放：PATH（子进程找基础命令）、HOME（macOS 基础工具）、CODEX_HOME（我们的目录）、
 * CODEX_API_KEY（本次凭证）。其他变量（AWS/代理/主机 token）一律不外泄。
 */
export function buildCodexEnv(
  source: NodeJS.ProcessEnv,
  codexHome: string,
  apiKey: string | null,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH && source.PATH.length > 0 ? source.PATH : '/usr/bin:/bin',
    CODEX_HOME: codexHome,
  };
  if (source.HOME) env.HOME = source.HOME;
  if (apiKey) env.CODEX_API_KEY = apiKey;
  return env;
}

/** 默认 jsonl 落点：`<dataDir>/harness/<run_id>.jsonl`。 */
export class JsonlHarnessSink implements HarnessEventSink {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  write(runId: string, event: HarnessEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const safe = path.basename(runId).replace(/[^A-Za-z0-9._-]/g, '_');
    fs.appendFileSync(path.join(this.dir, `${safe}.jsonl`), `${compactJson(event)}\n`, 'utf8');
  }
}

export interface HarnessStatus {
  state: 'not_configured' | 'ready' | 'running' | 'error' | 'unavailable';
  binary: string | null;
  version: string | null;
  approval_mode: 'voice' | 'manual_test';
  codex_home: string | null;
  last_error: string | null;
}

/** `brain.harness` 的判定：如实区分「没配」「路径错」「正在跑」「就绪」。 */
export function computeHarnessStatus(input: {
  binary: string | null;
  exists: boolean;
  version: string | null;
  active: number;
  approvalMode: 'voice' | 'manual_test';
  codexHome: string;
}): HarnessStatus {
  const base = {
    binary: input.binary,
    approval_mode: input.approvalMode,
    codex_home: input.codexHome,
  };
  if (!input.binary) {
    return { ...base, state: 'not_configured', version: null, last_error: null };
  }
  if (!input.exists) {
    return {
      ...base,
      state: 'error',
      version: null,
      last_error: `找不到可执行文件 ${input.binary}`,
    };
  }
  if (!input.version) {
    return {
      ...base,
      state: 'error',
      version: null,
      last_error: `无法从 ${input.binary} --version 读取版本`,
    };
  }
  return {
    ...base,
    state: input.active > 0 ? 'running' : 'ready',
    version: input.version,
    last_error: null,
  };
}

interface ActiveRun {
  controller: AbortController;
  thread: HarnessThreadLike | null;
  timeoutReason: 'timeout' | null;
}

export class HarnessExecutor {
  private deps: HarnessExecutorDeps;
  private active = new Map<string, ActiveRun>();

  constructor(deps: HarnessExecutorDeps) {
    this.deps = deps;
  }

  activeCount(): number {
    return this.active.size;
  }

  /** 真正中断 thread。返回 false 表示这个 run 没有活动执行体（已结束/从未启动）。 */
  abort(runId: string): boolean {
    const entry = this.active.get(runId);
    if (!entry) return false;
    try {
      entry.controller.abort(new Error('harness_cancelled'));
    } catch {
      /* abort 幂等失败不影响状态 */
    }
    return true;
  }

  dispose(): void {
    for (const [, entry] of this.active) {
      entry.timeoutReason = null;
      try {
        entry.controller.abort(new Error('harness_shutdown'));
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
  }

  /**
   * 执行一个 `route: harness` 的 run。
   *
   * 返回执行器视角的结局（测试用）。run 的权威状态仍在 runs 表。
   */
  async run(runId: string): Promise<HarnessOutcome> {
    const log = this.deps.log;
    const run = this.deps.runs.getRunRow(runId);
    if (!run) return 'skipped';
    if (isTerminal(run.status)) return run.status === 'cancelled' ? 'cancelled' : 'skipped';

    const missing = this.missingConfig();
    if (missing) {
      this.fail(runId, 'harness_unconfigured', missing);
      return 'failed';
    }
    const binary = this.deps.config.binary!;
    const apiKey = this.deps.credentials().apiKey!;

    const entry: ActiveRun = {
      controller: new AbortController(),
      thread: null,
      timeoutReason: null,
    };
    this.active.set(runId, entry);
    const timeoutMs = this.deps.config.timeoutMs ?? DEFAULT_HARNESS_TIMEOUT_MS;
    const timer = setTimeout(() => {
      entry.timeoutReason = 'timeout';
      try {
        entry.controller.abort(new Error('harness_timeout'));
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    let planStepId: string | null = null;
    let executingStepId: string | null = null;
    try {
      // 目录在真正要跑的时候才建：`/api/state` 只读、未配置 Harness 时不该写盘。
      fs.mkdirSync(this.deps.config.codexHome, { recursive: true });
      fs.mkdirSync(this.deps.config.workingDirectory, { recursive: true });
      planStepId = this.addStep(runId, '理解与规划', 'active');
      this.deps.runs.transition(runId, 'planning');

      const client = await this.deps.clientFactory({
        binary,
        codexHome: this.deps.config.codexHome,
        apiKey,
        workingDirectory: this.deps.config.workingDirectory,
        model: this.deps.config.model,
      });

      const resumedId =
        run.session_id !== null ? this.deps.runs.getSessionThreadId(run.session_id) : null;
      let thread = resumedId ? client.resumeThread(resumedId) : client.startThread();
      entry.thread = thread;

      let result: TurnResult;
      try {
        result = await this.executeTurn(runId, thread, run.prompt, entry, {
          planStepId,
          onExecuting: (stepId) => {
            executingStepId = stepId;
          },
        });
      } catch (e: any) {
        if (!resumedId || this.isCancelled(runId) || !isResumeFailure(messageOf(e))) throw e;
        // 历史被清/版本不兼容：明确重建，再试一次；不静默假装续上。
        thread = client.startThread();
        entry.thread = thread;
        this.recordThreadRebuilt(runId, resumedId, thread.id);
        result = await this.executeTurn(runId, thread, run.prompt, entry, {
          planStepId,
          onExecuting: (stepId) => {
            executingStepId = stepId;
          },
        });
      }

      if (this.isCancelled(runId)) return 'cancelled';
      this.persistThreadId(run, thread);
      this.finishStep(runId, planStepId, 'done', 'Harness 已完成规划');
      this.deps.runs.transition(runId, 'succeeded', {
        reason: 'harness',
        detail: result.summary,
        summary: result.summary,
      });
      return 'succeeded';
    } catch (e: any) {
      if (this.isCancelled(runId)) {
        this.finishStep(runId, executingStepId ?? planStepId, 'skipped', '已取消');
        return 'cancelled';
      }
      if (entry.timeoutReason === 'timeout') {
        this.finishStep(runId, executingStepId ?? planStepId, 'failed', 'Harness 执行超时');
        this.fail(runId, 'harness_timeout', `Harness 在 ${timeoutMs}ms 内未完成，已中断`);
        return 'failed';
      }
      const detail = messageOf(e);
      log('harness run failed', { run_id: runId, error: detail });
      this.finishStep(runId, executingStepId ?? planStepId, 'failed', detail.slice(0, 500));
      this.fail(runId, 'harness_error', detail.slice(0, 500));
      return 'failed';
    } finally {
      clearTimeout(timer);
      this.active.delete(runId);
    }
  }

  private async executeTurn(
    runId: string,
    thread: HarnessThreadLike,
    prompt: string,
    entry: ActiveRun,
    ctx: { planStepId: string | null; onExecuting: (stepId: string) => void },
  ): Promise<TurnResult> {
    const streamed = await thread.runStreamed(prompt, { signal: entry.controller.signal });
    let finalText = '';
    let toolCalls = 0;
    let planFinished = false;
    let terminal: 'completed' | 'failed' | null = null;
    let failure: string | null = null;

    for await (const event of streamed.events) {
      this.deps.sink.write(runId, event);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        this.persistThreadIdFromStream(runId, event.thread_id);
        continue;
      }
      if (event.type === 'turn.failed') {
        terminal = 'failed';
        failure = event.error?.message ?? 'turn.failed';
        break;
      }
      if (event.type === 'turn.completed') {
        terminal = 'completed';
        continue;
      }
      if (event.type === 'error') {
        terminal = 'failed';
        failure = event.message ?? 'thread error';
        break;
      }
      if (event.type !== 'item.completed' || !event.item) continue;
      const item = event.item;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        finalText = item.text;
        continue;
      }
      if (item.type !== 'mcp_tool_call') continue;

      // 首个工具调用 = 进入执行阶段。规划步骤在此收口。
      if (!planFinished) {
        this.finishStep(runId, ctx.planStepId, 'done', '已开始执行');
        planFinished = true;
      }
      if (!this.isExecuting(runId)) this.deps.runs.transition(runId, 'executing');
      const stepId = this.addStep(runId, `调用 ${item.tool ?? item.server ?? '工具'}`, 'active');
      ctx.onExecuting(stepId);
      const ok = item.status !== 'failed' && !item.error;
      const evidence = ok
        ? summarizeToolResult(item)
        : (item.error?.message ?? '工具调用失败');
      // item.id 在同一次 turn 内唯一，但不保证跨 turn 唯一；tool_calls 的主键跨 run
      // 共享一张表，因此带上 run_id 前缀，避免第二个 run 撞 UNIQUE。
      const toolCallId = item.id ? `${runId}:${item.id}` : undefined;
      this.deps.store.transaction((tx) => {
        this.deps.runs.recordToolCall(
          tx,
          runId,
          String(item.tool ?? 'unknown'),
          `调用 ${item.tool ?? '工具'}`,
          compactJson(item.arguments ?? {}).slice(0, 200),
          ok ? 'succeeded' : 'failed',
          {
            args: isRecord(item.arguments) ? item.arguments : {},
            toolCallId,
            // 有 task_id 才记录：安全停止归属只认 robotd 给出的任务 id，不猜活动 run。
            robotTaskId: robotTaskIdOf(item),
          },
        );
        this.updateStep(tx, stepId, ok ? 'done' : 'failed', evidence.slice(0, 500));
      });
      toolCalls += 1;
    }

    if (terminal === 'failed') throw new Error(failure ?? 'Harness turn failed');
    if (this.isCancelled(runId)) throw new Error('harness_cancelled');
    if (terminal !== 'completed') throw new Error('Harness 未返回 turn.completed');
    if (!planFinished) this.finishStep(runId, ctx.planStepId, 'done', 'Harness 已完成规划');
    const summary = finalText.trim()
      ? finalText.replace(/\s+/g, ' ').trim().slice(0, 200)
      : toolCalls > 0
        ? `Harness 完成，执行了 ${toolCalls} 个工具调用。`
        : 'Harness 已完成。';
    return { summary, toolCalls };
  }

  private missingConfig(): string | null {
    const binary = this.deps.config.binary;
    if (!binary) return '未配置 Harness 可执行文件（启动时用 --harness <path>）';
    if (!fs.existsSync(binary)) return `找不到 Harness 可执行文件 ${binary}`;
    if (!this.deps.credentials().apiKey) {
      return '缺少 CODEX_API_KEY 或 OPENAI_API_KEY，复杂指令暂时不能交给 Harness';
    }
    return null;
  }

  private fail(runId: string, reason: string, detail: string): void {
    if (this.isCancelled(runId)) return;
    try {
      this.deps.runs.transition(runId, 'failed', { reason, detail });
    } catch (e: any) {
      this.deps.log('harness failure transition failed', { run_id: runId, error: messageOf(e) });
    }
  }

  private isCancelled(runId: string): boolean {
    const row = this.deps.runs.getRunRow(runId);
    return row?.status === 'cancelled';
  }

  private isExecuting(runId: string): boolean {
    return this.deps.runs.getRunRow(runId)?.status === 'executing';
  }

  private addStep(runId: string, title: string, state: string): string {
    return this.deps.store.transaction((tx) => this.deps.runs.addStep(tx, runId, title, state));
  }

  private finishStep(runId: string, stepId: string | null, state: string, note: string): void {
    if (!stepId) return;
    try {
      this.deps.store.transaction((tx) => this.updateStep(tx, stepId, state, note));
    } catch (e: any) {
      this.deps.log('harness step finish failed', { run_id: runId, error: messageOf(e) });
    }
  }

  private updateStep(tx: Tx, stepId: string, state: string, note: string): void {
    tx.run(
      'UPDATE run_steps SET state = ?, note = ?, finished_at = ? WHERE step_id = ?',
      state,
      note,
      nowIso(),
      stepId,
    );
  }

  private persistThreadIdFromStream(runId: string, threadId: string): void {
    const run = this.deps.runs.getRunRow(runId);
    if (!run || !run.session_id) return;
    if (this.deps.runs.getSessionThreadId(run.session_id) === threadId) return;
    this.deps.runs.setSessionThreadId(run.session_id, threadId);
  }

  private persistThreadId(
    run: { run_id: string; session_id: string | null },
    thread: HarnessThreadLike,
  ): void {
    const threadId = thread.id;
    if (!run.session_id || !threadId) return;
    if (this.deps.runs.getSessionThreadId(run.session_id) === threadId) return;
    this.deps.runs.setSessionThreadId(run.session_id, threadId);
  }

  /**
   * 重建留痕。事件契约没有登记 `harness.*`，所以用已登记的 `run.step_changed`
   * 携带 `data.note = "harness.thread_rebuilt"`，并在 raw jsonl 与日志里各留一条。
   */
  private recordThreadRebuilt(runId: string, previousId: string, nextId: string | null): void {
    const detail = {
      type: 'harness.thread_rebuilt',
      reason: 'resume_failed',
      previous_thread_id: previousId,
      thread_id: nextId,
    };
    this.deps.sink.write(runId, detail);
    this.deps.log('harness.thread_rebuilt', { run_id: runId, ...detail });
    try {
      this.deps.store.transaction((tx) => {
        this.deps.events.emit(tx, {
          type: 'run.step_changed',
          run_id: runId,
          params: {
            step_id: 'harness-thread-rebuilt',
            step_title: '重建 Harness 线程',
            state: 'done',
            note: 'harness.thread_rebuilt',
          },
          data: { note: 'harness.thread_rebuilt', previous_thread_id: previousId, thread_id: nextId },
        });
      });
    } catch (e: any) {
      this.deps.log('record thread rebuild event failed', { run_id: runId, error: messageOf(e) });
    }
  }
}

interface TurnResult {
  summary: string;
  toolCalls: number;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarizeToolResult(item: NonNullable<HarnessEvent['item']>): string {
  const structured = (item as { result?: { structured_content?: unknown } }).result?.structured_content;
  if (structured !== undefined && structured !== null) return compactJson(structured).slice(0, 500);
  return '工具调用完成';
}

/** 工具结果里可能的 robotd task_id（不同 MCP 包装层可能放在 result 或其 structured_content）。 */
function robotTaskIdOf(item: NonNullable<HarnessEvent['item']>): string | null {
  const result = (item as { result?: unknown }).result;
  if (!isRecord(result)) return null;
  if (typeof result.task_id === 'string' && result.task_id) return result.task_id;
  const structured = result.structured_content;
  if (isRecord(structured) && typeof structured.task_id === 'string' && structured.task_id) {
    return structured.task_id;
  }
  return null;
}
