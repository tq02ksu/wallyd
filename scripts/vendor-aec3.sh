#!/bin/sh
# Vendor the MIT-licensed WebRTC AEC3 extraction into third_party/webrtc-aec3.
#
# Usage: sh scripts/vendor-aec3.sh <commit-or-tag>
#
# A floating ref (main/master/HEAD) is refused: real-time audio behavior must be
# reproducible from the committed tree, and a moving upstream turns
# "sample-identical" into an untestable claim. Record the resolved commit in the
# pull request body.
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
REF=${1:-}
if [ -z "$REF" ]; then
    echo "用法：sh scripts/vendor-aec3.sh <commit-or-tag>" >&2
    exit 2
fi
case "$REF" in
    main|master|HEAD)
        echo "拒绝浮动引用 '$REF'：请传具体 commit 或 tag" >&2
        exit 2
        ;;
esac

DEST=$HERE/third_party/webrtc-aec3
if [ -e "$DEST" ]; then
    echo "$DEST 已存在；先确认要更新再手动移走" >&2
    exit 2
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git init -q "$TMP/upstream"
git -C "$TMP/upstream" remote add origin https://github.com/Enaium/webrtc-aec3.git
git -C "$TMP/upstream" fetch -q --depth 1 origin "$REF"
git -C "$TMP/upstream" checkout -q FETCH_HEAD

if [ ! -d "$TMP/upstream/src" ]; then
    echo "上游缺 src/ 目录，拒绝入库" >&2
    exit 2
fi
if [ ! -f "$TMP/upstream/LICENSE" ] || ! grep -qi "MIT" "$TMP/upstream/LICENSE"; then
    echo "上游 LICENSE 缺失或不是 MIT，拒绝入库" >&2
    exit 2
fi

mkdir -p "$HERE/third_party"
SHA=$(git -C "$TMP/upstream" rev-parse HEAD)
mv "$TMP/upstream" "$DEST"
rm -rf "$DEST/.git"

echo "已入库 $DEST @ $SHA"
