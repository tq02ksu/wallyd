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
    ]
)
