// swift-tools-version:5.9
//
// Test-only Swift package for the macOS CI lane (GH-36).
//
// The bridge is a set of single-file scripts (`swiftc` script mode), so its
// hardware-free pure logic cannot be imported directly. `check-apple.sh` runs
// `scripts/apple/extract_bridge_core.py` to copy `struct EnergyVAD` and
// `func splitSentences` out of `scripts/mac_speech.swift` into
// `Sources/BridgeCore/Generated.swift` before `swift test`. That keeps the
// production file as the only source of truth: a rename or a changed signature
// makes the extraction fail, which turns the lane red.
//
// GH-55 adds a second copy of the same generated file in
// `Sources/BridgeCoreHarness`, compiled with `-D WALLY_AUDIO_TEST_HARNESS`.
// The two test targets therefore execute the real `classifyServeCommand` both
// ways: the default build must not know the harness commands, the flagged build
// must. No audio device is touched by either target.
import PackageDescription

let package = Package(
    name: "WallyBridgeCore",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(name: "BridgeCore", targets: ["BridgeCore"]),
    ],
    targets: [
        .target(name: "BridgeCore", path: "Sources/BridgeCore"),
        .testTarget(
            name: "BridgeCoreTests",
            dependencies: ["BridgeCore"],
            path: "Tests/BridgeCoreTests"
        ),
        .target(
            name: "BridgeCoreHarness",
            path: "Sources/BridgeCoreHarness",
            swiftSettings: [.define("WALLY_AUDIO_TEST_HARNESS")]
        ),
        .testTarget(
            name: "BridgeCoreHarnessTests",
            dependencies: ["BridgeCoreHarness"],
            path: "Tests/BridgeCoreHarnessTests"
        ),
    ]
)
