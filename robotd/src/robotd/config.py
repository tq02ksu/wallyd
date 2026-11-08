"""配置与启动校验。

优先级（与 plan R04 一致，从低到高）：内置默认 → 配置文件 → 环境变量 → 命令行参数。
命令行解析在 ``robotd.app``；本模块只负责「纯数据 + 校验」，不读 argv，便于测试。

设计约束：
- **只绑回环**：``bind`` 必须是 ``127.0.0.1``/``localhost``/``::1``。绑定 ``0.0.0.0`` 直接拒绝，
  不是警告（契约 §7）。
- **不给未实现的隔离机制编配置项**：控制隔离方案未定（R02），这里不放「worker 数」「线程池大小」
  这类会暗示结论的字段。
- **不把本机绝对路径当项目结构**：设备路径、桥二进制路径都可有默认值，但必须能由配置覆盖。
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass, field, replace
from dataclasses import fields as dataclass_fields
from typing import Any, Mapping

DEFAULT_HTTP_PORT = 8787
DEFAULT_ROBOT_ID = "WALLY"
DEFAULT_SERIAL_PORT = "/dev/cu.usbserial-A5069RR4"
DEFAULT_SERIAL_BAUD = 115200

_LOOPBACK_NAMES = {"localhost", "ip6-localhost"}


class ConfigError(ValueError):
    """配置不合法。启动阶段抛出，带上字段名，便于直接打印给使用者。"""

    def __init__(self, field_name: str, reason: str) -> None:
        super().__init__(f"配置 {field_name} 不合法：{reason}")
        self.field = field_name
        self.reason = reason


def _is_loopback(host: str) -> bool:
    if host in _LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Config:
    """运行配置。frozen：装配完成后任何字段都不可被顺手中改。"""

    # --- 网络 ---
    bind: str = "127.0.0.1"
    http_port: int = DEFAULT_HTTP_PORT

    # --- 身份 ---
    robot_id: str = DEFAULT_ROBOT_ID

    # --- 模式 ---
    sim: bool = False
    debug: bool = False

    # --- 设备 ---
    serial_port: str = DEFAULT_SERIAL_PORT
    serial_baud: int = DEFAULT_SERIAL_BAUD

    # --- 外部依赖端点 ---
    modeld_url: str = "http://127.0.0.1:8790"
    model_id: str = "poc"
    model_max_tokens: int = 96
    model_timeout_ms: int = 10_000

    # --- 时序参数（全部来自已确认的契约/实测，不在这里发明新数值）---
    #: host 在运动意图持续期间向板侧发 velocity 的频率下限（契约 §7 要求 ≥5Hz）
    heartbeat_hz: float = 5.0
    #: 板侧普通命令应答超时目标（契约 §7）
    board_reply_timeout_ms: int = 500
    #: 板侧心跳看门狗阈值（firmware HEARTBEAT_TIMEOUT_MS），仅用于仿真与诊断，不用于 host 侧断言
    board_watchdog_ms: int = 300
    #: WS 保留日志条数（有限补发窗口）
    event_log_max: int = 1000
    #: 状态快照向外推送的最大频率（契约 §2.2 1Hz）
    state_push_hz: float = 1.0

    # --- 语音打断门限（GH-5 / V02）---
    #: 打断门限 `max(ambient_db + 本值, speech_db)` 里的余量（dB）：
    #: AEC 回声残余相对本底的最大值 + 安全余量。默认 30 取自 VPIO 实测最坏
    #: +26.9 dB（eval/r14-voice-bringup-2026-10-24.md §5.6）；V03 换 AEC3 后收窄。
    # V03：AEC3 离线 P10 证据支持的暂定值；真机 30 分钟 0 误触发未验证。
    # 推导与回退条件见 docs/design/GH-6.md §4。
    barge_in_erle_margin_db: float = 15.0
    #: ``aec_erle_db`` 能作为打断判据的可用性底线（dB）。低于它视为「AEC 没压住」，
    #: ``speech.gate`` 落 ``no_erle``。默认 20 来自 AEC3 离线 P10 +31.2 dB 减约 11 dB；
    #: 同样允许配置覆盖（真机复核后按 eval 数据调整，见 docs/design/GH-6.md §4）。
    barge_in_erle_floor_db: float = 20.0

    # --- 工作区 ---
    #: 运行产物目录（日志、抓帧）。默认相对项目根的 work/，可覆盖。
    work_dir: str = ""
    log_json: bool = False

    extras: Mapping[str, Any] = field(default_factory=dict)

    # ------------------------------------------------------------ 校验
    def validate(self) -> "Config":
        if not _is_loopback(self.bind):
            raise ConfigError(
                "bind",
                f"{self.bind!r} 不是回环地址。robotd 只允许绑定 127.0.0.1 / ::1，"
                "绑定 0.0.0.0 会把串口原语与停止接口暴露到局域网",
            )
        # 0 是「由系统分配空闲端口」的标准写法（测试与受限环境都会用），不是非法值。
        # 真正非法的是负数与超过 65535。
        if not 0 <= self.http_port <= 65535:
            raise ConfigError("http_port", f"{self.http_port} 不在 0-65535（0 表示由系统分配）")
        if not self.robot_id:
            raise ConfigError("robot_id", "不能为空")
        if self.serial_baud <= 0:
            raise ConfigError("serial_baud", f"{self.serial_baud} 必须为正")
        if not (4.0 <= self.heartbeat_hz <= 50.0):
            # 契约要求 ≥5Hz；上限 50Hz 与板侧 tick 对齐，超过没有意义只是浪费串口带宽
            raise ConfigError("heartbeat_hz", f"{self.heartbeat_hz} 超出 [4, 50]；契约要求 ≥5Hz")
        if self.board_reply_timeout_ms <= 0:
            raise ConfigError("board_reply_timeout_ms", "必须为正")
        if not (0 < self.board_watchdog_ms < self.board_reply_timeout_ms * 4):
            raise ConfigError("board_watchdog_ms", f"{self.board_watchdog_ms} 与应答超时目标不相称")
        if self.event_log_max < 16:
            raise ConfigError("event_log_max", f"{self.event_log_max} 太小，补发窗口会失去意义")
        if not (0.1 <= self.state_push_hz <= 10.0):
            raise ConfigError("state_push_hz", f"{self.state_push_hz} 超出 [0.1, 10]")
        if not (0.0 <= self.barge_in_erle_margin_db <= 120.0):
            raise ConfigError("barge_in_erle_margin_db", f"{self.barge_in_erle_margin_db} 超出 [0, 120] dB")
        if not (0.0 <= self.barge_in_erle_floor_db <= 120.0):
            raise ConfigError("barge_in_erle_floor_db", f"{self.barge_in_erle_floor_db} 超出 [0, 120] dB")
        if not self.modeld_url.startswith(("http://", "https://")):
            raise ConfigError("modeld_url", "必须是 http(s) URL")
        if not self.sim and not self.serial_port:
            raise ConfigError("serial_port", "真机模式必须给出串口设备路径")
        return self

    @property
    def transport_kind(self) -> str:
        """对应契约 RobotState.transport 的 enum。"""
        return "sim" if self.sim else "serial"

    def with_overrides(self, **kwargs: Any) -> "Config":
        """返回替换后的新实例（frozen 配置的标准做法），并顺手校验。"""
        return replace(self, **{k: v for k, v in kwargs.items() if v is not None}).validate()


# ---------------------------------------------------------------- 来源解析
_ENV_MAP = {
    "ROBOTD_SIM": ("sim", "bool"),
    "ROBOTD_DEBUG": ("debug", "bool"),
    "ROBOTD_BIND": ("bind", "str"),
    "ROBOTD_HTTP_PORT": ("http_port", "int"),
    "ROBOTD_ROBOT_ID": ("robot_id", "str"),
    "ROBOTD_SERIAL_PORT": ("serial_port", "str"),
    "ROBOTD_SERIAL_BAUD": ("serial_baud", "int"),
    "ROBOTD_MODELD": ("modeld_url", "str"),
    "ROBOTD_MODEL": ("model_id", "str"),
    "ROBOTD_WORK_DIR": ("work_dir", "str"),
    "ROBOTD_LOG_JSON": ("log_json", "bool"),
    "ROBOTD_BARGE_IN_ERLE_MARGIN_DB": ("barge_in_erle_margin_db", "float"),
    "ROBOTD_BARGE_IN_ERLE_FLOOR_DB": ("barge_in_erle_floor_db", "float"),
}

_TRUE = {"1", "true", "yes", "on"}


def _coerce(raw: str, kind: str, field_name: str) -> Any:
    try:
        if kind == "bool":
            return raw.strip().lower() in _TRUE
        if kind == "int":
            return int(raw)
        if kind == "float":
            return float(raw)
        return raw
    except (TypeError, ValueError) as exc:
        raise ConfigError(field_name, f"环境变量值 {raw!r} 无法解析为 {kind}") from exc


def from_env(base: Config | None = None, env: Mapping[str, str] | None = None) -> Config:
    """叠加环境变量层。未设置的键保持 base 的值。"""
    import os

    env = os.environ if env is None else env
    cfg = base or Config()
    changes: dict[str, Any] = {}
    for key, (field_name, kind) in _ENV_MAP.items():
        if key in env and env[key] != "":
            changes[field_name] = _coerce(env[key], kind, field_name)
    return cfg.with_overrides(**changes) if changes else cfg.validate()


#: 配置文件可覆盖的字段类型。``from __future__ import annotations`` 让 ``field.type``
#: 是字符串，这里显式列出支持的类型，其余（如 ``Mapping``）不在配置文件里开放。
_FILE_KINDS = frozenset({"bool", "int", "float", "str"})


def from_file(path: str, base: Config | None = None) -> Config:
    """叠加 JSON 配置文件层。优先级：内置默认 → 配置文件 → 环境变量 → 命令行。

    格式是扁平 JSON 对象，键即 ``Config`` 字段名，例如
    ``{"barge_in_erle_margin_db": 30}``。**未知键直接拒绝**：把键拼错却静默沿用
    默认值，会让「配置文件里写了 30」变成一句假话——真机排障时最贵的就是这种沉默。
    类型也不做宽松转换（``"30"`` 字符串拒绝），错误带字段名。
    """
    import json
    from pathlib import Path

    p = Path(path).expanduser()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError("config", f"配置文件不存在：{p}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError("config", f"配置文件无法解析：{p}（{exc}）") from exc
    if not isinstance(raw, dict):
        raise ConfigError("config", "配置文件顶层必须是 JSON 对象")

    specs = {f.name: f for f in dataclass_fields(Config)}
    changes: dict[str, Any] = {}
    for key, value in raw.items():
        spec = specs.get(key)
        if spec is None or key == "extras":
            allowed = sorted(name for name in specs if name != "extras")
            raise ConfigError(key, f"配置文件含未知键 {key!r}；可用键：{allowed}")
        if str(spec.type) not in _FILE_KINDS:
            raise ConfigError(key, f"配置文件不支持覆盖字段 {key!r}（类型 {spec.type}）")
        changes[key] = _coerce_file_value(key, value, str(spec.type))
    cfg = base or Config()
    return cfg.with_overrides(**changes) if changes else cfg.validate()


def _coerce_file_value(key: str, value: Any, kind: str) -> Any:
    """JSON 值 → 配置字段值。类型不符就报错，不默默 cast。"""
    if kind == "bool":
        if not isinstance(value, bool):
            raise ConfigError(key, f"配置文件里 {key!r} 必须是布尔值，实际 {type(value).__name__}")
        return value
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigError(key, f"配置文件里 {key!r} 必须是整数，实际 {type(value).__name__}")
        return value
    if kind == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConfigError(key, f"配置文件里 {key!r} 必须是数字，实际 {type(value).__name__}")
        return float(value)
    if not isinstance(value, str):
        raise ConfigError(key, f"配置文件里 {key!r} 必须是字符串，实际 {type(value).__name__}")
    return value


def resolve_bind_address(bind: str, port: int) -> tuple[int, tuple[Any, ...]]:
    """把 (bind, port) 解析成 ``socket`` 可用的 (family, address)。只接受回环。"""
    if not _is_loopback(bind):
        raise ConfigError("bind", f"{bind!r} 不是回环地址")
    infos = socket.getaddrinfo(bind, port, type=socket.SOCK_STREAM)
    if not infos:
        raise ConfigError("bind", f"无法解析 {bind}")
    family, _, _, _, sockaddr = infos[0]
    return family, sockaddr
