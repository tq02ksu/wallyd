#!/usr/bin/env bash
# Apple (macOS) lane — GH-36.
#
# The four Linux lanes cannot compile Swift, so until this lane existed every
# `.swift` change was only guarded by source-text assertions. This lane runs on
# the official GitHub macOS runner (arm64) and does only what needs no audio
# device, no camera, and no TCC permission:
#
#   1. `swiftc -parse` every tracked `.swift` file  (syntax gate, all files)
#   2. `swiftc -O` the three self-contained tools    (real compile + link)
#   3. `swift test` over the hardware-free pure core (real XCTest assertions)
#   4. `bash eval/aec3/build_aec3.sh`, then link `aec3_eval`
#      — fail-closed: while `third_party/webrtc-aec3` is empty the build aborts
#        with a `scripts/vendor-aec3.sh` hint and this lane goes RED. There is
#        deliberately no shell or-true fallback and no `continue-on-error`.
#
# Nothing here touches a real microphone, speaker, or camera. Read
# `docs/design/macos-ci.md` for which criteria this lane does *not* cover.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
    printf '[apple] needs macOS: swiftc and XCTest ship with Xcode; this host is %s\n' \
        "$(uname -s)" >&2
    exit 1
fi

step_start=$SECONDS
printf '[apple] toolchain\n'
swift --version
printf '[apple] SDK: %s\n' "$(xcrun --show-sdk-version)"
printf '[apple] macOS: %s\n' "$(sw_vers -productVersion)"
xcodebuild -version
printf '[apple] toolchain probe: %ss\n' "$((SECONDS - step_start))"

# 1) Parse every tracked Swift file. `-parse` is the syntax gate that works for
# single-file scripts with top-level code (they cannot be type-checked alone),
# and it rejects a missing semicolon or an unbalanced brace.
swift_files=$(git ls-files '*.swift')
if [ -z "$swift_files" ]; then
    printf '[apple] no tracked .swift files found — refusing to report green\n' >&2
    exit 1
fi
swift_count=$(printf '%s\n' "$swift_files" | wc -l | tr -d ' ')

step_start=$SECONDS
printf '[apple] swiftc -parse (%s tracked .swift files)\n' "$swift_count"
for file in $swift_files; do
    if ! swiftc -parse "$file"; then
        printf '[apple] parse failed: %s\n' "$file" >&2
        exit 1
    fi
done
printf '[apple] swiftc -parse: %ss\n' "$((SECONDS - step_start))"

# 2) Real compile + link for the three tools that are self-contained (single
# file, no other repository sources). A parse-only gate would miss type errors
# and missing framework symbols, so these get a real `swiftc -O` build.
standalone_targets=(
    scripts/speech_fixture.swift
    src/tools/cam_list.swift
    eval/vision_bench.swift
)
step_start=$SECONDS
printf '[apple] swiftc -O (%s standalone targets)\n' "${#standalone_targets[@]}"
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
for file in "${standalone_targets[@]}"; do
    if [ ! -f "$file" ]; then
        printf '[apple] standalone target is missing: %s\n' "$file" >&2
        exit 1
    fi
    printf '[apple] swiftc -O: %s\n' "$file"
    # The issue text sketches `-o /dev/null`; a real temp path is used instead
    # so the linker's chmod on the output cannot fail on the /dev/null node.
    swiftc -O -o "$build_dir/$(basename "${file%.swift}")" "$file"
done
printf '[apple] swiftc -O: %ss\n' "$((SECONDS - step_start))"

# 3) A genuinely executed XCTest over the bridge's pure logic. `mac_speech.swift`
# is a script (top-level CLI dispatch), so SwiftPM cannot import it. The
# extractor copies `struct EnergyVAD` and `func splitSentences` verbatim out of
# it before the test run, which keeps one source of truth instead of a drifting
# duplicate. Both are hardware-free; see the test file for what is asserted.
step_start=$SECONDS
printf '[apple] XCTest over the hardware-free bridge core\n'
python3 scripts/apple/extract_bridge_core.py \
    --source scripts/mac_speech.swift \
    --out scripts/apple/Sources/BridgeCore/Generated.swift
swift test --package-path scripts/apple
printf '[apple] XCTest: %ss\n' "$((SECONDS - step_start))"

# 4) AEC3 offline harness. `build_aec3.sh` is owned by GH-6 and fails closed
# when the vendored sources are absent; this lane only runs it and turns that
# into a red apple job. When the sources exist, also link `aec3_eval` so the
# offline evaluator is compiled, not just the static library.
step_start=$SECONDS
printf '[apple] AEC3 offline harness\n'
if ! bash eval/aec3/build_aec3.sh; then
    printf '[apple] AEC3 build failed closed (expected while the sources are not vendored).\n' >&2
    printf '[apple] Run scripts/vendor-aec3.sh <commit-or-tag> to enable this step.\n' >&2
    exit 1
fi

# Resolve the source tree the same way build_aec3.sh does (GH-6 policy: only the
# committed tree or an explicit AEC3_SRC; there is no `work/` fallback). Keep this
# in sync with eval/aec3/build_aec3.sh; this file only compiles the harness.
aec3_src=${AEC3_SRC:-$ROOT/third_party/webrtc-aec3}
aec3_includes=(
    -I"$aec3_src/src" -I"$aec3_src/src/api" -I"$aec3_src/src/base/rtc_base"
    -I"$aec3_src/src/base" -I"$aec3_src/src/base/system_wrappers/include"
    -I"$aec3_src/src/audio_processing" -I"$aec3_src/src/absl"
    -I"$aec3_src/src/base/jsoncpp/include" -I"$aec3_src/src/audio_processing/aec3"
    -I"$aec3_src/src/audio_processing/resampler"
    -I"$aec3_src/src/audio_processing/logging"
    -I"$aec3_src/src/audio_processing/include"
    -I"$aec3_src/src/audio_processing/utility"
    -I"$aec3_src/src/rtc_base/experiments" -I"$aec3_src/src/common_audio"
    -I"$aec3_src/src/common_audio/third_party/ooura/fft_size_128"
)
aec3_lib=$ROOT/work/verify/build/libwebrtc_aec3.a
if [ ! -f "$aec3_lib" ]; then
    printf '[apple] build_aec3.sh succeeded but %s is missing\n' "$aec3_lib" >&2
    exit 1
fi
printf '[apple] linking aec3_eval\n'
clang++ -std=c++20 -O2 -m64 -DWEBRTC_MAC -DWEBRTC_POSIX \
    "${aec3_includes[@]}" \
    eval/aec3/aec3_eval.cc "$aec3_lib" \
    -o "$ROOT/work/verify/build/aec3_eval"
printf '[apple] AEC3 build: %ss\n' "$((SECONDS - step_start))"

printf '[apple] ok: %s Swift files parsed, %s compiled, XCTest passed, aec3_eval built\n' \
    "$swift_count" "${#standalone_targets[@]}"
