// Keeps the BridgeCore target non-empty in a fresh checkout.
//
// `Generated.swift` is produced by `scripts/apple/extract_bridge_core.py` from
// `scripts/mac_speech.swift` and is intentionally not committed. Run
// `bash scripts/ci/check-apple.sh` (or the extractor directly) before `swift
// test`; branching on the extracted declarations would otherwise fail to build.
