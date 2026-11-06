/**
 * 审批复述的编排：持久化审批 → robotd 系统播报 → **播完**才开确认窗口。
 *
 * 为什么单独一层：robotd 只给事件，agentd 才拥有审批状态。把「等播报完成」
 * 写在这里，`executeFastRun` 就不会在请求受理时误以为已经问过用户。
 *
 * 纪律：
 * - 系统播报失败/被打断 → 不开确认窗口，run 以 failed/cancelled 收尾并发事件；
 * - `speech.tts_finished` 带 approval_id 才是成功信号，`robot_announce` 的 200 不是；
 * - 重复完成事件幂等，不重复写窗口事件。
 */
import type { RunService } from './runs.ts';
import type { RobotdClient } from './robotd-client.ts';

export interface AnnouncementOutcome {
  approval_id: string;
  kind?: string;
  ok: boolean;
  reason?: string;
  response_id?: string;
  task_id?: string;
}

export class ApprovalAnnouncer {
  private runs: RunService;
  private robotd: RobotdClient;
  private log: (msg: string, extra?: Record<string, unknown>) => void;
  private windowMs: number;
  private noteSpeak?: (taskId: string, text: string) => void;

  constructor(opts: {
    runs: RunService;
    robotd: RobotdClient;
    log: (msg: string, extra?: Record<string, unknown>) => void;
    windowMs?: number;
    /** 让事件桥把 response_id 关联到播报摘要（可选）。 */
    noteSpeak?: (taskId: string, text: string) => void;
  }) {
    this.runs = opts.runs;
    this.robotd = opts.robotd;
    this.log = opts.log;
    this.windowMs = opts.windowMs ?? 30_000;
    this.noteSpeak = opts.noteSpeak;
  }

  /** 发起系统播报。失败时已把审批/run 收尾，返回 `ok:false`，不再抛给调用方。 */
  async announce(approvalId: string): Promise<{ ok: boolean; task_id?: string; text?: string; error?: string }> {
    const approval = this.runs.getApproval(approvalId);
    if (!approval) return { ok: false, error: `审批不存在：${approvalId}` };
    try {
      const accepted = await this.robotd.announce({
        approval_id: approvalId,
        kind: 'approval_repeat',
        action_label: approval.action_label,
        args_summary: approval.args_summary,
      });
      this.runs.markApprovalAnnounced(approvalId, accepted.text);
      this.noteSpeak?.(accepted.task_id, accepted.text);
      return { ok: true, task_id: accepted.task_id, text: accepted.text };
    } catch (e: any) {
      const message = e?.message ? String(e.message) : String(e);
      this.log('审批系统播报失败', { approval_id: approvalId, error: message });
      this.runs.abortApproval(approvalId, `系统播报失败：${message}`, { byStop: false });
      return { ok: false, error: message };
    }
  }

  /** robotd 播报真实终态。只有 `ok:true` 才开启确认窗口。 */
  onFinished(outcome: AnnouncementOutcome): void {
    if (!outcome.approval_id) return;
    if (outcome.ok) {
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
      { byStop },
    );
  }
}
