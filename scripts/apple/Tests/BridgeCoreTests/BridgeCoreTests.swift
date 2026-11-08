// XCTest for the hardware-free part of the speech bridge (GH-36 apple lane).
//
// `BridgeCore` is generated from `scripts/mac_speech.swift` by
// `scripts/apple/extract_bridge_core.py`, so these assertions run against the
// real production implementation (not a reimplementation). Nothing here opens
// a microphone, speaker, or camera: the macOS CI runner has none of those.
import XCTest
@testable import BridgeCore

/// Drives `EnergyVAD` with synthetic dBFS levels at a fixed 20 ms frame rate.
private struct VADDriver {
    var vad = EnergyVAD(speechDb: -36, silenceDb: -42, minSpeechSec: 0.3, endpointSilenceSec: 0.7)
    var t = 0.0
    var starts = 0
    var endpoints: [(speechMS: Int, silenceMS: Int)] = []

    mutating func feed(_ db: Double, frames: Int = 1) {
        for _ in 0..<frames {
            switch vad.push(db: db, tSec: t) {
            case .started:
                starts += 1
            case let .ended(speechMS, silenceMS):
                endpoints.append((speechMS, silenceMS))
            case .none:
                break
            }
            t += 0.02
        }
    }
}

final class EnergyVADTests: XCTestCase {
    func testSilenceNeverStartsASpeechRound() {
        var driver = VADDriver()
        driver.feed(-60.0, frames: 200)
        XCTAssertEqual(driver.starts, 0)
        XCTAssertTrue(driver.endpoints.isEmpty)
    }

    func testOnsetRequiresThreeConsecutiveFrames() {
        var driver = VADDriver()
        driver.feed(-60.0, frames: 10)
        // Two loud frames, one quiet frame resets the debounce counter.
        driver.feed(-20.0, frames: 2)
        driver.feed(-60.0, frames: 1)
        driver.feed(-20.0, frames: 2)
        XCTAssertEqual(driver.starts, 0, "a broken streak must not start a round")
        driver.feed(-20.0, frames: 1)
        XCTAssertEqual(driver.starts, 1, "the third consecutive frame crosses the onset gate")
    }

    func testEndpointFiresAfterSpeechFollowedBySilence() {
        var driver = VADDriver()
        driver.feed(-60.0, frames: 10)
        driver.feed(-20.0, frames: 50)  // ~1.0 s of speech
        driver.feed(-60.0, frames: 40)  // 0.8 s of silence
        XCTAssertEqual(driver.starts, 1)
        XCTAssertEqual(driver.endpoints.count, 1)
        XCTAssertGreaterThanOrEqual(driver.endpoints[0].speechMS, 300)
        XCTAssertGreaterThanOrEqual(driver.endpoints[0].silenceMS, 700)
    }

    func testShortBlipDoesNotProduceAnEndpoint() {
        var driver = VADDriver()
        driver.feed(-60.0, frames: 10)
        driver.feed(-20.0, frames: 5)  // 0.1 s, shorter than minSpeechSec
        driver.feed(-60.0, frames: 60)
        XCTAssertEqual(driver.starts, 1)
        XCTAssertTrue(driver.endpoints.isEmpty, "noise shorter than minSpeechSec must not endpoint")
    }

    func testHysteresisKeepsTheRoundAliveBetweenThresholds() {
        var driver = VADDriver()
        driver.feed(-60.0, frames: 10)
        driver.feed(-20.0, frames: 10)
        // -39 dB is below speechDb (-36) but above silenceDb (-42): still speaking.
        driver.feed(-39.0, frames: 50)
        driver.feed(-60.0, frames: 40)
        XCTAssertEqual(driver.starts, 1)
        XCTAssertEqual(driver.endpoints.count, 1)
        XCTAssertGreaterThanOrEqual(driver.endpoints[0].speechMS, 1000)
    }
}

final class SplitSentencesTests: XCTestCase {
    func testSplitsAtSentenceTerminators() {
        XCTAssertEqual(splitSentences("第一句。第二句。"), ["第一句。", "第二句。"])
    }

    func testDoesNotSplitAtDecimalPoints() {
        XCTAssertEqual(
            splitSentences("海拔 3.5 米，温度 25.6 度。"),
            ["海拔 3.5 米，温度 25.6 度。"]
        )
    }

    func testKeepsClosingQuoteWithItsSentence() {
        XCTAssertEqual(
            splitSentences("他说：“走吧！”然后就离开了。"),
            ["他说：“走吧！”", "然后就离开了。"]
        )
    }

    func testEnglishSentencesSplitOnlyAtEndOfSentence() {
        XCTAssertEqual(
            splitSentences("Line one. Line two ends here."),
            ["Line one.", "Line two ends here."]
        )
    }

    func testEmptyInputProducesNoChunks() {
        XCTAssertEqual(splitSentences(""), [])
    }

    func testBoundsLongUnpunctuatedTextWithoutDroppingCharacters() {
        let text = String(repeating: "字", count: 200)
        let chunks = splitSentences(text, maxLen: 20)
        XCTAssertFalse(chunks.isEmpty)
        XCTAssertTrue(chunks.allSatisfy { $0.count <= 20 }, "every chunk must respect maxLen")
        XCTAssertEqual(chunks.joined(), text, "bounding must not drop characters")
    }
}
