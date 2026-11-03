// uvc_capture —— UVC 摄像头抓帧的**原生桥**（POC 运行时依赖，不是探针）。
//
// 契约（见 architecture.md §8.4 / communication-protocol §4）：
//   spawn(swift, ["uvc_capture.swift", ...flags]) → **stdout 恰好一行 JSON**：{"ok":true,"data":{...}}
//   诊断一律走 stderr，不污染 stdout（RobotD 只解析 stdout）。
//
// 用法：
//   swift projects/robot/scripts/uvc_capture.swift list
//   swift projects/robot/scripts/uvc_capture.swift capture --out /tmp/a.jpg --width 1280 --height 720
//
// 参数：
//   --out      输出文件（默认 /tmp/uvc_capture.jpg）
//   --width/--height  目标格式（不给则用设备默认档）
//   --device   设备名子串（默认取第一个视频设备）
//   --timeout  等帧超时秒数（默认 10）
//   --quality  JPEG 质量 0–1（默认 0.85）
//   --fps      钉格式时限帧率（默认 10；0 = 不限制）。**这颗 HDI 摄像头只有未压缩 420v/yuvs**，
//              1280×720@30 就要约 332Mbps，USB2 带宽临界——出去帧时好时坏。只抓一帧不需要 30fps。
//   --rotate   0 | 180（默认 0）。**装车朝向倒装时用 180 摆正**——注意 180° 会把画面左右也翻过来，
//              视觉伺服算转向时必须和取帧用同一个朝向，否则转向符号会反。
//
// 退出码：0 成功；2 无设备；3 参数错；4 打不开设备/未授权；5 写文件失败；6 等帧超时
//
// 两个实测坑（来自 [[camera-detection]] §0.4）：
//   ① `sessionPreset = .high` 会覆盖 `activeFormat`，而 macOS 上 `AVCaptureSessionPresetInputPriority`
//      被标为 unavailable ⇒ 必须在 **session 跑起来之后**再钉一次格式；
//   ② 首帧即真图，但未授权时 session 会静默不出帧（表现为等帧超时，不是报错）。
import AVFoundation
import Foundation
import CoreImage
import ImageIO

// ---------------------------------------------------------------- 输出契约
func emitJSON(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]))
        ?? Data(#"{"ok":false,"error":{"code":"E_CAM_INTERNAL","message":"json encode failed"}}"#.utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String, _ message: String, _ exitCode: Int32) -> Never {
    emitJSON(["ok": false, "error": ["code": code, "message": message]])
    FileHandle.standardError.write(Data("[uvc_capture] \(message)\n".utf8))
    exit(exitCode)
}

func opt(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

let argv = CommandLine.arguments
let mode: String = {
    if argv.contains("list") || argv.contains("--list") { return "list" }
    if argv.contains("request-permission") || argv.contains("--request-permission") { return "request-permission" }
    return "capture"
}()
let t0 = Date()

/// 本进程的摄像头授权状态。**这就是"session 起来了却收不到帧"的头号原因**：
/// notDetermined/denied 时 AVFoundation 不会报错，只是永远不出帧。
func cameraAuth() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

// 第一次跑必然卡在这里：没有任何授权时，AVFoundation 会静默不出帧（不报错）。
// 这个模式负责把系统授权弹窗触发出来，并等一个明确结果。
if mode == "request-permission" {
    if cameraAuth() == "authorized" {
        emitJSON(["ok": true, "data": ["camera_authorization": "authorized", "granted": true,
                                       "note": "已有授权，无需再弹窗"]])
        exit(0)
    }
    FileHandle.standardError.write(Data(
        "[uvc_capture] 请求摄像头授权：若系统弹出对话框请点「允许」；没弹窗就去 系统设置 → 隐私与安全性 → 摄像头 手动打开承载本进程的 App。\n".utf8))
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .video) { ok in granted = ok; sem.signal() }
    if sem.wait(timeout: .now() + 90) == .timedOut {
        fail("E_CAM_PERM_TIMEOUT", "90s 内没等到授权结果（当前=\(cameraAuth())）", 4)
    }
    let after = cameraAuth()
    emitJSON(["ok": granted, "data": ["camera_authorization": after, "granted": granted]])
    exit(granted ? 0 : 4)
}

let types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .external,
                                           .continuityCamera, .deskViewCamera]
let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video,
                                                 position: .unspecified)
let devices = discovery.devices

func fourCC(_ sub: FourCharCode) -> String {
    String(bytes: [UInt8((sub >> 24) & 0xff), UInt8((sub >> 16) & 0xff),
                   UInt8((sub >> 8) & 0xff), UInt8(sub & 0xff)], encoding: .ascii) ?? "?"
}

// ---------------------------------------------------------------- list：设备与格式
if mode == "list" {
    let list: [[String: Any]] = devices.enumerated().map { (i, d) in
        let formats: [[String: Any]] = d.formats.map { f in
            let dim = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let fps = f.videoSupportedFrameRateRanges
                .map { [$0.minFrameRate, $0.maxFrameRate] }
            return ["width": Int(dim.width), "height": Int(dim.height),
                    "fourcc": fourCC(CMFormatDescriptionGetMediaSubType(f.formatDescription)),
                    "fps": fps]
        }
        return ["index": i, "name": d.localizedName, "uniqueID": d.uniqueID,
                "modelID": d.modelID,
                // 独占设备：被别的 App 占着时 session 会「running 但不出帧」（表现为等帧超时）
                "in_use_by_another_app": d.isInUseByAnotherApplication,
                "formats": formats]
    }
    emitJSON(["ok": true, "data": ["camera_authorization": cameraAuth(),
                                   "devices": list,
                                   "elapsed_ms": Int(Date().timeIntervalSince(t0) * 1000)]])
    exit(0)
}

// ---------------------------------------------------------------- capture：抓一帧
guard let device = opt("--device").map({ want in
    devices.first { $0.localizedName.localizedCaseInsensitiveContains(want) }
}) ?? devices.first else {
    fail("E_CAM_NODEV", "没有可用的视频设备（在 USB 上认到不等于 AVFoundation 认到）", 2)
}

let out = opt("--out") ?? "/tmp/uvc_capture.jpg"
let wantW = opt("--width").flatMap(Int.init)
let wantH = opt("--height").flatMap(Int.init)
let quality = Double(opt("--quality") ?? "0.85") ?? 0.85
let wantFps = Double(opt("--fps") ?? "10") ?? 10          // 0 = 不限制
let rotate = Int(opt("--rotate") ?? "0") ?? 0
guard rotate == 0 || rotate == 180 else { fail("E_CAM_ARGS", "--rotate 只支持 0 或 180", 3) }
if (wantW == nil) != (wantH == nil) { fail("E_CAM_ARGS", "--width 与 --height 必须成对给", 3) }
let timeoutSec = Double(opt("--timeout") ?? "10") ?? 10

/// 钉格式。macOS 上 preset 会覆盖 activeFormat，所以 startRunning 之后要再来一次。
func applyWantedFormat(_ tag: String) {
    guard let w = wantW, let h = wantH else { return }
    do {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        let cands = device.formats.filter {
            let d = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
            return Int(d.width) == w && Int(d.height) == h
        }
        guard let best = cands.max(by: { a, b in
            (a.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0)
                < (b.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0)
        }) else {
            FileHandle.standardError.write(Data("[uvc_capture] \(tag): 设备不支持 \(w)x\(h)，保持当前档\n".utf8))
            return
        }
        device.activeFormat = best
        if let r = best.videoSupportedFrameRateRanges.max(by: { $0.maxFrameRate < $1.maxFrameRate }) {
            // 限帧率＝直接限带宽（见文件头 --fps 说明）。只要一帧，不需要跑满 30fps。
            let target = wantFps > 0 ? min(wantFps, r.maxFrameRate) : r.maxFrameRate
            if target >= r.minFrameRate {
                device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: CMTimeScale(target * 1000))
            }
            FileHandle.standardError.write(Data(
                "[uvc_capture] \(tag): \(w)x\(h) fps<=\(String(format: "%.0f", target)) （格式 \(fourCC(CMFormatDescriptionGetMediaSubType(best.formatDescription)))）\n".utf8))
        }
    } catch {
        FileHandle.standardError.write(Data("[uvc_capture] \(tag): lockForConfiguration 失败 \(error)\n".utf8))
    }
}

applyWantedFormat("before-start")

let session = AVCaptureSession()
session.sessionPreset = .high
guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
    fail("E_CAM_OPEN", "打不开 \(device.localizedName)（TCC 未授权 / 设备被占用）", 4)
}
session.addInput(input)

let output = AVCaptureVideoDataOutput()
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)]
output.alwaysDiscardsLateVideoFrames = true
let ciContext = CIContext()
let outURL = URL(fileURLWithPath: out)

final class Grabber: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    // 嵌套类不能闭包捕获外部局部变量，一律走 init 传进来（探针版踩过同一个坑）
    let out: String
    let quality: Double
    let rotate: Int
    let deviceName: String
    let session: AVCaptureSession
    let ctx: CIContext
    var done = false
    var seen = 0
    init(out: String, quality: Double, rotate: Int, deviceName: String,
         session: AVCaptureSession, ctx: CIContext) {
        self.out = out; self.quality = quality; self.rotate = rotate
        self.deviceName = deviceName; self.session = session; self.ctx = ctx
    }
    func captureOutput(_ o: AVCaptureOutput, didOutput sb: CMSampleBuffer, from c: AVCaptureConnection) {
        seen += 1
        guard !done, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        done = true
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        var img = CIImage(cvPixelBuffer: pb)
        if rotate == 180 {
            img = img.transformed(by: CGAffineTransform(rotationAngle: .pi))
            img = img.transformed(by: CGAffineTransform(translationX: CGFloat(w), y: CGFloat(h)))
        }
        guard let cg = ctx.createCGImage(img, from: img.extent) else {
            fail("E_CAM_WRITE", "CGImage 转换失败", 5)
        }
        guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.jpeg" as CFString, 1, nil) else {
            fail("E_CAM_WRITE", "无法创建 JPEG 输出 \(out)", 5)
        }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        let ok = CGImageDestinationFinalize(dest)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: out))?[.size] as? Int ?? 0
        session.stopRunning()
        if !ok { fail("E_CAM_WRITE", "JPEG 落盘失败 \(out)", 5) }
        emitJSON(["ok": true, "data": [
            "out": out, "device": deviceName,
            "width": cg.width, "height": cg.height, "rotate": rotate,
            "bytes": bytes, "frames_seen": seen,
            "elapsed_ms": Int(Date().timeIntervalSince(t0) * 1000),
        ]])
        exit(0)
    }
}

let grabber = Grabber(out: out, quality: quality, rotate: rotate,
                      deviceName: device.localizedName, session: session, ctx: ciContext)
output.setSampleBufferDelegate(grabber, queue: DispatchQueue(label: "uvc.capture"))
guard session.canAddOutput(output) else { fail("E_CAM_OPEN", "canAddOutput=false", 4) }
session.addOutput(output)

session.startRunning()
guard session.isRunning else { fail("E_CAM_PERM", "session 未启动（TCC 未授权或设备被占用）", 4) }
applyWantedFormat("after-start")

DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSec) {
    let dim = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
    fail("E_CAM_TIMEOUT",
         "\(Int(timeoutSec))s 没拿到帧（已收 \(grabber.seen) 个 buffer，activeFormat=\(dim.width)x\(dim.height)）"
         + " —— 摄像头授权=\(cameraAuth())（授权不是 authorized 时 AVFoundation 会**静默不出帧**），"
         + "或设备被别的 App 独占；跑 `request-permission` 可触发授权",
         6)
}
RunLoop.main.run()
