// Voice bridge internals for the `serve` mode.
//
// This file is concatenated after mac_speech.swift by scripts/build_audio_bridge.sh so the
// executable stays a single binary. It deliberately has no top-level statements: the entry
// point is runServeBridgeMode(), called from mac_speech.swift when mode == "serve".
//
// Boundaries (issue GH-4 / ADR-0012 rule 5):
//   Capture -> AEC(optional) -> VAD -> ASR -> [speech_state / partial / endpoint / final]
//   Text -> Split -> Synth -> BoundedQueue -> Render -> [tts_*]
// The audio tap copies a frame and enqueues it. Conversion, VAD, ASR, synthesis and playback
// all run on their own serial workers; VAD and ASR are sibling frame subscribers.

struct VoiceEngineUnavailable: Error {
    let code: String
    let message: String
}

enum VoiceBackend: String {
    case system
    case sherpa
}

// ---------------------------------------------------------------- pure frame data

/// One immutable ASR-format frame. `startFrame` is a continuous sample index, not wall time.
final class AudioFrame: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    let startFrame: Int
    let endFrame: Int
    let sampleRate: Double
    let capturedAtMs: Int
    let tMonoNs: UInt64

    init(buffer: AVAudioPCMBuffer, startFrame: Int, sampleRate: Double,
         capturedAtMs: Int, tMonoNs: UInt64) {
        self.buffer = buffer
        self.startFrame = startFrame
        self.endFrame = startFrame + Int(buffer.frameLength)
        self.sampleRate = sampleRate
        self.capturedAtMs = capturedAtMs
        self.tMonoNs = tMonoNs
    }

    var audioMs: Int { Int(Double(endFrame) / sampleRate * 1000) }
}

/// VAD writes only this pure data; ASR reads it for partial gating. It carries no verdict.
final class SpeechWindow: @unchecked Sendable {
    private let lock = NSLock()
    private var startMs: Int?
    private var endMs: Int?

    func reset() { lock.lock(); startMs = nil; endMs = nil; lock.unlock() }
    func started(_ ms: Int) { lock.lock(); startMs = ms; endMs = nil; lock.unlock() }
    func ended(_ ms: Int) { lock.lock(); endMs = ms; lock.unlock() }
    func snapshot() -> (start: Int?, end: Int?) {
        lock.lock(); defer { lock.unlock() }
        return (startMs, endMs)
    }
}

/// Fan-out to independent subscriber queues. The publisher never runs subscriber work inline.
final class FrameBus: @unchecked Sendable {
    private let lock = NSLock()
    private var handlers: [(String, (AudioFrame) -> Void)] = []

    func subscribe(_ name: String, _ handler: @escaping (AudioFrame) -> Void) {
        lock.lock(); handlers.append((name, handler)); lock.unlock()
    }

    func publish(_ frame: AudioFrame) {
        lock.lock(); let current = handlers.map { $0.1 }; lock.unlock()
        for handler in current { handler(frame) }
    }
}

// ---------------------------------------------------------------- tap timing

/// Measures only the tap callback (copy + enqueue), never conversion/ASR/TTS.
final class TapTiming: @unchecked Sendable {
    private let lock = NSLock()
    private var micros: [Double] = []
    private var total = 0

    func record(_ us: Double) {
        lock.lock()
        total += 1
        micros.append(us)
        if micros.count > 20_000 { micros.removeFirst(micros.count - 20_000) }
        lock.unlock()
    }

    func snapshot() -> [String: Any] {
        lock.lock()
        let samples = micros
        let count = total
        lock.unlock()
        let values = samples.sorted()
        guard !values.isEmpty else {
            return ["frames": count, "p50_ms": 0.0, "p99_ms": 0.0, "max_ms": 0.0]
        }
        func p(_ q: Double) -> Double {
            let i = min(values.count - 1, max(0, Int(Double(values.count - 1) * q)))
            return (values[i] / 1000.0 * 1000).rounded() / 1000
        }
        return [
            "frames": count,
            "p50_ms": p(0.50),
            "p99_ms": p(0.99),
            "max_ms": ((values.last ?? 0) / 1000.0 * 1000).rounded() / 1000,
        ]
    }
}

// ---------------------------------------------------------------- ASR engines

struct ASRFinal {
    let text: String
    let streamed: String
    let via: String
}

protocol ASREngine: AnyObject {
    var name: String { get }
    func begin(utteranceId: String, format: AVAudioFormat, autoEndpoint: Bool,
               window: SpeechWindow, emit: @escaping ([String: Any]) -> Void) async throws
    func feed(_ frame: AudioFrame)
    func finish() async -> ASRFinal
}

/// Wraps SpeechAnalyzer + SpeechTranscriber. The engine owns only ASR concerns; VAD arrives
/// through SpeechWindow and endpoint decisions stay in the VAD worker.
final class SystemASREngine: ASREngine, @unchecked Sendable {
    let name = "system"
    private let localeID: String
    private let lock = NSLock()
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var collector: Task<String, Error>?
    private var commitTimer: DispatchSourceTimer?
    private var window: SpeechWindow?
    private var emit: (([String: Any]) -> Void)?
    private var utteranceId = ""
    private var autoEndpoint = true
    private var accepted = ""
    private var revision = 0
    private var fedFrames = 0
    private var ended = false
    private var recording: AVAudioFile?
    private var recordingPath: String?
    private var format: AVAudioFormat?

    init(localeID: String) { self.localeID = localeID }

    func begin(utteranceId: String, format: AVAudioFormat, autoEndpoint: Bool,
               window: SpeechWindow, emit: @escaping ([String: Any]) -> Void) async throws {
        self.utteranceId = utteranceId
        self.autoEndpoint = autoEndpoint
        self.window = window
        self.emit = emit
        self.format = format

        let asked = Locale(identifier: localeID)
        let l = await SpeechTranscriber.supportedLocale(equivalentTo: asked) ?? asked
        // Fast results keep partials live; finish() runs one accurate batch pass as the final.
        let fast = (opt("--asr-preset") ?? "fast") != "accurate"
        let transcriber = SpeechTranscriber(
            locale: l, transcriptionOptions: [],
            reportingOptions: fast ? [.volatileResults, .fastResults] : [.volatileResults],
            attributeOptions: [.audioTimeRange])
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
        self.analyzer = analyzer
        self.continuation = cont

        let path = NSTemporaryDirectory() + "mac_speech-utt-\(utteranceId).caf"
        recording = try? AVAudioFile(forWriting: URL(fileURLWithPath: path),
                                     settings: format.settings,
                                     commonFormat: format.commonFormat,
                                     interleaved: format.isInterleaved)
        recordingPath = recording == nil ? nil : path

        collector = Task.detached { [weak self] () throws -> String in
            guard let self else { return "" }
            for try await r in transcriber.results {
                self.onResult(text: r.text, range: r.range, isFinal: r.isFinal)
            }
            self.lock.lock(); let out = self.accepted; self.lock.unlock()
            return out
        }
        _ = Task.detached { try await analyzer.start(inputSequence: stream) }

        // Periodic finalize (0.8s) makes the volatile range commit in real time.
        let commit = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        commit.schedule(deadline: .now() + 0.8, repeating: 0.8)
        commit.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let frames = self.fedFrames, ending = self.ended, fmt = self.format
            self.lock.unlock()
            guard !ending, let fmt else { return }
            let t = CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(fmt.sampleRate))
            Task { try? await analyzer.finalize(through: t) }
        }
        commit.resume()
        lock.lock(); commitTimer = commit; lock.unlock()
    }

    private func onResult(text: AttributedString, range: CMTimeRange, isFinal: Bool) {
        let chunk = String(text.characters)
        let sMs = Int(range.start.seconds * 1000)
        let eMs = Int(range.end.seconds * 1000)
        let snap = window?.snapshot()
        let start = snap?.start
        let end = snap?.end
        let margin = 300
        var inWindow = false
        if let start { inWindow = eMs >= start - margin && sMs <= (end.map { $0 + margin } ?? Int.max) }
        lock.lock(); let uid = utteranceId; let fed = fedFrames; lock.unlock()
        if isFinal {
            guard !autoEndpoint || inWindow else {
                emit?(["ev": "final_chunk_dropped", "text": chunk, "utterance_id": uid,
                       "audio_start_ms": sMs, "audio_end_ms": eMs,
                       "reason": start == nil ? "no_speech" : "out_of_window",
                       "fed_frames": fed, "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            lock.lock(); accepted += chunk; let acc = accepted; lock.unlock()
            emit?(["ev": "final_chunk", "text": acc, "utterance_id": uid,
                   "audio_start_ms": sMs, "audio_end_ms": eMs, "fed_frames": fed,
                   "ts_mono_ns": monoNs(), "t_ms": ms()])
        } else {
            guard !autoEndpoint || inWindow else { return }
            lock.lock(); revision += 1; let rev = revision, acc = accepted; lock.unlock()
            emit?(["ev": "partial", "text": acc + chunk, "revision": rev,
                   "utterance_id": uid, "audio_start_ms": sMs, "audio_end_ms": eMs,
                   "fed_frames": fed, "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
    }

    func feed(_ frame: AudioFrame) {
        lock.lock()
        guard !ended, let cont = continuation else { lock.unlock(); return }
        fedFrames = max(fedFrames, frame.endFrame)
        let fmt = format
        lock.unlock()
        recording?.writeSilently(frame.buffer)
        guard let fmt else { return }
        let start = CMTime(value: CMTimeValue(frame.startFrame), timescale: CMTimeScale(fmt.sampleRate))
        cont.yield(AnalyzerInput(buffer: frame.buffer, bufferStartTime: start))
    }

    func finish() async -> ASRFinal {
        lock.lock()
        guard !ended else { lock.unlock(); return ASRFinal(text: accepted, streamed: accepted, via: "stream") }
        ended = true
        let analyzer = self.analyzer
        let cont = continuation
        let task = collector
        let path = recordingPath
        let timer = commitTimer
        commitTimer = nil
        recording = nil
        recordingPath = nil
        lock.unlock()
        timer?.cancel()
        cont?.finish()
        _ = try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        let streamed = await waitText(task)
        var text = streamed
        var via = "stream"
        if !streamed.isEmpty, let path, (opt("--final-pass") ?? "batch") != "off",
           let accurate = await SpeechBatchTranscriber.transcribe(path: path, locale: localeID),
           !accurate.isEmpty {
            text = accurate
            via = "batch"
        }
        if let path { try? FileManager.default.removeItem(atPath: path) }
        return ASRFinal(text: text, streamed: streamed, via: via)
    }

    private func waitText(_ task: Task<String, Error>?) async -> String {
        guard let task else { lock.lock(); let acc = accepted; lock.unlock(); return acc }
        return await withTaskGroup(of: String?.self) { group in
            group.addTask { (try? await task.value) }
            group.addTask {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                return nil
            }
            let first = (await group.next()) ?? nil
            group.cancelAll()
            if let first { return first }
            self.lock.lock(); let acc = self.accepted; self.lock.unlock()
            return acc
        }
    }
}

final class SherpaASREngine: ASREngine {
    let name = "sherpa"
    func begin(utteranceId: String, format: AVAudioFormat, autoEndpoint: Bool,
               window: SpeechWindow, emit: @escaping ([String: Any]) -> Void) async throws {
        throw VoiceEngineUnavailable(code: "E_ASR_NOT_IMPLEMENTED",
                                     message: "--asr sherpa 尚未实现；接口已就绪，换模型是后续独立工作")
    }
    func feed(_ frame: AudioFrame) {}
    func finish() async -> ASRFinal { ASRFinal(text: "", streamed: "", via: "none") }
}

enum SpeechBatchTranscriber {
    static func transcribe(path: String, locale: String) async -> String? {
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else { return nil }
        let asked = Locale(identifier: locale)
        let loc = await SpeechTranscriber.supportedLocale(equivalentTo: asked) ?? asked
        let transcriber = SpeechTranscriber(locale: loc, preset: .transcription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collector = Task { () -> String in
            var out = ""
            for try await r in transcriber.results { out += String(r.text.characters) }
            return out
        }
        if let last = try? await analyzer.analyzeSequence(from: file) {
            try? await analyzer.finalizeAndFinish(through: last)
        }
        return (try? await collector.value) ?? nil
    }
}

// ---------------------------------------------------------------- TTS engines

struct TTSAudio {
    let buffers: [AVAudioPCMBuffer]
    let format: AVAudioFormat?
    let durationSec: Double
}

protocol TTSEngine: AnyObject {
    var name: String { get }
    func synthesize(_ text: String, voice: String?, rate: Float, dryRun: Bool) throws -> TTSAudio
}

final class SystemTTSEngine: TTSEngine {
    let name = "system"

    func synthesize(_ text: String, voice voiceID: String?, rate: Float, dryRun: Bool) throws -> TTSAudio {
        if dryRun { return TTSAudio(buffers: [], format: nil, durationSec: min(0.4, 0.03 * Double(text.count))) }
        let voice = voiceID.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
            ?? AVSpeechSynthesisVoice(language: "zh-CN")
        let synth = AVSpeechSynthesizer()
        let u = AVSpeechUtterance(string: text)
        u.voice = voice
        u.rate = min(max(rate, 0.1), 1.0)

        let lock = NSLock()
        var finished = false
        var buffers: [AVAudioPCMBuffer] = []
        var format: AVAudioFormat?
        let done = DispatchSemaphore(value: 0)
        synth.write(u) { buf in
            lock.lock()
            if let pcm = buf as? AVAudioPCMBuffer {
                if pcm.frameLength > 0 {
                    if format == nil { format = pcm.format }
                    if let copy = copyPCMBuffer(pcm) { buffers.append(copy) }
                }
            } else {
                finished = true
            }
            lock.unlock()
            if finished { done.signal() }
        }

        // write() callbacks are delivered through the main run loop, which the serve loop pumps.
        let t0 = Date()
        var lastCount = -1
        var quietSince = Date()
        while true {
            lock.lock(); let f = finished; let n = buffers.count; lock.unlock()
            if f { break }
            if n != lastCount { lastCount = n; quietSince = Date() }
            if n > 0 && Date().timeIntervalSince(quietSince) > 0.35 { break }
            if Date().timeIntervalSince(t0) > 20 { break }
            if done.wait(timeout: .now() + 0.05) == .success { break }
        }
        lock.lock(); let out = buffers; let fmt = format; lock.unlock()
        guard !out.isEmpty else {
            throw VoiceEngineUnavailable(code: "E_TTS_SYNTH", message: "TTS 没有产出音频：\(text.prefix(30))")
        }
        let frames = out.reduce(0) { $0 + Int($1.frameLength) }
        let duration = fmt.map { Double(frames) / $0.sampleRate } ?? 1.0
        return TTSAudio(buffers: out, format: fmt, durationSec: duration)
    }
}

final class SherpaTTSEngine: TTSEngine {
    let name = "sherpa"
    func synthesize(_ text: String, voice: String?, rate: Float, dryRun: Bool) throws -> TTSAudio {
        throw VoiceEngineUnavailable(code: "E_TTS_NOT_IMPLEMENTED",
                                     message: "--tts sherpa 尚未实现；接口已就绪，换模型是后续独立工作")
    }
}

// ---------------------------------------------------------------- bounded TTS queue

struct TTSClip {
    let responseId: String
    let index: Int
    let text: String
    let audio: TTSAudio
}

final class BoundedTTSQueue: @unchecked Sendable {
    private let capacity: Int
    private let lock = NSLock()
    private var items: [TTSClip] = []
    private(set) var peak = 0
    private(set) var droppedTotal = 0

    init(capacity: Int) { self.capacity = max(1, capacity) }

    /// Drops the oldest clip when full, per voice-architecture §5.1. The caller reports
    /// tts_chunk_dropped explicitly; nothing is silently lost.
    func push(_ clip: TTSClip) -> (dropped: TTSClip?, depth: Int, peak: Int) {
        lock.lock()
        var dropped: TTSClip?
        if items.count >= capacity {
            dropped = items.removeFirst()
            droppedTotal += 1
        }
        items.append(clip)
        peak = max(peak, items.count)
        let depth = items.count
        let p = peak
        lock.unlock()
        return (dropped, depth, p)
    }

    func pop() -> TTSClip? { lock.lock(); defer { lock.unlock() }; return items.isEmpty ? nil : items.removeFirst() }
    func drain() -> [TTSClip] { lock.lock(); let out = items; items.removeAll(); lock.unlock(); return out }
    var depth: Int { lock.lock(); defer { lock.unlock() }; return items.count }
    var peakDepth: Int { lock.lock(); defer { lock.unlock() }; return peak }
    var dropped: Int { lock.lock(); defer { lock.unlock() }; return droppedTotal }
}

// ---------------------------------------------------------------- helper functions

func copyPCMBuffer(_ buf: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(pcmFormat: buf.format, frameCapacity: buf.frameLength) else { return nil }
    copy.frameLength = buf.frameLength
    let src = UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList)
    let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for i in 0..<min(src.count, dst.count) {
        guard let s = src[i].mData, let d = dst[i].mData else { continue }
        memcpy(d, s, Int(src[i].mDataByteSize))
        dst[i].mDataByteSize = src[i].mDataByteSize
    }
    return copy
}

extension AVAudioFile {
    /// AVAudioFile.write is unsafe on the audio tap thread; callers here are worker threads only.
    func writeSilently(_ buffer: AVAudioPCMBuffer) { try? write(from: buffer) }
}

// ---------------------------------------------------------------- bridge

final class ActiveUtterance {
    let id: String
    let auto: Bool
    let autoEndpoint: Bool
    let startedAtFrame: Int
    let window = SpeechWindow()
    var sawSpeech = false
    var ending = false

    init(id: String, auto: Bool, autoEndpoint: Bool, startedAtFrame: Int) {
        self.id = id
        self.auto = auto
        self.autoEndpoint = autoEndpoint
        self.startedAtFrame = startedAtFrame
    }
}

final class TTSResponseState {
    let id: String
    let chunks: Int
    let voice: String?
    let rate: Float
    let dryRun: Bool
    var synthesized = 0
    var played = 0
    var dropped = 0
    var cancelled = false
    var finished = false

    init(id: String, chunks: Int, voice: String?, rate: Float, dryRun: Bool) {
        self.id = id
        self.chunks = chunks
        self.voice = voice
        self.rate = rate
        self.dryRun = dryRun
    }
}

private struct RawMicFrame {
    let buffer: AVAudioPCMBuffer
    let capturedAtMs: Int
    let tMonoNs: UInt64
}

final class ServeBridgeV2: @unchecked Sendable {
    let localeID: String
    let aec: Bool
    let prerollMax: Int
    let asrFormat: AVAudioFormat
    let asrBackend: VoiceBackend
    let ttsBackend: VoiceBackend
    let loc: Locale

    // Serial workers: each pipeline stage owns exactly one queue.
    let work = DispatchQueue(label: "mac_speech.serve.control")
    private let captureQueue = DispatchQueue(label: "mac_speech.serve.capture")
    private let vadQueue = DispatchQueue(label: "mac_speech.serve.vad")
    private let asrQueue = DispatchQueue(label: "mac_speech.serve.asr")
    private let ttsSynthQueue = DispatchQueue(label: "mac_speech.serve.tts.synth")
    private let ttsRenderQueue = DispatchQueue(label: "mac_speech.serve.tts.render")

    let lock = NSLock()
    let frameBus = FrameBus()
    let tapTiming = TapTiming()
    let convertTiming = TapTiming()

    var engine = AVAudioEngine()
    var micFormat: AVAudioFormat?
    var converter: AVAudioConverter?
    var playerNode: AVAudioPlayerNode?
    var lastTapAt = Date()
    var restarting = false
    var watchdog: DispatchSourceTimer?
    var aecConvertReported = false

    // Capture -> frame bus.
    private var rawQueue: [RawMicFrame] = []
    private let rawCapacity: Int
    private let captureWake = DispatchSemaphore(value: 0)
    private var captureStopped = false
    private var captureFrames = 0
    private var captureDrops = 0
    private var nextFrame = 0
    private var convertedFrames = 0
    private var vadFrames = 0
    private var asrFrames = 0
    private var lastTimingEmitFrame = 0

    // VAD worker state. All mutation happens on vadQueue.
    var calibrated = false
    var calibSamples: [Double] = []
    var speechDb: Double
    var silenceDb: Double
    var ambientDbForProbe: Double = -120
    var probeVad: EnergyVAD
    var activeVad: EnergyVAD?
    var activeFloorDb: Double = -80.0
    var preroll: [AudioFrame] = []
    var lastEchoProbeMs = 0
    var autoSeq = 0
    var currentPartial: String?
    var lastFinalText: String?
    var lastFinalAtMs: Int?
    var lastRenderDb: Double = -120

#if WALLY_AUDIO_TEST_HARNESS
    // GH-55: harness playback is the same render path as TTS, so the 100 ms
    // `aec_echo_probe` cadence must run for it too — otherwise ABAB would
    // produce WAVs with no echo measurements and look "finished".
    var harnessRenderActive = false
    var harnessRecording = false
    var harnessMicSamples: [Int16] = []
    var harnessRecordSubscribed = false
#endif

    // ASR worker / utterance lifecycle.
    var active: ActiveUtterance?
    var asrEngine: (any ASREngine)?
    var engineFailed = false
    var autoStarting = false
    var maxItem: DispatchWorkItem?
    var idleItem: DispatchWorkItem?

    // Output pipeline.
    let ttsEngine: any TTSEngine
    let clipQueue: BoundedTTSQueue
    let ttsQueueCapacity: Int
    private let renderWake = DispatchSemaphore(value: 0)
    private var renderStopped = false
    var response: TTSResponseState?
    var synth: AVSpeechSynthesizer?

    // Mute.
    var muted = false

    var dumpFile: AVAudioFile?
    var dumpPath: String?
    var micUID: String?

    init(loc: Locale, localeID: String, asrFormat: AVAudioFormat, aec: Bool,
         speechDb: Double, silenceDb: Double, prerollMax: Int, asrBackend: VoiceBackend,
         ttsBackend: VoiceBackend, ttsQueue: Int) {
        self.loc = loc
        self.localeID = localeID
        self.asrFormat = asrFormat
        self.aec = aec
        self.speechDb = speechDb
        self.silenceDb = silenceDb
        self.prerollMax = prerollMax
        self.asrBackend = asrBackend
        self.ttsBackend = ttsBackend
        self.rawCapacity = max(8, Int(opt("--capture-raw-queue") ?? "64") ?? 64)
        self.probeVad = EnergyVAD(speechDb: speechDb, silenceDb: silenceDb,
                                  minSpeechSec: 0.3, endpointSilenceSec: 0.7)
        let capacity = max(1, ttsQueue)
        if ttsBackend == .system {
            self.ttsEngine = SystemTTSEngine()
        } else {
            self.ttsEngine = SherpaTTSEngine()
        }
        self.ttsQueueCapacity = capacity
        self.clipQueue = BoundedTTSQueue(capacity: capacity)
    }

    // ------------------------------------------------------------ lifecycle

    func start() {
        frameBus.subscribe("vad") { [weak self] frame in
            self?.vadQueue.async { self?.handleVadFrame(frame) }
        }
        frameBus.subscribe("asr") { [weak self] frame in
            self?.asrQueue.async { self?.handleASRFrame(frame) }
        }
        captureQueue.async { [weak self] in self?.captureLoop() }
        ttsRenderQueue.async { [weak self] in self?.renderLoop() }

        let ok = buildEngine()
        var ready: [String: Any] = ["ev": "bridge_ready",
                                    "pid": Int(ProcessInfo.processInfo.processIdentifier),
                                    "locale": loc.identifier, "asr_format": asrFormat.description,
                                    "aec": aec, "engine_started": ok, "preroll": prerollMax,
                                    "asr_engine": asrBackend.rawValue,
                                    "tts_engine": ttsBackend.rawValue,
                                    "tts_queue_capacity": ttsQueueCapacity,
                                    "auto_listen": true,
                                    "ts_mono_ns": monoNs(), "t_ms": ms()]
#if WALLY_AUDIO_TEST_HARNESS
        // Falsification anchor for eval/aec3: a default build omits this field,
        // so a script that sees harness commands answered must not trust them.
        ready["test_harness"] = true
#endif
        emitLine(ready)
        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] n in
                guard let self, (n.object as? AVAudioEngine) === self.engine else { return }
                self.scheduleRestart("config_change")
            }
        let t = DispatchSource.makeTimerSource(queue: work)
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let age = Date().timeIntervalSince(self.lastTapAt)
            let running = self.engine.isRunning
            self.lock.unlock()
            if !running || age > 3.0 { self.scheduleRestart(running ? "tap_stall" : "engine_stopped") }
        }
        t.resume()
        watchdog = t
    }

    func scheduleRestart(_ why: String) {
        lock.lock()
        if restarting { lock.unlock(); return }
        restarting = true
        lock.unlock()
        emitLine(["ev": "engine_restarting", "reason": why, "ts_mono_ns": monoNs(), "t_ms": ms()])
        work.async { [weak self] in
            guard let self else { return }
            let ok = self.buildEngine()
            self.lock.lock(); self.restarting = false; self.lock.unlock()
            emitLine(["ev": "engine_restarted", "reason": why, "ok": ok,
                      "mic_format": self.micFormat?.description ?? "-",
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
    }

    /// Build engine and install a tap that does **only** copy + enqueue.
    @discardableResult
    func buildEngine() -> Bool {
        engine.stop()
        engine = AVAudioEngine()
        if let uid = micUID, let dev = Self.findInputDevice(uid: uid) { bindInputDevice(engine, dev) }
        let input = engine.inputNode
        let player = AVAudioPlayerNode()
        engine.attach(player)
        let out = engine.outputNode
        let outFmt = out.outputFormat(forBus: 0)
        if outFmt.sampleRate > 0 {
            let mixFmt = engine.mainMixerNode.outputFormat(forBus: 0)
            engine.connect(player, to: engine.mainMixerNode, format: mixFmt)
            engine.connect(engine.mainMixerNode, to: out, format: outFmt)
        }
        if aec {
            do {
                try input.setVoiceProcessingEnabled(true)
            } catch {
                emitLine(["ev": "aec_unavailable", "aec": true, "reason": "\(error)",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
            let fmtAfter = input.inputFormat(forBus: 0)
            emitLine(["ev": "aec_format", "aec": true,
                      "format_after_vpio": fmtAfter.description,
                      "sample_rate": fmtAfter.sampleRate, "channels": fmtAfter.channelCount,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
        let fmt = input.inputFormat(forBus: 0)
        let convSource = fmt.channelCount > 1
            ? (AVAudioFormat(commonFormat: fmt.commonFormat, sampleRate: fmt.sampleRate,
                             channels: 1, interleaved: false) ?? fmt)
            : fmt
        guard fmt.sampleRate > 0, let conv = AVAudioConverter(from: convSource, to: asrFormat) else {
            emitLine(["ev": "error", "code": "E_MIC_OPEN",
                      "message": "麦克风格式不可用（\(fmt)）或无法转换到 \(asrFormat)",
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            return false
        }
        lock.lock(); micFormat = fmt; converter = conv; lastTapAt = Date(); lock.unlock()
        input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { [weak self] buf, _ in
            self?.handleTap(buf)
        }
        do { try engine.start() } catch {
            emitLine(["ev": "error", "code": "E_MIC_OPEN", "message": "麦克风启动失败：\(error)",
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            return false
        }
        lock.lock(); playerNode = player; lastTapAt = Date(); lock.unlock()
        return true
    }

    static func findInputDevice(uid: String) -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                               mScope: kAudioObjectPropertyScopeGlobal,
                                               mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                             &addr, 0, nil, &size) == noErr else { return nil }
        let n = Int(size) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: n)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &addr, 0, nil, &size, &ids) == noErr else { return nil }
        for id in ids {
            var uidAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID,
                                                      mScope: kAudioObjectPropertyScopeGlobal,
                                                      mElement: kAudioObjectPropertyElementMain)
            var cfUid: CFString? = nil
            var s = UInt32(MemoryLayout<CFString?>.size)
            if AudioObjectGetPropertyData(id, &uidAddr, 0, nil, &s, &cfUid) == noErr,
               let u = cfUid as String?, u == uid { return id }
        }
        return nil
    }

    func bindInputDevice(_ engine: AVAudioEngine, _ dev: AudioDeviceID) {
        guard let au = engine.inputNode.audioUnit else { return }
        var d = dev
        let st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                      kAudioUnitScope_Global, 0, &d,
                                      UInt32(MemoryLayout<AudioDeviceID>.size))
        emitLine(["ev": "mic_bind", "uid": micUID ?? "-", "device_id": dev,
                  "status": Int(st), "ok": st == noErr, "ts_mono_ns": monoNs(), "t_ms": ms()])
    }

    // ------------------------------------------------------------ capture worker

    /// Audio tap: deep copy + enqueue + timing. No conversion, VAD, ASR or playback here.
    func handleTap(_ buf: AVAudioPCMBuffer) {
        let t0 = DispatchTime.now().uptimeNanoseconds
        guard let copy = copyPCMBuffer(buf) else { return }
        let raw = RawMicFrame(buffer: copy, capturedAtMs: ms(), tMonoNs: monoNs())
        lock.lock()
        lastTapAt = Date()
        captureFrames += 1
        rawQueue.append(raw)
        if rawQueue.count > rawCapacity {
            let overflow = rawQueue.count - rawCapacity
            rawQueue.removeFirst(overflow)
            captureDrops += overflow
        }
        lock.unlock()
        let us = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1000.0
        tapTiming.record(us)
        captureWake.signal()
    }

    private func captureLoop() {
        while true {
            lock.lock(); let stopped = captureStopped; lock.unlock()
            if stopped { return }
            _ = captureWake.wait(timeout: .now() + 0.2)
            while true {
                lock.lock(); let raw = rawQueue.isEmpty ? nil : rawQueue.removeFirst(); lock.unlock()
                guard let raw else { break }
                let t0 = DispatchTime.now().uptimeNanoseconds
                processRaw(raw)
                convertTiming.record(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1000.0)
            }
            maybeEmitTiming()
        }
    }

    private func processRaw(_ raw: RawMicFrame) {
        lock.lock(); let srcFmt = micFormat; let conv = converter; lock.unlock()
        guard let srcFmt, let conv, let out = convert(raw.buffer, srcFmt, conv) else { return }
        if let dumpPath { dumpBuffer(out, path: dumpPath) }
        lock.lock()
        let start = nextFrame
        nextFrame += Int(out.frameLength)
        convertedFrames += 1
        lock.unlock()
        let frame = AudioFrame(buffer: out, startFrame: start, sampleRate: asrFormat.sampleRate,
                               capturedAtMs: raw.capturedAtMs, tMonoNs: raw.tMonoNs)
        frameBus.publish(frame)
    }

    private func maybeEmitTiming() {
        lock.lock()
        let frames = captureFrames
        let should = frames - lastTimingEmitFrame >= 250
        if should { lastTimingEmitFrame = frames }
        let converted = convertedFrames, drops = captureDrops, fed = nextFrame
        lock.unlock()
        guard should else { return }
        var ev = tapTiming.snapshot()
        ev["ev"] = "capture_timing"
        ev["converted_frames"] = converted
        lock.lock(); let vad = vadFrames, asr = asrFrames; lock.unlock()
        ev["vad_frames"] = vad
        ev["asr_frames"] = asr
        ev["capture_drops"] = drops
        ev["fed_frames"] = fed
        let p99 = (ev["p99_ms"] as? Double) ?? 0
        ev["p99_ok"] = p99 < 5.0
        let work = convertTiming.snapshot()
        ev["capture_work_p99_ms"] = work["p99_ms"]
        ev["capture_work_p99_ok"] = ((work["p99_ms"] as? Double) ?? 0) < 5.0
        ev["ts_mono_ns"] = monoNs()
        ev["t_ms"] = ms()
        emitLine(ev)
    }

    func convert(_ buf: AVAudioPCMBuffer, _ srcFormat: AVAudioFormat,
                 _ conv: AVAudioConverter) -> AVAudioPCMBuffer? {
        let source = downmixIfNeeded(buf, srcFormat)
        let ratio = asrFormat.sampleRate / srcFormat.sampleRate
        let cap = AVAudioFrameCount(Double(source.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: asrFormat, frameCapacity: cap) else { return nil }
        var err: NSError?
        var fed = false
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData
            return source
        }
        if aec && !aecConvertReported {
            aecConvertReported = true
            var perChRms: [Double] = []
            if let f = buf.floatChannelData {
                for c in 0..<Int(buf.format.channelCount) {
                    var sq = 0.0
                    for i in 0..<Int(buf.frameLength) { let v = Double(f[c][i]); sq += v * v }
                    perChRms.append(((sq / Double(max(1, Int(buf.frameLength)))).squareRoot() * 100000).rounded() / 100000)
                }
            }
            emitLine(["ev": "aec_convert", "src_format": buf.format.description,
                      "src_ch": Int(buf.format.channelCount), "per_ch_rms": perChRms,
                      "out_frames": Int(out.frameLength), "err": err?.localizedDescription ?? "",
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
        return (err == nil && out.frameLength > 0) ? out : nil
    }

    private func downmixIfNeeded(_ buf: AVAudioPCMBuffer, _ fmt: AVAudioFormat) -> AVAudioPCMBuffer {
        let ch = Int(fmt.channelCount)
        guard ch > 1, let monoFmt = AVAudioFormat(commonFormat: fmt.commonFormat,
                                                  sampleRate: fmt.sampleRate, channels: 1,
                                                  interleaved: false),
              let mono = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: buf.frameLength)
        else { return buf }
        mono.frameLength = buf.frameLength
        let n = Int(buf.frameLength)
        if let src = buf.floatChannelData, let dst = mono.floatChannelData {
            let acc = dst[0]
            for i in 0..<n {
                var s: Float = 0
                for c in 0..<ch { s += src[c][i] }
                acc[i] = s / Float(ch)
            }
        } else if let src = buf.int16ChannelData, let dst = mono.int16ChannelData {
            let acc = dst[0]
            for i in 0..<n {
                var s = 0
                for c in 0..<ch { s += Int(src[c][i]) }
                acc[i] = Int16(clamping: s / ch)
            }
        } else { return buf }
        return mono
    }

    private func dumpBuffer(_ buf: AVAudioPCMBuffer, path: String) {
        if dumpFile == nil {
            let cf = asrFormat.commonFormat
            dumpFile = try? AVAudioFile(forWriting: URL(fileURLWithPath: path),
                                        settings: asrFormat.settings,
                                        commonFormat: cf == .pcmFormatFloat32 ? .pcmFormatFloat32 : .pcmFormatInt16,
                                        interleaved: asrFormat.isInterleaved)
        }
        dumpFile?.writeSilently(buf)
    }

    // ------------------------------------------------------------ VAD worker (side channel)

    private func handleVadFrame(_ frame: AudioFrame) {
        lock.lock(); vadFrames += 1; lock.unlock()
        lock.lock()
        let m = muted
        let activeId = active?.id
        let autoEndpoint = active?.autoEndpoint ?? false
#if WALLY_AUDIO_TEST_HARNESS
        // Harness playback is the production render path, so it must also drive
        // the production echo-probe cadence.
        let speaking = response != nil || harnessRenderActive
#else
        let speaking = response != nil
#endif
        let renderDb = lastRenderDb
        let busy = engineFailed || autoStarting
        lock.unlock()

        // AEC diagnostic: 100ms cadence while there is a render reference; fed_frames makes
        // frame loss auditable. This is a fact, not a decision.
        if speaking {
            let now = ms()
            if now - lastEchoProbeMs >= 100 {
                lastEchoProbeMs = now
                let db = bufferDb(frame.buffer, offset: 0, count: Int(frame.buffer.frameLength))
                var ev: [String: Any] = [
                    "ev": "aec_echo_probe", "db": (db * 10).rounded() / 10,
                    "ambient_db": ambientDbForProbe,
                    "per_ch_db": perChannelDb(frame.buffer),
                    "src_ch": Int(frame.buffer.format.channelCount),
                    "audio_ms": frame.audioMs, "fed_frames": frame.endFrame,
                    "ts_mono_ns": monoNs(), "t_ms": now,
                ]
                if renderDb > -100 {
                    // ERLE estimate: render reference level minus residual mic level.
                    ev["aec_erle_db"] = ((renderDb - db) * 10).rounded() / 10
                    ev["render_db"] = (renderDb * 10).rounded() / 10
                }
                emitLine(ev)
            }
        }

        if !calibrated {
            calibrate(with: frame)
            if activeId != nil { return }
            pushPreroll(frame)
            return
        }

        if activeId != nil && autoEndpoint {
            runUtteranceVAD(frame)
            return
        }

        if activeId == nil && !m && !busy {
            runProbeVAD(frame)
        } else if activeId == nil {
            pushPreroll(frame)
        }
    }

    private func calibrate(with frame: AudioFrame) {
        let db = bufferDb(frame.buffer, offset: 0, count: Int(frame.buffer.frameLength))
        calibSamples.append(db)
        guard calibSamples.count >= 30 else { return }
        let sorted = calibSamples.sorted()
        let median = sorted[sorted.count / 2]
        lock.lock()
        calibrated = true
        if median > -120 {
            let speechOffset = Double(opt("--calib-speech-offset") ?? "8") ?? 8
            let silenceOffset = Double(opt("--calib-silence-offset") ?? "4") ?? 4
            let speechCap = Double(opt("--calib-speech-cap") ?? "-32") ?? -32
            let silenceCap = Double(opt("--calib-silence-cap") ?? "-38") ?? -38
            speechDb = min(max(self.speechDb, median + speechOffset), speechCap)
            silenceDb = min(max(self.silenceDb, median + silenceOffset), silenceCap)
        }
        ambientDbForProbe = median
        let sDb = speechDb, qDb = silenceDb
        lock.unlock()
        probeVad.speechDb = sDb
        probeVad.silenceDb = qDb
        if var vad = activeVad {
            vad.speechDb = sDb
            vad.silenceDb = qDb
            activeVad = vad
        }
        emitLine(["ev": "vad_calibrated", "ambient_db": (median * 10).rounded() / 10,
                  "speech_db": (sDb * 10).rounded() / 10,
                  "silence_db": (qDb * 10).rounded() / 10,
                  "fed_frames": frame.endFrame,
                  "ts_mono_ns": monoNs(), "t_ms": ms()])
    }

    private func runProbeVAD(_ frame: AudioFrame) {
        let sub = max(1, Int(asrFormat.sampleRate * 0.02))
        var i = 0
        let n = Int(frame.buffer.frameLength)
        var started = false
        var startDb: Double = -120
        var startSec: Double = 0
        while i < n && !started {
            let len = min(sub, n - i)
            let db = bufferDb(frame.buffer, offset: i, count: len)
            let tSec = Double(frame.startFrame + i) / asrFormat.sampleRate
            probeVad.speechDb = speechDb
            probeVad.silenceDb = silenceDb
            if case .started = probeVad.push(db: db, tSec: tSec) {
                started = true
                startDb = db
                startSec = tSec
            }
            i += len
        }
        if started {
            let pre = preroll
            preroll.removeAll()
            probeVad = EnergyVAD(speechDb: speechDb, silenceDb: silenceDb,
                                 minSpeechSec: 0.3, endpointSilenceSec: 0.7)
            autoSeq += 1
            let id = "utt-auto-\(autoSeq)"
            // Report the raw VAD fact before opening the round. During playback this is the
            // frame that lets robotd's AudioRuntime decide barge-in vs. echo; the bridge must
            // not decide whether the frame is "allowed".
            lock.lock(); let renderDb = lastRenderDb; lock.unlock()
            var fact: [String: Any] = [
                "ev": "speech_state", "state": "speech", "utterance_id": id,
                "rms_db": (startDb * 10).rounded() / 10,
                "db": (startDb * 10).rounded() / 10,
                "audio_ms": Int(startSec * 1000), "fed_frames": frame.endFrame,
                "ts_mono_ns": monoNs(), "t_ms": ms(),
            ]
            if renderDb > -100 {
                fact["render_db"] = (renderDb * 10).rounded() / 10
                fact["aec_erle_db"] = ((renderDb - startDb) * 10).rounded() / 10
            }
            emitLine(fact)
            lock.lock(); autoStarting = true; lock.unlock()
            work.async { [weak self] in
                Task { await self?.beginUtt(id: id, auto: true, autoEndpoint: true,
                                            endpointMs: 700, minSpeechMs: 300,
                                            maxSeconds: 1800, idleMs: 0, preroll: pre) }
            }
        } else {
            pushPreroll(frame)
        }
    }

    private func runUtteranceVAD(_ frame: AudioFrame) {
        guard var vad = activeVad else { return }
        let sub = max(1, Int(asrFormat.sampleRate * 0.02))
        var i = 0
        let n = Int(frame.buffer.frameLength)
        while i < n {
            let len = min(sub, n - i)
            let db = bufferDb(frame.buffer, offset: i, count: len)
            let tSec = Double(frame.startFrame + i) / asrFormat.sampleRate
            // Track a slow noise floor so a loud room does not keep the VAD "speaking" forever.
            activeFloorDb = (activeFloorDb * 24 + db) / 25
            vad.speechDb = max(speechDb, min(activeFloorDb + 8, -32))
            vad.silenceDb = max(silenceDb, min(activeFloorDb + 4, -38))
            let action = vad.push(db: db, tSec: tSec)
            switch action {
            case .started:
                lock.lock()
                active?.sawSpeech = true
                let id = active?.id ?? ""
                let win = active?.window
                lock.unlock()
                win?.started(Int(tSec * 1000))
                emitLine(["ev": "speech_state", "state": "speech", "utterance_id": id,
                          "rms_db": (db * 10).rounded() / 10, "audio_ms": Int(tSec * 1000),
                          "fed_frames": frame.endFrame, "ts_mono_ns": monoNs(), "t_ms": ms()])
            case .ended(let speechMs, let silenceMs):
                lock.lock(); let id = active?.id ?? ""; let win = active?.window; lock.unlock()
                win?.ended(Int(tSec * 1000))
                emitLine(["ev": "speech_state", "state": "silence", "utterance_id": id,
                          "audio_ms": Int(tSec * 1000), "fed_frames": frame.endFrame,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                emitLine(["ev": "endpoint", "reason": "silence", "utterance_id": id,
                          "speech_ms": speechMs, "silence_ms": silenceMs,
                          "audio_ms": Int(tSec * 1000), "fed_frames": frame.endFrame,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                activeVad = vad
                finish(reason: "silence", id: id)
                return
            case .none:
                break
            }
            i += len
        }
        activeVad = vad
    }

    private func pushPreroll(_ frame: AudioFrame) {
        guard prerollMax > 0 else { return }
        preroll.append(frame)
        if preroll.count > prerollMax { preroll.removeFirst(preroll.count - prerollMax) }
    }

    // ------------------------------------------------------------ ASR worker

    private func handleASRFrame(_ frame: AudioFrame) {
        lock.lock(); asrFrames += 1; lock.unlock()
        lock.lock()
        let eng = asrEngine
        let utt = active
        lock.unlock()
        guard let eng, let utt, !utt.ending, frame.endFrame > utt.startedAtFrame else { return }
        eng.feed(frame)
    }

    // ------------------------------------------------------------ utterance lifecycle

    func listen(_ cmd: [String: Any]) {
        lock.lock(); let busy = active != nil || autoStarting; lock.unlock()
        if busy {
            emitLine(["ev": "error", "code": "E_BUSY", "message": "上一轮听还没结束",
                      "utterance_id": (cmd["utterance_id"] as? String) ?? "",
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            return
        }
        let id = (cmd["utterance_id"] as? String) ?? "utt-\(Int(Date().timeIntervalSince1970 * 1000))"
        let autoEndpoint = (cmd["auto_endpoint"] as? Bool) ?? true
        let endpointMs = (cmd["endpoint_silence_ms"] as? Double) ?? 700
        let minSpeechMs = (cmd["min_speech_ms"] as? Double) ?? 300
        let maxSeconds = (cmd["max_seconds"] as? Double) ?? 300
        let idleMs = (cmd["idle_timeout_ms"] as? Double) ?? 20_000
        vadQueue.async { [weak self] in
            guard let self else { return }
            let pre = self.preroll
            self.preroll.removeAll()
            self.work.async { [weak self] in
                Task { await self?.beginUtt(id: id, auto: false, autoEndpoint: autoEndpoint,
                                            endpointMs: endpointMs, minSpeechMs: minSpeechMs,
                                            maxSeconds: maxSeconds, idleMs: idleMs, preroll: pre) }
            }
        }
    }

    private func beginUtt(id: String, auto: Bool, autoEndpoint: Bool, endpointMs: Double,
                          minSpeechMs: Double, maxSeconds: Double, idleMs: Double,
                          preroll pre: [AudioFrame]) async {
        lock.lock()
        if active != nil {
            autoStarting = false
            lock.unlock(); return
        }
        let startedAt = nextFrame
        lock.unlock()

        let utt = ActiveUtterance(id: id, auto: auto, autoEndpoint: autoEndpoint,
                                  startedAtFrame: startedAt)
        let eng: any ASREngine = asrBackend == .system
            ? SystemASREngine(localeID: localeID) : SherpaASREngine()
        do {
            try await eng.begin(utteranceId: id, format: asrFormat, autoEndpoint: autoEndpoint,
                                window: utt.window) { ev in emitLine(ev) }
        } catch let err as VoiceEngineUnavailable {
            emitLine(["ev": "error", "code": err.code, "message": err.message,
                      "utterance_id": id, "ts_mono_ns": monoNs(), "t_ms": ms()])
            // End the round explicitly so a caller waiting for final does not hang.
            emitLine(["ev": "final", "text": "", "utterance_id": id,
                      "stop_reason": "engine_unavailable", "no_speech": false,
                      "engine_error": err.code, "ts_mono_ns": monoNs(), "t_ms": ms()])
            // A missing engine implementation will not heal on retry; stop auto-starting.
            lock.lock(); engineFailed = true; autoStarting = false; lock.unlock()
            return
        } catch {
            emitLine(["ev": "error", "code": "E_ASR_START", "message": "\(error)",
                      "utterance_id": id, "ts_mono_ns": monoNs(), "t_ms": ms()])
            emitLine(["ev": "final", "text": "", "utterance_id": id,
                      "stop_reason": "engine_unavailable", "no_speech": false,
                      "engine_error": "E_ASR_START", "ts_mono_ns": monoNs(), "t_ms": ms()])
            // Transient system-engine start failures should be retried on the next speech, not
            // disable always-on listening permanently.
            lock.lock(); autoStarting = false; lock.unlock()
            return
        }

        lock.lock()
        active = utt
        asrEngine = eng
        engineFailed = false
        autoStarting = false
        let sDb = speechDb, qDb = silenceDb
        lock.unlock()
        vadQueue.sync {
            self.activeFloorDb = -80.0
            self.activeVad = autoEndpoint
                ? EnergyVAD(speechDb: sDb, silenceDb: qDb,
                            minSpeechSec: minSpeechMs / 1000.0,
                            endpointSilenceSec: endpointMs / 1000.0)
                : nil
        }

        for frame in pre { eng.feed(frame) }
        emitLine(["ev": "ready", "locale": loc.identifier, "source": auto ? "vad" : "mic",
                  "utterance_id": id, "asr_format": asrFormat.description,
                  "asr_engine": asrBackend.rawValue, "auto": auto,
                  "auto_endpoint": autoEndpoint, "endpoint_silence_ms": endpointMs,
                  "min_speech_ms": minSpeechMs, "speech_db": (sDb * 10).rounded() / 10,
                  "silence_db": (qDb * 10).rounded() / 10,
                  "preroll": pre.count, "max_seconds": maxSeconds,
                  "fed_frames": startedAt, "ts_mono_ns": monoNs(), "t_ms": ms()])
        armTimers(id: id, maxSeconds: maxSeconds, idleMs: idleMs)
    }

    private func armTimers(id: String, maxSeconds: Double, idleMs: Double) {
        let maxItem = DispatchWorkItem { [weak self] in self?.finish(reason: "max_seconds", id: id) }
        let idleItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock(); let started = self.active?.sawSpeech ?? false; self.lock.unlock()
            if !started { self.finish(reason: "idle", id: id) }
        }
        lock.lock(); self.maxItem = maxItem; self.idleItem = idleItem; lock.unlock()
        work.asyncAfter(deadline: .now() + maxSeconds, execute: maxItem)
        if idleMs > 0 { work.asyncAfter(deadline: .now() + idleMs / 1000, execute: idleItem) }
    }

    private func cancelTimers() {
        lock.lock(); let a = maxItem, b = idleItem; maxItem = nil; idleItem = nil; lock.unlock()
        a?.cancel(); b?.cancel()
    }

    func finish(reason: String, id: String? = nil) {
        lock.lock()
        guard let utt = active, !utt.ending else { lock.unlock(); return }
        if let id, id != utt.id { lock.unlock(); return }
        utt.ending = true
        active = nil
        let eng = asrEngine
        asrEngine = nil
        lock.unlock()
        cancelTimers()
        Task.detached { [weak self] in
            guard let self else { return }
            let res = await eng?.finish() ?? ASRFinal(text: "", streamed: "", via: "none")
            let noSpeech = utt.autoEndpoint && !utt.sawSpeech
            let text = noSpeech ? "" : res.text
            self.lock.lock()
            self.lastFinalText = text
            self.lastFinalAtMs = Int(monoNs() / 1_000_000)
            self.currentPartial = nil
            let fed = self.nextFrame
            self.lock.unlock()
            emitLine(["ev": "final", "text": text, "utterance_id": utt.id,
                      "stop_reason": reason, "no_speech": noSpeech,
                      "asr_final": res.via, "streamed_text": res.streamed,
                      "fed_frames": fed,
                      "audio_ms": Int(Double(fed) / self.asrFormat.sampleRate * 1000),
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
    }

    // ------------------------------------------------------------ mute / status

    func setMuted(_ m: Bool) {
        lock.lock()
        if muted == m { lock.unlock(); status(); return }
        muted = m
        let cur = active
        lock.unlock()
        if m, let cur { finish(reason: "muted", id: cur.id) }
        emitLine(["ev": "mute", "muted": m, "ts_mono_ns": monoNs(), "t_ms": ms()])
        status()
    }

    // ------------------------------------------------------------ output pipeline

    func speak(_ cmd: [String: Any]) {
        let text = (cmd["text"] as? String) ?? ""
        guard !text.isEmpty else {
            emitLine(["ev": "error", "code": "E_TTS_EMPTY", "message": "speak 需要 text",
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            return
        }
        let responseId = (cmd["response_id"] as? String) ?? "tts-\(Int(Date().timeIntervalSince1970 * 1000))"
        let voiceID = cmd["voice"] as? String
        let rate = Float((cmd["rate"] as? Double) ?? 0.5)
        let dryRun = (cmd["dry_run"] as? Bool) ?? false
        let chunks = splitSentences(text)
        lock.lock()
        let busy = response != nil
        lock.unlock()
        if busy {
            emitLine(["ev": "error", "code": "E_TTS_BUSY", "message": "上一段还没播完",
                      "response_id": responseId, "ts_mono_ns": monoNs(), "t_ms": ms()])
            return
        }
        let state = TTSResponseState(id: responseId, chunks: chunks.count, voice: voiceID,
                                     rate: rate, dryRun: dryRun)
        lock.lock(); response = state; lock.unlock()
        emitLine(["ev": "tts_started", "response_id": responseId,
                  "voice": voiceID ?? (AVSpeechSynthesisVoice(language: "zh-CN")?.identifier ?? "-"),
                  "chars": text.count, "chunks": chunks.count, "dry_run": dryRun,
                  "tts_engine": ttsBackend.rawValue,
                  "ts_mono_ns": monoNs(), "t_ms": ms()])
        if chunks.isEmpty {
            finishResponse(responseId, cancelled: false, reason: "done")
            return
        }
        for (idx, piece) in chunks.enumerated() {
            ttsSynthQueue.async { [weak self] in
                self?.synthesizeChunk(responseId: responseId, index: idx, text: piece,
                                      voice: voiceID, rate: rate, dryRun: dryRun)
            }
        }
        ttsSynthQueue.async { [weak self] in self?.maybeFinishResponse(responseId) }
    }

    private func synthesizeChunk(responseId: String, index: Int, text: String,
                                 voice: String?, rate: Float, dryRun: Bool) {
        lock.lock()
        guard let state = response, state.id == responseId, !state.cancelled else {
            lock.unlock(); return
        }
        lock.unlock()
        do {
            let audio = try ttsEngine.synthesize(text, voice: voice, rate: rate, dryRun: dryRun)
            lock.lock()
            let stillActive = response?.id == responseId && response?.cancelled != true
            lock.unlock()
            guard stillActive else { return }
            let clip = TTSClip(responseId: responseId, index: index, text: text, audio: audio)
            let result = clipQueue.push(clip)
            if let dropped = result.dropped {
                lock.lock()
                if let current = response, current.id == responseId { current.dropped += 1 }
                lock.unlock()
                emitLine(["ev": "tts_chunk_dropped", "response_id": dropped.responseId,
                          "index": dropped.index, "text": dropped.text,
                          "reason": "queue_full", "depth": result.depth, "peak": result.peak,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
            lock.lock()
            if let current = response, current.id == responseId { current.synthesized += 1 }
            lock.unlock()
            emitLine(["ev": "tts_queued", "response_id": responseId, "index": index,
                      "text": text, "depth": result.depth, "peak": result.peak,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            renderWake.signal()
            maybeFinishResponse(responseId)
        } catch let err as VoiceEngineUnavailable {
            emitLine(["ev": "error", "code": err.code, "message": err.message,
                      "response_id": responseId, "index": index,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            finishResponse(responseId, cancelled: true, reason: "engine_unavailable")
        } catch {
            emitLine(["ev": "error", "code": "E_TTS_SYNTH", "message": "\(error)",
                      "response_id": responseId, "index": index,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            finishResponse(responseId, cancelled: true, reason: "synth_error")
        }
    }

    private func renderLoop() {
        while true {
            lock.lock(); let stopped = renderStopped; lock.unlock()
            if stopped { return }
            _ = renderWake.wait(timeout: .now() + 0.2)
            while let clip = clipQueue.pop() {
                render(clip)
            }
            lock.lock(); let rid = response?.id; lock.unlock()
            if let rid { maybeFinishResponse(rid) }
        }
    }

    private func render(_ clip: TTSClip) {
        lock.lock()
        guard let state = response, state.id == clip.responseId, !state.cancelled else {
            lock.unlock(); return
        }
        lock.unlock()
        emitLine(["ev": "tts_chunk_started", "response_id": clip.responseId, "index": clip.index,
                  "text": clip.text, "ts_mono_ns": monoNs(), "t_ms": ms()])
        if clip.audio.buffers.isEmpty {
            // dry-run: simulate playback while remaining cancellable.
            let end = Date().addingTimeInterval(clip.audio.durationSec)
            while Date() < end {
                lock.lock(); let gone = response?.id != clip.responseId || response?.cancelled == true
                lock.unlock()
                if gone { return }
                Thread.sleep(forTimeInterval: 0.02)
            }
        } else if let db = referenceDb(clip.audio.buffers) {
            lock.lock(); lastRenderDb = db; lock.unlock()
            playBuffers(clip.audio.buffers, text: clip.text, responseId: clip.responseId)
        }
        lock.lock()
        let cancelled = response?.id != clip.responseId || response?.cancelled == true
        if !cancelled, let current = response { current.played += 1 }
        let played = response?.played ?? 0
        let depth = clipQueue.depth, peak = clipQueue.peakDepth
        lock.unlock()
        guard !cancelled else { return }
        emitLine(["ev": "tts_chunk_finished", "response_id": clip.responseId, "index": clip.index,
                  "played": played, "depth": depth, "peak": peak,
                  "ts_mono_ns": monoNs(), "t_ms": ms()])
        emitLine(["ev": "tts_played", "response_id": clip.responseId, "index": clip.index,
                  "played": played, "depth": depth, "peak": peak,
                  "ts_mono_ns": monoNs(), "t_ms": ms()])
        maybeFinishResponse(clip.responseId)
    }

    private func referenceDb(_ bufs: [AVAudioPCMBuffer]) -> Double? {
        var sum = 0.0
        var count = 0
        for b in bufs {
            if let f = b.floatChannelData {
                let p = f[0]
                for i in 0..<Int(b.frameLength) { let v = Double(p[i]); sum += v * v; count += 1 }
            } else if let s = b.int16ChannelData {
                let p = s[0]
                for i in 0..<Int(b.frameLength) { let v = Double(p[i]) / 32768.0; sum += v * v; count += 1 }
            }
        }
        guard count > 0 else { return nil }
        let rms = (sum / Double(count)).squareRoot()
        return rms > 1e-7 ? 20 * log10(rms) : nil
    }

    /// Convert already-rendered PCM to the mixer/playerNode format.
    private func buffersForMixer(_ bufs: [AVAudioPCMBuffer],
                                 _ mixFmt: AVAudioFormat) -> [AVAudioPCMBuffer] {
        guard let first = bufs.first else { return [] }
        if mixFmt.channelCount == first.format.channelCount,
           mixFmt.sampleRate == first.format.sampleRate {
            return bufs
        }
        guard let conv = AVAudioConverter(from: first.format, to: mixFmt) else { return [] }
        var playBufs: [AVAudioPCMBuffer] = []
        for b in bufs {
            let cap = AVAudioFrameCount(Double(b.frameLength) * mixFmt.sampleRate / b.format.sampleRate) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: mixFmt, frameCapacity: cap) else { continue }
            var used = false
            var convErr: NSError?
            conv.convert(to: out, error: &convErr) { _, status in
                if used { status.pointee = .noDataNow; return nil }
                used = true; status.pointee = .haveData
                return b
            }
            if convErr == nil { playBufs.append(out) }
        }
        return playBufs
    }

    /// The one playback path. Production TTS and the GH-55 test harness both
    /// schedule here, on the node attached to this bridge's AVAudioEngine, so a
    /// measured echo is the production render path's echo.
    private func scheduleOnPlayerNode(_ bufs: [AVAudioPCMBuffer])
        -> (player: AVAudioPlayerNode, seconds: Double)? {
        lock.lock(); let engine = self.engine; let player = playerNode; lock.unlock()
        guard let player, engine.isRunning else { return nil }
        let mixFmt = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.connect(player, to: engine.mainMixerNode, format: mixFmt)
        let playBufs = buffersForMixer(bufs, mixFmt)
        guard !playBufs.isEmpty else { return nil }
        player.stop()
        player.play()
        for b in playBufs { player.scheduleBuffer(b, at: nil, options: [], completionHandler: nil) }
        let seconds = Double(playBufs.reduce(0) { $0 + Int64($1.frameLength) }) / mixFmt.sampleRate
        return (player, seconds)
    }

    /// Schedule pre-synthesized PCM on the engine's playerNode so AEC sees the render reference.
    private func playBuffers(_ bufs: [AVAudioPCMBuffer], text: String, responseId: String) {
        guard let scheduled = scheduleOnPlayerNode(bufs) else {
            // Engine rebuilding: fall back to system synthesis so speech still leaves the robot.
            let synth = AVSpeechSynthesizer()
            lock.lock(); self.synth = synth; lock.unlock()
            let u = AVSpeechUtterance(string: text)
            synth.speak(u)
            var spoke = false
            let end = Date().addingTimeInterval(1.0)
            while Date() < end {
                if synth.isSpeaking { spoke = true }
                if spoke && !synth.isSpeaking { break }
                lock.lock(); let gone = response?.id != responseId || response?.cancelled == true
                lock.unlock()
                if gone { synth.stopSpeaking(at: .immediate); break }
                Thread.sleep(forTimeInterval: 0.02)
            }
            return
        }
        let player = scheduled.player
        let seconds = scheduled.seconds
        let deadline = Date().addingTimeInterval(seconds + 1.0)
        while Date() < deadline {
            lock.lock(); let gone = response?.id != responseId || response?.cancelled == true
            lock.unlock()
            if gone { player.stop(); return }
            if !player.isPlaying && Date() > deadline.addingTimeInterval(-seconds * 0.9) { break }
            Thread.sleep(forTimeInterval: 0.02)
        }
    }

    private func maybeFinishResponse(_ responseId: String) {
        lock.lock()
        guard let state = response, state.id == responseId, !state.finished else { lock.unlock(); return }
        let done = state.synthesized >= state.chunks && state.played + state.dropped >= state.chunks
            && clipQueue.depth == 0 && !state.cancelled
        lock.unlock()
        if done { finishResponse(responseId, cancelled: false, reason: "done") }
    }

    private func finishResponse(_ responseId: String, cancelled: Bool, reason: String) {
        lock.lock()
        guard let state = response, state.id == responseId, !state.finished else { lock.unlock(); return }
        state.finished = true
        state.cancelled = state.cancelled || cancelled
        response = nil
        let played = state.played, dropped = state.dropped, chunks = state.chunks
        let synth = self.synth
        self.synth = nil
        let player = playerNode
        lock.unlock()
        synth?.stopSpeaking(at: .immediate)
        player?.stop()
        let remaining = clipQueue.drain()
        for clip in remaining {
            emitLine(["ev": "tts_chunk_dropped", "response_id": clip.responseId,
                      "index": clip.index, "text": clip.text,
                      "reason": cancelled ? "cancelled" : "queue_full",
                      "depth": 0, "peak": clipQueue.peakDepth,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
        if cancelled {
            emitLine(["ev": "tts_cancelled", "response_id": responseId, "reason": reason,
                      "chunks": chunks, "played": played, "dropped": dropped,
                      "peak": clipQueue.peakDepth, "ts_mono_ns": monoNs(), "t_ms": ms()])
        } else {
            emitLine(["ev": "tts_finished", "response_id": responseId, "stop_reason": reason,
                      "chunks": chunks, "played": played, "dropped": dropped,
                      "peak": clipQueue.peakDepth, "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
        renderWake.signal()
    }

    func stopSpeak() {
        lock.lock(); let rid = response?.id; lock.unlock()
        guard let rid else {
            emitLine(["ev": "tts_cancelled", "response_id": "current", "reason": "stop_speak",
                      "had_playback": false, "ts_mono_ns": monoNs(), "t_ms": ms()])
            return
        }
        finishResponse(rid, cancelled: true, reason: "stop_speak")
    }

#if WALLY_AUDIO_TEST_HARNESS
    // ------------------------------------------------------------ test-only WAV harness (GH-55)
    //
    // Compiled in only with `-D WALLY_AUDIO_TEST_HARNESS` (build script:
    // `WALLY_AUDIO_TEST_HARNESS=1 sh scripts/build_audio_bridge.sh`). A default
    // build does not contain these commands at all: classifyServeCommand
    // returns nil and the bridge answers E_CMD_UNKNOWN.
    //
    // Both commands schedule through `scheduleOnPlayerNode`, i.e. the same
    // ServeBridgeV2 / AVAudioEngine / playerNode graph as `speak`, and playback
    // sets `harnessRenderActive` so the production 100 ms `aec_echo_probe`
    // cadence runs. A separate playback path would measure a different echo
    // than production and make ABAB results non-transferable.

    /// Read a WAV into decoded PCM buffers.
    private func readWavBuffers(_ path: String) -> [AVAudioPCMBuffer]? {
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else { return nil }
        let fmt = file.processingFormat
        let frames = AVAudioFrameCount(file.length)
        guard frames > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames),
              (try? file.read(into: buf)) != nil, buf.frameLength > 0 else { return nil }
        return [buf]
    }

    /// Down-mix and resample any PCM buffer to 16 kHz mono Int16.
    ///
    /// Linear interpolation on purpose: `AVAudioConverter`'s push mode stalls
    /// when only one input buffer is supplied (the old `record` command hit
    /// this and produced header-only WAVs).
    static func pcm16Mono16k(_ buf: AVAudioPCMBuffer) -> [Int16] {
        let inFrames = Int(buf.frameLength)
        let srcRate = buf.format.sampleRate
        let srcCh = max(1, Int(buf.format.channelCount))
        guard inFrames > 0, srcRate > 0 else { return [] }
        let outFrames = max(1, Int(Double(inFrames) * 16_000.0 / srcRate))
        var out = [Int16](repeating: 0, count: outFrames)
        let ratio = srcRate / 16_000.0
        if let f = buf.floatChannelData {
            for i in 0..<outFrames {
                let pos = Double(i) * ratio
                let i0 = min(Int(pos), inFrames - 1), i1 = min(i0 + 1, inFrames - 1)
                let frac = Float(pos - Double(i0))
                var acc: Float = 0
                for c in 0..<srcCh { acc += f[c][i0] * (1 - frac) + f[c][i1] * frac }
                acc /= Float(srcCh)
                out[i] = Int16(max(-32768, min(32767, acc * 32767)))
            }
        } else if let s = buf.int16ChannelData {
            for i in 0..<outFrames {
                let pos = Double(i) * ratio
                let i0 = min(Int(pos), inFrames - 1), i1 = min(i0 + 1, inFrames - 1)
                let frac = Float(pos - Double(i0))
                var acc: Float = 0
                for c in 0..<srcCh {
                    acc += Float(s[c][i0]) * (1 - frac) + Float(s[c][i1]) * frac
                }
                acc /= Float(srcCh)
                out[i] = Int16(max(-32768, min(32767, acc)))
            }
        } else {
            return []
        }
        return out
    }

    /// Write 16 kHz mono PCM16 WAV. Returns false instead of throwing so the
    /// event can carry the failure.
    static func writeWav16(_ samples: [Int16], to path: String) -> Bool {
        guard !samples.isEmpty else { return false }
        var data = Data()
        func put32(_ v: UInt32) {
            var x = v.littleEndian
            withUnsafeBytes(of: &x) { data.append(contentsOf: $0) }
        }
        func put16(_ v: UInt16) {
            var x = v.littleEndian
            withUnsafeBytes(of: &x) { data.append(contentsOf: $0) }
        }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8))
        put32(36 + bytes)
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        put32(16)
        put16(1)                 // PCM
        put16(1)                 // mono
        put32(16_000)
        put32(16_000 * 2)        // byte rate
        put16(2)                 // block align
        put16(16)                // bits per sample
        data.append(contentsOf: Array("data".utf8))
        put32(bytes)
        var le = samples.map { $0.littleEndian }
        le.withUnsafeBufferPointer { data.append(Data(bytes: $0.baseAddress!, count: $0.count * 2)) }
        return (try? data.write(to: URL(fileURLWithPath: path))) != nil
    }

    /// Append captured mic frames while `harnessRecording` is set. Called from
    /// the capture worker; only memory copies happen here (never disk I/O).
    private func harnessMicFrame(_ frame: AudioFrame) {
        lock.lock(); let rec = harnessRecording; lock.unlock()
        guard rec else { return }
        let samples = Self.pcm16Mono16k(frame.buffer)
        guard !samples.isEmpty else { return }
        lock.lock(); harnessMicSamples.append(contentsOf: samples); lock.unlock()
    }

    private func beginHarnessRender() {
        lock.lock(); harnessRenderActive = true; lock.unlock()
    }

    private func endHarnessRender() {
        lock.lock(); harnessRenderActive = false; lock.unlock()
    }

    /// `{"cmd":"harness_play_wav","path":"…/aec_probe.wav"}`
    func harnessPlayWav(_ cmd: [String: Any]) {
        guard let path = cmd["path"] as? String else {
            emitLine(["ev": "error", "code": "E_ARGS", "message": "harness_play_wav 需要 path",
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            return
        }
        work.async { [weak self] in
            guard let self else { return }
            guard let buffers = self.readWavBuffers(path) else {
                emitLine(["ev": "error", "code": "E_FILE", "message": "读不到或解码失败：\(path)",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            let frames = buffers.reduce(0) { $0 + Int($1.frameLength) }
            let rate = buffers[0].format.sampleRate
            guard rate > 0 else {
                emitLine(["ev": "error", "code": "E_FILE", "message": "测试音采样率无效：\(path)",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            if let db = self.referenceDb(buffers) {
                self.lock.lock(); self.lastRenderDb = db; self.lock.unlock()
            }
            emitLine(["ev": "play_started", "path": path, "frames": frames,
                      "format": buffers[0].format.description,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            self.beginHarnessRender()
            guard let scheduled = self.scheduleOnPlayerNode(buffers) else {
                self.endHarnessRender()
                emitLine(["ev": "error", "code": "E_NO_PLAYER",
                          "message": "playerNode 不可用（engine 未运行）",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            // 0.5 s tail so residual echo is captured as well.
            Thread.sleep(forTimeInterval: scheduled.seconds + 0.5)
            self.endHarnessRender()
            emitLine(["ev": "play_finished", "path": path, "frames": frames,
                      "seconds": (Double(frames) / rate * 1000).rounded() / 1000,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
    }

    /// `{"cmd":"harness_record_pair","dir":"…","path":"…/aec_probe.wav"}`
    ///
    /// Plays the WAV through the production playerNode and records
    /// `<dir>/ref.wav` (the test WAV's PCM, down-mixed/resampled to 16 kHz mono
    /// on the same timebase as the AEC model) plus `<dir>/mic.wav` (the capture
    /// pipeline's frames).
    func harnessRecordPair(_ cmd: [String: Any]) {
        guard let dir = cmd["dir"] as? String, let path = cmd["path"] as? String else {
            emitLine(["ev": "error", "code": "E_ARGS", "message": "harness_record_pair 需要 dir 与 path",
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            return
        }
        work.async { [weak self] in
            guard let self else { return }
            guard let buffers = self.readWavBuffers(path) else {
                emitLine(["ev": "error", "code": "E_FILE", "message": "读不到或解码失败：\(path)",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            var ref: [Int16] = []
            for b in buffers { ref.append(contentsOf: Self.pcm16Mono16k(b)) }
            guard !ref.isEmpty else {
                emitLine(["ev": "error", "code": "E_FILE", "message": "测试音没有可用的 PCM 样本",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            emitLine(["ev": "record_read", "dir": dir, "path": path,
                      "src_format": buffers[0].format.description,
                      "ref_samples": ref.count, "ts_mono_ns": monoNs(), "t_ms": ms()])

            self.lock.lock()
            self.harnessMicSamples.removeAll(keepingCapacity: true)
            self.harnessRecording = true
            let subscribe = !self.harnessRecordSubscribed
            self.harnessRecordSubscribed = true
            self.lock.unlock()
            if subscribe {
                self.frameBus.subscribe("test-harness-record") { [weak self] frame in
                    self?.harnessMicFrame(frame)
                }
            }
            emitLine(["ev": "record_started", "dir": dir, "ts_mono_ns": monoNs(), "t_ms": ms()])

            self.beginHarnessRender()
            guard let scheduled = self.scheduleOnPlayerNode(buffers) else {
                self.endHarnessRender()
                self.lock.lock(); self.harnessRecording = false; self.lock.unlock()
                emitLine(["ev": "error", "code": "E_NO_PLAYER",
                          "message": "playerNode 不可用（engine 未运行）",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            if let db = self.referenceDb(buffers) {
                self.lock.lock(); self.lastRenderDb = db; self.lock.unlock()
            }
            emitLine(["ev": "record_scheduled", "dir": dir,
                      "seconds": (scheduled.seconds * 1000).rounded() / 1000,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            // Play length + 1.5 s tail so the mic file also carries decay.
            Thread.sleep(forTimeInterval: scheduled.seconds + 1.5)
            self.endHarnessRender()
            self.lock.lock()
            self.harnessRecording = false
            let mic = self.harnessMicSamples
            self.harnessMicSamples.removeAll(keepingCapacity: false)
            self.lock.unlock()

            let okRef = Self.writeWav16(ref, to: dir + "/ref.wav")
            let okMic = Self.writeWav16(mic, to: dir + "/mic.wav")
            emitLine(["ev": "record_finished", "dir": dir, "ref_samples": ref.count,
                      "mic_samples": mic.count, "ref_ok": okRef, "mic_ok": okMic,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
    }
#endif

    // ------------------------------------------------------------ status / shutdown

    func status() {
        lock.lock()
        let age = Date().timeIntervalSince(lastTapAt)
        let running = engine.isRunning
        let listening = active?.id
        let cal = calibrated
        let sDb = speechDb, qDb = silenceDb
        let speaking = response?.id
        let mic = micFormat?.description ?? "-"
        let m = muted, partial = currentPartial
        let lastText = lastFinalText, lastAt = lastFinalAtMs
        let captured = captureFrames, fed = nextFrame, drops = captureDrops
        let vad = vadFrames, asr = asrFrames
        lock.unlock()
        var out: [String: Any] = ["ev": "status", "engine_running": running,
                                  "tap_age_ms": Int(age * 1000), "calibrated": cal,
                                  "speech_db": (sDb * 10).rounded() / 10,
                                  "silence_db": (qDb * 10).rounded() / 10,
                                  "mic_format": mic, "muted": m, "mode": "always_on",
                                  "asr_engine": asrBackend.rawValue,
                                  "tts_engine": ttsBackend.rawValue,
                                  "capture_frames": captured, "fed_frames": fed,
                                  "vad_frames": vad, "asr_frames": asr,
                                  "capture_drops": drops,
                                  "tts_queue_depth": clipQueue.depth,
                                  "tts_queue_peak": clipQueue.peakDepth,
                                  "tts_dropped": clipQueue.dropped,
                                  "ts_mono_ns": monoNs(), "t_ms": ms()]
        if let listening { out["listening"] = listening }
        if let speaking { out["speaking"] = speaking }
        if let partial { out["current_partial"] = partial }
        if let lastText { out["last_final"] = lastText }
        if let lastAt { out["last_final_at_ms"] = lastAt }
        let timing = tapTiming.snapshot()
        out["tap_p99_ms"] = timing["p99_ms"]
        out["tap_p50_ms"] = timing["p50_ms"]
        out["tap_max_ms"] = timing["max_ms"]
        out["capture_work_p99_ms"] = convertTiming.snapshot()["p99_ms"]
        emitLine(out)
    }

    func shutdown() {
        lock.lock()
        let u = active
        active = nil
        asrEngine = nil
        let synth = self.synth
        let rid = response?.id
        captureStopped = true
        renderStopped = true
        lock.unlock()
        synth?.stopSpeaking(at: .immediate)
        if let rid { finishResponse(rid, cancelled: true, reason: "bridge_shutdown") }
        if let u { _ = u.id }
        engine.stop()
        watchdog?.cancel()
        captureWake.signal()
        renderWake.signal()
        emitLine(["ev": "bridge_bye", "ts_mono_ns": monoNs(), "t_ms": ms()])
    }
}

// ---------------------------------------------------------------- serve entry point

func runServeBridgeMode() async {
    guard #available(macOS 26.0, *) else { fail("E_ASR_OS", "常驻语音桥需要 macOS 26+", 2) }
    if micAuth() != "authorized" {
        fail("E_MIC_PERM", "麦克风授权=\(micAuth())（未授权时录到的是空音频）；"
            + "先去 系统设置 → 隐私与安全性 → 麦克风 打开承载进程的 App", 4)
    }

    let asrRaw = (opt("--asr") ?? "system").lowercased()
    let ttsRaw = (opt("--tts") ?? "system").lowercased()
    guard let asrBackend = VoiceBackend(rawValue: asrRaw) else {
        fail("E_ARGS", "--asr 只支持 system|sherpa（收到 \(asrRaw)）", 3)
    }
    guard let ttsBackend = VoiceBackend(rawValue: ttsRaw) else {
        fail("E_ARGS", "--tts 只支持 system|sherpa（收到 \(ttsRaw)）", 3)
    }

    var speechDb0 = -36.0
    var silenceDb0 = -42.0
    switch (opt("--sensitivity") ?? "medium").lowercased() {
    case "low":  speechDb0 = -30.0; silenceDb0 = -36.0
    case "high": speechDb0 = -42.0; silenceDb0 = -48.0
    default:     speechDb0 = -36.0; silenceDb0 = -42.0
    }
    speechDb0 = Double(opt("--speech-db") ?? "\(speechDb0)") ?? speechDb0
    silenceDb0 = Double(opt("--silence-db") ?? "\(silenceDb0)") ?? silenceDb0

    let sLocaleID = opt("--locale") ?? "zh_CN"
    let sAsked = Locale(identifier: sLocaleID)
    let sProbe = SpeechTranscriber(locale: sAsked, transcriptionOptions: [],
                                   reportingOptions: [.volatileResults, .fastResults],
                                   attributeOptions: [.audioTimeRange])
    guard let sFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [sProbe]) else {
        fail("E_ASR_FORMAT", "拿不到 ASR 需要的音频格式", 2)
    }
    var sFormatFinal = sFormat
    if (opt("--asr-fmt") ?? "auto") == "float32",
       let f32 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sFormat.sampleRate,
                               channels: 1, interleaved: false) {
        sFormatFinal = f32
    }

    let ttsQueue = Int(opt("--tts-queue") ?? "8") ?? 8
    let bridge = ServeBridgeV2(loc: sAsked, localeID: sLocaleID, asrFormat: sFormatFinal,
                               aec: argv.contains("--aec"), speechDb: speechDb0,
                               silenceDb: silenceDb0,
                               prerollMax: Int(opt("--preroll-buffers") ?? "5") ?? 5,
                               asrBackend: asrBackend, ttsBackend: ttsBackend,
                               ttsQueue: ttsQueue)
    bridge.dumpPath = opt("--dump-pcm")
    bridge.micUID = opt("--mic-uid")
    bridge.start()

    // Command surface is intentionally small: listen / stop / speak / stop_speak plus mute,
    // unmute, status and quit. Diagnostic play/record entry points are not production
    // commands, and the GH-55 test harness is compiled in only with
    // `-D WALLY_AUDIO_TEST_HARNESS` (see classifyServeCommand in mac_speech.swift).
    DispatchQueue.global().async {
        while let line = readLine(strippingNewline: true) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            guard let d = t.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
                emitLine(["ev": "error", "code": "E_CMD_JSON",
                          "message": "命令不是 JSON：\(t.prefix(80))",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                continue
            }
            guard let command = classifyServeCommand((obj["cmd"] as? String) ?? "") else {
                emitLine(["ev": "error", "code": "E_CMD_UNKNOWN",
                          "message": "不认识的命令：\(obj["cmd"] ?? "-")",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                continue
            }
            switch command {
            case .listen:     bridge.listen(obj)
            case .stop:       bridge.finish(reason: (obj["reason"] as? String) ?? "stdin")
            case .mute:       bridge.setMuted(true)
            case .unmute:     bridge.setMuted(false)
            case .speak:      bridge.speak(obj)
            case .stopSpeak:  bridge.stopSpeak()
            case .status:     bridge.status()
            case .quit:       bridge.shutdown(); exit(0)
#if WALLY_AUDIO_TEST_HARNESS
            case .harnessPlayWav:    bridge.harnessPlayWav(obj)
            case .harnessRecordPair: bridge.harnessRecordPair(obj)
#endif
            }
        }
        bridge.shutdown()
        exit(0)
    }

    // Main run loop is needed by AVSpeechSynthesizer.write callbacks.
    let onMain = Thread.isMainThread
    emitLine(["ev": "serve_loop_start", "is_main_thread": onMain,
              "thread": Thread.current.name ?? "-", "ts_mono_ns": monoNs(), "t_ms": ms()])
    while true {
        if onMain {
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        } else {
            DispatchQueue.main.async { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }
}



