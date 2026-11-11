#!/usr/bin/env python3
"""GH-58：`smoke_voice.sh` 的纯断言层（B1–B7）。

这里只读 NDJSON 事件与 stderr，**不启动进程、不碰设备**；采集在
`eval/aec3/smoke_voice.sh` 里。这样同一套判据可以用固定 fixture 离线跑，
不需要 macOS、麦克风或扬声器。

判据（来自 #41）：

- B1：见过 `bridge_ready`
- B2：见过 `tts_started`
- B3：`tts_chunk_finished` 计数 > 0
- B4：见过 `tts_played`，且 `played > 0`（非 dry-run）
- B5：见过 `tts_finished`，`stop_reason == "done"`，未被取消
- B6：stderr 无 `Terminating app`
- B7：播报窗口内 `speech_state` / 采集电平（`aec_echo_probe`）持续更新

另有 C0（生产构建）：`bridge_ready` 不得回报 `test_harness: true`。测试 harness
构建不是正式播报证据，不能让它冒充生产命令面的 PASS。

退出码：0 = PASS；1 = FAIL；2 = 参数或输入错误（不是判定结果）。
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

# B7：播报窗口内至少要有 3 次电平/语音状态更新，且首尾跨度覆盖窗口的 50%。
# 生产桥在播报期间按 100ms 节奏发 `aec_echo_probe`，一段 3 秒播报约 30 次。
MIN_LEVEL_EVENTS = 3
MIN_LEVEL_COVERAGE = 0.5
LEVEL_EVENT_TYPES = ("aec_echo_probe", "speech_state")
CRASH_MARKER = "Terminating app"


class InputError(Exception):
    """输入文件不合法（fail closed，不猜）。"""


@dataclass(frozen=True)
class Check:
    key: str
    ok: bool
    detail: str


@dataclass
class Report:
    checks: list[Check]
    counts: dict[str, object]

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.checks)


def load_events(path: Path) -> list[dict]:
    """读 NDJSON；空行跳过，坏行直接判输入错误（不静默丢事件）。"""
    events: list[dict] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise InputError(f"读不到事件文件 {path}: {exc}") from exc
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise InputError(f"{path}:{lineno} 不是合法 JSON: {exc.msg}") from exc
        if not isinstance(obj, dict):
            raise InputError(f"{path}:{lineno} 不是 JSON 对象")
        events.append(obj)
    return events


def _t_ms(event: dict) -> int | None:
    value = event.get("t_ms")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _wire(events: list[dict], response_id: str | None) -> list[dict]:
    if response_id is None:
        return events
    return [event for event in events if event.get("response_id") == response_id]


def analyze(events: list[dict], stderr_text: str, response_id: str | None = None) -> Report:
    """对事件与 stderr 做 B1–B7 + C0 判定。纯函数，不读文件。"""
    bridge = [event for event in events if event.get("ev") == "bridge_ready"]
    tts_started = _wire([event for event in events if event.get("ev") == "tts_started"], response_id)
    chunk_finished = _wire(
        [event for event in events if event.get("ev") == "tts_chunk_finished"], response_id
    )
    tts_played = _wire([event for event in events if event.get("ev") == "tts_played"], response_id)
    tts_finished = _wire([event for event in events if event.get("ev") == "tts_finished"], response_id)
    tts_cancelled = _wire([event for event in events if event.get("ev") == "tts_cancelled"], response_id)
    harness = [event for event in bridge if event.get("test_harness") is True]

    played_values = [
        event["played"]
        for event in tts_played
        if isinstance(event.get("played"), int) and not isinstance(event.get("played"), bool)
    ]
    max_played = max(played_values, default=0)
    dry_run = any(event.get("dry_run") is True for event in tts_started)

    starts = [t for t in (_t_ms(event) for event in tts_started) if t is not None]
    ends = [t for t in (_t_ms(event) for event in tts_finished) if t is not None]
    window = (min(starts), max(ends)) if starts and ends else None

    level_total = {"aec_echo_probe": 0, "speech_state": 0}
    level_in_window: list[tuple[int, str]] = []
    level_missing_t_ms = 0
    for event in events:
        ev = event.get("ev")
        if ev not in LEVEL_EVENT_TYPES:
            continue
        level_total[ev] += 1
        when = _t_ms(event)
        if when is None:
            level_missing_t_ms += 1
            continue
        if window is not None and window[0] <= when <= window[1]:
            level_in_window.append((when, ev))

    window_ms = (window[1] - window[0]) if window is not None else 0
    level_span = 0
    if level_in_window:
        times = [when for when, _ in level_in_window]
        level_span = max(times) - min(times)

    b7_reasons: list[str] = []
    if window is None:
        b7_reasons.append("无法确定播报窗口（缺 tts_started 或 tts_finished 的 t_ms）")
    else:
        if len(level_in_window) < MIN_LEVEL_EVENTS:
            b7_reasons.append(
                f"播报窗口内采集电平/speech_state 只有 {len(level_in_window)} 次（需要 ≥ {MIN_LEVEL_EVENTS}）"
            )
        if window_ms > 0 and level_span < window_ms * MIN_LEVEL_COVERAGE:
            b7_reasons.append(
                f"电平更新只覆盖窗口 {level_span}/{window_ms}ms（需要 ≥ {int(MIN_LEVEL_COVERAGE * 100)}%）"
            )
    if level_missing_t_ms:
        b7_reasons.append(f"{level_missing_t_ms} 条电平事件缺 t_ms，无法证明发生在播报窗口内")

    finished = tts_finished[0] if tts_finished else None
    stop_reason = finished.get("stop_reason") if finished else None

    checks = [
        Check(
            "C0",
            not harness,
            (
                "bridge_ready 未回报 test_harness（默认生产构建）"
                if not harness
                else "检测到 test_harness=true：这是测试 harness 构建，不是正式播报证据"
            ),
        ),
        Check(
            "B1",
            bool(bridge),
            f"bridge_ready 次数 = {len(bridge)}"
            + (f"，engine_started = {bridge[0].get('engine_started')}" if bridge else ""),
        ),
        Check(
            "B2",
            bool(tts_started),
            f"tts_started 次数 = {len(tts_started)}"
            + (f"，chunks = {tts_started[0].get('chunks')}" if tts_started else ""),
        ),
        Check("B3", bool(chunk_finished), f"tts_chunk_finished 次数 = {len(chunk_finished)}"),
        Check(
            "B4",
            bool(tts_played) and max_played > 0 and not dry_run,
            (
                f"tts_played 事件 = {len(tts_played)}，played 最大值 = {max_played}"
                if tts_played
                else "缺 tts_played：只合成、没有播出的证据"
            )
            + ("；tts_started 是 dry_run，不能证明出声" if dry_run else ""),
        ),
        Check(
            "B5",
            bool(tts_finished) and stop_reason == "done" and not tts_cancelled,
            (
                f"tts_finished 次数 = {len(tts_finished)}，stop_reason = {stop_reason}"
                if tts_finished
                else "缺 tts_finished：播报没有正常收尾"
            )
            + (f"；另有 tts_cancelled {len(tts_cancelled)} 条" if tts_cancelled else ""),
        ),
        Check(
            "B6",
            CRASH_MARKER not in stderr_text,
            (
                f"stderr 无 {CRASH_MARKER!r}"
                if CRASH_MARKER not in stderr_text
                else f"stderr 含 {CRASH_MARKER!r}：桥进程崩溃"
            ),
        ),
        Check("B7", not b7_reasons, "；".join(b7_reasons) if b7_reasons else "播报窗口内电平持续更新"),
    ]

    counts: dict[str, object] = {
        "bridge_ready": len(bridge),
        "tts_started": len(tts_started),
        "tts_chunk_finished": len(chunk_finished),
        "tts_played": len(tts_played),
        "played_values": played_values,
        "tts_finished": len(tts_finished),
        "stop_reason": stop_reason,
        "tts_cancelled": len(tts_cancelled),
        "aec_echo_probe": level_total["aec_echo_probe"],
        "speech_state": level_total["speech_state"],
        "level_in_window": len(level_in_window),
        "window_ms": window_ms,
        "level_span_ms": level_span,
        "window": window,
    }
    return Report(checks=checks, counts=counts)


def render(report: Report) -> str:
    counts = report.counts
    window = counts["window"]
    played = ",".join(str(value) for value in counts["played_values"]) or "-"
    lines = [
        "== smoke_voice 事件计数 ==",
        f"bridge_ready            {counts['bridge_ready']}",
        f"tts_started             {counts['tts_started']}",
        f"tts_chunk_finished      {counts['tts_chunk_finished']}",
        f"tts_played              {counts['tts_played']} (played: {played}；最大值 "
        f"{max(counts['played_values'], default=0)})",
        f"tts_finished            {counts['tts_finished']} (stop_reason: {counts['stop_reason']})",
        f"tts_cancelled           {counts['tts_cancelled']}",
        f"aec_echo_probe          总量 {counts['aec_echo_probe']}，播报窗口内 "
        f"{counts['level_in_window']}（speech_state 总量 {counts['speech_state']}）",
        (
            f"播报窗口                t_ms {window[0]}..{window[1]}（{counts['window_ms']}ms），"
            f"电平跨度 {counts['level_span_ms']}ms"
            if window is not None
            else "播报窗口                无法确定"
        ),
        "== B1–B7 断言 ==",
    ]
    for check in report.checks:
        lines.append(f"{'PASS' if check.ok else 'FAIL'} {check.key} {check.detail}")
    lines.append("PASS" if report.ok else "FAIL")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="smoke_voice.sh 的 B1–B7 断言（只读 fixture 或已采集的事件文件）"
    )
    parser.add_argument("--events", required=True, help="桥的 NDJSON 事件文件")
    parser.add_argument("--stderr", dest="stderr_path", required=True, help="桥的 stderr 文件")
    parser.add_argument("--response-id", default=None, help="只统计该 response_id 的 TTS 事件")
    args = parser.parse_args(argv)

    try:
        events = load_events(Path(args.events))
        stderr_text = Path(args.stderr_path).read_text(encoding="utf-8", errors="replace")
    except (InputError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    report = analyze(events, stderr_text, response_id=args.response_id)
    print(render(report))
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
