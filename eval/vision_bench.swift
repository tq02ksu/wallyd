// 快路径基线：macOS 自带 Vision 框架的**单帧延迟**实测（无外部权重、无下载）。
// 编译：swiftc -O -o vision_bench vision_bench.swift
// 用法：./vision_bench img1.jpg img2.jpg ...   （输出 CSV：image,case,first_ms,mean_ms,min_ms,results）
import Foundation
import Vision
import ImageIO
import CoreGraphics

func timeCase(_ cg: CGImage, _ make: () -> VNRequest, warmup: Int, iters: Int)
    -> (first: Double, mean: Double, min: Double, n: Int) {
    var times: [Double] = []
    var first = -1.0
    var count = 0
    for i in 0..<(warmup + iters) {
        let req = make()
        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        let t0 = CFAbsoluteTimeGetCurrent()
        do { try handler.perform([req]) } catch { return (-2, -2, -2, -2) }
        let dt = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0
        if i < warmup {
            if i == 0 { first = dt }
            continue
        }
        times.append(dt)
        count = (req.results ?? []).count
    }
    let mean = times.reduce(0, +) / Double(times.count)
    return (first, mean, times.min() ?? -1, count)
}

let paths = Array(CommandLine.arguments.dropFirst())
guard !paths.isEmpty else {
    FileHandle.standardError.write("usage: vision_bench <image>...\n".data(using: .utf8)!)
    exit(2)
}

let warmup = Int(ProcessInfo.processInfo.environment["WARMUP"] ?? "") ?? 1
let iters = Int(ProcessInfo.processInfo.environment["ITERS"] ?? "") ?? 5

print("image,case,first_ms,mean_ms,min_ms,results")

for path in paths {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        print("\((path as NSString).lastPathComponent),<load-failed>,,,, ")
        continue
    }
    let name = (path as NSString).lastPathComponent

    var cases: [(String, () -> VNRequest)] = [
        ("VNClassifyImageRequest", { VNClassifyImageRequest() }),
        ("VNRecognizeAnimalsRequest", { VNRecognizeAnimalsRequest() }),
        ("VNDetectHumanRectanglesRequest", { VNDetectHumanRectanglesRequest() }),
        ("VNDetectFaceRectanglesRequest", { VNDetectFaceRectanglesRequest() }),
        ("VNDetectRectanglesRequest", { VNDetectRectanglesRequest() }),
        ("VNGenerateObjectnessBasedSaliencyImageRequest", { VNGenerateObjectnessBasedSaliencyImageRequest() }),
        ("VNGenerateForegroundInstanceMaskRequest", { VNGenerateForegroundInstanceMaskRequest() }),
    ]

    for (label, make) in cases {
        let r = timeCase(cg, make, warmup: warmup, iters: iters)
        print(String(format: "%@,%@,%.1f,%.1f,%.1f,%d", name, label, r.first, r.mean, r.min, r.n))
    }
}
