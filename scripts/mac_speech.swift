// mac_speech —— 语音原生桥（ASR / TTS，全走 macOS 系统能力，不引模型）
//
// 对应 architecture.md §6.4 那张图里的 `mac_speech`；与 `uvc_capture.swift`
// 同一套契约：**stdout 恰好一行 JSON**（`{"ok":true,"data":{...}}`），诊断一律走 stderr。
//
// 选型依据（model-selection §0.1/§0.2，已实测）：ASR = SpeechAnalyzer + SpeechTranscriber
// （zh_CN 资产已装、5s 音频 0.15s）、TTS = AVSpeechSynthesizer（19 个中文音色）。
// **不做多 provider / 回退**——SFSpeechRecognizer / whisper.cpp / Kokoro 都不接。
//
// 用法：
//   swift <wallyd-root>/scripts/mac_speech.swift list
//   swift <wallyd-root>/scripts/mac_speech.swift transcribe --record 5 --locale zh_CN
//   swift <wallyd-root>/scripts/mac_speech.swift transcribe --file /tmp/a.caf
//   swift <wallyd-root>/scripts/mac_speech.swift stream [--locale zh_CN] [--max-seconds 300]
//        [--auto-endpoint] [--endpoint-silence-ms 700] [--min-speech-ms 300] [--sensitivity low|medium|high]
//   swift <wallyd-root>/scripts/mac_speech.swift speak --text "你好" [--voice <identifier>] [--rate 0.5]
//   swift <wallyd-root>/scripts/mac_speech.swift request-permission      # 触发麦克风授权
//
// 退出码：0 成功；2 无设备/无能力；3 参数错；4 没权限；5 录制或转写失败；6 超时
//
// ⚠ **`stream` 是这条契约的唯一例外**：别的模式 stdout 恰好一行 JSON；stream 模式吐 **NDJSON**
//   （每行一个事件），因为要"边说边出字"：
//     {"ev":"ready",...} → 反复 {"ev":"partial","text":...}（volatile）→ {"ev":"final","text":...}
//   停止方式：**stdin 收到一行 "stop" 或 EOF**（robotd 关掉管道即可），或到 --max-seconds。
//   开了 --auto-endpoint 后还会吐：{"ev":"speech_state","state":"speech|silence"} 与
//   {"ev":"endpoint","reason":"silence",...}——**说完自动收尾**（用系统 SpeechDetector 判的静音。
//   注意"静音"要发生在**已经说过话之后**才触发；纯静音永远不会自动停，免得刚开始就结束）。
//
// 两个坑（与相机同源）：
//   ① **未授权麦克风时是个"静音陷阱"**：TCC 没给权限时录音不报错，只是录到全零/极短数据，
//      转写结果为空——所以 `list` 会打印 `microphone_authorization`，出错时也带出来；
//   ② 系统能力**必须在非沙箱进程里调**（受限沙箱里 supportedLocales 会返回 0，见 §6.4 的警告）。
import Foundation
import AVFAudio
import AVFoundation
import Speech

// ---------------------------------------------------------------- 输出契约
func emitJSON(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]))
        ?? Data(#"{"ok":false,"error":{"code":"E_AUDIO_INTERNAL","message":"json encode failed"}}"#.utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String, _ message: String, _ exitCode: Int32) -> Never {
    emitJSON(["ok": false, "error": ["code": code, "message": message]])
    FileHandle.standardError.write(Data("[mac_speech] \(message)\n".utf8))
    exit(exitCode)
}

// stream 模式用：NDJSON，一行一个事件。多线程写 stdout，加锁避免串行错位。
let emitLock = NSLock()
func emitLine(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    emitLock.lock()
    FileHandle.standardOutput.write(d)
    FileHandle.standardOutput.write(Data("\n".utf8))
    emitLock.unlock()
}

func opt(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

func micAuth() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

let argv = CommandLine.arguments
let mode: String = {
    if argv.contains("list") || argv.contains("--list") { return "list" }
    if argv.contains("vad-selftest") { return "vad-selftest" }
    if argv.contains("split-selftest") { return "split-selftest" }
    if argv.contains("serve") { return "serve" }
    if argv.contains("speak-stream") { return "speak-stream" }
    if argv.contains("transcribe") { return "transcribe" }
    if argv.contains("stream") { return "stream" }
    if argv.contains("speak") { return "speak" }
    if argv.contains("request-permission") || argv.contains("--request-permission") { return "request-permission" }
    return ""
}()
let t0 = Date()
let ms = { Int(Date().timeIntervalSince(t0) * 1000) }

// 单调时钟（纳秒）：音频 / 文本 / 说话人 / 视觉对齐只用它，墙钟只做展示。
let monoBase = DispatchTime.now().uptimeNanoseconds
func monoNs() -> UInt64 { DispatchTime.now().uptimeNanoseconds &- monoBase }

/// 一段 PCM 的 RMS（dBFS）。支持 float32 / int16，两种 ASR 输入格式都覆盖。
func bufferDb(_ buf: AVAudioPCMBuffer, offset: Int, count: Int) -> Double {
    guard count > 0 else { return -120 }
    var sum = 0.0
    if let f = buf.floatChannelData {
        let p = f[0]
        var i = offset
        while i < offset + count { let v = Double(p[i]); sum += v * v; i += 1 }
    } else if let s = buf.int16ChannelData {
        let p = s[0]
        var i = offset
        while i < offset + count { let v = Double(p[i]) / 32768.0; sum += v * v; i += 1 }
    } else {
        return -120
    }
    let rms = (sum / Double(count)).squareRoot()
    return rms > 1e-7 ? 20 * log10(rms) : -120
}

/// 逐声道 RMS 电平（dBFS）。
/// 用途：小智（xiaozhi-esp32）的 AEC 是**端侧 AFE 用硬件参考声道**做的（`input_format = "MR"`，
/// M=Mic、R=Reference）。VPIO 同样可能给出多声道，其中某个声道是播放参考。
/// 若把全部声道等权混成单声道，等于把参考信号掺进麦克风信号，自己破坏 AEC。
/// 这个探针就是把「哪个声道是什么」测出来，不靠猜。
func perChannelDb(_ buf: AVAudioPCMBuffer) -> [Double] {
    var out: [Double] = []
    let n = Int(buf.frameLength)
    guard n > 0 else { return out }
    for c in 0..<Int(buf.format.channelCount) {
        var sum = 0.0
        if let f = buf.floatChannelData {
            let p = f[c]
            for i in 0..<n { let v = Double(p[i]); sum += v * v }
        } else if let s = buf.int16ChannelData {
            let p = s[c]
            for i in 0..<n { let v = Double(p[i]) / 32768.0; sum += v * v }
        } else {
            out.append(-120); continue
        }
        let rms = (sum / Double(n)).squareRoot()
        out.append(rms > 1e-7 ? ((20 * log10(rms)) * 10).rounded() / 10 : -120)
    }
    return out
}

/// 能量 VAD：把「有人在说 / 说完」从系统 SpeechDetector 里解耦出来。
/// 纯能量门限 + 迟滞 + 最短话长；可在 `vad-selftest` 里用合成电平离线自测（不需要麦克风）。
struct EnergyVAD {
    // 本底校准会按现场噪声抬高这两个门限，所以是 var。
    var speechDb: Double
    var silenceDb: Double
    let minSpeechSec: Double
    let endpointSilenceSec: Double
    /// 起判去抖：连续 N 个 20ms 子帧都过门限才算「开始说话」。
    /// 真机实测：默认 -36dB 门限下，房间噪声（rms≈-34.6）会单帧触发假起点，加去抖后不误判。
    var onsetFrames: Int = 3
    enum Action { case none, started, ended(speech_ms: Int, silence_ms: Int) }
    private(set) var speaking = false
    private var speechSec = 0.0
    private var silenceSec = 0.0
    private var lastSec: Double?
    private var above = 0

    mutating func push(db: Double, tSec: Double) -> Action {
        let dt = lastSec.map { max(0.0, min(0.5, tSec - $0)) } ?? 0.02
        lastSec = tSec
        if !speaking {
            above = db >= speechDb ? above + 1 : 0
            guard above >= max(1, onsetFrames) else { return .none }
            above = 0
            speaking = true; speechSec = dt; silenceSec = 0
            return .started
        }
        if db >= silenceDb {                       // 迟滞：门限之上的微弱声也算还在说
            speechSec += dt; silenceSec = 0
            return .none
        }
        silenceSec += dt
        guard silenceSec >= endpointSilenceSec else { return .none }
        let spoke = speechSec, sil = silenceSec
        speaking = false; speechSec = 0; silenceSec = 0
        guard spoke >= minSpeechSec else { return .none }   // 太短当噪声，不提端点
        return .ended(speech_ms: Int(spoke * 1000), silence_ms: Int(sil * 1000))
    }
}

// ---------------------------------------------------------------- 麦克风授权
if mode == "request-permission" {
    if micAuth() == "authorized" {
        emitJSON(["ok": true, "data": ["microphone_authorization": "authorized", "granted": true]])
        exit(0)
    }
    FileHandle.standardError.write(Data(
        "[mac_speech] 请求麦克风授权：有弹窗就点「允许」；没弹窗就去 系统设置 → 隐私与安全性 → 麦克风 手动打开承载本进程的 App。\n".utf8))
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in granted = ok; sem.signal() }
    if sem.wait(timeout: .now() + 90) == .timedOut {
        fail("E_MIC_PERM_TIMEOUT", "90s 内没等到授权结果（当前=\(micAuth())）", 4)
    }
    emitJSON(["ok": granted, "data": ["microphone_authorization": micAuth(), "granted": granted]])
    exit(granted ? 0 : 4)
}

// ---------------------------------------------------------------- list：设备 / 音色 / ASR 资产
if mode == "list" {
    let dict = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external],
                                                mediaType: .audio, position: .unspecified).devices
    let mics: [[String: Any]] = dict.map { ["name": $0.localizedName, "uniqueID": $0.uniqueID] }

    let allVoices = AVSpeechSynthesisVoice.speechVoices()
    let zhVoices = allVoices.filter { $0.language.hasPrefix("zh") }
    let voices: [[String: Any]] = zhVoices.map {
        ["language": $0.language, "name": $0.name, "identifier": $0.identifier, "quality": $0.quality.rawValue]
    }

    var asr: [String: Any] = [:]
    if #available(macOS 26.0, *) {
        asr["is_available"] = SpeechTranscriber.isAvailable
        asr["supported_locales"] = (await SpeechTranscriber.supportedLocales).map(\.identifier).sorted()
        asr["installed_locales"] = (await SpeechTranscriber.installedLocales).map(\.identifier).sorted()
        let want = Locale(identifier: "zh_CN")
        let loc = await SpeechTranscriber.supportedLocale(equivalentTo: want) ?? want
        let transcriber = SpeechTranscriber(locale: loc, preset: .transcription)
        asr["zh_locale"] = loc.identifier
        asr["zh_asset_status"] = String(describing: await AssetInventory.status(forModules: [transcriber]))
    } else {
        asr["error"] = "需要 macOS 26+"
    }

    emitJSON(["ok": true, "data": [
        "microphone_authorization": micAuth(),
        "microphones": mics,
        "tts": ["voice_count": allVoices.count, "zh_voice_count": zhVoices.count, "zh_voices": voices],
        "asr": asr,
        "elapsed_ms": ms(),
    ]])
    exit(0)
}

// ---------------------------------------------------------------- split-selftest：离线自测分句
// 分句是「说得像人话」的核心，且**与麦克风无关**，所以单独可测：
//   swift scripts/mac_speech.swift split-selftest
// 断言不在这里写死（切法会调），只打印结果，由 Python 侧测试比对。
if mode == "split-selftest" {
    let samples = [
        "你好，我是机器人。语音功能已经接通了。",
        "第一句。第二句。第三句。",
        "海拔 3.5 米，温度 25.6 度。",
        "他说：“走吧！”然后就离开了。",
        "这是一句没有标点的话",
        "短句！问题？感叹；还有省略号……结束。",
        "Line one. Line two ends here.",
        "",
    ]
    for s in samples {
        emitLine(["ev": "split", "text": s, "chunks": splitSentences(s)])
    }
    exit(0)
}

/// 按标点切句。**只在句末标点处切**，逗号不切——切碎了合成出来会一顿一顿。
///
/// 规则与取舍：
/// - 中文句末：。！？；… 与英文 .!?; 都能切；省略号只看最后一个字符。
/// - **不在小数、缩写处切**：判断「`.` 后面是空白或结尾」才切，
///   避免 `3.5 米`、`Mr. Li` 被拆开。
/// - 每句限长 `maxLen`：超长没标点的句子按逗号补切，再不行硬切，
///   否则一句要合成很久，首包延迟就上去了（违背「首字延迟与发言长度无关」）。
func splitSentences(_ text: String, maxLen: Int = 60) -> [String] {
    let terminators: Set<Character> = ["。", "！", "？", "；", "…", "!", "?", ";"]
    // 收尾引号/括号：**吃掉**跟在句末标点后面的这些字符，否则会出现
    // `他说：“走吧！` + `”然后就离开了。` 这种被引号切开的碎片。
    let trailing: Set<Character> = ["”", "\"", "』", "」", "）", ")", "》", "’", "'"]
    var out: [String] = []
    var cur = ""
    let chars = Array(text)
    var i = 0
    while i < chars.count {
        let ch = chars[i]
        if ch == "\n" {
            let t = cur.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { out.append(t) }
            cur = ""
            i += 1
            continue
        }
        cur.append(ch)
        var isEnd = terminators.contains(ch)
        if ch == "." {
            // 英文句点：后面是空白/结尾才算句末，避免拆开小数与缩写
            let next = i + 1 < chars.count ? chars[i + 1] : " "
            isEnd = next.isWhitespace || i + 1 == chars.count
        }
        if isEnd {
            // 连续省略号 / 感叹号（……、！！！）作为**一个**句末处理：往后吃掉同族标点
            var j = i + 1
            if ch == "…" {
                while j < chars.count, chars[j] == "…" { cur.append(chars[j]); j += 1 }
            }
            // 吃掉紧跟的收尾引号/括号（最多两个，兼容 `。”` 与 `』）`）
            var k = 0
            while j < chars.count, trailing.contains(chars[j]), k < 2 {
                cur.append(chars[j]); j += 1; k += 1
            }
            let t = cur.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { out.append(t) }
            cur = ""
            i = j
            continue
        }
        i += 1
    }
    let tail = cur.trimmingCharacters(in: .whitespacesAndNewlines)
    if !tail.isEmpty { out.append(tail) }
    // 超长句按逗号补切；仍超长就硬切（保证首包不被长句拖住）
    var bounded: [String] = []
    for s in out {
        if s.count <= maxLen { bounded.append(s); continue }
        var rest = Substring(s)
        while rest.count > maxLen {
            let window = rest.prefix(maxLen)
            if let cut = window.lastIndex(where: { $0 == "，" || $0 == "," || $0 == "、" }) {
                let piece = rest[rest.startIndex...cut]
                let t = piece.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { bounded.append(t) }
                rest = rest[rest.index(after: cut)...]
                continue
            }
            let piece = rest.prefix(maxLen)
            let t = piece.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { bounded.append(t) }
            rest = rest.dropFirst(maxLen)
        }
        let t = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { bounded.append(t) }
    }
    return bounded.isEmpty ? (text.isEmpty ? [] : [text]) : bounded
}

// ---------------------------------------------------------------- vad-selftest：离线自测端点逻辑
if mode == "vad-selftest" {
    func run(_ db: [Double], dt: Double = 0.02) -> (started: Bool, ended: Bool) {
        var vad = EnergyVAD(speechDb: -36, silenceDb: -42, minSpeechSec: 0.3, endpointSilenceSec: 0.7)
        var t = 0.0, started = false, ended = false
        for d in db {
            switch vad.push(db: d, tSec: t) {
            case .started: started = true
            case .ended: ended = true
            case .none: break
            }
            t += dt
        }
        return (started, ended)
    }
    let silence = Array(repeating: -60.0, count: 50)
    let longSilence = Array(repeating: -60.0, count: 60)
    let speech = Array(repeating: -20.0, count: 100)     // 2.0s
    let blip = Array(repeating: -20.0, count: 5)         // 0.1s（< min-speech）
    let a = run(silence + speech + longSilence)
    let b = run(silence + blip + longSilence)
    let c = run(silence)
    let pass = a.started && a.ended && b.started && !b.ended && !c.started && !c.ended
    emitJSON(["ok": pass, "data": [
        "case_speech_then_silence": ["started": a.started, "ended": a.ended],
        "case_short_blip": ["started": b.started, "ended": b.ended],
        "case_all_silence": ["started": c.started, "ended": c.ended],
        "expected": "说→静音 触发端点；短促噪声不触发；纯静音不触发",
    ]])
    exit(pass ? 0 : 1)
}

// ---------------------------------------------------------------- stream：边说边出字
if mode == "stream" {
    guard #available(macOS 26.0, *) else { fail("E_ASR_OS", "流式转写需要 macOS 26+", 2) }
    if micAuth() != "authorized" {
        fail("E_MIC_PERM", "麦克风授权=\(micAuth())（未授权时录到的是空音频）；先去 系统设置 → 隐私与安全性 → 麦克风 打开承载进程的 App", 4)
    }
    let localeID = opt("--locale") ?? "zh_CN"
    let maxSeconds = Double(opt("--max-seconds") ?? "300") ?? 300
    // 端点检测**默认开**：改用自带能量 VAD，不再把系统 SpeechDetector 放进 analyzer
    // （实测 SpeechDetector 与 SpeechTranscriber 同管线时两边都收不到结果）。--no-auto-endpoint 可关。
    let autoEndpoint = !argv.contains("--no-auto-endpoint")
    let aec = argv.contains("--aec")                              // 输入侧开语音处理（AEC/NS）；需真机验证
    let utteranceId = opt("--utterance") ?? "utt-\(Int(Date().timeIntervalSince1970 * 1000))"
    let filePath = opt("--file")                                  // 离线回归用：和麦克风走同一条管线
    let trace = argv.contains("--trace")                          // 排查用：喂数据/volatile 区间打点
    let endpointSilenceMs = Double(opt("--endpoint-silence-ms") ?? "700") ?? 700
    let minSpeechMs = Double(opt("--min-speech-ms") ?? "300") ?? 300
    // 敏感度 → 能量阈值预设（保留旧参数名，兼容既有调用）
    let sensPreset: (speech: Double, silence: Double) = {
        switch (opt("--sensitivity") ?? "medium").lowercased() {
        case "low":  return (-30.0, -36.0)
        case "high": return (-42.0, -48.0)
        default:     return (-36.0, -42.0)
        }
    }()
    let speechDb = Double(opt("--speech-db") ?? "\(sensPreset.speech)") ?? sensPreset.speech
    let silenceDb = Double(opt("--silence-db") ?? "\(sensPreset.silence)") ?? sensPreset.silence

    let asked = Locale(identifier: localeID)
    let loc = await SpeechTranscriber.supportedLocale(equivalentTo: asked) ?? asked
    // 关键：**必须显式开 `.fastResults`**。只用 `.progressiveTranscription` 预设时，实测中间结果
    // 会攒到输入结束才一次性吐出来（"边说边出字"根本不出来）；.fastResults 才是低延迟上报的开关。
    let streamFast = (opt("--asr-preset") ?? "accurate") == "fast"
    let transcriber = SpeechTranscriber(
        locale: loc,
        transcriptionOptions: [],
        reportingOptions: streamFast ? [.volatileResults, .fastResults] : [.volatileResults],
        attributeOptions: [.audioTimeRange])
    // 只挂 transcriber：端点交给下面的能量 VAD，避免 detector 把整条管线拖哑。
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    // 诊断：volatile 区间变化是否在说话过程中实时发生（判断"没实时处理"还是"没实时上报"）
    if trace { await analyzer.setVolatileRangeChangedHandler { range, s, e in
        emitLine(["ev": "volatile_range", "start": range.start.seconds, "end": range.end.seconds,
                  "changed_start": s, "changed_end": e, "ts_mono_ns": monoNs(), "t_ms": ms()])
    } }
    guard let asrFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        fail("E_ASR_FORMAT", "拿不到 ASR 需要的音频格式", 2)
    }

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    let stopSignal = DispatchSemaphore(value: 0)
    let reasonLock = NSLock()
    var stopReason = "stdin"
    var stopSignalled = false
    func setStopReason(_ r: String) {
        reasonLock.lock()
        stopReason = r
        let already = stopSignalled
        stopSignalled = true
        reasonLock.unlock()
        if !already { stopSignal.signal() }
    }
    func currentStopReason() -> String { reasonLock.lock(); defer { reasonLock.unlock() }; return stopReason }
    var revision = 0
    // partial 门控：只在 VAD 判出的「说话窗口」内上报 volatile 结果。
    // 用**音频时间轴**比对（而不是 wall-clock 布尔），因为文件模式灌数据比实时快得多，
    // 布尔标志会出现「VAD 已结束、ASR 结果才回来」→ 把正常 partial 全挡掉（实测踩过）。
    // 声明在 collector 前面，它要读。
    let vadLock = NSLock()
    var speechStartMs: Int? = nil
    var speechEndMs: Int? = nil
    let gateMarginMs = 300
    // ⚠ 必须是 **detached**：脚本顶层代码是 @MainActor 隔离的，普通 Task 会继承 main actor，
    // 而主流程要阻塞等停止信号 → 消费任务被饿死，结果全攒到结束才吐（实测：118 条 volatile 回调
    // 全挤在最后一刻）。detached 才能真并行。
    let collector = Task.detached { () -> String in
        var settled = ""
        for try await r in transcriber.results {
            let chunk = String(r.text.characters)
            let sMs = Int(r.range.start.seconds * 1000)
            let eMs = Int(r.range.end.seconds * 1000)
            if r.isFinal {
                settled += chunk
                emitLine(["ev": "final_chunk", "text": chunk, "utterance_id": utteranceId,
                          "audio_start_ms": sMs, "audio_end_ms": eMs,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            } else {
                // 只上报落在「说话窗口」内的 volatile 结果：噪声上的元音幻觉（uuu/喂喂喂）不推给上层。
                // autoEndpoint 关掉时没有窗口概念 → 不做门控（保持旧行为）。
                if autoEndpoint {
                    vadLock.lock(); let s0 = speechStartMs, s1 = speechEndMs; vadLock.unlock()
                    guard let start = s0 else { continue }
                    // ⚠ 不能写 `(s1 ?? Int.max) + gateMarginMs`：窗口还没结束（s1 == nil）时
                    // 会变成 Int.max + 300 ⇒ **算术溢出直接 SIGTRAP**（2026-10-16 真机崩溃根因，
                    // 崩溃报告 `Swift runtime failure: arithmetic overflow`）。
                    let hi = s1.map { $0 + gateMarginMs } ?? Int.max
                    guard eMs >= start - gateMarginMs && sMs <= hi else { continue }
                }
                revision += 1
                emitLine(["ev": "partial", "text": settled + chunk, "revision": revision,
                          "utterance_id": utteranceId, "audio_start_ms": sMs, "audio_end_ms": eMs,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
        }
        return settled
    }

    // ---- 端点检测：自带能量 VAD（不依赖系统 SpeechDetector）----
    // 「静音」必须发生在「已经说过话」之后才算说完；太短的语音当噪声丢弃。
    var vad = EnergyVAD(speechDb: speechDb, silenceDb: silenceDb,
                        minSpeechSec: minSpeechMs / 1000.0,
                        endpointSilenceSec: endpointSilenceMs / 1000.0)
    let feedLock = NSLock()
    var fedFrames = 0

    // ---- 本底噪声校准 + partial 门控（2026-10-14 真机修）----
    // 现场实测：房间本底噪声峰值能到 -31dB，而默认说话门限是 -36dB ⇒ VAD 认为"一直在说"、
    // 永不触发端点；低延迟流式 ASR 于是在噪声上吐元音幻觉（`uuuu…`/`喂喂喂`），并被推到面板上。
    // 两步修：①开录先量 ~0.6s 本底，把门限抬到本底之上；②只有 VAD 判「正在说」时才把 partial 推出去。
    var calibSamples: [Double] = []
    var calibrated = false
    let calibFrames = autoEndpoint ? 30 : 0        // 30 × 20ms = 600ms

    /// 把 ASR 格式的 PCM 喂给 analyzer，并按 20ms 子帧跑 VAD（用音频时间轴，file/mic 行为一致）。
    func ingestConverted(_ out: AVAudioPCMBuffer) {
        feedLock.lock()
        let startFrame = fedFrames
        fedFrames += Int(out.frameLength)
        let sr = asrFormat.sampleRate
        feedLock.unlock()

        // 带 bufferStartTime：给 analyzer 一条连续时间轴，否则它可能攒到结束才处理
        let start = CMTime(value: CMTimeValue(startFrame), timescale: CMTimeScale(sr))
        continuation.yield(AnalyzerInput(buffer: out, bufferStartTime: start))

        guard autoEndpoint else { return }
        let sub = max(1, Int(sr * 0.02))                 // 20ms 子帧
        var i = 0
        let n = Int(out.frameLength)
        while i < n {
            let len = min(sub, n - i)
            let db = bufferDb(out, offset: i, count: len)
            let tSec = Double(startFrame + i) / sr
            // ① 前 600ms 只量本底：用中位数（避开引擎启动那一下的爆音），据此抬高门限
            if !calibrated {
                calibSamples.append(db)
                if calibSamples.count >= calibFrames {
                    let sorted = calibSamples.sorted()
                    let median = sorted[sorted.count / 2]
                    calibrated = true
                    if median > -120 {
                        // 偏移取 8/4（太激进的 12/6 会把"本底 -45、人声 -35"这种 10dB 信噪比的
                        // 正常说话也挡掉——真机实测过）；同时给个绝对上限，免得房间很吵时门限高到没人能触发。
                        let speechOffset = Double(opt("--calib-speech-offset") ?? "8") ?? 8
                        let silenceOffset = Double(opt("--calib-silence-offset") ?? "4") ?? 4
                        let speechCap = Double(opt("--calib-speech-cap") ?? "-32") ?? -32
                        let silenceCap = Double(opt("--calib-silence-cap") ?? "-38") ?? -38
                        vad.speechDb = min(max(vad.speechDb, median + speechOffset), speechCap)
                        vad.silenceDb = min(max(vad.silenceDb, median + silenceOffset), silenceCap)
                    }
                    emitLine(["ev": "vad_calibrated", "ambient_db": (median * 10).rounded() / 10,
                              "speech_db": (vad.speechDb * 10).rounded() / 10,
                              "silence_db": (vad.silenceDb * 10).rounded() / 10,
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                }
                i += len
                continue
            }
            switch vad.push(db: db, tSec: tSec) {
            case .started:
                vadLock.lock(); speechStartMs = Int(tSec * 1000); speechEndMs = nil; vadLock.unlock()
                emitLine(["ev": "speech_state", "state": "speech", "utterance_id": utteranceId,
                          "rms_db": (db * 10).rounded() / 10, "audio_ms": Int(tSec * 1000),
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            case .ended(let speechMs, let silenceMs):
                vadLock.lock(); speechEndMs = Int(tSec * 1000); vadLock.unlock()
                emitLine(["ev": "speech_state", "state": "silence", "utterance_id": utteranceId,
                          "audio_ms": Int(tSec * 1000), "ts_mono_ns": monoNs(), "t_ms": ms()])
                emitLine(["ev": "endpoint", "reason": "silence", "utterance_id": utteranceId,
                          "speech_ms": speechMs, "silence_ms": silenceMs,
                          "audio_ms": Int(tSec * 1000), "ts_mono_ns": monoNs(), "t_ms": ms()])
                setStopReason("silence")
            case .none:
                break
            }
            i += len
        }
    }

    /// 从任意源格式（麦克风或音频文件）转成 ASR 格式后 ingest。
    func ingest(_ buf: AVAudioPCMBuffer, _ srcFormat: AVAudioFormat, _ conv: AVAudioConverter) {
        let ratio = asrFormat.sampleRate / srcFormat.sampleRate
        let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: asrFormat, frameCapacity: cap) else { return }
        var err: NSError?
        var fed = false
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData
            return buf
        }
        if err == nil && out.frameLength > 0 { ingestConverted(out) }
    }

    try? await analyzer.prepareToAnalyze(in: asrFormat)

    // ---- 文件模式：与麦克风完全同一条管线（同样的转换 / VAD / 事件），用于离线回归 ----
    if let fp = filePath {
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: fp)) else {
            fail("E_AUDIO_REC", "打不开音频文件 \(fp)", 5)
        }
        let srcFormat = file.processingFormat
        guard let conv = AVAudioConverter(from: srcFormat, to: asrFormat) else {
            fail("E_ASR_FORMAT", "无法把 \(srcFormat) 转成 \(asrFormat)", 2)
        }
        emitLine(["ev": "ready", "locale": loc.identifier, "source": "file", "file": fp,
                  "asr_format": asrFormat.description, "max_seconds": maxSeconds,
                  "auto_endpoint": autoEndpoint, "endpoint_silence_ms": endpointSilenceMs,
                  "min_speech_ms": minSpeechMs, "speech_db": speechDb, "silence_db": silenceDb,
                  "utterance_id": utteranceId, "ts_mono_ns": monoNs()])
        let analyzerTask = Task.detached { try await analyzer.start(inputSequence: stream) }
        let chunkFrames: AVAudioFrameCount = 4096
        while let buf = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: chunkFrames) {
            do { try file.read(into: buf, frameCount: chunkFrames) } catch { break }
            if buf.frameLength == 0 { break }
            ingest(buf, srcFormat, conv)
            if stopSignal.wait(timeout: .now()) == .success { break }   // VAD 判出端点
        }
        continuation.finish()
        _ = try? await analyzerTask.value
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        let text = (try? await collector.value) ?? ""
        emitLine(["ev": "final", "text": text, "utterance_id": utteranceId,
                  "elapsed_ms": ms(), "stop_reason": currentStopReason(), "ts_mono_ns": monoNs()])
        exit(0)
    }

    // ---- 麦克风模式 ----
    let engine = AVAudioEngine()
    let input = engine.inputNode
    if aec { try? input.setVoiceProcessingEnabled(true) }   // ⚠ 会改输入格式，需真机验证
    let micFormat = input.inputFormat(forBus: 0)
    guard micFormat.sampleRate > 0, let converter = AVAudioConverter(from: micFormat, to: asrFormat) else {
        fail("E_MIC_OPEN", "麦克风格式不可用（\(micFormat)）或无法转换到 \(asrFormat)", 4)
    }
    var feedCount = 0
    input.installTap(onBus: 0, bufferSize: 2048, format: micFormat) { buf, _ in
        ingest(buf, micFormat, converter)
        feedCount += 1
        if trace && feedCount % 25 == 0 {   // ≈每秒一条：判定"喂得晚"还是"analyzer 攒着"
            FileHandle.standardError.write(Data(
                "[mac_speech] feed #\(feedCount) in=\(buf.frameLength) t=\(Int(Date().timeIntervalSince(t0) * 1000))ms\n".utf8))
        }
    }
    do { try engine.start() } catch { fail("E_MIC_OPEN", "麦克风启动失败：\(error)", 4) }

    emitLine(["ev": "ready", "locale": loc.identifier, "source": "mic",
              "asr_format": asrFormat.description, "max_seconds": maxSeconds,
              "auto_endpoint": autoEndpoint, "endpoint_silence_ms": endpointSilenceMs,
              "min_speech_ms": minSpeechMs, "speech_db": speechDb, "silence_db": silenceDb,
              "utterance_id": utteranceId, "aec": aec, "ts_mono_ns": monoNs()])

    let analyzerTask = Task.detached { try await analyzer.start(inputSequence: stream) }
    // 周期性 finalize：探它是不是"提交点"（不让 analyzer 攒到结束才吐字）
    let commitTimer = DispatchSource.makeTimerSource(queue: .global())
    commitTimer.schedule(deadline: .now() + 0.8, repeating: 0.8)
    commitTimer.setEventHandler {
        let t = CMTime(value: CMTimeValue(fedFrames), timescale: CMTimeScale(asrFormat.sampleRate))
        Task { try? await analyzer.finalize(through: t) }
    }
    commitTimer.resume()
    // 停止条件：stdin 收到 "stop" 或 EOF（robotd 关管道）／到 max-seconds
    DispatchQueue.global().async {
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces).lowercased() == "stop" { break }
        }
        setStopReason("stdin")
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + maxSeconds) {
        setStopReason("max_seconds")
    }
    // 空闲超时：开录后一直没人说话就收尾。否则「点了开始听但没说话」会一直挂着占资源，
    // 也让面板看起来像卡死（真机踩过：一个任务挂了 300s）。
    let idleTimeoutMs = Double(opt("--idle-timeout") ?? "20000") ?? 20000
    DispatchQueue.global().asyncAfter(deadline: .now() + idleTimeoutMs / 1000) {
        vadLock.lock(); let started = speechStartMs != nil; vadLock.unlock()
        if !started { setStopReason("idle") }
    }
    // 异步等待（不是阻塞 wait）：让上面那些任务有机会跑，同时不占死 main actor
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().async {
            stopSignal.wait()
            cont.resume()
        }
    }

    engine.stop()
    input.removeTap(onBus: 0)
    continuation.finish()
    let traceOut = { (s: String) in
        guard trace else { return }
        FileHandle.standardError.write(Data("[mac_speech] shutdown: \(s)\n".utf8))
    }
    traceOut("engine stopped, input sequence finished")
    _ = try? await analyzerTask.value
    traceOut("analyzer.start returned")
    try? await analyzer.finalizeAndFinishThroughEndOfInput()
    traceOut("finalized")
    let text = (try? await collector.value) ?? ""
    traceOut("collector done")
    emitLine(["ev": "final", "text": text, "utterance_id": utteranceId,
              "elapsed_ms": ms(), "stop_reason": currentStopReason(), "ts_mono_ns": monoNs()])
    exit(0)
}

// ---------------------------------------------------------------- speak：TTS
if mode == "speak" {
    guard let text = opt("--text"), !text.isEmpty else { fail("E_AUDIO_ARGS", "speak 需要 --text", 3) }
    let voiceID = opt("--voice")
    let rate = Float(opt("--rate") ?? "0.5") ?? 0.5

    // 必须等委托回调：`speak()` 之后 `isSpeaking` 可能还是 false（刚开始播放时），
    // 用 isSpeaking 轮询会**立刻返回**、话根本没说完（实测 19 字只花了 26ms）。
    final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
        let done = DispatchSemaphore(value: 0)
        var finished = false
        func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
            finished = true; done.signal()
        }
        func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
            done.signal()
        }
    }
    let speaker = Speaker()
    let synth = AVSpeechSynthesizer()
    synth.delegate = speaker
    let utterance = AVSpeechUtterance(string: text)
    utterance.rate = min(max(rate, 0.1), 1.0)
    if let id = voiceID {
        guard let v = AVSpeechSynthesisVoice(identifier: id) else {
            fail("E_TTS_VOICE", "找不到音色 \(id)（用 list 看可用 identifier）", 3)
        }
        utterance.voice = v
    }
    if utterance.voice == nil {
        utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")   // 缺省给中文音色
    }
    synth.speak(utterance)
    // 一边等信号量、一边跑 runloop（否则委托回调送不到）；超时兜底
    let deadline = DispatchTime.now() + 60
    while speaker.done.wait(timeout: .now() + 0.1) != .success {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        if DispatchTime.now() > deadline { break }
    }
    let ok = speaker.finished
    if !ok { fail("E_TTS_TIMEOUT", "朗读超时（60s 还没说完）", 6) }
    emitJSON(["ok": true, "data": [
        "voice": utterance.voice?.identifier ?? "-",
        "voice_language": utterance.voice?.language ?? "-",
        "chars": text.count,
        "elapsed_ms": ms(),
    ]])
    exit(0)
}

// ---------------------------------------------------------------- speak-stream：边生成边播（NDJSON 进）
//
// stdin 每行一个句子块（纯文本，或 {"text":"…"}）；收到一行 `stop` 或 EOF 即收尾。
// stdout 吐 NDJSON：tts_started → tts_chunk_started/finished（逐块）→ tts_finished / tts_cancelled。
// `--dry-run` 不碰音频设备，按字数模拟播放，用于没有声卡的回归测试。
if mode == "speak-stream" {
    let voiceID = opt("--voice")
    let rate = Float(opt("--rate") ?? "0.5") ?? 0.5
    let dryRun = argv.contains("--dry-run")
    let responseId = opt("--response") ?? "tts-\(Int(Date().timeIntervalSince1970 * 1000))"

    var chosen: AVSpeechSynthesisVoice? = nil
    if let id = voiceID { chosen = AVSpeechSynthesisVoice(identifier: id) }
    if chosen == nil { chosen = AVSpeechSynthesisVoice(language: "zh-CN") }
    guard let voice = chosen else { fail("E_TTS_VOICE", "找不到可用音色（用 list 看 identifier）", 3) }

    emitLine(["ev": "tts_started", "response_id": responseId, "voice": voice.identifier,
              "dry_run": dryRun, "ts_mono_ns": monoNs(), "t_ms": ms()])

    // ---- dry-run：不需要声卡，按字数模拟每块播放时长，验证队列顺序与取消 ----
    if dryRun {
        let lock = NSLock()
        var queue: [String] = []
        var ended = false, cancelled = false, idx = 0
        let wake = DispatchSemaphore(value: 0)

        // 读线程：收块 / end / stop。**`end` 之后继续读**——否则播报中来的 stop 收不到，打断就是假的。
        DispatchQueue.global().async {
            while let line = readLine(strippingNewline: true) {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.isEmpty { continue }
                if t.lowercased() == "stop" {
                    lock.lock(); cancelled = true; lock.unlock(); wake.signal(); break
                }
                if t.lowercased() == "end" {
                    lock.lock(); ended = true; lock.unlock(); wake.signal(); continue
                }
                lock.lock(); queue.append(t); lock.unlock(); wake.signal()
            }
            lock.lock(); ended = true; lock.unlock(); wake.signal()   // EOF 同 end
        }

        // 播线程：按序"播放"，分小步睡，随时响应 stop
        DispatchQueue.global().async {
            while true {
                lock.lock()
                let c = cancelled, e = ended
                let text = queue.isEmpty ? nil : queue.removeFirst()
                lock.unlock()
                if c {
                    emitLine(["ev": "tts_cancelled", "response_id": responseId, "reason": "stdin",
                              "chunks": idx, "ts_mono_ns": monoNs(), "t_ms": ms()])
                    exit(0)
                }
                if let t = text {
                    let i = idx; idx += 1
                    emitLine(["ev": "tts_chunk_started", "response_id": responseId, "index": i,
                              "text": t, "ts_mono_ns": monoNs(), "t_ms": ms()])
                    let total = min(0.4, 0.03 * Double(t.count))
                    var slept = 0.0
                    while slept < total {
                        Thread.sleep(forTimeInterval: 0.02); slept += 0.02
                        lock.lock(); let c2 = cancelled; lock.unlock()
                        if c2 {
                            emitLine(["ev": "tts_cancelled", "response_id": responseId, "reason": "stdin",
                                      "chunks": idx, "ts_mono_ns": monoNs(), "t_ms": ms()])
                            exit(0)
                        }
                    }
                    emitLine(["ev": "tts_chunk_finished", "response_id": responseId, "index": i,
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                    continue
                }
                if e {   // 没有更多块且队列已空 → 正常结束
                    emitLine(["ev": "tts_finished", "response_id": responseId, "chunks": idx,
                              "stop_reason": "eof", "ts_mono_ns": monoNs(), "t_ms": ms()])
                    exit(0)
                }
                _ = wake.wait(timeout: .now() + 0.05)
            }
        }
        // 让两个后台线程跑起来（dry-run 全程由它们驱动）
        while true { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    }

    // ---- 真播：AVSpeechSynthesizer 内部按序排队，逐块上报 ----
    final class StreamSpeaker: NSObject, AVSpeechSynthesizerDelegate {
        let lock = NSLock()
        var indexOf: [ObjectIdentifier: Int] = [:]
        // declared：**读线程一收到块就同步 +1**（还没进 synth 队列也算）；
        // queued：真正 enqueue 进 synth 的数量；finishedCount：播完的数量。
        // 收尾只看 declared —— 否则 `end` 可能在主队列派发之前被读到，
        // 于是 finishedCount(0) >= queued(0) 成立、任务"0 块播完"就结束了（真机实测踩到）。
        var declared = 0, queued = 0, finishedCount = 0
        var inputClosed = false, cancelled = false, done = false
        let doneSem = DispatchSemaphore(value: 0)
        func declare() { lock.lock(); declared += 1; lock.unlock() }
        func enqueue(_ s: AVSpeechSynthesizer, _ u: AVSpeechUtterance, _ i: Int) {
            lock.lock(); indexOf[ObjectIdentifier(u)] = i; queued += 1; lock.unlock()
            s.speak(u)
        }
        func finish(_ reason: String) {
            lock.lock(); if done { lock.unlock(); return }; done = true; lock.unlock()
            doneSem.signal()
        }
        func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
            lock.lock(); let i = indexOf[ObjectIdentifier(u)] ?? -1; lock.unlock()
            emitLine(["ev": "tts_chunk_started", "response_id": rid, "index": i,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
        func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
            lock.lock(); let i = indexOf[ObjectIdentifier(u)] ?? -1
            finishedCount += 1
            let all = inputClosed && finishedCount >= declared
            lock.unlock()
            emitLine(["ev": "tts_chunk_finished", "response_id": rid, "index": i,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            if all { finish("done") }
        }
        // 取消不在这里收尾：统一由 stop 路径发 tts_cancelled
        var rid = ""
    }
    let speaker = StreamSpeaker()
    speaker.rid = responseId
    let synth = AVSpeechSynthesizer()
    synth.delegate = speaker
    DispatchQueue.global().async {
        var idx = 0
        while let line = readLine(strippingNewline: true) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            if t.lowercased() == "stop" {
                speaker.lock.lock(); speaker.cancelled = true; speaker.lock.unlock()
                DispatchQueue.main.async { synth.stopSpeaking(at: .immediate) }
                break
            }
            if t.lowercased() == "end" {                     // 没有更多块，但仍可继续收 stop（打断）
                speaker.lock.lock()
                speaker.inputClosed = true
                let drained = speaker.finishedCount >= speaker.declared
                speaker.lock.unlock()
                if drained { speaker.finish("done") }
                continue
            }
            var text = t
            if t.hasPrefix("{"), let d = t.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let s = obj["text"] as? String { text = s }
            let i = idx; idx += 1
            speaker.declare()                                 // 先登记再派发：关掉 end 抢跑的竞态
            DispatchQueue.main.async {
                let u = AVSpeechUtterance(string: text)
                u.rate = min(max(rate, 0.1), 1.0)
                u.voice = voice
                speaker.enqueue(synth, u, i)
            }
        }
        speaker.lock.lock()
        speaker.inputClosed = true
        let drained = speaker.finishedCount >= speaker.declared
        let cancelled = speaker.cancelled
        speaker.lock.unlock()
        if cancelled { speaker.finish("cancelled") }
        else if drained { speaker.finish("done") }   // 否则等最后一个 didFinish 收尾
    }
    let deadline = DispatchTime.now() + 600
    while speaker.doneSem.wait(timeout: .now() + 0.1) != .success {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        if DispatchTime.now() > deadline { break }
    }
    speaker.lock.lock()
    let cancelled = speaker.cancelled, chunks = speaker.declared, played = speaker.finishedCount
    speaker.lock.unlock()
    if cancelled {
        emitLine(["ev": "tts_cancelled", "response_id": responseId, "reason": "stdin",
                  "chunks": chunks, "played": played, "ts_mono_ns": monoNs(), "t_ms": ms()])
    } else {
        emitLine(["ev": "tts_finished", "response_id": responseId, "chunks": chunks,
                  "played": played, "stop_reason": "eof", "elapsed_ms": ms(), "ts_mono_ns": monoNs()])
    }
    exit(0)
}

// ---------------------------------------------------------------- serve：常驻语音桥（robotd 管理的子进程）
//
// 与 `stream` 的区别：**进程常驻**——音频引擎与采集 tap 只建一次，按 stdin 命令跑多轮「听 / 说」。
// 为什么必须常驻（2026-10-16 实测）：
//   ① 每次 `swift … stream` 都要重新编译（1–2s）再起音频引擎 ⇒ 面板点「开始听」卡半天；
//   ② 解释执行下麦克风模式会 SIGTRAP（swift-frontend 崩溃报告，EXC_BREAKPOINT）；
//   ③ 播放一开始，采集 tap 会悄悄停（实测喂帧在 ~2.8s 后不再有回调）⇒ 说完不收尾、结果不出来。
// 所以进程交给 robotd 管理（健康检查 / 崩溃重启 / 退出回收），本模式负责音频自愈与协议。
//
// 命令（stdin，一行一个 JSON）：
//   {"cmd":"listen","utterance_id":"utt-1","max_seconds":300,"auto_endpoint":true,
//    "endpoint_silence_ms":700,"min_speech_ms":300,"idle_timeout_ms":20000}
//   {"cmd":"stop","reason":"stdin"}        # 结束当前这轮听
//   {"cmd":"speak","text":"你好","response_id":"tts-1","voice":"…","rate":0.5,"dry_run":false}
//   {"cmd":"stop_speak"}                   # 打断播报
//   {"cmd":"status"} / {"cmd":"quit"}
// 事件（stdout NDJSON）：bridge_ready / vad_calibrated / engine_restarting / engine_restarted /
//   ready / speech_state / partial / final_chunk / final_chunk_dropped / endpoint / final /
//   tts_started / tts_chunk_started / tts_chunk_finished / tts_finished / tts_cancelled / status
//
// **门控修复（2026-10-16）**：`isFinal` 的整段结果同样只在「VAD 判出的说话窗口」内才计入；
// 整轮都没出现说话窗口时 final 返回空 + `no_speech:true`。此前静音幻觉（`u/uuu/喂`）会从
// final 这一支漏出去（partial 有门控、final 没有，真机实测踩到）。
if mode == "serve" {
    guard #available(macOS 26.0, *) else { fail("E_ASR_OS", "常驻语音桥需要 macOS 26+", 2) }
    if micAuth() != "authorized" {
        fail("E_MIC_PERM", "麦克风授权=\(micAuth())（未授权时录到的是空音频）；"
            + "先去 系统设置 → 隐私与安全性 → 麦克风 打开承载进程的 App", 4)
    }

    /// 一轮「听」的上下文（可变字段都在 ServeBridge.lock 下访问）。
    final class Utt: @unchecked Sendable {
        let id: String
        let autoEndpoint: Bool
        var vad: EnergyVAD
        var analyzer: SpeechAnalyzer?
        var continuation: AsyncStream<AnalyzerInput>.Continuation?
        var collector: Task<String, Error>?
        var commitTimer: DispatchSourceTimer?
        var revision = 0
        var accepted = ""            // 通过门控、计入本轮结果的文本
        var speechStartMs: Int?
        var speechEndMs: Int?
        var sawSpeech = false
        var ending = false
        var fedFrames = 0
        var endedAudioMs = 0
        var floorDb = -80.0            // 自适应底噪（缓慢跟随）
        init(id: String, autoEndpoint: Bool, speechDb: Double, silenceDb: Double,
             endpointSilenceMs: Double, minSpeechMs: Double) {
            self.id = id
            self.autoEndpoint = autoEndpoint
            self.vad = EnergyVAD(speechDb: speechDb, silenceDb: silenceDb,
                                 minSpeechSec: minSpeechMs / 1000.0,
                                 endpointSilenceSec: endpointSilenceMs / 1000.0)
        }
    }

    final class ServeBridge: @unchecked Sendable {
        let localeID: String
        let aec: Bool
        let prerollMax: Int
        let loc: Locale
        let asrFormat: AVAudioFormat
        let work = DispatchQueue(label: "mac_speech.serve")
        let lock = NSLock()

        var engine = AVAudioEngine()
        var micFormat: AVAudioFormat?
        /// AEC 诊断只报一次（转换链路的峰值）
        var aecConvertReported = false
        /// 播报期间的麦克风电平探针（判断 AEC 消除效果）
        var lastEchoProbeMs = 0
        // AEC3 对照实验：`record` 命令会把「送进 playerNode 的参考信号」和
        // 「同时收到的麦克风信号」两边都落成 WAV，供离线对比 AEC3 与 VPIO。
        // 之所以要真实录音而不是合成回声：AEC 的表现依赖真实房间声学（混响、延迟、
        // 非线性），合成一个线性回声只会得到一个漂亮但不可信的结论。
        var recording = false               // 正在录 AEC 对照 WAV
        var recMicSamples: [Int16] = []     // 麦克风侧样本（内存攒，结束统一写 WAV）
        /// 校准得到的本底，供探针对照
        var ambientDbForProbe: Double = -120
        var converter: AVAudioConverter?
        var preroll: [AVAudioPCMBuffer] = []
        var utt: Utt?
        var lastTapAt = Date()
        var restarting = false
        var calibrated = false
        var calibSamples: [Double] = []
        var speechDb: Double
        var silenceDb: Double
        var maxItem: DispatchWorkItem?
        var idleItem: DispatchWorkItem?
        var watchdog: DispatchSourceTimer?
        var synth: AVSpeechSynthesizer?
        var speakingResponse: String?
        var dumpFile: AVAudioFile?          // 诊断：--dump-pcm 时把喂给 ASR 的音频落盘
        var dumpPath: String?
        var uttFile: AVAudioFile?           // 本轮听的音频（收尾时用它跑一次准确档批量转写）
        var uttPath: String?
        var muted = false                   // 常听开关：mute 后不产生 utterance、不跑 ASR（采集仍在，能量可探）
        var suppressAuto = false            // 播报期间禁止自触发（避免把机器人自己的话听进去）
        var playerNode: AVAudioPlayerNode?  // 挂在同一 engine 里的播放节点（让 AEC 拿到参考）
        var micUID: String?                 // 指定输入设备（CoreAudio UID）；nil = 系统默认
        var probeVad: EnergyVAD             // 空闲态用来自动发现"有人开始说话"
        var autoSeq = 0
        var currentPartial: String?
        var lastFinalText: String?
        var lastFinalAtMs: Int?

        init(loc: Locale, localeID: String, asrFormat: AVAudioFormat, aec: Bool,
             speechDb: Double, silenceDb: Double, prerollMax: Int) {
            self.loc = loc
            self.localeID = localeID
            self.asrFormat = asrFormat
            self.aec = aec
            self.speechDb = speechDb
            self.silenceDb = silenceDb
            self.prerollMax = prerollMax
            self.probeVad = EnergyVAD(speechDb: speechDb, silenceDb: silenceDb,
                                      minSpeechSec: 0.3, endpointSilenceSec: 0.7)
        }

        // ------------------------------------------------------------ 引擎与采集

        /// 按 CoreAudio UID 找输入设备。`AVCaptureDevice.uniqueID` 与 CoreAudio UID
        /// 在多数情况下同值，但不保证；这里两边都试一遍。
        static func findInputDevice(uid: String) -> AudioDeviceID? {
            var addr = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyDevices,
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
                var uidAddr = AudioObjectPropertyAddress(
                    mSelector: kAudioDevicePropertyDeviceUID,
                    mScope: kAudioObjectPropertyScopeGlobal,
                    mElement: kAudioObjectPropertyElementMain)
                var cfUid: CFString? = nil
                var s = UInt32(MemoryLayout<CFString?>.size)
                if AudioObjectGetPropertyData(id, &uidAddr, 0, nil, &s, &cfUid) == noErr,
                   let u = cfUid as String?, u == uid {
                    // 必须确认它有输入声道，否则绑上去引擎起不来
                    var cfg = AudioBufferList()
                    var cfgSize = UInt32(MemoryLayout<AudioBufferList>.size)
                    var prop = AudioObjectPropertyAddress(
                        mSelector: kAudioDevicePropertyStreamConfiguration,
                        mScope: kAudioDevicePropertyScopeInput,
                        mElement: kAudioObjectPropertyElementMain)
                    if AudioObjectGetPropertyData(id, &prop, 0, nil, &cfgSize, &cfg) == noErr {
                        return id
                    }
                }
            }
            return nil
        }

        /// 把引擎的输入绑定到指定设备。`AVAudioEngine` 没有公开 API 指定输入设备，
        /// 但底层 `AVAudioIONode` 的 AudioUnit 支持 `kAudioOutputUnitProperty_CurrentDevice`。
        /// 必须在 inputNode 首次被访问后、engine.start() 之前调用。
        func bindInputDevice(_ engine: AVAudioEngine, _ dev: AudioDeviceID) {
            guard let au = engine.inputNode.audioUnit else {
                emitLine(["ev": "mic_bind_skip", "reason": "inputNode.audioUnit 不可用",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            var d = dev
            let st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global, 0,
                                          &d, UInt32(MemoryLayout<AudioDeviceID>.size))
            emitLine(["ev": "mic_bind", "uid": micUID ?? "-", "device_id": dev,
                      "status": Int(st), "ok": st == noErr, "ts_mono_ns": monoNs(), "t_ms": ms()])
        }

        /// 建引擎 + 起 tap。配置变更 / 喂帧停顿后重建——把「采集悄悄死掉」变成自愈。
        @discardableResult
        func buildEngine() -> Bool {
            engine.stop()
            engine = AVAudioEngine()
            // **必须在访问 inputNode 之前**绑定设备：一旦拿到 inputNode，引擎就绑定了
            // 当时的默认输入设备，之后再改系统默认也不会生效（要重建引擎）。
            // 指定设备的用途见 `--mic-uid`：AEC 是「按机型 × 设备」预设的，
            // 不同麦克风可能命中不同预设，需要能对比。
            if let uid = micUID, let dev = Self.findInputDevice(uid: uid) {
                bindInputDevice(engine, dev)
            }
            let input = engine.inputNode
            // TTS 播放节点：**必须挂在开启 VPIO 的那个 engine 里**，AEC 才能拿到
            // 精确的播放参考信号。AVSpeechSynthesizer.speak() 走的是系统另一套音频图，
            // VPIO 看不到它，只能靠盲式抑制 —— 实测残留仍达 +18dB（见 eval/r14 §5.3）。
            // 所以这里用 write(_:toBufferCallback:) 把 TTS 合成成 PCM，再经本 engine 播放。
            let player = AVAudioPlayerNode()
            engine.attach(player)
            // **播放链路在两种模式下都要接**：不只是 AEC 需要参考，`--no-aec` 时
            // playerNode 也必须连到 outputNode，否则 `player.play()` 会抛
            // 「player started when in a disconnected state」并**直接崩溃**
            // （实测：ab2 的 noaec 三组全部 core-audio 异常退出）。
            // 顺带说明为什么原来只在 aec 分支里接：那时 TTS 还走 synth.speak()，
            // 没有 playerNode，接输出只是为了给 VPIO 一个渲染链路。
            let out = engine.outputNode
            let outFmt = out.outputFormat(forBus: 0)
            // 播放连接的格式**必须显式钉死**，不能用 `format: nil`：
            // AVAudioEngine 会把 nil 解释为「用源节点格式」，而 scheduleBuffer 要求
            // buffer 的通道数与**已连接格式**严格相等，否则抛
            //   'required condition is false: _outputFormat.channelCount == buffer.format.channelCount'
            // 并**直接终止进程**（实测 ab2 六组全部在 play_started 之后崩溃）。
            // 各模式的连接格式不同：AEC 开 VPIO 时 mixer 是 4ch，无 AEC 时是 2ch，
            // 而 WAV 是 1ch。所以这里按 mixer 的实际格式连接，播放时再把 1ch 转成该格式。
            if outFmt.sampleRate > 0 {
                let mixFmt = engine.mainMixerNode.outputFormat(forBus: 0)
                engine.connect(player, to: engine.mainMixerNode, format: mixFmt)
                engine.connect(engine.mainMixerNode, to: out, format: outFmt)
            }
            if aec {
                // VPIO（语音处理 I/O）同时提供 AEC + NS。它要求引擎里有**渲染链路**：
                // AEC 靠播放参考信号估计回声路径，只有输入 tap 时 Apple 的实现会切到
                // 「处理格式」却拿不到参考，结果是**采到全静音**（实测 bufferDb 恒为 -120）。
                // 所以先接输出链路（上面已接），再开 VPIO。
                //
                // 早先用 `try?` 吞掉错误，导致「AEC 开着但实际是静音」这种沉默失败
                // 完全看不出来。这里改成显式上报——宁可让人看见 AEC 没开成。
                do {
                    try input.setVoiceProcessingEnabled(true)
                } catch {
                    emitLine(["ev": "aec_unavailable", "aec": true, "reason": "\(error)",
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                }
                // VPIO 会**改变输入格式**（实测常见：48kHz float32 多声道）。格式变了还按
                // 旧描述装 tap，要么装不上、要么收到全零帧 —— 表现为 ambient_db 恒为 -120。
                // 所以这里把启用前后的格式都报出来，便于判断到底切成了什么。
                let fmtAfter = input.inputFormat(forBus: 0)
                emitLine(["ev": "aec_format", "aec": true,
                          "format_after_vpio": fmtAfter.description,
                          "sample_rate": fmtAfter.sampleRate,
                          "channels": fmtAfter.channelCount,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
            let fmt = input.inputFormat(forBus: 0)
            // 多声道（AEC/VPIO 下实测为 4ch）先混成单声道，再按单声道建转换器；
            // 否则 AVAudioConverter 的默认 downmix 只取第 0 声道，会得到全零（见 downmixIfNeeded）。
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
            micFormat = fmt
            converter = conv
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

        func start() {
            let ok = buildEngine()
            emitLine(["ev": "bridge_ready", "pid": Int(ProcessInfo.processInfo.processIdentifier),
                      "locale": loc.identifier, "asr_format": asrFormat.description,
                      "aec": aec, "engine_started": ok, "preroll": prerollMax,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
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

        func handleTap(_ buf: AVAudioPCMBuffer) {
            lock.lock(); lastTapAt = Date(); lock.unlock()
            let raw = buf   // 保留原始多声道帧：下面的逐声道探针要直接看它
            guard let src = micFormat, let conv = converter,
                  let out = convert(buf, src, conv) else { return }
            lock.lock(); let cur = utt; let m = muted; let s = suppressAuto; lock.unlock()
            // AEC 效果量化：播报期间每 500ms 报一次麦克风电平。
            // 这是判断「回声消除是否真的有用」的唯一直接证据——不靠听感。
            // 有 AEC 时这个值应接近本底；没有 AEC 时会被自己的播放顶到 -10dB 左右。
            if s {
                let now = ms()
                // 100ms 一次（原来是 500ms）：样本量 5 倍，才能看出句内起伏而不是撞运气。
                if now - lastEchoProbeMs >= 100 {
                    lastEchoProbeMs = now
                    emitLine(["ev": "aec_echo_probe", "db": bufferDb(out, offset: 0, count: Int(out.frameLength)),
                              "ambient_db": ambientDbForProbe,
                              "per_ch_db": perChannelDb(raw),
                              "src_ch": Int(raw.format.channelCount),
                              "ts_mono_ns": monoNs(), "t_ms": now])
                }
            }
            if let cur { ingest(cur, out) }
            else if m || s { pushPreroll(out) }        // 静音/播报：不产生新 utterance
            else { autoDetectOrPreroll(out) }          // 常听：自动切出 utterance
            // AEC3 对照：把麦克风侧（含回声）原样攒进内存，结束时统一写 WAV。
            // **不用 AVAudioFile 在音频线程里写**：实测 write(from:) 会阻塞整个 tap
            // （record_started 之后线程卡死，两个 wav 都停在 4096 字节表头）。
            // 音频线程里只做内存拷贝，写盘交给命令线程。
            lock.lock(); let recording = self.recording; lock.unlock()
            if recording {
                if let d = out.int16ChannelData?[0] {
                    lock.lock()
                    self.recMicSamples.append(contentsOf: UnsafeBufferPointer(start: d, count: Int(out.frameLength)))
                    lock.unlock()
                }
            }
        }

        /// 常听模式：空闲态里用能量 VAD 发现"有人开口"，命中就自动起一轮听。
        /// 没命中就继续留预滚（顺带量本底）。**校准完成前不判**，避免底噪误触发。
        func autoDetectOrPreroll(_ out: AVAudioPCMBuffer) {
            lock.lock(); let cal = calibrated; let sDb = speechDb; let qDb = silenceDb; lock.unlock()
            guard cal else { pushPreroll(out); return }
            let sub = max(1, Int(asrFormat.sampleRate * 0.02))
            var i = 0
            let n = Int(out.frameLength)
            var hit = false
            while i < n && !hit {
                let len = min(sub, n - i)
                let db = bufferDb(out, offset: i, count: len)
                lock.lock()
                probeVad.speechDb = sDb
                probeVad.silenceDb = qDb
                let action = probeVad.push(db: db, tSec: Double(i) / asrFormat.sampleRate)
                lock.unlock()
                if case .started = action { hit = true }
                i += len
            }
            if hit {
                lock.lock()
                probeVad = EnergyVAD(speechDb: sDb, silenceDb: qDb, minSpeechSec: 0.3, endpointSilenceSec: 0.7)
                autoSeq += 1
                let id = "utt-auto-\(autoSeq)"
                lock.unlock()
                work.async { [weak self] in
                    Task { await self?.beginUtt(id: id, autoEndpoint: true, endpointMs: 700,
                                                minSpeechMs: 300, maxSeconds: 60, idleMs: 0, file: nil) }
                }
            } else {
                pushPreroll(out)
            }
        }

        /// 常听开关：mute = 不产生 utterance、不跑 ASR（采集 tap 仍在，VAD 能量可用于唤醒类判断）。
        func setMuted(_ m: Bool) {
            lock.lock()
            if muted == m { lock.unlock(); status(); return }
            muted = m
            let cur = utt
            lock.unlock()
            if m, let cur { finish(reason: "muted", id: cur.id) }
            emitLine(["ev": "mute", "muted": m, "ts_mono_ns": monoNs(), "t_ms": ms()])
            status()
        }

        /// 来源 → ASR 格式的单声道 Int16。
        ///
        /// **AEC 的坑**：开了 VPIO 后输入变成 `4 ch / 48kHz / Float32 deinterleaved`，
        /// 而 `AVAudioConverter` 的默认 downmix 只取第 0 声道 —— VPIO 的 4 声道排布里
        /// 音频并不在第 0 声道，于是转换结果全零：引擎在跑、回调在进、`src_peak` 有 0.02，
        /// 但 `out_peak` 恒为 0，最终表现为 `ambient_db: -120`（看起来像「麦克风没声音」）。
        /// 实测见 eval/r14-voice-bringup-2026-10-24.md §3。
        ///
        /// 所以多声道来源先**手动混成单声道**（取所有声道的均值），再交给 converter 做
        /// 采样率与位深转换。单声道来源仍走原路径，不引入额外拷贝。
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
            // AEC 诊断：VPIO 把输入切成 4ch/48k/Float32，若通道映射不对，转换结果会全零
            // —— 表面看「引擎在跑、有回调」，实际喂给 VAD/ASR 的是静音（ambient_db 恒 -120）。
            //
            // 另外：小智（xiaozhi-esp32）的做法是 input_format="MR"——Mic + Reference 各占一个声道，
            // AEC 由**端侧 AFE** 用参考声道做。VPIO 的 4 声道里很可能也就含参考通道。
            // 若真如此，把 4 声道等权混成单声道等于把「参考信号」混进麦克风信号，自己破坏 AEC。
            // 所以这里逐声道报峰值/均值，用来判断哪个是 Mic、哪个是 Reference。
            if aec && !aecConvertReported {
                aecConvertReported = true
                var perChPeak: [Double] = []
                var perChRms: [Double] = []
                if let f = buf.floatChannelData {
                    for c in 0..<Int(buf.format.channelCount) {
                        var pk = 0.0
                        var sq = 0.0
                        let p = f[c]
                        let n = Int(buf.frameLength)
                        for i in 0..<n {
                            let v = Double(p[i])
                            pk = max(pk, abs(v))
                            sq += v * v
                        }
                        perChPeak.append((pk * 100000).rounded() / 100000)
                        perChRms.append(((n > 0 ? (sq / Double(n)).squareRoot() : 0) * 100000).rounded() / 100000)
                    }
                }
                var outPeak = 0.0
                if let s = out.int16ChannelData {
                    let p = s[0]
                    for i in 0..<Int(out.frameLength) { outPeak = max(outPeak, abs(Double(p[i]) / 32768.0)) }
                }
                // 只比电平不够：4 个声道 dB 完全一致，既可能「同一信号复制 4 份」，
                // 也可能「4 个不同信号恰好电平相近」。这里比**逐样本差值**，
                // 差值为 0 才是真复制。这是判断「有没有独立参考声道」的决定性证据。
                var maxDiff = 0.0
                if let f = buf.floatChannelData, Int(buf.format.channelCount) > 1 {
                    let n = Int(buf.frameLength)
                    for c in 1..<Int(buf.format.channelCount) {
                        let p = f[c], q = f[0]
                        for i in 0..<n { maxDiff = max(maxDiff, abs(Double(p[i]) - Double(q[i]))) }
                    }
                }
                emitLine(["ev": "aec_convert", "aec": true,
                          "src_format": buf.format.description,
                          "src_ch": Int(buf.format.channelCount), "src_frames": Int(buf.frameLength),
                          "per_ch_peak": perChPeak, "per_ch_rms": perChRms,
                          "ch0_vs_others_max_diff": maxDiff,
                          "out_frames": Int(out.frameLength), "out_peak": outPeak,
                          "err": err?.localizedDescription ?? "",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
            return (err == nil && out.frameLength > 0) ? out : nil
        }

        /// 多声道 → 单声道（等权平均）。单声道直接原样返回。
        private func downmixIfNeeded(_ buf: AVAudioPCMBuffer, _ fmt: AVAudioFormat) -> AVAudioPCMBuffer {
            let ch = Int(fmt.channelCount)
            guard ch > 1, let monoFmt = AVAudioFormat(commonFormat: fmt.commonFormat,
                                                      sampleRate: fmt.sampleRate,
                                                      channels: 1,
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
            } else {
                return buf
            }
            return mono
        }

        /// 本轮听的音频落盘：收尾时用它跑一次**准确档批量转写**当 final。
        /// 为什么需要：流式档（`.fastResults`）在真实语音上会被严重截断（同一段音频只出首词），
        /// 而批量档 `analyzeSequence` 实测同一段音频能出全句（2026-10-16 对照实验）。
        func startUttRecording(id: String) {
            let path = NSTemporaryDirectory() + "mac_speech-utt-\(id).caf"
            let f = try? AVAudioFile(forWriting: URL(fileURLWithPath: path),
                                     settings: asrFormat.settings,
                                     commonFormat: asrFormat.commonFormat,
                                     interleaved: asrFormat.isInterleaved)
            lock.lock(); uttFile = f; uttPath = (f == nil) ? nil : path; lock.unlock()
        }

        func recordUtt(_ buf: AVAudioPCMBuffer) {
            lock.lock(); let f = uttFile; lock.unlock()
            try? f?.write(from: buf)
        }

        /// 准确档批量转写（与一次性 `transcribe --file` 同一条已验证的路径）。
        static func batchTranscribe(path: String, locale: String) async -> String? {
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

        /// 诊断用：把实际喂给 analyzer 的音频写文件（`--dump-pcm <path>`），
        /// 之后可以用 `transcribe --file` 复跑——区分「采集/转换丢音频」还是「实时识别退化」。
        func dump(_ buf: AVAudioPCMBuffer) {
            guard let dumpPath else { return }
            if dumpFile == nil {
                // 必须显式给 commonFormat/interleaved，否则 settings 与 buffer 的排布被解释成
                // 两套格式，ExtAudioFile 直接 CAVerboseAbort（实测崩过）。
                let cf = asrFormat.commonFormat
                dumpFile = try? AVAudioFile(forWriting: URL(fileURLWithPath: dumpPath),
                                            settings: asrFormat.settings,
                                            commonFormat: cf == .pcmFormatFloat32 ? .pcmFormatFloat32 : .pcmFormatInt16,
                                            interleaved: asrFormat.isInterleaved)
            }
            try? dumpFile?.write(from: buf)
        }

        /// 预滚：不在听的时候也留最近几帧，避免「开始听」漏掉第一个字。顺手量本底噪声。
        func pushPreroll(_ buf: AVAudioPCMBuffer) {
            lock.lock()
            if prerollMax > 0 {
                preroll.append(buf)
                if preroll.count > prerollMax { preroll.removeFirst(preroll.count - prerollMax) }
            }
            let needCalib = !calibrated
            lock.unlock()
            guard needCalib else { return }
            let db = bufferDb(buf, offset: 0, count: Int(buf.frameLength))
            lock.lock()
            if !calibrated { calibSamples.append(db) }
            var median = -120.0
            var justCalibrated = false
            if !calibrated && calibSamples.count >= 30 {
                let sorted = calibSamples.sorted()
                median = sorted[sorted.count / 2]
                calibrated = true
                justCalibrated = true
                if median > -120 {
                    let speechOffset = Double(opt("--calib-speech-offset") ?? "8") ?? 8
                    let silenceOffset = Double(opt("--calib-silence-offset") ?? "4") ?? 4
                    let speechCap = Double(opt("--calib-speech-cap") ?? "-32") ?? -32
                    let silenceCap = Double(opt("--calib-silence-cap") ?? "-38") ?? -38
                    speechDb = min(max(speechDb, median + speechOffset), speechCap)
                    silenceDb = min(max(silenceDb, median + silenceOffset), silenceCap)
                }
            }
            let sDb = speechDb, qDb = silenceDb
            if justCalibrated { ambientDbForProbe = median }
            lock.unlock()
            if justCalibrated {
                emitLine(["ev": "vad_calibrated", "ambient_db": (median * 10).rounded() / 10,
                          "speech_db": (sDb * 10).rounded() / 10,
                          "silence_db": (qDb * 10).rounded() / 10,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
        }

        // ------------------------------------------------------------ 听

        func listen(_ cmd: [String: Any]) {
            lock.lock(); let busy = utt != nil; lock.unlock()
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
            work.async { [weak self] in
                Task { await self?.beginUtt(id: id, autoEndpoint: autoEndpoint, endpointMs: endpointMs,
                                            minSpeechMs: minSpeechMs, maxSeconds: maxSeconds, idleMs: idleMs,
                                            file: cmd["file"] as? String) }
            }
        }

        func beginUtt(id: String, autoEndpoint: Bool, endpointMs: Double, minSpeechMs: Double,
                      maxSeconds: Double, idleMs: Double, file: String?) async {
            let asked = Locale(identifier: localeID)
            let l = await SpeechTranscriber.supportedLocale(equivalentTo: asked) ?? asked
            // 默认「准确档」：实测 `.fastResults` 会把真实语音识别严重截断（同一段音频只出首词，
            // 合成音却正常）——去掉它 partial 照样逐条出，质量回到批量档。--asr-preset fast 可退回。
            // 流式档默认 fast：partial 要实时（准确档会攒到收尾才吐字）；
            // 质量由收尾的「准确档复跑」兜底（见 finish() 的 asr_final=batch）。
            let fast = (opt("--asr-preset") ?? "fast") != "accurate"
            let transcriber = SpeechTranscriber(
                locale: l, transcriptionOptions: [],
                reportingOptions: fast ? [.volatileResults, .fastResults] : [.volatileResults],
                attributeOptions: [.audioTimeRange])
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            guard let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                emitLine(["ev": "error", "code": "E_ASR_FORMAT", "message": "拿不到 ASR 需要的音频格式",
                          "utterance_id": id, "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
            lock.lock()
            let u = Utt(id: id, autoEndpoint: autoEndpoint, speechDb: speechDb, silenceDb: silenceDb,
                        endpointSilenceMs: endpointMs, minSpeechMs: minSpeechMs)
            u.analyzer = analyzer
            u.continuation = cont
            utt = u
            let pre = preroll
            preroll.removeAll()
            lock.unlock()
            startUttRecording(id: id)

            u.collector = Task.detached { [weak self] () throws -> String in
                guard let self else { return "" }
                for try await r in transcriber.results {
                    let chunk = String(r.text.characters)
                    let sMs = Int(r.range.start.seconds * 1000)
                    let eMs = Int(r.range.end.seconds * 1000)
                    self.lock.lock()
                    let start = u.speechStartMs
                    let end = u.speechEndMs
                    let ueid = u.id
                    self.lock.unlock()
                    let margin = 300
                    var inWindow = false
                    if let start { inWindow = eMs >= start - margin && sMs <= (end.map { $0 + margin } ?? Int.max) }
                    if r.isFinal {
                        // 门控修复：说话窗口之外（含「整轮没说」）的 isFinal 一律丢弃。
                        guard !autoEndpoint || inWindow else {
                            emitLine(["ev": "final_chunk_dropped", "text": chunk, "utterance_id": ueid,
                                      "audio_start_ms": sMs, "audio_end_ms": eMs,
                                      "reason": start == nil ? "no_speech" : "out_of_window",
                                      "ts_mono_ns": monoNs(), "t_ms": ms()])
                            continue
                        }
                        self.lock.lock(); u.accepted += chunk; let acc = u.accepted; self.lock.unlock()
                        emitLine(["ev": "final_chunk", "text": acc, "utterance_id": ueid,
                                  "audio_start_ms": sMs, "audio_end_ms": eMs,
                                  "ts_mono_ns": monoNs(), "t_ms": ms()])
                    } else {
                        guard !autoEndpoint || inWindow else { continue }
                        self.lock.lock()
                        u.revision += 1
                        let rev = u.revision, acc = u.accepted
                        self.currentPartial = acc + chunk
                        self.lock.unlock()
                        emitLine(["ev": "partial", "text": acc + chunk, "revision": rev,
                                  "utterance_id": ueid, "audio_start_ms": sMs, "audio_end_ms": eMs,
                                  "ts_mono_ns": monoNs(), "t_ms": ms()])
                    }
                }
                self.lock.lock(); let out = u.accepted; self.lock.unlock()
                return out
            }
            _ = Task.detached { try await analyzer.start(inputSequence: stream) }
            // 周期 finalize（0.8s）：volatile 区间要靠它才**实时**提交；去掉后 partial 只在收尾吐
            // （2026-10-16 实测）。准确性由收尾的批量复跑兜底，所以这里只追低延迟。
            let commit = DispatchSource.makeTimerSource(queue: work)
            commit.schedule(deadline: .now() + 0.8, repeating: 0.8)
            commit.setEventHandler { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let frames = u.fedFrames, ending = u.ending
                self.lock.unlock()
                guard !ending else { return }
                let t = CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(self.asrFormat.sampleRate))
                Task { try? await analyzer.finalize(through: t) }
            }
            commit.resume()
            lock.lock(); u.commitTimer = commit; lock.unlock()

            for b in pre { ingest(u, b) }        // 预滚先灌，再灌实时帧
            // 回归接缝：listen 带 "file" 时改喂文件（与 --file 的 stream 模式同一条管线）。
            if let fp = file {
                work.async { [weak self] in
                    guard let self else { return }
                    guard let f = try? AVAudioFile(forReading: URL(fileURLWithPath: fp)) else {
                        emitLine(["ev": "error", "code": "E_AUDIO_REC", "message": "打不开音频文件 \(fp)",
                                  "utterance_id": id, "ts_mono_ns": monoNs(), "t_ms": ms()])
                        self.finish(reason: "file_error", id: id)
                        return
                    }
                    let src = f.processingFormat
                    guard let conv = AVAudioConverter(from: src, to: self.asrFormat) else {
                        self.finish(reason: "file_format", id: id)
                        return
                    }
                    let cap: AVAudioFrameCount = 4096
                    while let buf = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: cap) {
                        do { try f.read(into: buf, frameCount: cap) } catch { break }
                        if buf.frameLength == 0 { break }
                        self.lock.lock(); let ending = self.utt?.ending ?? true; self.lock.unlock()
                        if ending { break }
                        if let out = self.convert(buf, src, conv) { self.ingest(u, out) }
                    }
                    self.finish(reason: "file_eof", id: id)
                }
            }
            emitLine(["ev": "ready", "locale": l.identifier, "source": "mic", "utterance_id": id,
                      "asr_format": fmt.description, "auto_endpoint": autoEndpoint,
                      "endpoint_silence_ms": endpointMs, "min_speech_ms": minSpeechMs,
                      "speech_db": (speechDb * 10).rounded() / 10,
                      "silence_db": (silenceDb * 10).rounded() / 10,
                      "preroll": pre.count, "max_seconds": maxSeconds,
                      "ts_mono_ns": monoNs(), "t_ms": ms()])
            armTimers(id: id, maxSeconds: maxSeconds, idleMs: idleMs)
        }

        func armTimers(id: String, maxSeconds: Double, idleMs: Double) {
            let maxItem = DispatchWorkItem { [weak self] in self?.finish(reason: "max_seconds", id: id) }
            let idleItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.lock.lock(); let started = self.utt?.sawSpeech ?? false; self.lock.unlock()
                if !started { self.finish(reason: "idle", id: id) }
            }
            lock.lock(); self.maxItem = maxItem; self.idleItem = idleItem; lock.unlock()
            work.asyncAfter(deadline: .now() + maxSeconds, execute: maxItem)
            work.asyncAfter(deadline: .now() + idleMs / 1000, execute: idleItem)
        }

        func cancelTimers() {
            lock.lock(); let a = maxItem, b = idleItem; maxItem = nil; idleItem = nil; lock.unlock()
            a?.cancel(); b?.cancel()
        }

        /// 喂一帧到 analyzer，并按 20ms 子帧跑 VAD（与一次性 stream 模式同一套判据）。
        func ingest(_ u: Utt, _ out: AVAudioPCMBuffer) {
            dump(out)
            recordUtt(out)
            // 校准前不判说话（真机踩过：房间底噪 -34.8 直接越过默认 -36 门限，
            // VAD 一上来就"在说话"，之后一直不收尾 ⇒ 面板看着像卡死）。
            lock.lock(); let cal = calibrated; lock.unlock()
            if !cal {
                let db = bufferDb(out, offset: 0, count: Int(out.frameLength))
                lock.lock()
                if !calibrated { calibSamples.append(db) }
                var justCal = false
                var median = -120.0
                if !calibrated && calibSamples.count >= 30 {
                    let sorted = calibSamples.sorted()
                    median = sorted[sorted.count / 2]
                    calibrated = true
                    justCal = true
                    if median > -120 {
                        speechDb = min(max(speechDb, median + 8), -32)
                        silenceDb = min(max(silenceDb, median + 4), -38)
                        u.vad.speechDb = speechDb; u.vad.silenceDb = silenceDb
                    }
                }
                let sDb = speechDb, qDb = silenceDb
                lock.unlock()
                if justCal {
                    emitLine(["ev": "vad_calibrated", "ambient_db": (median * 10).rounded() / 10,
                              "speech_db": (sDb * 10).rounded() / 10,
                              "silence_db": (qDb * 10).rounded() / 10,
                              "source": "utterance_start",
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                }
                return
            }
            lock.lock()
            let startFrame = u.fedFrames
            u.fedFrames += Int(out.frameLength)
            let autoEndpoint = u.autoEndpoint
            let id = u.id
            lock.unlock()
            let sr = asrFormat.sampleRate
            let start = CMTime(value: CMTimeValue(startFrame), timescale: CMTimeScale(sr))
            u.continuation?.yield(AnalyzerInput(buffer: out, bufferStartTime: start))
            guard autoEndpoint else { return }
            let sub = max(1, Int(sr * 0.02))
            var i = 0
            let n = Int(out.frameLength)
            while i < n {
                let len = min(sub, n - i)
                let db = bufferDb(out, offset: i, count: len)
                let tSec = Double(startFrame + i) / sr
                lock.lock()
                // 自适应底噪：跟一条缓慢下降/上升的噪声估计，门限跟着抬，
                // 否则「房间底噪 > 固定 silence 门限」时 VAD 永远判不出停顿（端点不触发）。
                u.floorDb = (u.floorDb * 24 + db) / 25
                u.vad.speechDb = max(speechDb, min(u.floorDb + 8, -32))
                u.vad.silenceDb = max(silenceDb, min(u.floorDb + 4, -38))
                let action = u.vad.push(db: db, tSec: tSec)
                switch action {
                case .started: u.sawSpeech = true; u.speechStartMs = Int(tSec * 1000); u.speechEndMs = nil
                case .ended:   u.speechEndMs = Int(tSec * 1000)
                case .none:    break
                }
                u.endedAudioMs = Int(tSec * 1000)
                lock.unlock()
                switch action {
                case .started:
                    emitLine(["ev": "speech_state", "state": "speech", "utterance_id": id,
                              "rms_db": (db * 10).rounded() / 10, "audio_ms": Int(tSec * 1000),
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                case .ended(let speechMs, let silenceMs):
                    emitLine(["ev": "speech_state", "state": "silence", "utterance_id": id,
                              "audio_ms": Int(tSec * 1000), "ts_mono_ns": monoNs(), "t_ms": ms()])
                    emitLine(["ev": "endpoint", "reason": "silence", "utterance_id": id,
                              "speech_ms": speechMs, "silence_ms": silenceMs,
                              "audio_ms": Int(tSec * 1000), "ts_mono_ns": monoNs(), "t_ms": ms()])
                    finish(reason: "silence", id: id)
                    return
                case .none:
                    break
                }
                i += len
            }
        }

        /// 收尾一轮听：关输入序列 → finalize → 等 collector → 出门控后的结果。
        func finish(reason: String, id: String? = nil) {
            lock.lock()
            guard let u = utt, !u.ending else { lock.unlock(); return }
            if let id, id != u.id { lock.unlock(); return }
            u.ending = true
            utt = nil
            let commit = u.commitTimer
            lock.unlock()
            commit?.cancel()
            cancelTimers()
            Task.detached { [weak self] in
                guard let self else { return }
                u.continuation?.finish()
                _ = try? await u.analyzer?.finalizeAndFinishThroughEndOfInput()
                let streamed = await self.waitText(u)
                self.lock.lock()
                let sawSpeech = u.sawSpeech
                let audioMs = u.endedAudioMs
                let path = self.uttPath
                self.uttFile = nil; self.uttPath = nil
                self.lock.unlock()
                let noSpeech = u.autoEndpoint && !sawSpeech
                var text = noSpeech ? "" : streamed
                var via = "stream"
                // 准确档复跑：只在这一轮确实说过话、且有落盘音频时做
                if !noSpeech, let path, (opt("--final-pass") ?? "batch") != "off" {
                    if let accurate = await ServeBridge.batchTranscribe(path: path, locale: self.localeID),
                       !accurate.isEmpty {
                        text = accurate
                        via = "batch"
                    }
                }
                if let path { try? FileManager.default.removeItem(atPath: path) }
                self.lock.lock()
                self.lastFinalText = text
                self.lastFinalAtMs = Int(monoNs() / 1_000_000)
                self.currentPartial = nil
                self.lock.unlock()
                emitLine(["ev": "final", "text": text, "utterance_id": u.id,
                          "stop_reason": reason, "no_speech": noSpeech, "audio_ms": audioMs,
                          "asr_final": via, "streamed_text": streamed,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
        }

        /// 等 collector 收工（最多 3s，超时用已累计文本兜底）——finalize 之后它必然会结束。
        func waitText(_ u: Utt) async -> String {
            guard let task = u.collector else {
                lock.lock(); let acc = u.accepted; lock.unlock(); return acc
            }
            return await withTaskGroup(of: String?.self) { group in
                group.addTask { (try? await task.value) }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    return nil
                }
                let first = (await group.next()) ?? nil
                group.cancelAll()
                if let first { return first }
                self.lock.lock(); let acc = u.accepted; self.lock.unlock()
                return acc
            }
        }

        // ------------------------------------------------------------ 说

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
            // 分句在**桥内**做：上层只给整段文本，切法属于「怎么说得像人话」，不是契约的一部分。
            let chunks = splitSentences(text)
            lock.lock(); let busy = speakingResponse != nil; lock.unlock()
            if busy {
                emitLine(["ev": "error", "code": "E_TTS_BUSY", "message": "上一段还没播完",
                          "response_id": responseId, "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            work.async { [weak self] in
                guard let self else { return }
                let synth = AVSpeechSynthesizer()
                self.lock.lock()
                self.synth = synth
                self.speakingResponse = responseId
                self.suppressAuto = true       // 播报期间不把机器人自己的话当成人开口
                self.lock.unlock()
                let voice = voiceID.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
                    ?? AVSpeechSynthesisVoice(language: "zh-CN")
                emitLine(["ev": "tts_started", "response_id": responseId,
                          "voice": voice?.identifier ?? "-", "chars": text.count,
                          "chunks": chunks.count, "dry_run": dryRun,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])

                var played = 0
                var cancelled = false
                for (idx, piece) in chunks.enumerated() {
                    self.lock.lock(); let gone = self.speakingResponse != responseId; self.lock.unlock()
                    if gone { cancelled = true; break }
                    emitLine(["ev": "tts_chunk_started", "response_id": responseId, "index": idx,
                              "text": piece, "ts_mono_ns": monoNs(), "t_ms": ms()])
                    if dryRun {
                        Thread.sleep(forTimeInterval: min(0.4, 0.03 * Double(piece.count)))
                    } else {
                        // **播放走本 engine 的 playerNode**，不再用 synth.speak()。
                        // 差别就在 AEC：playerNode 的 PCM 是 VPIO 渲染链路上的「参考信号」，
                        // synth.speak() 播放的声音在系统另一套音频图里，VPIO 看不见。
                        // 长句走 synth.speak() 与「盲式抑制」的实测对比见 eval/r14 §5.3。
                        let t0 = Date()
                        let ok = self.speakViaEngine(piece: piece, voice: voice, rate: rate,
                                                     responseId: responseId)
                        if !ok {
                            // playerNode 不可用（例如 engine 重建中）时回退到 synth.speak()，
                            // 至少保证「能说话」；此时 AEC 会退回盲式抑制，记录在事件里便于诊断。
                            emitLine(["ev": "tts_fallback_synth", "response_id": responseId,
                                      "index": idx, "ts_mono_ns": monoNs(), "t_ms": ms()])
                            let est = max(0.8, 0.18 * Double(piece.count))
                            let u = AVSpeechUtterance(string: piece)
                            u.voice = voice
                            u.rate = min(max(rate, 0.1), 1.0)
                            synth.speak(u)
                            var spoke = false
                            while true {
                                Thread.sleep(forTimeInterval: 0.05)
                                self.lock.lock(); let c = self.speakingResponse != responseId; self.lock.unlock()
                                if c { cancelled = true; break }
                                let elapsed = Date().timeIntervalSince(t0)
                                if synth.isSpeaking { spoke = true }
                                if spoke && !synth.isSpeaking { break }
                                if elapsed > est + 5.0 { break }
                            }
                        }
                        self.lock.lock(); let c2 = self.speakingResponse != responseId; self.lock.unlock()
                        if c2 { cancelled = true; break }
                        Thread.sleep(forTimeInterval: 0.05)   // 句间微停顿
                    }
                    emitLine(["ev": "tts_chunk_finished", "response_id": responseId, "index": idx,
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                    played += 1
                }

                self.lock.lock()
                let wasCancelled = self.speakingResponse != responseId
                self.speakingResponse = nil
                self.synth = nil
                self.suppressAuto = false
                self.lock.unlock()
                if cancelled || wasCancelled {
                    emitLine(["ev": "tts_cancelled", "response_id": responseId, "reason": "stop_speak",
                              "chunks": chunks.count, "played": played,
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                } else {
                    emitLine(["ev": "tts_finished", "response_id": responseId, "stop_reason": "done",
                              "chunks": chunks.count, "played": played,
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                }
            }
        }

        /// 把一段 Int16 单声道样本写成标准 WAV（16k、单声道、16-bit）。
        ///
        /// 为什么手写而不用 AVAudioFile：实测在音频线程/命令线程里调用
        /// `AVAudioFile.write(from:)` 会**阻塞到进程卡死**（两个 wav 永远停在 4096 字节表头）。
        /// WAV 头只有 44 字节，手写反而确定性最高，也便于离线工具直接读。
        static func writeWav16(_ samples: [Int16], to path: String, rate: UInt32 = 16000) -> Bool {
            var data = Data()
            func put32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
            func put16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
            let bytes = UInt32(samples.count * 2)
            data.append(contentsOf: Array("RIFF".utf8))
            put32(36 + bytes)
            data.append(contentsOf: Array("WAVEfmt ".utf8))
            put32(16)                      // fmt chunk size
            put16(1)                       // PCM
            put16(1)                       // mono
            put32(rate)
            put32(rate * 2)                // byte rate
            put16(2)                       // block align
            put16(16)                      // bits
            data.append(contentsOf: Array("data".utf8))
            put32(bytes)
            var le = samples.map { $0.littleEndian }
            le.withUnsafeBufferPointer { data.append(Data(bytes: $0.baseAddress!, count: $0.count * 2)) }
            return (try? data.write(to: URL(fileURLWithPath: path))) != nil
        }

        /// AEC3 对照实验：录制「参考信号 + 麦克风信号」一对 WAV。
        ///
        /// 参考信号必须是**送进 playerNode 的那份 PCM**（软件分叉），而不是事后推导；
        /// 这正是 WebRTC 官方强调的「feed the render signal correctly, before any mixing」。
        ///
        /// 命令：{"cmd":"record","dir":"/abs/path","path":"work/verify/aec_probe.wav"}
        /// 产出 <dir>/ref.wav 与 <dir>/mic.wav（均为 16k 单声道 Int16）。
        func recordPair(_ cmd: [String: Any]) {
            guard let dir = cmd["dir"] as? String, let wavPath = cmd["path"] as? String,
                  let file = try? AVAudioFile(forReading: URL(fileURLWithPath: wavPath)) else {
                emitLine(["ev": "error", "code": "E_ARGS", "message": "record 需要 dir 与可读的 path",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            work.async { [weak self] in
                guard let self else { return }
                let src = file.processingFormat
                guard let buf = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: AVAudioFrameCount(file.length)),
                      (try? file.read(into: buf)) != nil else {
                    emitLine(["ev": "error", "code": "E_FILE", "message": "读不出测试音样本",
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                    return
                }
                emitLine(["ev": "record_read", "src": src.description,
                          "frames": Int(buf.frameLength), "ts_mono_ns": monoNs(), "t_ms": ms()])

                // 参考信号降到 16k 单声道（AEC3 用 16k，与麦克风侧同一时基，离线不用再对齐）。
                // 直接线性插值，不用 AVAudioConverter —— 它在「只喂一次输入」的 push 模式下会卡住。
                let srcRate = src.sampleRate, srcCh = Int(src.channelCount)
                let inFrames = Int(buf.frameLength)
                let outFrames = Int(Double(inFrames) * 16000.0 / srcRate)
                var refSamples = [Int16](repeating: 0, count: outFrames)
                let ratio = srcRate / 16000.0
                if let f32 = buf.floatChannelData {
                    for i in 0..<outFrames {
                        let pos = Double(i) * ratio
                        let i0 = min(Int(pos), inFrames - 1), i1 = min(i0 + 1, inFrames - 1)
                        let f = Float(pos - Double(i0))
                        var acc: Float = 0
                        for c in 0..<srcCh { acc += f32[c][i0] * (1 - f) + f32[c][i1] * f }
                        acc /= Float(srcCh)
                        refSamples[i] = Int16(max(-32768, min(32767, acc * 32767)))
                    }
                } else if let i16 = buf.int16ChannelData {
                    for i in 0..<outFrames {
                        let pos = Double(i) * ratio
                        let i0 = min(Int(pos), inFrames - 1), i1 = min(i0 + 1, inFrames - 1)
                        let f = Float(pos - Double(i0))
                        var acc: Float = 0
                        for c in 0..<srcCh { acc += Float(i16[c][i0]) * (1 - f) + Float(i16[c][i1]) * f }
                        acc /= Float(srcCh)
                        refSamples[i] = Int16(max(-32768, min(32767, acc)))
                    }
                }
                emitLine(["ev": "record_converted", "out_frames": outFrames,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])

                self.lock.lock()
                self.recording = true
                self.recMicSamples.removeAll(keepingCapacity: true)
                self.suppressAuto = true
                self.lock.unlock()
                emitLine(["ev": "record_started", "dir": dir, "ts_mono_ns": monoNs(), "t_ms": ms()])

                // 播放（走 playerNode，保证 AEC 参考链路与真实播报一致）
                self.lock.lock(); let player = self.playerNode; self.lock.unlock()
                let secs = Double(outFrames) / 16000.0
                if let player {
                    let mixFmt = player.outputFormat(forBus: 0)
                    let mRate = mixFmt.sampleRate, mCh = Int(mixFmt.channelCount)
                    let want = Int(Double(outFrames) * mRate / 16000.0)
                    if let up = AVAudioPCMBuffer(pcmFormat: mixFmt, frameCapacity: AVAudioFrameCount(want)),
                       let dst = up.floatChannelData {
                        up.frameLength = AVAudioFrameCount(want)
                        let r = 16000.0 / mRate
                        for i in 0..<want {
                            let pos = Double(i) * r
                            let i0 = min(Int(pos), outFrames - 1)
                            let v = Float(refSamples[i0]) / 32768.0
                            for c in 0..<mCh { dst[c][i] = v }
                        }
                        player.stop(); player.play()
                        player.scheduleBuffer(up, at: nil, options: [], completionHandler: nil)
                        emitLine(["ev": "record_scheduled", "frames": want, "channels": mCh,
                                  "rate": mRate, "ts_mono_ns": monoNs(), "t_ms": ms()])
                    }
                }
                Thread.sleep(forTimeInterval: secs + 1.5)

                self.lock.lock()
                self.recording = false
                let mic = self.recMicSamples
                self.recMicSamples.removeAll(keepingCapacity: false)
                self.suppressAuto = false
                self.lock.unlock()

                let okRef = Self.writeWav16(refSamples, to: dir + "/ref.wav")
                let okMic = Self.writeWav16(mic, to: dir + "/mic.wav")
                emitLine(["ev": "record_finished", "dir": dir, "seconds": secs,
                          "ref_samples": refSamples.count, "mic_samples": mic.count,
                          "ref_ok": okRef, "mic_ok": okMic,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
        }


        /// 播一段固定 WAV（AEC 对照实验用）。
        ///
        /// 与 `speak` 的区别：**输入逐字节相同**，且写入 playerNode 的是同一份 PCM，
        /// 不经过 AVSpeechSynthesizer。这样「回声源」是可控常量，ABAB 交替才有意义。
        func playFile(_ cmd: [String: Any]) {
            guard let path = cmd["path"] as? String else {
                emitLine(["ev": "error", "code": "E_ARGS", "message": "play 需要 path",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return
            }
            work.async { [weak self] in
                guard let self else { return }
                guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
                    emitLine(["ev": "error", "code": "E_FILE", "message": "读不到 \(path)",
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                    return
                }
                let fmt = file.processingFormat
                let frames = AVAudioFrameCount(file.length)
                guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames),
                      (try? file.read(into: buf)) != nil else {
                    emitLine(["ev": "error", "code": "E_FILE", "message": "解码失败 \(path)",
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                    return
                }
                self.lock.lock()
                let player = self.playerNode
                self.suppressAuto = true
                self.lock.unlock()
                guard let player else {
                    self.lock.lock(); self.suppressAuto = false; self.lock.unlock()
                    emitLine(["ev": "error", "code": "E_NO_PLAYER", "message": "playerNode 不可用",
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                    return
                }
                let secs = Double(buf.frameLength) / fmt.sampleRate
                emitLine(["ev": "play_started", "path": path, "seconds": secs,
                          "frames": Int(buf.frameLength), "format": fmt.description,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                player.stop()
                // **必须转成与 playerNode 已连接格式相同的通道数**。
                // scheduleBuffer 断言 `_outputFormat.channelCount == buffer.format.channelCount`，
                // 不相等会抛 NSException 直接终止进程（不是返回错误，没法 try）。
                // 这里读 playerNode 的 outputFormat（= 连接时的 mixer 格式），
                // 用 AVAudioConverter 把 WAV(1ch) 转过去，混音时把单声道复制到所有声道。
                let target = player.outputFormat(forBus: 0)
                let toPlay: AVAudioPCMBuffer
                if target.channelCount == fmt.channelCount, target.sampleRate == fmt.sampleRate {
                    toPlay = buf
                } else {
                    guard let conv = AVAudioConverter(from: fmt, to: target),
                          let converted = AVAudioPCMBuffer(
                            pcmFormat: target,
                            frameCapacity: AVAudioFrameCount(Double(buf.frameLength)
                                                            * target.sampleRate / fmt.sampleRate) + 64)
                    else {
                        self.lock.lock(); self.suppressAuto = false; self.lock.unlock()
                        emitLine(["ev": "error", "code": "E_CONVERT",
                                  "message": "无法把 \(fmt.channelCount)ch/\(fmt.sampleRate) 转成 \(target.channelCount)ch/\(target.sampleRate)",
                                  "ts_mono_ns": monoNs(), "t_ms": ms()])
                        return
                    }
                    var done = false
                    var convErr: NSError?
                    conv.convert(to: converted, error: &convErr) { _, status in
                        if done { status.pointee = .noDataNow; return nil }
                        done = true
                        status.pointee = .haveData
                        return buf
                    }
                    if let convErr {
                        self.lock.lock(); self.suppressAuto = false; self.lock.unlock()
                        emitLine(["ev": "error", "code": "E_CONVERT", "message": "\(convErr)",
                                  "ts_mono_ns": monoNs(), "t_ms": ms()])
                        return
                    }
                    toPlay = converted
                    emitLine(["ev": "play_converted", "from": fmt.description,
                              "to": target.description, "frames": Int(toPlay.frameLength),
                              "ts_mono_ns": monoNs(), "t_ms": ms()])
                }
                player.play()
                player.scheduleBuffer(toPlay, at: nil, options: [], completionHandler: nil)
                // 等播完（多留 0.5s 尾巴，让残余回声也被采到）
                Thread.sleep(forTimeInterval: Double(toPlay.frameLength) / target.sampleRate + 0.5)
                self.lock.lock(); self.suppressAuto = false; self.lock.unlock()
                emitLine(["ev": "play_finished", "path": path,
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
        }


        ///
        /// `AVSpeechSynthesizer.write(_:toBufferCallback:)` 把合成结果以 PCM 交出来（不入声卡），
        /// 再由 playerNode 播——这样 VPIO 的 AEC 才在渲染链路上看到「我自己在放什么」。
        /// 返回 false 表示 playerNode 不可用，调用方回退到 `synth.speak()`。
        func speakViaEngine(piece: String, voice: AVSpeechSynthesisVoice?, rate: Float,
                            responseId: String) -> Bool {
            lock.lock()
            let engine = self.engine
            let player = playerNode
            lock.unlock()
            guard let player, engine.isRunning else { return false }

            let synth = AVSpeechSynthesizer()
            let u = AVSpeechUtterance(string: piece)
            u.voice = voice
            u.rate = min(max(rate, 0.1), 1.0)

            // **必须持有 synth 到播放结束**：write(_:toBufferCallback:) 是异步的，
            // 局部变量一出作用域就被释放，回调再也不会到达（实测表现：卡死在等 finished）。
            self.lock.lock(); self.synth = synth; self.lock.unlock()

            // write 的回调按顺序分批投递 PCM。先攒齐（语音通常 1~3s 合成完）再一次性排队，
            // 避免边合成边播时首包不足导致卡顿。
            let lock2 = NSLock()
            var finished = false
            var cbCount = 0
            var buffers: [AVAudioPCMBuffer] = []
            var format: AVAudioFormat? = nil
            let done = DispatchSemaphore(value: 0)

            synth.write(u) { buf in
                lock2.lock()
                if let buf = buf as? AVAudioPCMBuffer {
                    cbCount += 1
                    if buf.frameLength > 0 {
                        if format == nil { format = buf.format }
                        // 回调里的 buffer 会被复用，必须深拷贝
                        if let copy = AVAudioPCMBuffer(pcmFormat: buf.format, frameCapacity: buf.frameLength) {
                            copy.frameLength = buf.frameLength
                            let src = UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList)
                            let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
                            for i in 0..<min(src.count, dst.count) {
                                guard let s = src[i].mData, let d = dst[i].mData else { continue }
                                memcpy(d, s, Int(src[i].mDataByteSize))
                                dst[i].mDataByteSize = src[i].mDataByteSize
                            }
                            buffers.append(copy)
                        }
                    }
                } else {
                    finished = true
                }
                let n = cbCount
                lock2.unlock()
                if n == 1 || n % 50 == 0 {
                    emitLine(["ev": "tts_write_cb", "response_id": responseId, "count": n,
                              "finished": finished, "ts_mono_ns": monoNs(), "t_ms": ms()])
                }
                if finished { done.signal() }
            }

            // 等合成完成。`write` 的结束回调**不一定**给 nil，所以主判据是「攒到足够 PCM
            // 且一段时间没有新回调」，另有硬超时兜底——不能只等 nil，否则会永久卡住。
            let t0 = Date()
            var lastCount = -1
            var quietSince = Date()
            while true {
                lock2.lock(); let f = finished; let n = buffers.count; lock2.unlock()
                if f { break }
                if n != lastCount { lastCount = n; quietSince = Date() }
                lock.lock(); let c = speakingResponse != responseId; lock.unlock()
                if c { synth.stopSpeaking(at: .immediate); return true }
                if n > 0 && Date().timeIntervalSince(quietSince) > 0.35 { break }
                if Date().timeIntervalSince(t0) > 20 { break }
                if done.wait(timeout: .now() + 0.05) == .success { break }
            }

            lock2.lock()
            let bufs = buffers
            let fmt = format
            lock2.unlock()
            guard let fmt, !bufs.isEmpty else { return true }

            lock.lock(); let stillMine = speakingResponse == responseId; lock.unlock()
            guard stillMine else { return true }

            player.stop()
            // 与 playFile 同理：**连接格式必须与实际排入的 buffer 通道数一致**。
            // TTS 的 write 回调给的是 1ch，而 mixer 在 AEC 模式下是 4ch，
            // 直接 connect(format: fmt) 再 scheduleBuffer 会触发
            // 'required condition is false: _outputFormat.channelCount == buffer.format.channelCount'。
            let mixFmt = engine.mainMixerNode.outputFormat(forBus: 0)
            engine.connect(player, to: engine.mainMixerNode, format: mixFmt)
            var playBufs: [AVAudioPCMBuffer] = []
            if mixFmt.channelCount == fmt.channelCount, mixFmt.sampleRate == fmt.sampleRate {
                playBufs = bufs
            } else if let conv = AVAudioConverter(from: bufs[0].format, to: mixFmt) {
                for b in bufs {
                    let cap = AVAudioFrameCount(Double(b.frameLength) * mixFmt.sampleRate / fmt.sampleRate) + 64
                    guard let out = AVAudioPCMBuffer(pcmFormat: mixFmt, frameCapacity: cap) else { continue }
                    var used = false
                    var convErr: NSError?
                    conv.convert(to: out, error: &convErr) { _, status in
                        if used { status.pointee = .noDataNow; return nil }
                        used = true
                        status.pointee = .haveData
                        return b
                    }
                    if let convErr {
                        emitLine(["ev": "error", "code": "E_CONVERT", "message": "\(convErr)",
                                  "ts_mono_ns": monoNs(), "t_ms": ms()])
                        break
                    }
                    playBufs.append(out)
                }
            }
            guard !playBufs.isEmpty else {
                emitLine(["ev": "error", "code": "E_CONVERT",
                          "message": "TTS 输出无法转换到 \(mixFmt.channelCount)ch",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
                return true
            }
            player.play()
            player.scheduleBuffer(playBufs[0], at: nil, options: [], completionHandler: nil)
            for b in playBufs.dropFirst() { player.scheduleBuffer(b, at: nil, options: [], completionHandler: nil) }
            // 按排队时长等待播完
            let seconds = Double(playBufs.reduce(0) { $0 + Int64($1.frameLength) }) / mixFmt.sampleRate
            let deadline = Date().addingTimeInterval(seconds + 1.0)
            while Date() < deadline {
                lock.lock(); let c = speakingResponse != responseId; lock.unlock()
                if c { player.stop(); return true }
                if !player.isPlaying && Date() > deadline.addingTimeInterval(-seconds * 0.9) { break }
                Thread.sleep(forTimeInterval: 0.02)
            }
            return true
        }

        func stopSpeak() {
            lock.lock()
            let synth = self.synth
            let player = playerNode
            let had = speakingResponse != nil
            let rid = speakingResponse
            speakingResponse = nil
            lock.unlock()
            if had { synth?.stopSpeaking(at: .immediate) }
            player?.stop()   // TTS 现在走本 engine 的 playerNode，必须一并停
            // **带上真实的 response_id**：上层要据此把对应的播报任务标为取消。
            // 之前固定写 "current" 会让 Python 侧对不上号（R14 修复）。
            emitLine(["ev": "tts_cancelled", "response_id": rid ?? "current", "reason": "stop_speak",
                      "had_playback": had, "ts_mono_ns": monoNs(), "t_ms": ms()])
        }

        func status() {
            lock.lock()
            let age = Date().timeIntervalSince(lastTapAt)
            let running = engine.isRunning
            let listening = utt?.id
            let cal = calibrated
            let sDb = speechDb, qDb = silenceDb
            let speaking = speakingResponse
            let mic = micFormat?.description ?? "-"
            let m = muted, partial = currentPartial
            let lastText = lastFinalText, lastAt = lastFinalAtMs
            lock.unlock()
            var out: [String: Any] = ["ev": "status", "engine_running": running,
                                      "tap_age_ms": Int(age * 1000), "calibrated": cal,
                                      "speech_db": (sDb * 10).rounded() / 10,
                                      "silence_db": (qDb * 10).rounded() / 10,
                                      "mic_format": mic, "muted": m, "mode": "always_on",
                                      "ts_mono_ns": monoNs(), "t_ms": ms()]
            if let listening { out["listening"] = listening }
            if let speaking { out["speaking"] = speaking }
            if let partial { out["current_partial"] = partial }
            if let lastText { out["last_final"] = lastText }
            if let lastAt { out["last_final_at_ms"] = lastAt }
            emitLine(out)
        }

        func shutdown() {
            lock.lock()
            let u = utt
            utt = nil
            let synth = self.synth
            speakingResponse = nil
            lock.unlock()
            synth?.stopSpeaking(at: .immediate)
            u?.continuation?.finish()
            engine.stop()
            watchdog?.cancel()
            emitLine(["ev": "bridge_bye", "ts_mono_ns": monoNs(), "t_ms": ms()])
        }
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
    // --asr-fmt float32：手工指定喂给 analyzer 的格式（诊断用，比较 Int16/Float32 对识别质量的影响）
    var sFormatFinal = sFormat
    if (opt("--asr-fmt") ?? "auto") == "float32",
       let f32 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sFormat.sampleRate,
                               channels: 1, interleaved: false) {
        sFormatFinal = f32
    }
    let bridge = ServeBridge(loc: sAsked, localeID: sLocaleID, asrFormat: sFormatFinal,
                             aec: argv.contains("--aec"), speechDb: speechDb0, silenceDb: silenceDb0,
                             prerollMax: Int(opt("--preroll-buffers") ?? "5") ?? 5)
    bridge.dumpPath = opt("--dump-pcm")
    bridge.micUID = opt("--mic-uid")
    bridge.start()

    // 命令循环：一行一个 JSON；EOF 或 quit 即收工
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
            switch (obj["cmd"] as? String) ?? "" {
            case "listen":     bridge.listen(obj)
            case "stop":       bridge.finish(reason: (obj["reason"] as? String) ?? "stdin")
            case "mute":       bridge.setMuted(true)
            case "unmute":     bridge.setMuted(false)
            case "speak":      bridge.speak(obj)
            case "play":       bridge.playFile(obj)
            case "record":     bridge.recordPair(obj)
            case "stop_speak": bridge.stopSpeak()
            case "status":     bridge.status()
            case "quit":       bridge.shutdown(); exit(0)
            default:
                emitLine(["ev": "error", "code": "E_CMD_UNKNOWN",
                          "message": "不认识的命令：\(obj["cmd"] ?? "-")",
                          "ts_mono_ns": monoNs(), "t_ms": ms()])
            }
        }
        bridge.shutdown()
        exit(0)
    }
    // ⚠ 不能用 `dispatchMain()`：顶层代码含 `await` 时 main 是 async 上下文，
    // 在里面调 `dispatchMain()` 会踩 Swift 并发检查（EXC_BREAKPOINT，实测 crash 报告
    // `mac_speech-2026-10-16-073230` 的主线程栈）。
    //
    // ⚠ 也不能用 `Thread.sleep` 空转：那样**主 RunLoop 不跑**，而
    // `AVSpeechSynthesizer.write(_:toBufferCallback:)` 的合成回调要靠主 RunLoop 派发，
    // 结果是回调永远不到达、TTS 卡死（实测：tts_chunk_started 之后无任何后续事件）。
    //
    // 顶层代码是 async 上下文，`RunLoop.main.run` 在这里**可能不在主线程**上执行，
    // 那样轮转的是「当前线程的 RunLoop 对象」而不是主 RunLoop，仍然不解决回调派发。
    // 所以用 sigaction-free 的做法：主线程上跑 RunLoop，靠 DispatchQueue.main 泵回调。
    let onMain = Thread.isMainThread
    emitLine(["ev": "serve_loop_start", "is_main_thread": onMain,
              "thread": Thread.current.name ?? "-", "ts_mono_ns": monoNs(), "t_ms": ms()])
    while true {
        if onMain {
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        } else {
            // 非主线程：只能靠 RunLoop 泵，但主 RunLoop 的源需要主线程驱动。
            // 这里显式把「泵主 RunLoop」的工作转交给主队列（若主队列仍在跑）。
            DispatchQueue.main.async {
                RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }
}

// ---------------------------------------------------------------- transcribe：录音 + ASR
guard mode == "transcribe" else {
    fail("E_AUDIO_ARGS", "不认识的模式：\(argv.dropFirst().joined(separator: " "))（用 list/stream/transcribe/speak/speak-stream/vad-selftest/request-permission）", 3)
}

let localeID = opt("--locale") ?? "zh_CN"
var audioPath = opt("--file")
let recordSec = Double(opt("--record") ?? "0") ?? 0
var recordMs = 0

if audioPath == nil {
    guard recordSec > 0 else { fail("E_AUDIO_ARGS", "transcribe 要么给 --file <路径>，要么给 --record <秒数>", 3) }
    if micAuth() != "authorized" {
        fail("E_MIC_PERM", "麦克风授权=\(micAuth())（不是 authorized 时录音会静默录到空/静音，转写必然为空）；"
             + "去 系统设置 → 隐私与安全性 → 麦克风 打开承载本进程的 App，或先跑 request-permission", 4)
    }
    let path = NSTemporaryDirectory() + "/mac_speech-\(Int(Date().timeIntervalSince1970)).caf"
    let tRec = Date()
    do {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let fmt = input.inputFormat(forBus: 0)
        guard fmt.sampleRate > 0 else { fail("E_MIC_OPEN", "拿不到麦克风格式（设备被占用？）", 4) }
        let file = try AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: fmt.settings)
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buf, _ in
            try? file.write(from: buf)
        }
        try engine.start()
        Thread.sleep(forTimeInterval: recordSec)      // CLI 里直接睡够时长，简单可靠
        engine.stop()
        input.removeTap(onBus: 0)
    } catch {
        fail("E_AUDIO_REC", "录音失败：\(error)", 5)
    }
    recordMs = Int(Date().timeIntervalSince(tRec) * 1000)
    audioPath = path
    FileHandle.standardError.write(Data(
        "[mac_speech] 录了 \(recordSec)s → \(path)（\(recordMs)ms）\n".utf8))
}

guard #available(macOS 26.0, *) else { fail("E_ASR_OS", "SpeechAnalyzer 需要 macOS 26+", 2) }

let tASR = Date()
var text = ""
do {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: audioPath!))
    let asked = Locale(identifier: localeID)
    let loc = await SpeechTranscriber.supportedLocale(equivalentTo: asked) ?? asked
    let transcriber = SpeechTranscriber(locale: loc, preset: .transcription)
    let assetStatus = await AssetInventory.status(forModules: [transcriber])
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collector = Task { () -> String in
        var out = ""
        for try await r in transcriber.results { out += String(r.text.characters) }
        return out
    }
    if let last = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: last)
    }
    text = try await collector.value
    emitJSON(["ok": true, "data": [
        "text": text,
        "locale": loc.identifier,
        "asset_status": String(describing: assetStatus),
        "audio": audioPath!,
        "record_ms": recordMs,
        "transcribe_ms": Int(Date().timeIntervalSince(tASR) * 1000),
        "elapsed_ms": ms(),
    ]])
    exit(0)
} catch {
    fail("E_ASR_FAIL", "转写失败：\(error)（audio=\(audioPath!)）", 5)
}
