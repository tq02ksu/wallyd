/**
 * 审批复述的编排：持久化审批 → robotd 系统播报 → **播完**才开确认窗口。
 *
 * 为什么单独一层：robotd 只给事件，agentd 才拥有审批状态。把「等播报完成」
 * 写在这里，`executeFastRun` 就不会在请求受理时误以为已经问过用户。
 *
 * 纪律：
 * - 系统播报失败/被打断 → 不开确认窗口，run 以 failed/cancelled 收尾并发事件；
 * - `speech.tts_finished` 带 approval_id 才是成功信号，`robot_announce` 的 200 不是；
 * - 重复完成事件幂等，不重复写窗口事件；
 * - **完成事件丢失不静默**：受理后等不到终态事件时按超时失败收尾，run 不会永远挂着。
 */
import type { RunService } from './runs.ts';
import type { RobotdClient } from './robotd-client.ts';

/** 只接受审批复述：别的 kind 即使带 approval_id 也不许开确认窗口。 */
const APPROVAL_REPEAT = 'approval_repeat';

export interface AnnouncementOutcome {
  approval_id: string;
  kind?: string;
  ok: boolean;
  reason?: string;
  response_id?: string;
  task_id?: string;
  /**
   * `speech.tts_finished.played`。**缺失 ≠ 0**：字段缺失按「没报」处理（兼容旧桥），
   * 明确为 0 则说明一句都没播出去，不能开确认窗口。
   */
  played?: number;
}

export class ApprovalAnnouncer {
  private runs: RunService;
  private robotd: RobotdClient;
  private log: (msg: string, extra?: Record<string, unknown>) => void;
  private windowMs: number;
  private announceTimeoutMs: number;
  private noteSpeak?: (taskId: string, text: string) => void;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: {
    runs: RunService;
    robotd: RobotdClient;
    log: (msg: string, extra?: Record<string, unknown>) => void;
    windowMs?: number;
    /** 受理后等 `speech.tts_finished`/`tts_cancelled` 的上限；超时按失败收尾。 */
    announceTimeoutMs?: number;
    /** 让事件桥把 response_id 关联到播报摘要（可选）。 */
    noteSpeak?: (taskId: string, text: string) => void;
  }) {
    this.runs = opts.runs;
    this.robotd = opts.robotd;
    this.log = opts.log;
    this.windowMs = opts.windowMs ?? 60_000;
    this.announceTimeoutMs = opts.announceTimeoutMs ?? 30_000;
    this.noteSpeak = opts.noteSpeak;
  }

  /** 发起系统播报。失败时已把审批/run 收尾，返回 `ok:false`，不再抛给调用方。 */
  async announce(approvalId: string): Promise<{ ok: boolean; task_id?: string; text?: string; error?: string }> {
    const approval = this.runs.getApproval(approvalId);
    if (!approval) return { ok: false, error: `审批不存在：${approvalId}` };
    if (!['persisted', 'announced'].includes(approval.status)) {
      // 已经开窗/已经结束的审批不再发第二次播报；重复调用不能制造第二个确认窗口。
      this.log('审批已不在可播报状态，跳过系统播报', {
        approval_id: approvalId,
        status: approval.status,
      });
      return { ok: false, error: `审批状态为 ${approval.status}，不能再播报` };
    }
    try {
      const accepted = await this.robotd.announce({
        approval_id: approvalId,
        kind: APPROVAL_REPEAT,
        action_label: approval.action_label,
        args_summary: approval.args_summary,
      });
      this.runs.markApprovalAnnounced(approvalId, accepted.text);
      this.noteSpeak?.(accepted.task_id, accepted.text);
      this.armTimeout(approvalId);
      return { ok: true, task_id: accepted.task_id, text: accepted.text };
    } catch (e: any) {
      const message = e?.message ? String(e.message) : String(e);
      this.log('审批系统播报失败', { approval_id: approvalId, error: message });
      this.clearTimeout(approvalId);
      this.runs.abortApproval(approvalId, `系统播报失败：${message}`, {
        byStop: false,
        kind: 'no_audio',
      });
      return { ok: false, error: message };
    }
  }

  /** robotd 播报真实终态。只有 `ok:true` 才开启确认窗口。 */
  onFinished(outcome: AnnouncementOutcome): void {
    if (!outcome.approval_id) return;
    // 关联字段必须完整且是审批复述：宁可忽略并留痕，也不能让别的事件代开确认窗口。
    // 缺 kind 的事件不算「确认为这次复述播完」，否则契约允许的可选字段会变成后门。
    if (outcome.kind !== APPROVAL_REPEAT) {
      this.log('忽略非审批复述的播报终态', {
        approval_id: outcome.approval_id,
        kind: outcome.kind,
      });
      return;
    }
    const approval = this.runs.getApproval(outcome.approval_id);
    if (!approval) {
      this.log('忽略未知审批的播报终态', { approval_id: outcome.approval_id });
      return;
    }
    this.clearTimeout(outcome.approval_id);
    if (outcome.ok) {
      if (outcome.played === 0) {
        // 桥报了 tts_finished，但一句都没播出去：用户没听见复述，不能问「确认吗」。
        this.runs.abortApproval(
          outcome.approval_id,
          '系统播报没有真正播放（played=0）',
          { byStop: false, kind: 'no_audio' },
        );
        return;
      }
      const opened = this.runs.openConfirmationWindow(outcome.approval_id, this.windowMs);
      if (!opened.opened) {
        this.log('播报完成但确认窗口未开启', {
          approval_id: outcome.approval_id,
          reason: opened.reason,
        });
      }
      return;
    }
    const reason = outcome.reason ?? 'interrupted';
    const byStop = reason === 'stop' || reason === 'requested';
    this.runs.abortApproval(
      outcome.approval_id,
      byStop ? '收到停止指令，复述被中止' : `系统播报未完成（${reason}）`,
      { byStop, kind: 'no_audio' },
    );
  }

  /** 受理后开始计时；丢失终态事件时必须显式失败，不能把 run 留在半路。 */
  private armTimeout(approvalId: string): void {
    this.clearTimeout(approvalId);
    const timer = setTimeout(() => {
      this.timers.delete(approvalId);
      const approval = this.runs.getApproval(approvalId);
      // 已开窗/已收尾的审批不受超时影响（迟到事件与重复调用都可能走到这里）。
      if (!approval || !['persisted', 'announced'].includes(approval.status)) return;
      this.log('系统播报终态事件超时', { approval_id: approvalId });
      this.runs.abortApproval(
        approvalId,
        '系统播报终态事件超时，未确认用户是否听到复述',
        { byStop: false, kind: 'announce_timeout' },
      );
    }, this.announceTimeoutMs);
    // 不让计时器拖住进程退出（测试与短生命周期 CLI 都需要）。
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(approvalId, timer);
  }

  private clearTimeout(approvalId: string): void {
    const timer = this.timers.get(approvalId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(approvalId);
  }
}
