# Third-party source

Third-party code committed here keeps its own license. The root
[`LICENSES.md`](../LICENSES.md) only describes WALLY's own split license.

## webrtc-aec3

`webrtc-aec3/` is expected to contain the MIT-licensed standalone WebRTC AEC3
extraction used by the real-time AEC path. It is **not vendored yet**: the
current development sandbox has no network access, so
`scripts/vendor-aec3.sh` must be run in a network-enabled checkout and the
result committed.

`eval/aec3/build_aec3.sh` reads only `third_party/webrtc-aec3/src` (or an
explicit `AEC3_SRC`); there is no `work/` fallback any more.

## Vendoring workflow (decided 2026-11-08)

- The maintainer populates `third_party/webrtc-aec3/` locally with
  `sh scripts/vendor-aec3.sh <commit-or-tag>` and pushes it as its own pull
  request. Execution rounds do not clone upstream.
- Record who vendored it, the pinned ref/commit, and who ran the license check
  (`LICENSE` contains MIT, `src/` exists) in that pull request and here.
- `eval/aec3/build_aec3.sh` **fails closed** (non-zero, naming
  `scripts/vendor-aec3.sh`) when `third_party/webrtc-aec3/src` is absent. It
  never silently falls back to VPIO, and it no longer reads a `work/` copy, so a
  fresh clone cannot appear to build an AEC3 library it does not have.
