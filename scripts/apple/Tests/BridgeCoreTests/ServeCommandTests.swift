// GH-55: the *default* build must answer E_CMD_UNKNOWN for the test harness
// commands. `BridgeCore` is generated from the production `mac_speech.swift`
// and compiled without `WALLY_AUDIO_TEST_HARNESS`, so this runs the real
// classifier rather than reimplementing it.
import XCTest
@testable import BridgeCore

final class ServeCommandTests: XCTestCase {
    func testProductionCommandSurfaceIsExactlyTheEightCommands() {
        let expected: [String: ServeCommand] = [
            "listen": .listen,
            "stop": .stop,
            "mute": .mute,
            "unmute": .unmute,
            "speak": .speak,
            "stop_speak": .stopSpeak,
            "status": .status,
            "quit": .quit,
        ]
        for (raw, command) in expected {
            XCTAssertEqual(classifyServeCommand(raw), Optional(command), raw)
        }
    }

    func testDefaultBuildDoesNotKnowTheHarnessCommands() {
        // nil is what makes the bridge emit E_CMD_UNKNOWN.
        XCTAssertNil(classifyServeCommand("harness_play_wav"))
        XCTAssertNil(classifyServeCommand("harness_record_pair"))
    }

    func testLegacyDiagnosticCommandsStayRemoved() {
        XCTAssertNil(classifyServeCommand("play"))
        XCTAssertNil(classifyServeCommand("record"))
    }

    func testUnknownCommandsAreRejected() {
        XCTAssertNil(classifyServeCommand(""))
        XCTAssertNil(classifyServeCommand("status "))
        XCTAssertNil(classifyServeCommand("HARNESS_PLAY_WAV"))
    }
}
