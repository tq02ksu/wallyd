"""GH-9 / V06：常听会话状态机、自动续听、防抖与 speaking 闸。

所有时间都来自注入的虚拟时钟与假调度器：30 分钟静音判据必须离线可复现，
不能真 sleep（CI 单 lane 有 15 分钟上限）。

维护者 2026-11-08 的边界：``speaking`` 闸只拦「非打断」的自动轮。
播报中 ``speech.gate`` 判 ``pass`` 的那一轮必须照常认领，否则 V03 的 barge-in 回归。
"""

from __future__ import annotations

import pytest

from robotd.api.http import RouteContext, _h_listen, _h_tasks_list
from robotd.app import App
from robotd.config import Config
from robotd.core.audio_runtime import AudioRuntime
from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.types import DeviceStatus


class FakeBridge:
    def __init__(self, ready: bool = True) -> None:
        self.status = DeviceStatus.READY if ready else DeviceStatus.LOST
        self._ready = ready
        self.sent: list[dict] = []

    def ready(self) -> bool:
        return self._ready

    def send(self, cmd: dict, best_effort: bool = False) -> None:  # noqa: FBT001, FBT002
        self.sent.append(cmd)


class FakeClock:
    def __init__(self, start: int = 1_700_000_000_000) -> None:
        self.t = start

    def now_ms(self) -> int:
        return self.t


class Rig:
    """AudioRuntime + 虚拟时钟 + 一次性调度器。"""

    def __init__(self, **kwargs) -> None:
        self.clock = FakeClock()
        self.emitted: list[tuple[str, dict]] = []
        self.jobs: list[list] = []
        self.rt = AudioRuntime(
            emit=lambda t, p: self.emitted.append((t, p)),
            now=self.clock.now_ms,
            schedule=self._schedule,
            **kwargs,
        )
        self.bridge = FakeBridge()
        self.rt.attach(self.bridge)

    def _schedule(self, delay_ms: int, fn) -> None:
        self.jobs.append([self.clock.now_ms() + max(0, int(delay_ms)), fn])

    def advance(self, ms: int) -> None:
        target = self.clock.now_ms() + ms
        while True:
            due = [job for job in self.jobs if job[0] <= target]
            if not due:
                break
            due.sort(key=lambda job: job[0])
            job = due[0]
            self.jobs.remove(job)
            self.clock.t = job[0]
            job[1]()
        self.clock.t = target

    def bridge_ready(self) -> None:
        self.rt.handle_bridge_event({"ev": "bridge_ready", "asr_format": "48000/1ch/float32"})

    def events(self, name: str) -> list[dict]:
        return [p for t, p in self.emitted if t == name]

    def count(self, name: str) -> int:
        return len(self.events(name))


AMBIENT_DB = -40.0
SPEECH_DB = -32.0


def calibrate(rt: AudioRuntime) -> None:
    rt.handle_bridge_event(
        {"ev": "vad_calibrated", "ambient_db": AMBIENT_DB, "speech_db": SPEECH_DB, "silence_db": -38.0}
    )


def probe_erle(rt: AudioRuntime, *, erle: float = 32.0) -> None:
    rt.handle_bridge_event({"ev": "aec_echo_probe", "aec_erle_db": erle, "render_db": -10.0})


def start_speaking(rt: AudioRuntime) -> None:
    rt.new_response(task_id="t-speak")
    rt.handle_bridge_event({"ev": "tts_started", "chunks": 1})


# ---------------------------------------------------------------- 启动与续听
def test_bridge_ready_starts_an_auto_round():
    rig = Rig()

    rig.bridge_ready()

    assert rig.rt.utt is not None
    assert rig.rt.utt.trigger == "auto"
    assert rig.rt.utt.task_id is None
    state = rig.rt.state()
    assert state["mode"] == "always_on"
    assert state["phase"] == "listening"
    listen = [c for c in rig.bridge.sent if c.get("cmd") == "listen"]
    assert len(listen) == 1
    assert listen[0]["utterance_id"] == rig.rt.utt.utterance_id
    assert listen[0]["idle_timeout_ms"] > 0
    assert rig.events("speech.ready")[-1]["trigger"] == "auto"


def test_silent_room_30_minutes_emits_only_idle_endpoints():
    """判据 1：静音房间跑 30 分钟虚拟时间，不产生任何 speech.final。"""
    rig = Rig()
    rig.bridge_ready()
    start = rig.clock.now_ms()

    for _ in range(90):
        rig.advance(20_000)  # 桥空闲超时
        uid = rig.rt.utt.utterance_id
        rig.rt.handle_bridge_event(
            {"ev": "final", "utterance_id": uid, "text": "", "stop_reason": "idle", "no_speech": True}
        )
        assert rig.rt.utt is None
        rig.advance(300)  # inter_utterance_ms

    assert rig.clock.now_ms() - start >= 30 * 60 * 1000
    assert rig.count("speech.final") == 0
    endpoints = rig.events("speech.endpoint")
    assert len(endpoints) == 90
    assert {p["reason"] for p in endpoints} == {"idle_timeout"}
    assert rig.rt.utt is not None and rig.rt.utt.trigger == "auto"


def test_busy_error_releases_unconfirmed_auto_round_and_retries():
    """runtime 主动 listen 与桥自动开轮相撞时不能留下幽灵轮次。"""
    rig = Rig()
    rig.bridge_ready()
    first = rig.rt.utt.utterance_id
    assert rig.rt.utt.confirmed is False

    rig.rt.handle_bridge_event({"ev": "error", "code": "E_BUSY", "message": "上一轮听还没结束"})

    assert rig.rt.utt is None
    rig.advance(300)
    assert rig.rt.utt is not None
    assert rig.rt.utt.utterance_id != first


def test_non_idle_no_speech_auto_round_still_reports_a_final():
    """判据 1 的反向边界：只有 idle/max_seconds 才翻译成 endpoint，别把识别失败也吞掉。"""
    rig = Rig()
    rig.rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-1", "auto": True})

    rig.rt.handle_bridge_event(
        {"ev": "final", "utterance_id": "utt-auto-1", "text": "", "stop_reason": "empty", "no_speech": True}
    )

    finals = rig.events("speech.final")
    assert len(finals) == 1
    assert finals[0]["no_speech"] is True
    assert not rig.events("speech.endpoint")


def test_bridge_lost_before_resume_does_not_create_a_ghost_round():
    """判据 5：桥不再 ready 时，排队中的续听不得开新轮。"""
    rig = Rig()
    rig.bridge_ready()
    uid = rig.rt.utt.utterance_id
    rig.rt.handle_bridge_event(
        {"ev": "final", "utterance_id": uid, "text": "", "stop_reason": "idle", "no_speech": True}
    )

    rig.bridge.status = DeviceStatus.LOST
    rig.bridge._ready = False
    rig.advance(300)

    assert rig.rt.utt is None
    assert rig.count("speech.ready") == 1
    assert rig.rt.state()["mode"] == "idle"


def test_stop_listening_halts_auto_resume_and_mode_drops():
    """判据 2 的反向验证：显式停止后不再续听，mode 掉回 idle。"""
    rig = Rig()
    rig.bridge_ready()
    uid = rig.rt.utt.utterance_id

    rig.rt.stop_listening()

    assert rig.rt.state()["mode"] == "idle"
    rig.rt.handle_bridge_event(
        {"ev": "final", "utterance_id": uid, "text": "", "stop_reason": "requested", "no_speech": True}
    )
    rig.advance(1000)
    assert rig.rt.utt is None
    assert rig.count("speech.ready") == 1


def test_speech_final_then_resume_keeps_always_on_and_passes_through_idle():
    """判据 2：final → 续听，mode 全程 always_on；播报后必须 speaking→idle→listening。"""
    rig = Rig()
    rig.bridge_ready()
    uid = rig.rt.utt.utterance_id
    rig.rt.handle_bridge_event(
        {"ev": "speech_state", "state": "speech", "utterance_id": uid, "rms_db": -22.0}
    )
    rig.rt.handle_bridge_event(
        {"ev": "final", "utterance_id": uid, "text": "你好", "stop_reason": "endpoint"}
    )

    assert rig.rt.state()["mode"] == "always_on"
    assert rig.rt.state()["phase"] == "thinking"
    assert rig.rt.utt is None

    start_speaking(rig.rt)
    assert rig.rt.state()["phase"] == "speaking"
    assert rig.rt.state()["mode"] == "always_on"

    rig.rt.handle_bridge_event({"ev": "tts_finished", "chunks": 1, "played": 1})
    # 播报结束先回 idle：inter_utterance_ms 的落点
    assert rig.rt.state()["phase"] == "idle"
    assert rig.rt.state()["mode"] == "always_on"

    rig.advance(300)
    assert rig.rt.state()["phase"] == "listening"
    assert rig.rt.utt is not None and rig.rt.utt.trigger == "auto"


def test_mode_drops_to_idle_when_muted_or_bridge_lost():
    rig = Rig()
    rig.bridge_ready()
    assert rig.rt.state()["mode"] == "always_on"

    rig.rt.set_muted(True)
    assert rig.rt.state()["mode"] == "idle"

    rig.rt.set_muted(False)
    assert rig.rt.state()["mode"] == "always_on"

    rig.rt.detach()
    assert rig.rt.state()["mode"] == "idle"


def test_muted_bridge_ready_does_not_create_a_ghost_round():
    rig = Rig()
    rig.rt.set_muted(True)

    rig.bridge_ready()
    rig.advance(1000)

    assert rig.rt.utt is None
    assert not [c for c in rig.bridge.sent if c.get("cmd") == "listen"]
    assert rig.count("speech.ready") == 0


# ---------------------------------------------------------------- 防抖
def _two_rounds(inter_utterance_ms: int) -> Rig:
    rig = Rig(inter_utterance_ms=inter_utterance_ms)
    rig.rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-1", "auto": True})
    rig.rt.handle_bridge_event(
        {"ev": "final", "utterance_id": "utt-auto-1", "text": "", "stop_reason": "silence", "no_speech": True}
    )
    return rig


def test_inter_utterance_debounce_rejects_a_round_inside_the_window():
    """判据 3：间隔 < 300 ms 的第二轮只认领一次。"""
    rig = _two_rounds(300)
    rig.advance(100)

    rig.rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-2", "auto": True})

    assert rig.rt.utt is None
    assert rig.count("speech.ready") == 1
    assert not [p for p in rig.events("speech.ready") if p["utterance_id"] == "utt-auto-2"]


def test_zero_inter_utterance_adopts_both_rounds():
    """判据 3 的反向验证：防抖设 0 时两轮都认领。"""
    rig = _two_rounds(0)

    rig.rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-2", "auto": True})

    assert rig.rt.utt is not None and rig.rt.utt.utterance_id == "utt-auto-2"
    assert rig.count("speech.ready") == 2


# ---------------------------------------------------------------- speaking 闸
def test_speaking_rejects_bare_auto_ready_and_records_ignored():
    """判据 4：播报中裸 ready 不认领，记 speech.ignored{speaking}。"""
    rig = Rig()
    start_speaking(rig.rt)

    rig.rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-9", "auto": True})

    assert rig.rt.utt is None
    assert rig.count("speech.ready") == 0
    assert rig.events("speech.ignored") == [{"utterance_id": "utt-auto-9", "reason": "speaking"}]


def test_speaking_suppressed_gate_does_not_adopt_and_records_ignored_once():
    rig = Rig()
    calibrate(rig.rt)
    probe_erle(rig.rt)
    start_speaking(rig.rt)

    # 播报中的自听回声：gate suppressed/echo
    rig.rt.handle_bridge_event(
        {"ev": "speech_state", "state": "speech", "utterance_id": "utt-auto-echo", "db": -30.0}
    )

    assert rig.events("speech.gate")[-1]["decision"] == "suppressed"
    assert rig.rt.utt is None
    # V02 的事实仍然在：桥确实开了这一轮
    assert rig.events("speech.started")[-1]["utterance_id"] == "utt-auto-echo"
    assert rig.events("speech.ignored") == [{"utterance_id": "utt-auto-echo", "reason": "speaking"}]

    # 同一轮的 utterance VAD 再报一次 speech_state：只判一次，不重复记 ignored。
    rig.rt.handle_bridge_event(
        {"ev": "speech_state", "state": "speech", "utterance_id": "utt-auto-echo", "db": -30.0}
    )
    assert len(rig.events("speech.gate")) == 1
    assert len(rig.events("speech.ignored")) == 1

    # 桥随后补一个 ready：同一轮只记一次 ignored，不重复
    rig.rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-echo", "auto": True})
    assert len(rig.events("speech.ignored")) == 1
    assert rig.rt.utt is None


def test_speaking_gate_lets_barge_in_pass_be_adopted():
    """判据 4b：播报中 gate=pass 的轮仍被认领，barge-in 不回归。"""
    rig = Rig()
    calibrate(rig.rt)
    probe_erle(rig.rt)
    start_speaking(rig.rt)

    rig.rt.handle_bridge_event(
        {"ev": "speech_state", "state": "speech", "utterance_id": "utt-auto-user", "db": -5.0}
    )

    assert rig.events("speech.gate")[-1]["decision"] == "pass"
    assert rig.rt.utt is not None and rig.rt.utt.utterance_id == "utt-auto-user"
    assert rig.events("speech.ready")[-1]["trigger"] == "auto"
    assert rig.events("speech.tts_cancelled")[-1]["reason"] == "barge_in"
    assert rig.rt.state()["phase"] == "listening"
    assert not rig.events("speech.ignored")


def test_new_response_stops_in_flight_listen_round_before_speaking():
    """常听持有的 listen 必须先停，否则桥的 probe VAD 不跑，barge-in 失效。"""
    rig = Rig()
    rig.bridge_ready()
    assert rig.rt.utt is not None

    start_speaking(rig.rt)

    assert rig.rt.utt is None
    assert rig.rt.state()["phase"] == "speaking"
    stop = [c for c in rig.bridge.sent if c.get("cmd") == "stop"]
    assert len(stop) == 1 and stop[0]["reason"] == "speaking"

    # 播报期间的 VAD 仍然能走到 gate，并真的打断
    calibrate(rig.rt)
    probe_erle(rig.rt)
    rig.rt.handle_bridge_event(
        {"ev": "speech_state", "state": "speech", "utterance_id": "utt-auto-barge", "db": -5.0}
    )
    assert rig.events("speech.gate")[-1]["decision"] == "pass"
    assert rig.rt.utt is not None and rig.rt.utt.utterance_id == "utt-auto-barge"
    assert rig.events("speech.tts_cancelled")[-1]["reason"] == "barge_in"


# ---------------------------------------------------------------- trigger
def test_api_utterance_carries_trigger_api_in_ready_and_started():
    rig = Rig()
    utt = rig.rt.new_utterance(task_id="t-1")

    assert utt.trigger == "api"
    assert rig.events("speech.ready")[-1]["trigger"] == "api"

    rig.rt.handle_bridge_event(
        {"ev": "speech_state", "state": "speech", "utterance_id": utt.utterance_id, "rms_db": -20.0}
    )
    assert rig.events("speech.started")[-1]["trigger"] == "api"


# ---------------------------------------------------------------- 任务表与 409
def _ctx(
    app: App, method: str, path: str, body: dict | None = None, query: dict | None = None
) -> RouteContext:
    return RouteContext(
        app=app,
        method=method,
        path=path,
        query=query or {},
        params={},
        body=body,
        handler=None,  # type: ignore[arg-type]
    )


def test_auto_rounds_never_register_a_task(tmp_path):
    """判据 6：自动轮次不入 task 表；显式 listen 仍然建任务。"""
    app = App(Config(sim=True, http_port=0, work_dir=str(tmp_path)))
    app.audio.attach(FakeBridge())
    app.audio.handle_bridge_event({"ev": "bridge_ready", "asr_format": "x"})
    assert app.audio.utt is not None

    uid = app.audio.utt.utterance_id
    app.audio.handle_bridge_event(
        {"ev": "final", "utterance_id": uid, "text": "", "stop_reason": "idle", "no_speech": True}
    )
    assert _h_tasks_list(_ctx(app, "GET", "/v1/tasks")) == {"tasks": []}

    accepted = _h_listen(_ctx(app, "POST", "/v1/speech/listen", body={}))
    assert len(_h_tasks_list(_ctx(app, "GET", "/v1/tasks"))["tasks"]) == 1
    assert accepted["task_id"]
    app.audio.detach()


def test_muted_listen_returns_state_conflict(tmp_path):
    """判据 5：静音后显式 listen 返回 409/E_STATE（既有行为不回退）。"""
    app = App(Config(sim=True, http_port=0, work_dir=str(tmp_path)))
    app.audio.attach(FakeBridge())
    app.audio.set_muted(True)

    with pytest.raises(RobotdError) as info:
        _h_listen(_ctx(app, "POST", "/v1/speech/listen", body={}))

    assert info.value.code is ErrorCode.STATE


# ---------------------------------------------------------------- 迟到事件
def test_late_final_from_old_utterance_does_not_overwrite_current_round():
    """判据 7：旧轮 final 不得写入当前轮，也不得覆盖 last_final。"""
    rig = Rig()
    rig.rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-1", "auto": True})
    rig.rt.handle_bridge_event(
        {"ev": "final", "utterance_id": "utt-auto-1", "text": "旧轮", "stop_reason": "endpoint"}
    )
    rig.advance(300)
    rig.rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-2", "auto": True})

    rig.rt.handle_bridge_event(
        {"ev": "final", "utterance_id": "utt-auto-1", "text": "迟到", "stop_reason": "endpoint"}
    )

    assert rig.rt.utt is not None and rig.rt.utt.utterance_id == "utt-auto-2"
    assert rig.rt.last_final == "旧轮"
    finals = rig.events("speech.final")
    assert [p["text"] for p in finals] == ["旧轮"]
