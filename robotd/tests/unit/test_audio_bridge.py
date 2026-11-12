"""AudioBridge launch parameters stay aligned with the native bridge flags."""

from __future__ import annotations

from pathlib import Path

import pytest

from robotd.devices import audio_bridge as bridge_module
from robotd.devices.audio_bridge import AudioBridge, AudioBridgeUnavailable


def _captured_launch_args(tmp_path: Path, *, aec: bool) -> list[str]:
    app_path = tmp_path / "AudioBridge.app"
    app_path.mkdir()
    bridge = AudioBridge(
        app_path=app_path,
        work_dir=tmp_path,
        on_event=lambda _event: None,
        aec=aec,
    )
    captured: list[str] = []

    class StopAfterLaunch(OSError):
        pass

    def fake_run(args: list[str], **_kwargs: object) -> None:
        captured.extend(args)
        raise StopAfterLaunch("stop after capturing launch arguments")

    original_run = bridge_module.subprocess.run
    bridge_module.subprocess.run = fake_run
    try:
        with pytest.raises(AudioBridgeUnavailable):
            bridge.start()
    finally:
        bridge_module.subprocess.run = original_run

    return captured


def test_aec_enabled_is_forwarded_to_the_native_bridge(tmp_path: Path) -> None:
    args = _captured_launch_args(tmp_path, aec=True)

    assert "--aec" in args
    assert "--no-aec" not in args


def test_aec_disabled_is_forwarded_to_the_native_bridge(tmp_path: Path) -> None:
    args = _captured_launch_args(tmp_path, aec=False)

    assert "--aec" not in args
    assert "--no-aec" in args
