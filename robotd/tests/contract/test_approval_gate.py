"""GH-18 门禁：契约里声明了审批的端点，**行为上**必须真的要求审批。

这里不读注册表就下结论：每条断言都起一个真的 ``ThreadingHTTPServer``，
用真的 ``http.client`` 发请求。契约枚举读的是生成物 ``openapi.json``，
判定口径是「``x-requires-approval`` 字段存在即需审批」（布尔与对象两种形态都算），
不硬编码 ``true``，也不断言 ``params`` 的具体内容。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from robotd.api.http import build_routes, serve
from robotd.app import App
from robotd.approval_digest import approval_args_digest
from robotd.config import Config
from robotd.core.types import DeviceStatus
from robotd.devices.sim import SimBoard

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
APPROVAL_REASON_MISSING = "missing_credential"


# ---------------------------------------------------------------- 假语音桥
class FakeAudioBridge:
    """足够让 ``robot_speak`` 真正受理（200）的最小桥；不碰麦克风/扬声器。"""

    def __init__(self) -> None:
        self.status = DeviceStatus.READY
        self.sent: list[dict[str, Any]] = []

    def ready(self) -> bool:
        return True

    def send(self, cmd: dict[str, Any], best_effort: bool = False) -> None:  # noqa: FBT001, FBT002
        self.sent.append(cmd)


# ---------------------------------------------------------------- 凭据工具
def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def mint_credential(
    secret_hex: str,
    *,
    capability: str = "robot_speak",
    args: dict[str, Any] | None = None,
    params: tuple[str, ...] = ("text",),
    issuer: str = "agentd",
    issued_at: float | None = None,
    expires_at: float | None = None,
    nonce: str | None = None,
    args_digest: str | None = None,
) -> str:
    now = time.time()
    payload = {
        "issuer": issuer,
        "capability": capability,
        "args_digest": args_digest or approval_args_digest(args or {}, list(params)),
        "issued_at": _iso(now if issued_at is None else issued_at),
        "expires_at": _iso(now + 60 if expires_at is None else expires_at),
        "nonce": nonce or uuid.uuid4().hex,
    }
    segment = _b64url(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signature = hmac.new(bytes.fromhex(secret_hex), segment.encode("ascii"), hashlib.sha256).digest()
    return f"{segment}.{_b64url(signature)}"


def write_secret(data_root: Path, value: str | None = None) -> str:
    secret = value or uuid.uuid4().hex * 2
    path = data_root / "robot" / "agentd" / "approval-signing-key"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(secret + "\n", encoding="utf-8")
    return secret


def nonce_records(work_dir: Path, nonce: str, consumed_at: float | None = None) -> None:
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "approval-nonces.json").write_text(
        json.dumps({"version": 1, "consumed": {nonce: consumed_at or time.time()}}),
        encoding="utf-8",
    )


# ---------------------------------------------------------------- 真服务器
class RunningRobotd:
    def __init__(self, *, work_dir: Path, debug: bool, with_bridge: bool = True) -> None:
        self.config = Config(sim=True, http_port=0, debug=debug, work_dir=str(work_dir))
        self.app = App(self.config)
        self.app.attach_sim_board(SimBoard())
        self.bridge = FakeAudioBridge() if with_bridge else None
        if self.bridge is not None:
            self.app.audio.attach(self.bridge)
        self.app.start()
        self.server = serve(self.app, bind="127.0.0.1", port=0, debug=debug)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.app.shutdown()
        self.thread.join(timeout=3)

    def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        credential: str | None = None,
    ) -> tuple[int, Any]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"content-type": "application/json"} if payload is not None else {}
        if credential is not None:
            headers["X-Wally-Approval"] = credential
        try:
            conn.request(method, path, body=payload, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
        finally:
            conn.close()


@contextmanager
def running(
    tmp_path: Path,
    *,
    debug: bool = True,
    work_dir: Path | None = None,
    with_bridge: bool = True,
) -> Iterator[RunningRobotd]:
    server = RunningRobotd(
        work_dir=work_dir or (tmp_path / "work"),
        debug=debug,
        with_bridge=with_bridge,
    )
    try:
        yield server
    finally:
        server.close()


# ---------------------------------------------------------------- 契约枚举
def spec() -> dict[str, Any]:
    return json.loads((CONTRACTS / "generated" / "openapi.json").read_text(encoding="utf-8"))


def approval_operations() -> dict[str, dict[str, Any]]:
    """字段**存在**即需审批：``true`` 与 ``{params: [...]}`` 都算。"""
    found: dict[str, dict[str, Any]] = {}
    for item in spec()["paths"].values():
        for method in ("get", "post", "put", "delete", "patch"):
            op = item.get(method)
            if not isinstance(op, dict) or "debug" in op.get("tags", []):
                continue
            if "x-requires-approval" in op:
                found[op["operationId"]] = op
    return found


def routes_by_operation() -> dict[str, Any]:
    return {r.operation_id: r for r in build_routes(debug=False)}


def route_path(template: str) -> str:
    return re.sub(r"\{[^}]+\}", "missing", template)


# ---------------------------------------------------------------- 判据 1/4
def test_every_contract_approval_endpoint_returns_403_without_credential(tmp_path, monkeypatch):
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(tmp_path / "appdata"))
    declared = approval_operations()
    # 只做「这三个今天确实被识别出来」的健全性检查；枚举本身覆盖将来新增的端点。
    assert {"robot_speak", "robot_follow", "robot_calibration_set"} <= set(declared)

    routes = routes_by_operation()
    with running(tmp_path) as live:
        for operation_id in declared:
            route = routes[operation_id]
            status, body = live.call(route.method, route_path(route.template), {})
            assert status == 403, f"{operation_id} 无凭据必须 403，实际 {status}: {body}"
            assert body["error"]["code"] == "E_APPROVAL", body
            assert body["error"]["details"]["reason"] == APPROVAL_REASON_MISSING, body
            assert "agentd 签发的一次性授权" in body["error"]["message"], body


# ---------------------------------------------------------------- 判据 2/5
def test_endpoints_without_approval_are_not_blocked(tmp_path, monkeypatch):
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(tmp_path / "appdata"))
    declared = approval_operations()
    routes = routes_by_operation()
    with running(tmp_path, debug=False) as live:
        for operation_id, route in routes.items():
            if operation_id in declared or operation_id == "events_subscribe":
                continue
            payload = {} if route.method != "GET" else None
            status, body = live.call(route.method, route_path(route.template), payload)
            blocked = (
                status == 403 and isinstance(body, dict) and body.get("error", {}).get("code") == "E_APPROVAL"
            )
            assert not blocked, f"{operation_id} 未声明审批却被审批门拦住：{body}"

        status, body = live.call("POST", "/v1/robot/stop", {"reason": "stop"})
        assert status == 200 and body["stopped"] is True
        status, _ = live.call("GET", "/v1/health")
        assert status == 200


# ---------------------------------------------------------------- 判据 3
def test_forged_expired_mismatched_and_manually_consumed_credentials_are_403(tmp_path, monkeypatch):
    data_root = tmp_path / "appdata"
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(data_root))
    secret = write_secret(data_root)
    body = {"text": "没有审批不能说话"}
    with running(tmp_path) as live:
        other_secret = "b" * 64
        cases = {
            "bad_signature": mint_credential(other_secret, args=body),
            "expired": mint_credential(
                secret,
                args=body,
                issued_at=time.time() - 120,
                expires_at=time.time() - 60,
            ),
            "args_digest_mismatch": mint_credential(secret, args={"text": "另一句话"}),
            "capability_mismatch": mint_credential(secret, capability="robot_follow", args=body),
            "unknown_issuer": mint_credential(secret, issuer="someone-else", args=body),
            "window_too_long": mint_credential(secret, args=body, expires_at=time.time() + 3600),
            "not_yet_valid": mint_credential(
                secret,
                args=body,
                issued_at=time.time() + 120,
                expires_at=time.time() + 180,
            ),
            "malformed_nonce": mint_credential(secret, args=body, nonce="bad nonce!"),
        }
        for name, credential in cases.items():
            status, resp = live.call("POST", "/v1/robot/speak", body, credential=credential)
            assert status == 403, f"{name} 必须 403，实际 {status}: {resp}"
            assert resp["error"]["code"] == "E_APPROVAL", (name, resp)
            assert resp["error"]["details"]["reason"] == name, (name, resp)

        nonce = uuid.uuid4().hex
        consumed = mint_credential(secret, args=body, nonce=nonce)
        nonce_records(tmp_path / "work", nonce)
        status, resp = live.call("POST", "/v1/robot/speak", body, credential=consumed)
        assert status == 403 and resp["error"]["details"]["reason"] == "nonce_replayed", resp


# ---------------------------------------------------------------- 判据 8
def test_one_time_credential_is_consumed_by_the_system(tmp_path, monkeypatch):
    data_root = tmp_path / "appdata"
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(data_root))
    secret = write_secret(data_root)
    body = {"text": "只说一次"}
    credential = mint_credential(secret, args=body)
    with running(tmp_path) as live:
        first, _ = live.call("POST", "/v1/robot/speak", body, credential=credential)
        second, resp = live.call("POST", "/v1/robot/speak", body, credential=credential)
    assert first == 200, "第一次必须真的执行"
    assert second == 403 and resp["error"]["details"]["reason"] == "nonce_replayed", resp


# ---------------------------------------------------------------- 判据 9
def test_consumed_nonce_survives_robotd_restart(tmp_path, monkeypatch):
    data_root = tmp_path / "appdata"
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(data_root))
    secret = write_secret(data_root)
    body = {"text": "重启后不能再放一次"}
    credential = mint_credential(secret, args=body)

    with running(tmp_path) as live:
        first, _ = live.call("POST", "/v1/robot/speak", body, credential=credential)
    with running(tmp_path) as restarted:
        second, resp = restarted.call("POST", "/v1/robot/speak", body, credential=credential)
    assert first == 200
    assert second == 403 and resp["error"]["details"]["reason"] == "nonce_replayed", resp


# ---------------------------------------------------------------- 判据 10
def test_corrupt_nonce_store_denies_the_request(tmp_path, monkeypatch):
    """账本损坏时不能「跳过坏条目继续放行」——那正是重放窗口。"""
    data_root = tmp_path / "appdata"
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(data_root))
    secret = write_secret(data_root)
    body = {"text": "账本坏了也不能执行"}
    (tmp_path / "work").mkdir(parents=True, exist_ok=True)
    (tmp_path / "work" / "approval-nonces.json").write_text("{not json", encoding="utf-8")

    with running(tmp_path) as live:
        status, resp = live.call(
            "POST",
            "/v1/robot/speak",
            body,
            credential=mint_credential(secret, args=body),
        )
    assert status == 403 and resp["error"]["details"]["reason"] == "nonce_store_unavailable", resp


def test_nonce_store_write_failure_denies_the_request(tmp_path, monkeypatch):
    data_root = tmp_path / "appdata"
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(data_root))
    secret = write_secret(data_root)
    body = {"text": "记不上就不要执行"}
    credential = mint_credential(secret, args=body)

    # work_dir 是一个普通文件：mkdir(parents=True) 必然失败。
    broken_work = tmp_path / "work-is-a-file"
    broken_work.write_text("not a directory", encoding="utf-8")
    with running(tmp_path, work_dir=broken_work) as live:
        status, resp = live.call("POST", "/v1/robot/speak", body, credential=credential)
        stop_status, _ = live.call("POST", "/v1/robot/stop", {})
    assert status == 403, "消费记录写不进去时必须拒绝，不能「记不上先执行」"
    assert resp["error"]["details"]["reason"] == "nonce_store_unavailable", resp
    assert stop_status == 200, "审批失败不能连累安全旁路"


# ---------------------------------------------------------------- 判据 11
def test_missing_secret_denies_but_robotd_runs_and_recovers_without_restart(tmp_path, monkeypatch):
    data_root = tmp_path / "appdata"
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(data_root))
    body = {"text": "秘密还没生成"}
    pending = mint_credential("c" * 64, args=body)

    with running(tmp_path) as live:
        status, resp = live.call("POST", "/v1/robot/speak", body, credential=pending)
        assert status == 403 and resp["error"]["details"]["reason"] == "missing_signing_key", resp
        assert live.call("POST", "/v1/robot/stop", {})[0] == 200
        assert live.call("GET", "/v1/health")[0] == 200

        # agentd 后启动：写入秘密，**不重启 robotd**，同一个端点立刻可用。
        secret = write_secret(data_root)
        fresh = mint_credential(secret, args=body)
        ok, ok_body = live.call("POST", "/v1/robot/speak", body, credential=fresh)
    assert ok == 200, f"秘密补齐后无需重启就应放行，实际 {ok}: {ok_body}"


# ---------------------------------------------------------------- 判据 6
def test_debug_flag_does_not_weaken_approval(tmp_path, monkeypatch):
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(tmp_path / "appdata"))
    with running(tmp_path, debug=False) as live:
        status, resp = live.call("POST", "/v1/robot/speak", {"text": "debug 也不豁免"})
        assert status == 403 and resp["error"]["code"] == "E_APPROVAL", resp
        assert live.call("POST", "/v1/robot/stop", {})[0] == 200


def test_credential_header_is_declared_on_every_approval_operation():
    """契约层也不能只写「需要审批」而不说凭据怎么来。"""
    for operation_id, op in approval_operations().items():
        headers = [p for p in op.get("parameters", []) if p.get("$ref", "").endswith("/ApprovalCredential")]
        assert headers, f"{operation_id} 未在契约里声明 X-Wally-Approval 头"
    assert "X-Wally-Approval" in (CONTRACTS / "openapi.yaml").read_text(encoding="utf-8")
