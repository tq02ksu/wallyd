"""GH-6 步骤 1/2 的入库与构建路径门禁（Linux 可判定）。

AEC3 源码本身无法在无网络沙箱里下载，所以这里不声称「已接入」；只钉住三件
可判定的事：构建脚本认入库路径、vendor 脚本要求固定引用、许可证必须是 MIT。
真正编译与逐样本对齐仍只能在 macOS 上验证。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BUILD = ROOT / "eval" / "aec3" / "build_aec3.sh"
VENDOR = ROOT / "scripts" / "vendor-aec3.sh"
AB = ROOT / "eval" / "aec3" / "aec_ab2.sh"
COMPARE = ROOT / "eval" / "aec3" / "compare_wav.py"


def test_aec3_build_reads_only_the_in_repo_third_party_tree():
    text = BUILD.read_text(encoding="utf-8")
    assert "third_party/webrtc-aec3" in text
    # 构建必须能在 clone 后的仓库内找到源码，而不是只认 work/ 下的临时目录。
    assert "AEC3_SRC" in text
    # GH-6 D1：不许再退回 work/ 下的离线副本——那会让 fresh clone 静默构建出坏库。
    assert "work/refs/webrtc-aec3" not in text


def test_aec3_build_fails_closed_without_vendored_source(tmp_path):
    """GH-6 D1 判据 1：源码缺失时非 0 退出，且 stderr 指向 vendor 脚本。"""
    empty = tmp_path / "webrtc-aec3"
    empty.mkdir()
    proc = subprocess.run(
        ["sh", str(BUILD)],
        capture_output=True,
        text=True,
        env={"AEC3_SRC": str(empty), "PATH": "/usr/bin:/bin"},
        check=False,
    )
    assert proc.returncode != 0
    assert "vendor-aec3.sh" in proc.stderr


def test_vendor_script_refuses_floating_refs_and_requires_an_explicit_one():
    text = VENDOR.read_text(encoding="utf-8")
    assert "FETCH_HEAD" in text
    assert "main|master|HEAD" in text
    assert "commit-or-tag" in text
    assert "https://github.com/Enaium/webrtc-aec3.git" in text


def test_vendor_script_enforces_the_mit_license_and_source_layout():
    text = VENDOR.read_text(encoding="utf-8")
    assert 'grep -qi "MIT"' in text
    assert "LICENSE" in text
    assert "src" in text


def test_ab_experiment_has_a_fail_closed_aec3_branch():
    text = AB.read_text(encoding="utf-8")
    assert "--aec3" in text
    # 未知 flag 被忽略时不能把 VPIO 数据伪装成 AEC3：桥必须确认模式。
    assert '"aec_mode": "aec3"' in text
    assert "aec3" in text and "vpio" in text


def test_wav_comparator_exists_for_sample_identical_acceptance():
    text = COMPARE.read_text(encoding="utf-8")
    assert "PCM16" in text
    assert "--tolerance" in text
    assert "首个索引" in text
