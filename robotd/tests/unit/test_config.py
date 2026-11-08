"""配置校验：回环绑定、范围、优先级。"""

from __future__ import annotations

import json

import pytest

from robotd.config import Config, ConfigError, from_env, from_file


def test_defaults_are_loopback_and_valid():
    cfg = Config().validate()
    assert cfg.bind == "127.0.0.1"
    assert cfg.transport_kind == "serial"


@pytest.mark.parametrize("bind", ["0.0.0.0", "192.168.1.10", "10.0.0.1", "::"])
def test_non_loopback_bind_rejected(bind):
    with pytest.raises(ConfigError) as ei:
        Config(bind=bind).validate()
    assert ei.value.field == "bind"
    assert "回环" in ei.value.reason


@pytest.mark.parametrize("bind", ["127.0.0.1", "localhost", "::1"])
def test_loopback_accepted(bind):
    assert Config(bind=bind).validate().bind == bind


def test_heartbeat_below_contract_floor_rejected():
    # 契约 §7：运动意图持续期间 host 必须 ≥5Hz
    with pytest.raises(ConfigError):
        Config(heartbeat_hz=2.0).validate()


def test_event_log_window_must_be_meaningful():
    with pytest.raises(ConfigError):
        Config(event_log_max=4).validate()


def test_env_layer_overrides_and_validates():
    cfg = from_env(Config(), env={"ROBOTD_SIM": "1", "ROBOTD_HTTP_PORT": "8899"})
    assert cfg.sim is True
    assert cfg.http_port == 8899
    assert cfg.transport_kind == "sim"


def test_env_bad_value_gives_actionable_error():
    with pytest.raises(ConfigError) as ei:
        from_env(Config(), env={"ROBOTD_HTTP_PORT": "http"})
    assert ei.value.field == "http_port"


def test_barge_in_margin_is_tunable_and_validated():
    """GH-5：打断门限的余量只有一份，可由环境变量调整，越界直接拒绝。"""
    assert Config().barge_in_erle_margin_db == 15.0
    cfg = from_env(Config(), env={"ROBOTD_BARGE_IN_ERLE_MARGIN_DB": "12.5"})
    assert cfg.barge_in_erle_margin_db == 12.5
    with pytest.raises(ConfigError) as ei:
        Config(barge_in_erle_margin_db=-1.0).validate()
    assert ei.value.field == "barge_in_erle_margin_db"


def test_barge_in_floor_is_tunable_and_validated():
    """GH-6 D2：ERLE 底线也是配置项，默认 20，越界拒绝。"""
    assert Config().barge_in_erle_floor_db == 20.0
    cfg = from_env(Config(), env={"ROBOTD_BARGE_IN_ERLE_FLOOR_DB": "18"})
    assert cfg.barge_in_erle_floor_db == 18.0
    with pytest.raises(ConfigError) as ei:
        Config(barge_in_erle_floor_db=200.0).validate()
    assert ei.value.field == "barge_in_erle_floor_db"


def test_config_file_layer_sets_barge_in_thresholds(tmp_path):
    """判据 2：配置文件可覆盖打断门限（默认值不变）。"""
    path = tmp_path / "robotd.json"
    path.write_text(
        json.dumps({"barge_in_erle_margin_db": 30, "barge_in_erle_floor_db": 22}),
        encoding="utf-8",
    )

    cfg = from_file(str(path))

    # JSON 的 30 是 int，配置字段是 float：值必须真的生效，而不是被静默忽略。
    assert cfg.barge_in_erle_margin_db == 30.0
    assert cfg.barge_in_erle_floor_db == 22.0


def test_env_layer_outranks_the_config_file(tmp_path):
    path = tmp_path / "robotd.json"
    path.write_text(json.dumps({"barge_in_erle_margin_db": 30}), encoding="utf-8")

    cfg = from_env(from_file(str(path)), env={"ROBOTD_BARGE_IN_ERLE_MARGIN_DB": "12"})

    assert cfg.barge_in_erle_margin_db == 12.0


def test_config_file_rejects_unknown_keys(tmp_path):
    """拼错键必须报错：静默沿用默认值会让「配置里写了 30」变成假话。"""
    path = tmp_path / "robotd.json"
    path.write_text(json.dumps({"barge_in_erle_margn_db": 30}), encoding="utf-8")

    with pytest.raises(ConfigError) as ei:
        from_file(str(path))

    assert ei.value.field == "barge_in_erle_margn_db"
    assert "未知键" in ei.value.reason


def test_config_file_rejects_wrong_types(tmp_path):
    path = tmp_path / "robotd.json"
    path.write_text(json.dumps({"barge_in_erle_margin_db": "30"}), encoding="utf-8")

    with pytest.raises(ConfigError) as ei:
        from_file(str(path))

    assert ei.value.field == "barge_in_erle_margin_db"
    assert "必须是数字" in ei.value.reason


def test_missing_config_file_is_actionable(tmp_path):
    with pytest.raises(ConfigError) as ei:
        from_file(str(tmp_path / "missing.json"))

    assert "不存在" in ei.value.reason


def test_check_config_cli_reports_the_config_file_thresholds(tmp_path, capsys):
    """端到端：``--config`` 真的接到 Config，而不是只存在于解析函数里。"""
    from robotd.__main__ import main

    path = tmp_path / "robotd.json"
    path.write_text(
        json.dumps({"barge_in_erle_margin_db": 30, "barge_in_erle_floor_db": 22}),
        encoding="utf-8",
    )

    assert main(["check-config", "--sim", "--config", str(path)]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["config"]["barge_in_erle_margin_db"] == 30.0
    assert payload["config"]["barge_in_erle_floor_db"] == 22.0


def test_config_defaults_match_the_audio_runtime_defaults():
    """``App`` 用两个默认值判断「是否被覆盖」；两处常量漂移会让回显说谎。"""
    from robotd.core.audio_runtime import (
        DEFAULT_BARGE_IN_ERLE_FLOOR_DB,
        DEFAULT_BARGE_IN_ERLE_MARGIN_DB,
    )

    cfg = Config()

    assert cfg.barge_in_erle_margin_db == DEFAULT_BARGE_IN_ERLE_MARGIN_DB
    assert cfg.barge_in_erle_floor_db == DEFAULT_BARGE_IN_ERLE_FLOOR_DB


def test_frozen_config_cannot_be_mutated():
    cfg = Config()
    with pytest.raises(Exception):
        cfg.http_port = 1234  # type: ignore[misc]


def test_sim_mode_does_not_require_serial_port():
    assert Config(sim=True, serial_port="").validate().sim is True


def test_real_mode_requires_serial_port():
    with pytest.raises(ConfigError):
        Config(sim=False, serial_port="").validate()
