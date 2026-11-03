#!/bin/sh
# 构建常驻语音桥 AudioBridge.app（R14 / ADR-0011）
#
# 用法：
#   sh scripts/build_audio_bridge.sh            # 输出到 work/bin/AudioBridge.app
#   OUT=/somewhere/AudioBridge.app sh scripts/build_audio_bridge.sh
#
# 为什么要打成 .app 并用 open 启动：见 doc/decisions/0011-audio-bridge-app-bundle-tcc.md
# 签名：优先用稳定自签身份（重编译不掉 TCC 授权）；没证书时回退 adhoc（每次要重新授权）。
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-$HERE/work/bin/AudioBridge.app}
SRC=$HERE/scripts/mac_speech.swift

if [ ! -f "$SRC" ]; then
    echo "找不到源码 $SRC" >&2
    exit 2
fi

mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"

echo "==> 编译 $SRC"
swiftc -O -o "$OUT/Contents/MacOS/AudioBridge" "$SRC"

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
