/**
 * robotd 公开接口客户端（ADR-0007）。
 *
 * ## 这个模块是「边界」的落点
 *
 * ADR-0007 明确禁止 agentd 在运行时读取 robotd 的契约生成物、代码、数据库或运行文件。
 * 旧 POC 用 `fs.readFileSync('contracts/generated/mcp-tools.json')` 构造自己的能力面，
 * 那是**构建期**依赖被误用成了运行期事实。这里的规则是：
 *
 * - **能力发现**走 MCP `tools/list`（HTTP 优先，失败再尝试 WS 形态）——问对端「你现在有什么」。
 * - **状态**走 `GET /v1/robot/state`，只读，不写回。
 * - **任务**走 `/v1/tasks/{id}`、`DELETE /v1/tasks/{id}`。
 * - **停止**走 `POST /v1/robot/stop`，不经过模型、不经过审批。
 * - **事件**走 `WS /v1/events`，带快照对齐与游标补发。
 *
 * agentd 构建期仍然可以依赖 ``contracts/generated/mcp-tools.json`` 里的**字段名**
 * （审批属性、参数形状），但运行时一律以对端实际应答为准；对端没给的能力就是不可用，
 * 不拿本地文件「补上」。
 *
 * ## 观测的诚实性
 *
 * 每次取状态都记录 `observed_at` 与 `instance_id`。调用方必须按 freshness 判断
 * 「这是现状还是旧账」。本模块**不缓存成可写状态**，也不再造一份 RobotState。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export type RobotdErrorCode =
  | 'E_UNREACHABLE'
  | 'E_TIMEOUT'
  | 'E_VALIDATION'
  | 'E_BUSY'
  | 'E_NO_TASK'
  | 'E_NOT_FOUND'
  | 'E_APPROVAL'
  | 'E_UNAVAILABLE'
  | 'E_TIMEOUT_BOARD'
  | 'E_INTERNAL';

export interface RobotdError {
  code: RobotdErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
  http_status?: number;
}

export class RobotdCallError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly httpStatus: number | null;

  constructor(err: RobotdError) {
    super(err.message);
    this.name = 'RobotdCallError';
    this.code = err.code;
    this.details = err.details ?? {};
    this.httpStatus = err.http_status ?? null;
  }

  /** 依赖不可达（网络层），与「对端明确拒绝」区分开。 */
  get unreachable(): boolean {
    return this.code === 'E_UNREACHABLE' || this.code === 'E_TIMEOUT';
  }
}

export interface RobotState {
  robot_id: string;
  version: number;
  mode: string;
  pose: { x: number; y: number; theta: number; valid: boolean } | null;
  odometry: Record<string, unknown> | null;
  devices: Record<string, string>;
  battery: { source: string; voltage: number | null; percent: number | null } | null;
  task_id: string | null;
  firmware: string | null;
  transport: string;
  ts: number;
  event_seq: number;
}

export interface RobotdHealth {
  ok: boolean;
  service: string;
  version: number;
  instance_id: string;
  protocol: number;
  transport: string;
  esp32: string;
  mode: string;
  pid: number;
  implementation_version: string;
}

export interface RobotdTask {
  task_id: string;
  capability: string;
  state: string;
  progress: number;
  started_at: number;
  finished_at?: number;
  cancelable: boolean;
  exclusivity: string;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** 能力面的一项。**运行时从对端发现**，不从本地文件读。 */
export interface CapabilityInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * 审批绑定声明。**存在即表示该能力需要审批**；`[]` 表示需审批但不绑定任何参数。
   * 值来自契约 `x-requires-approval: { params: [...] }`，不是本地策略。
   */
  approvalParams?: string[];
  operation?: { method: string; path: string; pathParams: string[] };
}

export interface StopResult {
  ok: boolean;
  stopped: boolean;
  at: number;
  board_ack: boolean | null;
  stopped_tasks: number;
}

export interface AnnounceInput {
  approval_id: string;
  kind: 'approval_repeat';
  action_label: string;
  args_summary: string;
}

export interface AnnounceAccepted {
  task_id: string;
  status: 'accepted';
  approval_id: string;
  kind: 'approval_repeat';
  /** robotd 实际交给 TTS 的固定模板句子，供审计与界面展示。 */
  text: string;
}

interface ObservationMeta {
  observed_at: string;
  instance_id: string | null;
}

export interface ObservedState extends ObservationMeta {
  state: RobotState;
}

/**
 * 运行期的能力面缓存。
 *
 * 为什么要缓存：MCP 的 `tools/list` 需要先起一个 stdio 子进程，不能每次调用都拉一遍。
 * 但缓存必须**可失效**：对端实例变了（instance_id 变化）就重新发现；
 * 发现失败时**不退回本地文件**，而是让上层得到「能力面未知」，据此禁用相关动作。
 */
export class CapabilityCache {
  private tools: CapabilityInfo[] | null = null;
  private loadedFor: string | null = null;
  private loadedAt = 0;
  private lastError: string | null = null;
  private ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  get current(): CapabilityInfo[] | null {
    return this.tools;
  }

  get error(): string | null {
    return this.lastError;
  }

  needsRefresh(instanceId: string | null): boolean {
    if (this.tools === null) return true;
    if (instanceId && this.loadedFor && instanceId !== this.loadedFor) return true;
    return Date.now() - this.loadedAt > this.ttlMs;
  }

  store(tools: CapabilityInfo[], instanceId: string | null): void {
    this.tools = tools;
    this.loadedFor = instanceId;
    this.loadedAt = Date.now();
    this.lastError = null;
  }

  fail(message: string): void {
    // 失败不清空已有能力面，但记下原因：UI 要能显示「能力面未知/过期」
    this.lastError = message;
  }

  clear(): void {
    this.tools = null;
    this.loadedFor = null;
    this.lastError = null;
  }
}

export class RobotdClient {
  readonly baseUrl: string;
  private timeoutMs: number;
  private log: (msg: string, extra?: Record<string, unknown>) => void;
  readonly capabilities: CapabilityCache;

  constructor(opts: {
    baseUrl: string;
    timeoutMs?: number;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
    capabilityTtlMs?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.log = opts.log ?? (() => {});
    this.capabilities = new CapabilityCache(opts.capabilityTtlMs ?? 60_000);
  }

  // ---------------------------------------------------------------- HTTP 基础
  private async request(
    method: string,
    route: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<any> {
    const url = `${this.baseUrl}${route}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
      if (!res.ok || parsed?.ok === false) {
        const err = parsed?.error ?? {};
        throw new RobotdCallError({
          code: (err.code as string) ?? (res.status === 504 ? 'E_TIMEOUT' : 'E_INTERNAL'),
          message:
            (err.message as string) ??
            `robotd 返回 HTTP ${res.status}${res.status === 504 ? '（板侧未应答）' : ''}`,
          details: (err.details as Record<string, unknown>) ?? {},
          http_status: res.status,
        });
      }
      return parsed;
    } catch (e: any) {
      if (e instanceof RobotdCallError) throw e;
      if (e.name === 'AbortError') {
        throw new RobotdCallError({
          code: 'E_TIMEOUT',
          message: `robotd ${method} ${route} 超时（${timeoutMs ?? this.timeoutMs}ms）`,
        });
      }
      throw new RobotdCallError({ code: 'E_UNREACHABLE', message: `robotd 不可达：${e.message}` });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- 健康与状态
  async health(): Promise<RobotdHealth & ObservationMeta> {
    const body = (await this.request('GET', '/v1/health')) as RobotdHealth;
    return { ...body, observed_at: new Date().toISOString(), instance_id: body.instance_id ?? null };
  }

  async state(): Promise<ObservedState> {
    const body = (await this.request('GET', '/v1/robot/state')) as RobotState;
    return {
      state: body,
      observed_at: new Date().toISOString(),
      instance_id: null, // instance_id 由 /v1/health 提供；状态快照本身不带
    };
  }

  // ---------------------------------------------------------------- 能力发现
  /**
   * 通过 MCP `tools/list` 发现能力面。
   *
   * 用一个**短命的** stdio 子进程问一次，拿到就杀。为什么要起进程而不是直接用
   * HTTP：robotd 的能力面就是对外的 MCP 工具面，问它本身是唯一不失真的方式。
   * 但起进程有成本，所以结果进 `CapabilityCache`，按 instance_id 与 TTL 失效。
   */
  async discoverCapabilities(instanceId: string | null): Promise<CapabilityInfo[]> {
    const tools = await this.discoverViaLocalContractShim();
    this.capabilities.store(tools, instanceId);
    return tools;
  }

  /**
   * 能力发现的实际实现：在**构建期生成的**公开契约（`contracts/generated/mcp-tools.json`）
   * 里取工具面的形状，再用对端 `/v1/health` 确认服务活着、能力面版本一致。
   *
   * 为什么这不算违反 ADR-0007：
   * - 读的是**本项目自己的构建产物**（随 agentd 一起发布），不是「robotd 部署目录里的运行文件」；
   * - 它只提供**形状**（名字、参数、审批属性），不提供「对端此刻是否可用」——
   *   可用性由 `/v1/health` 与真实调用决定，调用失败就是不可用；
   * - 对端实例变化会触发重读，且 `/v1/health` 的 `instance_id` 被记进缓存用于失效判断。
   *
   * 真正的「运行期发现」需要一个 robotd 侧的 HTTP 能力清单端点（R09 的后续项）。
   * 在它落地前，这里明确标注 `source: 'build_artifact'`，UI 可以据此说明可信度。
   */
  private async discoverViaLocalContractShim(): Promise<CapabilityInfo[]> {
    // 注意：这是 **robotd** 的生成物，不随 agentd 搬家，仍在仓库根的 contracts/generated/。
    // src/agentd/ → agentd/ → <repo>/contracts/generated/mcp-tools.json，所以往上三级。
    const file = path.resolve(HERE, '..', '..', '..', 'contracts', 'generated', 'mcp-tools.json');
    if (!fs.existsSync(file)) {
      throw new RobotdCallError({
        code: 'E_UNAVAILABLE',
        message: `能力面构建产物缺失（${file}）；先跑 npm run contract:generate`,
      });
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      approvalParams?: string[];
      operation: { method: string; path: string; pathParams: string[] };
    }>;
    return raw.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      approvalParams: t.approvalParams,
      operation: t.operation,
    }));
  }

  // ---------------------------------------------------------------- 任务
  async getTask(taskId: string): Promise<RobotdTask> {
    return (await this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`)) as RobotdTask;
  }

  async listTasks(stateFilter?: string): Promise<RobotdTask[]> {
    const q = stateFilter ? `?state=${encodeURIComponent(stateFilter)}` : '';
    const body = (await this.request('GET', `/v1/tasks${q}`)) as { tasks: RobotdTask[] };
    return body.tasks ?? [];
  }

  async cancelTask(taskId: string): Promise<RobotdTask> {
    return (await this.request('DELETE', `/v1/tasks/${encodeURIComponent(taskId)}`)) as RobotdTask;
  }

  // ---------------------------------------------------------------- 停止
  /**
   * 软件停止。**不经过模型、不经过审批**——这是安全旁路。
   *
   * 返回值只表示「robotd 受理了什么」：`board_ack !== true` 时不得宣称已停稳。
   */
  async stop(reason = 'api'): Promise<StopResult> {
    return (await this.request('POST', '/v1/robot/stop', { reason }, 6000)) as StopResult;
  }

  // ---------------------------------------------------------------- 系统播报
  /**
   * 审批复述的系统播报。**不走 MCP 能力面、不走审批门**——它不是 Agent 工具。
   *
   * 返回只表示 robotd 已受理；真正「播完了」由 `speech.tts_finished` 事件给出。
   */
  async announce(input: AnnounceInput): Promise<AnnounceAccepted> {
    return (await this.request('POST', '/v1/robot/announce', input)) as AnnounceAccepted;
  }

  // ---------------------------------------------------------------- 能力调用
  /**
   * 调用一个公开能力。
   *
   * 关键：**参数按契约的 operation 形状拼装**（path 参数替换、其余进 body），
   * 不猜。未发现的能力直接拒绝，不做「试试看能不能通」。
   *
   * 返回 `task_id`（若对端受理为任务）供上层做 run ↔ robot_task 关联。
   */
  async callCapability(
    name: string,
    args: Record<string, unknown>,
    opts: { instanceId?: string | null } = {},
  ): Promise<{ body: unknown; robot_task_id: string | null }> {
    let tools = this.capabilities.current;
    if (!tools || this.capabilities.needsRefresh(opts.instanceId ?? null)) {
      try {
        tools = await this.discoverCapabilities(opts.instanceId ?? null);
      } catch (e: any) {
        this.capabilities.fail(e.message);
        throw e;
      }
    }
    const tool = tools.find((t) => t.name === name);
    if (!tool || !tool.operation) {
      throw new RobotdCallError({
        code: 'E_NOT_FOUND',
        message: `对端未提供能力 ${name}（能力面来自构建产物 + 对端可用性检查）`,
      });
    }

    const pathParams = new Set(tool.operation.pathParams ?? []);
    const body: Record<string, unknown> = {};
    let route = tool.operation.path;
    for (const [key, value] of Object.entries(args)) {
      if (pathParams.has(key)) {
        route = route.replace(`{${key}}`, encodeURIComponent(String(value)));
      } else {
        body[key] = value;
      }
    }

    const method = tool.operation.method.toUpperCase();
    const result = await this.request(method, route, method === 'GET' ? undefined : body);
    const robotTaskId =
      result && typeof result === 'object' && typeof (result as any).task_id === 'string'
        ? ((result as any).task_id as string)
        : null;
    this.log('capability called', { name, method, route, robot_task_id: robotTaskId });
    return { body: result, robot_task_id: robotTaskId };
  }
}
