// 列出 macOS（AVFoundation）能当相机用的设备 —— 判"这颗摄像头到底能不能用"。
// 用法：swift src/tools/cam_list.swift
import AVFoundation
import Foundation

let types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .external, .continuityCamera, .deskViewCamera]
let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified)
print("video devices = \(discovery.devices.count)")
for d in discovery.devices {
    print("- \(d.localizedName)  uniqueID=\(d.uniqueID)  modelID=\(d.modelID)")
}
if discovery.devices.isEmpty {
    print("=> macOS 看不到任何可用摄像头：这颗是非 UVC（私有协议），系统无法驱动")
}
