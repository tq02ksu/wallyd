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
//   sh scripts/build_audio_bridge.sh             # AudioBridge.app；serve 由它编译两个源文件
//   AudioBridge serve [--asr system|sherpa] [--tts system|sherpa] [--tts-queue 8] [--aec]
//        [--locale zh_CN]                        # 常驻桥：双管道、engine 可替换
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

// ---------------------------------------------------------------- serve：常驻语音桥
//
// 实现拆到 scripts/mac_speech_pipeline.swift（构建时拼进同一个 main.swift，仍是同一个
// mac_speech 二进制）：拾音/VAD/ASR 与分句/合成/有界队列/渲染是两条独立 worker 管道。
// 命令面只有 listen / stop / speak / stop_speak + mute / unmute / status / quit。
// 引擎参数：--asr system|sherpa、--tts system|sherpa（sherpa 先返回 E_*_NOT_IMPLEMENTED）。
// 新增可观测事件：tts_queued / tts_played / tts_chunk_dropped / aec_erle_db / capture_timing。
#if !VOICE_PIPELINE
func runServeBridgeMode() async {
    fail("E_BUILD", "serve 需要 scripts/build_audio_bridge.sh 构建的 AudioBridge.app（两个源文件一起编译）", 3)
}
#endif
if mode == "serve" { await runServeBridgeMode() }

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
