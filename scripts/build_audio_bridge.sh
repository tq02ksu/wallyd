#!/bin/sh
# 构建常驻语音桥 AudioBridge.app（R14 / ADR-0011）
#
# 用法：
#   sh scripts/build_audio_bridge.sh            # 输出到 work/bin/AudioBridge.app
#   OUT=/somewhere/AudioBridge.app sh scripts/build_audio_bridge.sh
#
# 测试专用 WAV 通道（GH-55，**默认不编译**）：
#   WALLY_AUDIO_TEST_HARNESS=1 sh scripts/build_audio_bridge.sh
#   开启后 serve 才认识 harness_play_wav / harness_record_pair，并在
#   bridge_ready 里回报 "test_harness": true。默认构建下发这些命令回
#   E_CMD_UNKNOWN（由 robotd 单测与 apple lane 的 XCTest 锁住）。
#
# 为什么要打成 .app 并用 open 启动：见 docs/decisions/0011-audio-bridge-app-bundle-tcc.md
# 签名：优先用稳定自签身份（重编译不掉 TCC 授权）；没证书时回退 adhoc（每次要重新授权）。
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-$HERE/work/bin/AudioBridge.app}
SRC=$HERE/scripts/mac_speech.swift
PIPELINE=$HERE/scripts/mac_speech_pipeline.swift

if [ ! -f "$SRC" ]; then
    echo "找不到源码 $SRC" >&2
    exit 2
fi
if [ ! -f "$PIPELINE" ]; then
    echo "找不到语音管道源码 $PIPELINE" >&2
    exit 2
fi

mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"

echo "==> 编译 $SRC + $PIPELINE"
# Swift 只允许一个文件承载顶层代码。把管道声明拼到 main.swift 尾部，保证：
#   ① 仍然是同一个可执行文件；② serve 模式只走 mac_speech_pipeline.swift 的两条管道。
TMP_BUILD=$(mktemp -d)
trap 'rm -rf "$TMP_BUILD"' EXIT
cat "$SRC" "$PIPELINE" > "$TMP_BUILD/main.swift"
# 独立编译开关：只有显式 WALLY_AUDIO_TEST_HARNESS=1 才把测试命令面编进来。
HARNESS_DEFINE=""
if [ "${WALLY_AUDIO_TEST_HARNESS:-0}" = "1" ]; then
    HARNESS_DEFINE="-D WALLY_AUDIO_TEST_HARNESS"
    echo "==> 测试专用 harness 已开启（bridge_ready 会回报 test_harness=true）"
else
    echo "==> 默认构建：不含 harness_play_wav / harness_record_pair"
fi
# shellcheck disable=SC2086  # HARNESS_DEFINE 是刻意分成两个参数的空/非空标志
swiftc -O -D VOICE_PIPELINE $HARNESS_DEFINE -o "$OUT/Contents/MacOS/AudioBridge" "$TMP_BUILD/main.swift"

echo "==> 写 Info.plist"
cat > "$OUT/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>AudioBridge</string>
<key>CFBundleIdentifier</key><string>com.macmini.robot.audiobridge</string>
<key>CFBundleName</key><string>AudioBridge</string>
<key>CFBundleDisplayName</key><string>Robot Audio Bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<!-- 后台常驻：不占 Dock、不抢焦点 -->
<key>LSBackgroundOnly</key><true/>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>机器人语音输入需要麦克风</string>
<key>NSSpeechRecognitionUsageDescription</key><string>机器人需要语音识别来理解指令</string>
</dict></plist>
PLIST

echo "==> 签名"
# **必须用稳定签名身份**：adhoc 签名按 CDHash 识别，每次重编译都换身份，
# TCC 麦克风授权随之失效（改一行代码就要去系统设置手动点一次，迭代成本极高）。
# 自签证书的签名身份稳定 → 授权一次之后重编译不再失效。
#
# ⚠ 私钥放在**独立钥匙串** work/cert/dev.keychain-db 里，而不是登录钥匙串：
#   登录钥匙串的私钥每次签名都要走 GUI 授权弹窗（`SecKeyCreateSignature` 卡住，
#   实测 codesign 挂 40s 以上不返回）。独立钥匙串 + set-key-partition-list
#   之后 codesign 可以直接用，签名耗时 ~2s。
#
# 一次性准备（约 5 分钟，见 work/cert/README.md）：
#   1. openssl 生成自签证书（EKU=codeSigning）
#   2. security create-keychain / import / set-key-partition-list
#   3. security add-trusted-cert -d -r trustRoot -p codeSign   （信任，否则不进身份列表）
#
# 没装证书时回退 adhoc（仍可用，只是每次要重新授权）。
SIGN_ID=${SIGN_ID:-"AudioBridge Dev"}
DEV_KS=${DEV_KS:-$HERE/work/cert/dev.keychain-db}
DEV_KS_PASS=${DEV_KS_PASS:-devks}

if [ -f "$DEV_KS" ] && security find-identity -v -p codesigning "$DEV_KS" 2>/dev/null | grep -q "$SIGN_ID"; then
    security unlock-keychain -p "$DEV_KS_PASS" "$DEV_KS" >/dev/null 2>&1 || true
    echo "    身份：${SIGN_ID}（稳定签名，重编译不掉授权）"
    codesign --force --sign "$SIGN_ID" --keychain "$DEV_KS" --timestamp=none "$OUT" 2>&1 | sed 's/^/    /'
else
    echo "    身份：adhoc（未找到 ${SIGN_ID}，每次重编译都要重新授权麦克风）"
    echo "          装法见 work/cert/README.md"
    codesign --force --sign - "$OUT" 2>&1 | sed 's/^/    /'
fi

echo "==> 完成：$OUT"
echo
echo "首次使用（或改了桥的代码之后）需要授权一次："
echo "    open -a \"$OUT\" --args request-permission"
echo "    然后在系统弹窗里点「允许」；没有弹窗就去"
echo "    系统设置 → 隐私与安全性 → 麦克风 / 语音识别 里手动打开 AudioBridge"
