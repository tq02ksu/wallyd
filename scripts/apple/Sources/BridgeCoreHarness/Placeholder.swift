// Keeps the BridgeCoreHarness target non-empty in a fresh checkout.
//
// `Generated.swift` is produced by `scripts/apple/extract_bridge_core.py
// --out-harness ...` from `scripts/mac_speech.swift` before `swift test`. This
// target is compiled with `-D WALLY_AUDIO_TEST_HARNESS`, so the generated
// command surface includes the GH-55 harness commands.
