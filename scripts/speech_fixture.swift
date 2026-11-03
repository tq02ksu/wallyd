// speech_fixture —— 生成「静音 + 合成语音 + 静音」的测试音频，供 mac_speech.swift stream --file 离线回归。
//
// 为什么需要它：VAD 端点检测要「说过话之后再静音」才会触发，光用 say 生成的文件两端没有足够静音，
// 测不到端点。这里用 AVSpeechSynthesizer.write 拿到 PCM，自己拼上前后静音，落成 16kHz 单声道 CAF。
//
// 用法：
//   swift projects/robot/scripts/speech_fixture.swift --text "你好，我是移动机器人" \
//     --out work/eval/speech/zh_test.caf [--lead-ms 400] [--tail-ms 1200] [--voice <identifier>] [--rate 0.5]
import Foundation
import AVFAudio

func opt(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

func fail(_ code: String, _ msg: String) -> Never {
    let obj: [String: Any] = ["ok": false, "error": ["code": code, "message": msg]]
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(d); FileHandle.standardOutput.write(Data("\n".utf8))
    }
    FileHandle.standardError.write(Data("[speech_fixture] \(msg)\n".utf8))
    exit(1)
}

let text = opt("--text") ?? "你好，我是移动机器人。现在开始测试语音识别。"
let outPath = opt("--out") ?? "work/eval/speech/fixture.caf"
let leadMs = Double(opt("--lead-ms") ?? "400") ?? 400
let tailMs = Double(opt("--tail-ms") ?? "1200") ?? 1200
let rate = Float(opt("--rate") ?? "0.5") ?? 0.5
let voiceID = opt("--voice")

let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
let sr = outFmt.sampleRate

final class Collector: NSObject, AVSpeechSynthesizerDelegate {
    var buffers: [AVAudioPCMBuffer] = []
    let done = DispatchSemaphore(value: 0)
}
let collector = Collector()
let synth = AVSpeechSynthesizer()

var voice: AVSpeechSynthesisVoice? = nil
if let id = voiceID { voice = AVSpeechSynthesisVoice(identifier: id) }
if voice == nil { voice = AVSpeechSynthesisVoice(language: "zh-CN") }
guard let useVoice = voice else { fail("E_TTS_VOICE", "找不到中文音色") }

let utterance = AVSpeechUtterance(string: text)
utterance.voice = useVoice
utterance.rate = min(max(rate, 0.1), 1.0)

// write(_:toBufferCallback:) 在内部线程回调；收集副本，完成后统一转换落盘。
synth.write(utterance) { buffer in
    if let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength == 0 {
        collector.done.signal()          // 结束标记：零长度缓冲
        return
    }
    if let pcm = buffer as? AVAudioPCMBuffer, let copy = AVAudioPCMBuffer(pcmFormat: pcm.format, frameCapacity: pcm.frameLength) {
        copy.frameLength = pcm.frameLength
        let ch = Int(pcm.format.channelCount)
        if let src = pcm.floatChannelData, let dst = copy.floatChannelData {
            for c in 0..<ch { memcpy(dst[c], src[c], Int(pcm.frameLength) * MemoryLayout<Float>.size) }
        } else if let src = pcm.int16ChannelData, let dst = copy.int16ChannelData {
            for c in 0..<ch { memcpy(dst[c], src[c], Int(pcm.frameLength) * MemoryLayout<Int16>.size) }
        }
        collector.buffers.append(copy)
    }
}

// 跑 runloop 等合成结束（write 回调期间不能阻塞主线程）
let deadline = DispatchTime.now() + 30
while collector.done.wait(timeout: .now() + 0.05) != .success {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    if DispatchTime.now() > deadline { break }
}

guard !collector.buffers.isEmpty else { fail("E_TTS_EMPTY", "合成没有产出任何音频（voice=\(useVoice.identifier)）") }

// 收集到的分片转成 16k mono
var samples: [Float] = []
for buf in collector.buffers {
    guard let conv = AVAudioConverter(from: buf.format, to: outFmt) else { continue }
    let ratio = outFmt.sampleRate / buf.format.sampleRate
    let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { continue }
    var err: NSError?
    var fed = false
    conv.convert(to: out, error: &err) { _, status in
        if fed { status.pointee = .noDataNow; return nil }
        fed = true; status.pointee = .haveData
        return buf
    }
    if err == nil, let p = out.floatChannelData {
        samples.append(contentsOf: UnsafeBufferPointer(start: p[0], count: Int(out.frameLength)))
    }
}
guard !samples.isEmpty else { fail("E_TTS_EMPTY", "转换后没有样本") }

// 拼前后静音 → 落盘
let lead = [Float](repeating: 0, count: Int(leadMs / 1000 * sr))
let tail = [Float](repeating: 0, count: Int(tailMs / 1000 * sr))
let all = lead + samples + tail

let url = URL(fileURLWithPath: outPath)
try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
guard let file = try? AVAudioFile(forWriting: url, settings: outFmt.settings) else {
    fail("E_WRITE", "写不了 \(outPath)")
}
guard let pcm = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: AVAudioFrameCount(all.count)) else {
    fail("E_WRITE", "分配输出缓冲失败")
}
pcm.frameLength = AVAudioFrameCount(all.count)
all.withUnsafeBufferPointer { src in
    pcm.floatChannelData![0].update(from: src.baseAddress!, count: all.count)
}
do { try file.write(from: pcm) } catch { fail("E_WRITE", "写文件失败：\(error)") }

let obj: [String: Any] = ["ok": true, "data": [
    "path": url.path,
    "voice": useVoice.identifier,
    "text": text,
    "sample_rate": Int(sr),
    "speech_ms": Int(Double(samples.count) / sr * 1000),
    "lead_ms": Int(leadMs), "tail_ms": Int(tailMs),
    "total_ms": Int(Double(all.count) / sr * 1000),
]]
if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(d); FileHandle.standardOutput.write(Data("\n".utf8))
}
