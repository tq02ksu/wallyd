/**
 * 总览聚合：一次请求给 UI 它需要的全部东西。
 *
 * ## 为什么单独一个模块
 *
 * 总览最容易写成「把所有东西拼一起」，然后就变成第二个真相源。
 * 这里的纪律是：**本模块不持有状态**。每次调用都现取现算，
 * 每个外部观测都带 `observed_at` 与 `freshness`，取不到就如实说取不到。
 *
 * ## 四种「不正常的正常」
 *
 * 身体观测必须能区分：`ok`（新鲜）/ `stale`（有数据但过期）/
 * `offline`（连不上）/ `not_connected`（从未连过）/ `unknown`（连上了但没数据）。
 * 把这四者混成一句「离线」，用户就无法判断「是不是该去看一眼机器人」。
 *
 * ## issues 排序
 *
 * 第一条是「最该先处理的一件事」。安全类问题（磁盘不可写、身体状态未知）
 * 排在配置类问题前面——因为前者会让后续判断全部失效。
 */
import { Store, nowIso } from './store.ts';
import type { EventLog } from './events.ts';
import type { RobotdClient, ObservedState } from './robotd-client.ts';
import { RobotdCallError } from './robotd-client.ts';
import type { RunService } from './runs.ts';
import type { ModelService } from './models.ts';
import type { components } from '../../contracts/generated/agentd-types.ts';

/** 身体状态多久算过期。超过它就不该再显示成「当前状态」。 */
export const OBSERVATION_TTL_MS = 5000;

/**
 * Harness 状态。**形状由契约决定，不在这里手写**。
 *
 * 下面这行不是装饰：它让 `tsc` 成为第二道契约门禁——契约里给 `HarnessStatus`
 * 加了必填字段而这里没跟上，编译就红。手写一份镜像类型而不绑定，等于把
 * 「实现 == 契约」这件事交给运气：两边各改各的，运行时才炸。
 *
 * `Required` 是因为本实现**总是**显式给出每个字段（含 null），
 * 而契约里除 `state` 外都是可选的——手写版比契约更严，这是刻意的：
 * 界面上「没给」和「给了 null」必须能区分，缺字段会让 UI 显示成空白而不是「未知」。
 */
export type HarnessInfo = Required<components['schemas']['HarnessStatus']>;

/**
 * 待处理问题。同样从契约派生：`issue` 会原样进响应体，手抄就会漂。
 *
 * `severity` 用 `NonNullable<>` 收窄——契约里它是 required，但 openapi-typescript
 * 会把「required 但没有 default」也标成可选，这里补回来，排序表才拿得到字面量类型。
 */
export type Issue = Omit<components['schemas']['Issue'], 'severity'> & {
  severity: NonNullable<components['schemas']['Issue']['severity']>;
};

export interface OverviewOptions {
  store: Store;
  events: EventLog;
  robotd: RobotdClient;
  runs: RunService;
  models: ModelService;
  bootId: string;
  startedAt: string;
  harness: () => HarnessInfo;
  allowManualApprove: boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** robotd 事件订阅状态（R14）。可选：老测试夹具可以不传。 */
  subscription?: () => Record<string, unknown>;
}

const SEVERITY_RANK: Record<Issue['severity'], number> = { error: 0, warning: 1, info: 2 };

export class Overview {
  private opts: OverviewOptions;
  /** 上一次成功观测（用于「过期但仍可展示」与断线间隔记录）。 */
  private lastGood: ObservedState | null = null;
  private lastGoodAt: number | null = null;
  private lastFailure: { at: string; reason: string } | null = null;

  constructor(opts: OverviewOptions) {
    this.opts = opts;
  }

  get lastGoodObservation(): ObservedState | null {
    return this.lastGood;
  }

  /** 拉一次身体观测。成功就记住；失败不清掉上次的成功值，但会标陈旧。 */
  async observeBody(): Promise<Record<string, unknown>> {
    const endpoint = this.opts.robotd.baseUrl;
    try {
      const observed = await this.opts.robotd.state();
      const health = await this.opts.robotd.health();
      this.lastGood = { ...observed, instance_id: health.instance_id };
      this.lastGoodAt = Date.now();
      if (this.lastFailure) {
        // 恢复：写一条 recovered 事件，让历史里能看到「断过、又好了」
        const gapFrom = this.lastFailure.at;
        this.lastFailure = null;
        this.safeEmit({
          type: 'dependency.recovered',
          params: {
            dependency: 'robotd',
            detail: `与 robotd 的连接已恢复（实例 ${health.instance_id}）`,
            gap_from: gapFrom,
          },
        });
      }
      const ageMs = 0;
      return {
        state: 'ok',
        source: 'robotd',
        endpoint,
        observed_at: observed.observed_at,
        freshness: { age_ms: ageMs, threshold_ms: OBSERVATION_TTL_MS, expired: false },
        instance_id: health.instance_id,
        robot: {
          mode: observed.state.mode,
          devices: observed.state.devices,
          battery: observed.state.battery,
          pose: observed.state.pose,
          task_id: observed.state.task_id,
        },
      };
    } catch (e: any) {
      const err = e instanceof RobotdCallError ? e : null;
      const reason = err?.message ?? String(e?.message ?? e);
      const nowIsoStr = nowIso();

      // 记录断线起点（只记第一次）
      if (!this.lastFailure) {
        this.lastFailure = { at: nowIsoStr, reason };
        this.safeEmit({
          type: 'dependency.unavailable',
          params: {
            dependency: 'robotd',
            reason,
            impact: '无法读取机器人状态；依赖状态判断的动作会保持不可用。',
            advice: '检查 robotd 是否在运行（本机回环端口）。停止机器人不依赖 agentd。',
          },
        });
      }

      if (this.lastGood) {
        const ageMs = Date.now() - (this.lastGoodAt ?? Date.now());
        const expired = ageMs > OBSERVATION_TTL_MS;
        return {
          state: expired ? 'stale' : 'ok',
          source: 'robotd',
          endpoint,
          observed_at: this.lastGood.observed_at,
          freshness: { age_ms: ageMs, threshold_ms: OBSERVATION_TTL_MS, expired },
          instance_id: this.lastGood.instance_id,
          robot: {
            mode: this.lastGood.state.mode,
            devices: this.lastGood.state.devices,
            battery: this.lastGood.state.battery,
            pose: this.lastGood.state.pose,
            task_id: this.lastGood.state.task_id,
          },
          note: `这是 ${Math.round(ageMs / 1000)} 秒前的数据；此后与 robotd 失去联系：${reason}`,
        };
      }

      return {
        state: this.lastGoodAt === null ? 'not_connected' : 'offline',
        source: 'robotd',
        endpoint,
        observed_at: null,
        freshness: { age_ms: null, threshold_ms: OBSERVATION_TTL_MS, expired: true },
        instance_id: null,
        robot: null,
        note: reason,
      };
    }
  }

  private safeEmit(input: { type: string; params: Record<string, unknown> }): void {
    try {
      if (!this.opts.events.isRegistered(input.type)) return;
      this.opts.events.emitStandalone(input as any);
    } catch (e: any) {
      this.opts.log('overview emit failed', { type: input.type, error: e.message });
    }
  }

  async build(): Promise<Record<string, unknown>> {
    const now = Date.now();
    const started = Date.parse(this.opts.startedAt);
    const stats = this.opts.store.stats();
    const body = await this.observeBody();
    const harnessInfo = this.opts.harness();
    const modelStatus = this.opts.models.modelStatus();
    const active = this.opts.runs.activeRun();
    const recent = this.opts.events.query({ limit: 5 }).events;

    const issues: Issue[] = [];

    // ---- 安全/可用性优先
    if (!stats.writable) {
      issues.push({
        severity: 'error',
        title: '历史库不可写',
        detail: stats.last_error ?? '无法写入数据目录',
        action: 'settings/storage',
      });
    }
    if (body.state === 'offline' || body.state === 'not_connected') {
      issues.push({
        severity: 'error',
        title: '读不到机器人状态',
        detail: String(body.note ?? ''),
        action: 'diagnostics/robotd',
      });
    } else if (body.state === 'stale') {
      issues.push({
        severity: 'warning',
        title: '机器人状态已过期',
        detail: String(body.note ?? ''),
        action: 'diagnostics/robotd',
      });
    }

    // ---- 配置类
    if (modelStatus.state === 'not_configured') {
      issues.push({
        severity: 'info',
        title: '还没配置高级模型',
        detail: '简单指令仍可用；需要理解复杂说法时再配置。',
        action: 'settings/models',
      });
    } else if (modelStatus.state === 'invalid') {
      issues.push({
        severity: 'warning',
        title: '高级模型配置未通过验证',
        detail: String(modelStatus.note ?? ''),
        action: 'settings/models',
      });
    }
    if (harnessInfo.state === 'unavailable' || harnessInfo.state === 'error') {
      issues.push({
        severity: 'warning',
        title: 'Harness 不可用',
        detail: harnessInfo.last_error ?? '复杂任务暂时无法执行',
        action: 'diagnostics/harness',
      });
    }
    if (this.opts.allowManualApprove) {
      issues.push({
        severity: 'warning',
        title: '当前处于测试模式：允许手工批准',
        detail: '生产运行时必须是关闭状态；手工批准只用于调试。',
        action: 'diagnostics',
      });
    }

    issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

    return {
      ok: true,
      generated_at: nowIso(now),
      self: {
        boot_id: this.opts.bootId,
        started_at: this.opts.startedAt,
        uptime_s: Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0,
      },
      body,
      brain: {
        daemon: stats.writable ? 'ok' : 'degraded',
        harness: harnessInfo,
        model: modelStatus,
        store: stats.writable ? 'ok' : 'read_only',
      },
      active_run: active ? this.opts.runs.getRunDetail(active.run_id).run : null,
      // robotd 事件订阅：断线/重连/从没连上都要能看见，不能只报「正常」。
      subscription: this.opts.subscription?.() ?? null,
      recent_events: recent,
      issues,
    };
  }
}
