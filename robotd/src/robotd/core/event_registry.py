"""robotd 事件登记表的唯一读取点。

登记表本体是 ``contracts/generated/robotd-events.json``（由
``contracts/events.json`` 经 ``npm run contract:generate`` 生成）。本模块只执行
契约，不重新定义契约——不要在这里维护第二份事件名清单。

判定的三档边界（GH-20 定案）：

1. ``events[].type``：**精确字符串相等**。它们是已实现、走 ``_reduce`` 的事件，
   没有一条是通配；``device.*`` 之类只表达订阅过滤，不表示允许任意 ``device.xxx``。
2. ``reserved_unimplemented``：按**带点前缀**放行（``vision.`` / ``camera.`` /
   ``people.`` / ``person.``）。它们是契约预留面，不是拼写错误的避风港。
3. ``excluded_from_public``：``board.log`` / ``board.tx`` / ``board.rx`` 三条
   **精确名**，只走 ``--debug`` 旁路。``board.`` 不是前缀白名单。

其余一律视为未登记：生产代码读不到表时明确报错，而不是退化成形状校验。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

__all__ = ["EventRegistry", "load_event_registry"]

_DEFAULT_REGISTRY_PATH = (
    Path(__file__).resolve().parents[4] / "contracts" / "generated" / "robotd-events.json"
)


@dataclass(frozen=True)
class EventRegistry:
    """登记表的可判定视图。``allows()`` 是内核唯一的放行判据。"""

    exact: frozenset[str]
    prefixes: tuple[str, ...]
    debug: frozenset[str]
    no_state: frozenset[str]
    required_fields: Mapping[str, frozenset[str]] = field(default_factory=dict, hash=False)

    def allows(self, event_type: str) -> bool:
        if event_type in self.exact or event_type in self.debug:
            return True
        return any(event_type.startswith(prefix) for prefix in self.prefixes)


def _split_types(raw: Any, *, where: str) -> list[str]:
    """登记表把多个名字写在同一条记录里（``board.tx / board.rx``），必须拆开。"""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"{where}: type 必须是非空字符串，实际 {raw!r}")
    return [part.strip() for part in raw.split("/") if part.strip()]


def _parse_registry(data: Mapping[str, Any]) -> EventRegistry:
    events = data.get("events")
    if not isinstance(events, list) or not events:
        raise ValueError("事件登记表缺 events[] 或为空")

    exact: set[str] = set()
    no_state: set[str] = set()
    required_fields: dict[str, frozenset[str]] = {}
    for event in events:
        if not isinstance(event, Mapping):
            raise ValueError(f"events[] 的元素必须是对象，实际 {event!r}")
        event_type = event.get("type")
        if not isinstance(event_type, str) or not event_type:
            raise ValueError(f"事件缺 type：{event!r}")
        if "*" in event_type:
            raise ValueError(f"events[] 只允许精确名，不允许通配：{event_type!r}")
        if event_type in exact:
            raise ValueError(f"事件重复登记：{event_type}")
        fields = event.get("required_fields") or []
        if not isinstance(fields, list):
            raise ValueError(f"{event_type}.required_fields 必须是数组")
        exact.add(event_type)
        if event.get("no_state") is True:
            no_state.add(event_type)
        required_fields[event_type] = frozenset(str(name) for name in fields)

    prefixes: list[str] = []
    for entry in data.get("reserved_unimplemented") or []:
        raw = entry.get("type") if isinstance(entry, Mapping) else None
        for token in _split_types(raw, where="reserved_unimplemented"):
            if not token.endswith(".*"):
                # 预留面必须是通配；把精确名混进来会让「前缀放行」失去边界。
                raise ValueError(f"reserved_unimplemented 只接受前缀通配：{token!r}")
            prefix = token[:-1]
            if prefix not in prefixes:
                prefixes.append(prefix)

    debug: set[str] = set()
    for entry in data.get("excluded_from_public") or []:
        raw = entry.get("type") if isinstance(entry, Mapping) else None
        for token in _split_types(raw, where="excluded_from_public"):
            if "*" in token:
                raise ValueError(f"excluded_from_public 只接受精确名，不允许通配：{token!r}")
            debug.add(token)

    return EventRegistry(
        exact=frozenset(exact),
        prefixes=tuple(prefixes),
        debug=frozenset(debug),
        no_state=frozenset(no_state),
        required_fields=required_fields,
    )


@lru_cache(maxsize=1)
def _load_cached(path: str) -> EventRegistry:
    target = Path(path)
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except OSError as exc:
        raise RuntimeError(f"读不到事件登记表 {target}；先跑 npm run contract:generate") from exc
    if not isinstance(data, Mapping):
        raise ValueError(f"事件登记表必须是对象：{target}")
    return _parse_registry(data)


def load_event_registry(path: str | os.PathLike[str] | None = None) -> EventRegistry:
    """读取并解析登记表（进程内缓存；测试可通过参数或环境变量换路径）。"""
    target = (
        Path(path)
        if path is not None
        else Path(os.environ.get("ROBOTD_EVENTS_REGISTRY", _DEFAULT_REGISTRY_PATH))
    )
    return _load_cached(str(target))
