// GH-55: with `-D WALLY_AUDIO_TEST_HARNESS` the same generated classifier must
// recognise the test-only commands. This proves the flag actually opens the
// surface (and that the default target above closes it) without any device.
import XCTest
@testable import BridgeCoreHarness

final class ServeCommandHarnessTests: XCTestCase {
    func testHarnessBuildRecognisesTheHarnessCommands() {
        XCTAssertEqual(classifyServeCommand("harness_play_wav"), .some(.harnessPlayWav))
        XCTAssertEqual(classifyServeCommand("harness_record_pair"), .some(.harnessRecordPair))
    }

    func testHarnessBuildKeepsTheProductionSurface() {
        XCTAssertEqual(classifyServeCommand("listen"), .some(.listen))
        XCTAssertEqual(classifyServeCommand("stop_speak"), .some(.stopSpeak))
    }

    func testHarnessBuildStillRejectsLegacyNamesAndUnknowns() {
        XCTAssertNil(classifyServeCommand("play"))
        XCTAssertNil(classifyServeCommand("record"))
        XCTAssertNil(classifyServeCommand("harness_play"))
    }
}
