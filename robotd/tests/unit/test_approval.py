"""审批拒绝侧的路径与错误体约束：不绑 socket，可在任何环境跑。"""

from __future__ import annotations

import pytest

from robotd import approval
from robotd.core.errors import ErrorCode, RobotdError


def test_secret_path_uses_app_data_convention(monkeypatch, tmp_path):
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(tmp_path))
    assert approval.approval_secret_path() == (
        tmp_path.resolve() / "robot" / "agentd" / "approval-signing-key"
    )


def test_secret_and_nonce_store_are_deliberately_separate(monkeypatch, tmp_path):
    """秘密跟着运行产物被清掉，或账本堆进应用私有目录，都是错误方向。"""
    appdata = tmp_path / "appdata"
    work = tmp_path / "work"
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(appdata))

    secret = approval.approval_secret_path()
    nonce_store = approval.nonce_store_path(work)

    assert nonce_store == work / "approval-nonces.json"
    assert work.resolve() not in secret.parents
    assert appdata.resolve() / "robot" / "agentd" in secret.parents


def test_missing_credential_error_is_readable_and_stable():
    with pytest.raises(RobotdError) as excinfo:
        approval.require_credential_header(None, "robot_speak")

    err = excinfo.value
    assert err.code is ErrorCode.APPROVAL
    assert err.http_status == 403
    assert "agentd 签发的一次性授权" in err.message
    assert err.details["reason"] == "missing_credential"
