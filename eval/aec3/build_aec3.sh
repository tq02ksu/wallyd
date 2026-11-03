#!/bin/sh
# 编译 WebRTC AEC3 静态库（arm64 macOS），用于 AEC 对照实验。
#
# 为什么不用 CMake：本机没装 cmake/ninja，而 CMakeLists 只是「收集所有 src/*.cc 加一组 include
# 路径」，逻辑很简单，直接用 clang 复刻即可，避免为了一个实验引入构建系统依赖。
#
# 源码：work/refs/webrtc-aec3（Enaium/webrtc-aec3，从 WebRTC 提取的独立 AEC3）
# 许可证：MIT
#
# 排除项与 CMakeLists 一致：
#   - 非 x86 平台排除 *_avx2.cc / *_sse2.cc / *_sse.cc
#   - 保留 *_neon.cc（arm64 需要）
#
# 用法：sh work/verify/build_aec3.sh
set -eu

HERE=$(cd "$(dirname "$0")/../.." && pwd)
SRC=$HERE/work/refs/webrtc-aec3
OUT=$HERE/work/verify/build
mkdir -p "$OUT/obj"

[ -d "$SRC/src" ] || { echo "缺源码：$SRC（git clone Enaium/webrtc-aec3）"; exit 1; }

INC="-I$SRC/src -I$SRC/src/api -I$SRC/src/base/rtc_base -I$SRC/src/base \
 -I$SRC/src/base/system_wrappers/include -I$SRC/src/audio_processing \
 -I$SRC/src/absl -I$SRC/src/base/jsoncpp/include -I$SRC/src/audio_processing/aec3 \
 -I$SRC/src/audio_processing/resampler -I$SRC/src/audio_processing/logging \
 -I$SRC/src/audio_processing/include -I$SRC/src/audio_processing/utility \
 -I$SRC/src/rtc_base/experiments -I$SRC/src/common_audio \
 -I$SRC/src/common_audio/third_party/ooura/fft_size_128"

DEFS="-DWEBRTC_MAC -DWEBRTC_POSIX"
CXXFLAGS="-std=c++20 -O2 -fPIC -fexceptions -Wall -Wno-deprecated -m64 $DEFS $INC"

cd "$SRC"
n=0
for f in $(find src -name "*.cc" -o -name "*.c" | grep -vE "_avx2\.cc$|_sse2\.cc$|_sse\.cc$"); do
    obj="$OUT/obj/$(echo "$f" | tr '/' '_').o"
    if [ -f "$obj" ] && [ "$obj" -nt "$f" ]; then continue; fi
    if [ "${f##*.}" = "c" ]; then
        clang -O2 -fPIC -m64 $DEFS $INC -c "$f" -o "$obj" 2>>"$OUT/build.log" || {
            echo "FAIL $f"; tail -5 "$OUT/build.log"; exit 1; }
    else
        clang++ $CXXFLAGS -c "$f" -o "$obj" 2>>"$OUT/build.log" || {
            echo "FAIL $f"; tail -20 "$OUT/build.log"; exit 1; }
    fi
    n=$((n+1))
done

echo "已编译 $n 个新文件，打包静态库…"
ar rcs "$OUT/libwebrtc_aec3.a" "$OUT/obj"/*.o
echo "==> 完成：$OUT/libwebrtc_aec3.a"
ls -lh "$OUT/libwebrtc_aec3.a"
