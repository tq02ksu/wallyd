# Third-party source

Third-party code committed here keeps its own license. The root
[`LICENSES.md`](../LICENSES.md) only describes WALLY's own split license.

## webrtc-aec3

`webrtc-aec3/` is expected to contain the MIT-licensed standalone WebRTC AEC3
extraction used by the real-time AEC path. It is **not vendored yet**: the
current development sandbox has no network access, so
`scripts/vendor-aec3.sh` must be run in a network-enabled checkout and the
result committed.

Build and evaluation scripts already prefer
`third_party/webrtc-aec3/src`; `work/refs/webrtc-aec3` remains only a local
fallback for the historical offline experiment.
