// AEC3 离线对照实验：用**同一份真实录音**对比 AEC3 与无 AEC。
//
// 为什么不直接用合成回声：AEC 的表现极度依赖真实房间声学（混响、延迟、非线性失真），
// 合成一个线性回声只是给自己一个漂亮的结果。这里读的是桥录下的真实麦克风信号。
//
// 输入：
//   --render <wav>  送进 playerNode 的那份 PCM（软件分叉的参考信号）
//   --capture <wav> 同时录下的麦克风信号（含回声）
// 输出：逐帧 ERLE 统计（均值/中位/P90/最大/最小），以及残余电平相对静音段的比值。
//
// 用法：aec3_eval --render ref.wav --capture mic.wav [--delay-ms 25]
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "api/echo_canceller3_config.h"
#include "api/echo_canceller3_factory.h"
#include "api/echo_control.h"
#include "api/environment.h"
#include "audio_processing/audio_buffer.h"
#include "audio_processing/logging/wav_file.h"

namespace {

constexpr int kRate = 16000;      // AEC3 支持 16k/32k/48k；此处用 16k（与 ASR 一致）
constexpr int kCh = 1;
constexpr int kFrame = 160;       // 10ms @ 16k

double RmsDb(const std::vector<int16_t>& v, size_t from, size_t count) {
    double s = 0.0;
    for (size_t i = from; i < from + count && i < v.size(); ++i) {
        double x = static_cast<double>(v[i]);
        s += x * x;
    }
    double rms = std::sqrt(s / std::max<size_t>(count, 1));
    return 20.0 * std::log10(std::max(rms, 1e-9) / 32768.0);
}

void Fill(webrtc::AudioBuffer* b, const int16_t* d) {
    float* const* ch = b->channels();
    for (int i = 0; i < kFrame; ++i) ch[0][i] = static_cast<float>(d[i]);
}

void Extract(webrtc::AudioBuffer* b, int16_t* out) {
    const float* const* ch = b->channels_const();
    for (int i = 0; i < kFrame; ++i) {
        float s = ch[0][i];
        out[i] = static_cast<int16_t>(s > 32767.f ? 32767.f : (s < -32768.f ? -32768.f : s));
    }
}

}  // namespace

int main(int argc, char** argv) {
    std::string renderPath, capturePath;
    int delayMs = 25;
    bool dump = false;
    std::string outPath;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--render" && i + 1 < argc) renderPath = argv[++i];
        else if (a == "--capture" && i + 1 < argc) capturePath = argv[++i];
        else if (a == "--delay-ms" && i + 1 < argc) delayMs = std::atoi(argv[++i]);
        else if (a == "--dump") dump = true;
        else if (a == "--out" && i + 1 < argc) outPath = argv[++i];
    }
    if (renderPath.empty() || capturePath.empty()) {
        std::fprintf(stderr, "用法：aec3_eval --render ref.wav --capture mic.wav [--delay-ms 25]\n");
        return 2;
    }

    webrtc::WavReader rr(renderPath), cr(capturePath);
    if (rr.sample_rate() != kRate || cr.sample_rate() != kRate) {
        std::fprintf(stderr, "两个 WAV 都必须是 %d Hz（当前 render=%u capture=%u）\n",
                     kRate, rr.sample_rate(), cr.sample_rate());
        return 2;
    }
    if (rr.num_channels() != kCh || cr.num_channels() != kCh) {
        std::fprintf(stderr, "两个 WAV 都必须是单声道\n");
        return 2;
    }

    size_t n = std::min(rr.num_samples(), cr.num_samples());
    n = (n / kFrame) * kFrame;
    std::vector<int16_t> far(n, 0), mic(n, 0);
    rr.ReadSamples(n, far.data());
    cr.ReadSamples(n, mic.data());

    webrtc::Environment env;
    webrtc::EchoCanceller3Config cfg;
    // default_delay 单位是 4ms 块（16k 下 kBlockSize=64 样本）。25 块 = 100ms。
    cfg.delay.default_delay = std::max(1, delayMs / 4);
    cfg.filter.initial_state_seconds = 0.5f;
    cfg.filter.conservative_initial_phase = false;
    webrtc::EchoCanceller3Factory factory(cfg);
    auto aec = factory.Create(env, kRate, kCh, kCh);

    webrtc::AudioBuffer renderBuf(kRate, kCh, kRate, kCh, kRate, kCh);
    webrtc::AudioBuffer captureBuf(kRate, kCh, kRate, kCh, kRate, kCh);

    std::vector<int16_t> out(n, 0);
    size_t frames = n / kFrame;
    for (size_t f = 0; f < frames; ++f) {
        size_t off = f * kFrame;
        Fill(&renderBuf, far.data() + off);
        aec->AnalyzeRender(&renderBuf);
        Fill(&captureBuf, mic.data() + off);
        aec->AnalyzeCapture(&captureBuf);
        aec->ProcessCapture(&captureBuf, false);
        Extract(&captureBuf, out.data() + off);
    }

    // 逐 100ms 窗统计 ERLE，避免被整体均值掩盖句内起伏（这正是之前踩过的坑）
    //
    // **只统计真正有回声的窗**：静音窗里 mic 只有本底，AEC3 对它的 ERLE 天然是 0 dB，
    // 计进去会把 P10 拉到 0，得到一个「最差情况很糟」的假结论（实测踩过这次坑）。
    // 判据：该窗 mic 电平比所有窗的最小值（≈本底）高出 10 dB 以上。
    std::vector<double> erles;
    std::vector<std::pair<size_t,double>> allWin;   // (起点, ERLE)
    std::vector<double> winMicDb;
    const size_t win = kFrame * 10;   // 100ms
    for (size_t p = 0; p + win <= n; p += win) {
        double mp = 0, op = 0;
        for (size_t i = p; i < p + win; ++i) {
            double m = mic[i], o = out[i];
            mp += m * m; op += o * o;
        }
        double mdb = 10.0 * std::log10(std::max(mp / win, 1e-9));
        double odb = 10.0 * std::log10(std::max(op / win, 1e-9));
        winMicDb.push_back(mdb);
        allWin.push_back({p, mp < 1e-6 ? 0.0 : 10.0 * std::log10(mp / std::max(op, 1e-6))});
        if (dump) {
            std::printf("  t=%5.2fs  mic=%7.1f dB  out=%7.1f dB  ERLE=%6.1f\n",
                        (double)p / kRate, mdb, odb, allWin.back().second);
        }
    }
    double floorDb = *std::min_element(winMicDb.begin(), winMicDb.end());
    for (size_t k = 0; k < allWin.size(); ++k) {
        if (winMicDb[k] > floorDb + 10.0) erles.push_back(allWin[k].second);
    }

    double inDb = RmsDb(mic, 0, n), outDb = RmsDb(out, 0, n);
    std::printf("输入(mic) RMS  %8.2f dB\n", inDb);
    std::printf("输出(aec) RMS  %8.2f dB\n", outDb);
    std::printf("整体抑制       %8.2f dB\n", inDb - outDb);
    if (!erles.empty()) {
        std::vector<double> s = erles;
        std::sort(s.begin(), s.end());
        auto pct = [&](double q) { return s[(size_t)(q * (s.size() - 1))]; };
        std::printf("\n逐 100ms 窗 ERLE（%zu 窗）\n", s.size());
        std::printf("  中位 %6.1f  均值 %6.1f  P10 %6.1f  P90 %6.1f  最大 %6.1f  最小 %6.1f\n",
                    pct(0.5), [&]{ double t=0; for(double v:s)t+=v; return t/s.size(); }(),
                    pct(0.1), pct(0.9), s.back(), s.front());
    } else {
        std::printf("没有有效窗（录音太安静？）\n");
    }
    if (!outPath.empty()) {
        webrtc::WavWriter w(outPath, kRate, kCh);
        w.WriteSamples(out.data(), out.size());
        std::printf("\n残差已写出：%s\n", outPath.c_str());
    }
    return 0;
}
