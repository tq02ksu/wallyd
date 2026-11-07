"""审批凭据的**拒绝侧**：验签、参数绑定、一次性消费。

边界（对应 #18）：

- 用户「同意」只存在于语音层；robotd 无法验证一句话是不是用户说的，所以它只校验
  **agentd 为这组参数签出的短时一次性凭据**。
- 凭据的 ``args_digest`` 必须由 :mod:`robotd.approval_digest` 复算（规则单一真值在
  ``contracts/approval-digest.json``），本模块不另写规范化规则。
- 共享验签秘密由 agentd 首次启动时生成；robotd **每次都重读**，不缓存、不在启动时失败。
  秘密缺失 → 需审批请求 403，但 robotd 正常工作。
- 已消费 nonce 记在 robotd 自己的 ``resolve_work_dir(config)`` 下：先落盘、后执行，
  写失败即拒绝（宁可不执行，不能重复执行）。

凭据格式（单行 HTTP 头 ``X-Wally-Approval``）::

    <base64url(payload-json)>.<base64url(hmac-sha256(secret, payload-segment))>

签名覆盖**收到的 payload 段的原样 ASCII 字节**（不是重新序列化后的 JSON），
所以两端不需要再约定一份「凭据 JSON 的规范化规则」。``payload-json`` 字段见
``docs/design/GH-18.md``。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

from .approval_digest import approval_args_digest
from .core.errors import ErrorCode, RobotdError

log = logging.getLogger("robotd.approval")

CREDENTIAL_HEADER = "X-Wally-Approval"

#: 共享秘密文件名（agentd 写、robotd 读）。
SECRET_FILENAME = "approval-signing-key"
#: 已消费 nonce 记录（robotd 独占）。
NONCE_STORE_FILENAME = "approval-nonces.json"

#: 已消费记录的保留时长；过期记录在每次写入时顺手清掉，不做定时任务。
NONCE_TTL_SECONDS = 24 * 60 * 60
#: 凭据最长有效期：短时窗口是这道门的一部分，不是可调参数。
MAX_CREDENTIAL_LIFETIME_SECONDS = 300
#: 两进程时钟允许的偏差。
CLOCK_SKEW_SECONDS = 5

_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_NONCE_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,128}$")
_HEX_KEY_RE = re.compile(r"^[0-9a-f]{64}$")

#: 同一进程内 check-then-consume 必须原子；ThreadingHTTPServer 是多线程的。
_NONCE_LOCK = threading.Lock()

_CLAIM_KEYS = ("issuer", "capability", "args_digest", "issued_at", "expires_at", "nonce")


class _StoreUnavailable(Exception):
    """nonce 记录读写失败：调用方必须 fail closed。"""


# ---------------------------------------------------------------- 路径
def app_data_root() -> Path:
    """应用私有数据根，与 ``agentd/src/agentd/paths.ts`` 的同名约定一致。

    macOS 用 ``~/Library/Application Support``（系统不会主动清理），
    其他平台退回 ``$XDG_DATA_HOME`` / ``~/.local/share``。
    ``WALLY_APP_DATA_DIR`` 只用于测试隔离与同一台机器上的显式布局；两边读同一个值。
    """
    override = os.environ.get("WALLY_APP_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    xdg = os.environ.get("XDG_DATA_HOME")
    return Path(xdg) if xdg else Path.home() / ".local" / "share"


def approval_secret_path() -> Path:
    """共享验签秘密路径。**不在启动时缓存**：agentd 可能比 robotd 晚起。"""
    return app_data_root() / "robot" / "agentd" / SECRET_FILENAME


def nonce_store_path(work_dir: Path) -> Path:
    """已消费 nonce 记录路径：robotd 的工作目录，不是共享秘密目录。"""
    return Path(work_dir) / NONCE_STORE_FILENAME


# ---------------------------------------------------------------- 秘密
def read_signing_key() -> bytes | None:
    """每次请求重读共享秘密；缺失或不可用返回 ``None``（调用方 403）。"""
    try:
        path = approval_secret_path()
        text = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except (OSError, RuntimeError):
        log.warning("共享验签秘密不可读，需审批请求将全部拒绝")
        return None
    if not _HEX_KEY_RE.match(text):
        log.warning("共享验签秘密格式非法（期望 64 位小写 hex），需审批请求将全部拒绝")
        return None
    return bytes.fromhex(text)


# ---------------------------------------------------------------- 拒绝
def approval_error(capability: str, reason: str, message: str | None = None) -> RobotdError:
    """可读的 403：``detail`` 让排障区分「没凭据」与「凭据无效」。"""
    return RobotdError(
        ErrorCode.APPROVAL,
        message or f"{capability} 需要 agentd 签发的一次性授权",
        {"capability": capability, "reason": reason},
    )


def require_credential_header(header_value: str | None, capability: str) -> None:
    """只检查「有没有凭据」。放在读 body 之前，保证无凭据请求稳定 403。"""
    if not header_value or not header_value.strip():
        raise approval_error(capability, "missing_credential")


# ---------------------------------------------------------------- 凭据解析
def _b64url_decode(segment: str) -> bytes:
    if not _B64URL_RE.match(segment):
        raise ValueError("不是 base64url 段")
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _parse_claims(payload_segment: str, signature_segment: str, secret: bytes) -> dict[str, Any]:
    expected = hmac.new(secret, payload_segment.encode("ascii"), hashlib.sha256).digest()
    got = _b64url_decode(signature_segment)
    if not hmac.compare_digest(expected, got):
        raise ValueError("签名不匹配")
    raw = _b64url_decode(payload_segment)
    try:
        claims = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("payload 不是合法 UTF-8 JSON") from exc
    if not isinstance(claims, dict):
        raise ValueError("payload 必须是 JSON 对象")
    for key in _CLAIM_KEYS:
        if not isinstance(claims.get(key), str) or not claims[key]:
            raise ValueError(f"payload 缺字段 {key}")
    return claims


def _parse_instant(value: str) -> float:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"时间不是 RFC3339：{value!r}") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"时间必须带时区：{value!r}")
    return parsed.timestamp()


# ---------------------------------------------------------------- nonce 记录
def _load_nonces(path: Path) -> dict[str, float]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise _StoreUnavailable(f"读取消费记录失败：{exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise _StoreUnavailable("消费记录不是合法 JSON") from exc
    if not isinstance(data, dict) or not isinstance(data.get("consumed"), dict):
        raise _StoreUnavailable("消费记录结构不对")
    out: dict[str, float] = {}
    for nonce, ts in data["consumed"].items():
        if not isinstance(nonce, str) or isinstance(ts, bool) or not isinstance(ts, (int, float)):
            # 结构损坏时不能「跳过坏条目继续放行」：那条 nonce 可能正是被消费的。
            raise _StoreUnavailable("消费记录含非法条目")
        out[nonce] = float(ts)
    return out


def _write_nonces(path: Path, consumed: Mapping[str, float]) -> None:
    """原子写：临时文件 + fsync + ``os.replace``。任何失败都向上抛。"""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=".approval-nonces-", dir=str(path.parent))
    except OSError as exc:
        raise _StoreUnavailable(f"创建消费记录失败：{exc}") from exc
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "consumed": dict(consumed)}, fh, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except OSError as exc:
        raise _StoreUnavailable(f"写入消费记录失败：{exc}") from exc
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def consume_nonce(work_dir: Path, nonce: str, *, now: float, capability: str) -> None:
    """验签通过后调用：nonce 已用过 → 403；否则先落盘再放行。"""
    if not _NONCE_RE.match(nonce):
        raise approval_error(capability, "malformed_nonce")
    path = nonce_store_path(work_dir)
    with _NONCE_LOCK:
        try:
            consumed = _load_nonces(path)
        except _StoreUnavailable:
            log.warning("消费记录不可读，拒绝需审批请求")
            raise approval_error(capability, "nonce_store_unavailable") from None
        if nonce in consumed:
            raise approval_error(capability, "nonce_replayed")
        consumed[nonce] = now
        cutoff = now - NONCE_TTL_SECONDS
        consumed = {key: ts for key, ts in consumed.items() if ts >= cutoff}
        try:
            _write_nonces(path, consumed)
        except _StoreUnavailable:
            log.warning("消费记录写入失败，拒绝需审批请求（不能记不上就执行）")
            raise approval_error(capability, "nonce_store_unavailable") from None


# ---------------------------------------------------------------- 入口
def enforce_approval(
    *,
    header_value: str | None,
    capability: str,
    approval_params: Sequence[str],
    body: Mapping[str, Any],
    work_dir: Path,
    now: float | None = None,
) -> None:
    """校验一个需审批请求。通过则返回（nonce 已消费）；否则 raise E_APPROVAL。"""
    require_credential_header(header_value, capability)
    secret = read_signing_key()
    if secret is None:
        # 消息保持同一条可读口径；「秘密还没生成」由 details.reason 区分。
        raise approval_error(capability, "missing_signing_key")

    token = header_value.strip()
    if token.count(".") != 1:
        raise approval_error(capability, "malformed_credential")
    payload_segment, signature_segment = token.split(".", 1)
    try:
        claims = _parse_claims(payload_segment, signature_segment, secret)
    except (ValueError, binascii.Error, UnicodeEncodeError):
        raise approval_error(capability, "bad_signature") from None

    if claims["issuer"] != "agentd":
        raise approval_error(capability, "unknown_issuer")
    if claims["capability"] != capability:
        raise approval_error(capability, "capability_mismatch")

    current = time.time() if now is None else now
    try:
        issued_at = _parse_instant(claims["issued_at"])
        expires_at = _parse_instant(claims["expires_at"])
    except ValueError:
        raise approval_error(capability, "malformed_time") from None
    if expires_at <= issued_at:
        raise approval_error(capability, "malformed_time")
    if expires_at - issued_at > MAX_CREDENTIAL_LIFETIME_SECONDS:
        raise approval_error(capability, "window_too_long")
    if issued_at > current + CLOCK_SKEW_SECONDS:
        raise approval_error(capability, "not_yet_valid")
    if current > expires_at:
        raise approval_error(capability, "expired")

    claimed_digest = claims["args_digest"]
    try:
        recomputed = approval_args_digest(body, approval_params)
    except (TypeError, ValueError):
        raise approval_error(capability, "args_not_digestible") from None
    if not hmac.compare_digest(recomputed, claimed_digest):
        raise approval_error(capability, "args_digest_mismatch")

    consume_nonce(work_dir, claims["nonce"], now=current, capability=capability)
