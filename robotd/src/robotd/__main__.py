"""命令行入口：``python -m robotd`` / ``robotd``。

配置优先级（从低到高）：内置默认 → 环境变量 → 命令行参数。

``serve`` 现在会真正启动 HTTP/WS 传输层（R09/R10）：``api.http.serve()`` 绑定回环端口，
先把 active 监听建立成功再打印 listening，失败（端口被占等）直接以非零退出并说明原因。
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import threading
from typing import Sequence

from . import __version__
from .app import App, resolve_work_dir, setup_logging
from .config import DEFAULT_HTTP_PORT, DEFAULT_SERIAL_BAUD, DEFAULT_SERIAL_PORT, Config, from_env
from .core.errors import RobotdError

log = logging.getLogger("robotd.main")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="robotd",
        description="Mac mini 移动机器人身体运行时（Python，迁移期与 TS POC 并存）",
        epilog=("同一串口只能有一个实际持有者：本进程与旧 TS robotd 不得同时连接真机。"),
    )
    p.add_argument("--version", action="version", version=f"robotd {__version__}")
    p.add_argument("--sim", action="store_true", help="仿真模式（无硬件）")
    p.add_argument("--bind", default=None, help="监听地址，只允许回环（默认 127.0.0.1）")
    p.add_argument("--http", type=int, default=None, help=f"HTTP 端口（默认 {DEFAULT_HTTP_PORT}）")
    p.add_argument(
        "--port",
        "--serial-port",
        dest="serial_port",
        default=None,
        help=f"串口设备（默认 {DEFAULT_SERIAL_PORT}）",
    )
    p.add_argument("--baud", type=int, default=None, help=f"串口波特率（默认 {DEFAULT_SERIAL_BAUD}）")
    p.add_argument("--robot-id", default=None, help="稳定机器人标识")
    p.add_argument("--modeld", default=None, help="modeld 端点（默认 http://127.0.0.1:8790）")
    p.add_argument("--model", default=None, help="modeld 模型 id")
    p.add_argument("--work-dir", default=None, help="运行产物目录（默认 <项目根>/work）")
    p.add_argument("--debug", action="store_true", help="打开调试旁路（不进公开工具面）")
    p.add_argument("--json-log", action="store_true", help="日志输出 JSON 行")
    p.add_argument(
        "--audio-bridge",
        default=None,
        help="常驻语音桥：(默认) 不装配；auto = <work>/bin/AudioBridge.app；或直接给 .app 路径",
    )
    p.add_argument("--audio-locale", default="zh_CN", help="语音识别语言（默认 zh_CN）")
    p.add_argument(
        "--audio-aec",
        action="store_true",
        help=(
            "开启输入侧语音处理（AEC/NS）。注意实测（eval/r14-voice-bringup-2026-10-24.md §5.2）："
            "它能压掉约 30dB 回声但只在前 1.5 秒有效，之后残留仍高于说话门限——"
            "目前**不足以支撑 barge-in**，播报期间仍会屏蔽自动识别。默认关闭。"
        ),
    )

    sub = p.add_subparsers(dest="command")
    # 子 parser 不重复定义父级选项：argparse 会用它覆盖父级解析结果。
    sub.add_parser("check-config", help="只做配置校验并打印生效配置（不启动任何设备）")
    sub.add_parser("health", help="打印本进程构建信息与契约版本")
    sub.add_parser("serve", help="启动服务（传输层待 R09/R10，当前只验证监听与生命周期）")
    return p


def _config_from_args(args: argparse.Namespace) -> Config:
    base = from_env(Config())
    return base.with_overrides(
        sim=True if args.sim else None,
        bind=args.bind,
        http_port=args.http,
        serial_port=args.serial_port,
        serial_baud=args.baud,
        robot_id=args.robot_id,
        modeld_url=args.modeld,
        model_id=args.model,
        work_dir=args.work_dir,
        debug=True if args.debug else None,
        log_json=True if args.json_log else None,
    )


def _split_command(raw: list[str]) -> tuple[str, list[str]]:
    """把子命令从参数里摘出来，其余选项交给父 parser。

    argparse 的 subparsers 会把子命令之后的全部 token 交给子 parser，
    而子 parser 不定义父级选项 —— 于是 ``robotd check-config --sim`` 会报
    ``unrecognized arguments``。这里统一归一化成 ``['check-config', '--sim']``
    再交给父 parser 解析，两种书写顺序都能用。
    """
    commands = {"check-config", "health", "serve"}
    command = "serve"
    rest: list[str] = []
    for item in raw:
        if item in commands and command == "serve":
            command = item
            continue
        rest.append(item)
    return command, rest


def main(argv: Sequence[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    command, rest = _split_command(raw)
    parser = build_parser()
    # 只解析父级选项：子 parser 用 parse_known，未识别的由父级报错
    args, unknown = parser.parse_known_args(rest)
    if unknown:
        parser.error(f"unrecognized arguments: {' '.join(unknown)}")
    args.command = command

    try:
        config = _config_from_args(args)
    except RobotdError as exc:
        print(f"robotd: {exc.to_public()['error']['code']} {exc.message}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - 配置校验失败要给人看得懂的原因
        print(f"robotd: {exc}", file=sys.stderr)
        return 2

    setup_logging(json=config.log_json)

    if command == "health":
        print(
            json.dumps(
                {
                    "service": "robotd",
                    "implementation_version": __version__,
                    "contract_version": 1,
                    "protocol": 2,
                    "python": sys.version.split()[0],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    if command == "check-config":
        print(
            json.dumps(
                {
                    "config": {
                        "bind": config.bind,
                        "http_port": config.http_port,
                        "robot_id": config.robot_id,
                        "sim": config.sim,
                        "debug": config.debug,
                        "transport": config.transport_kind,
                        "serial_port": config.serial_port,
                        "serial_baud": config.serial_baud,
                        "modeld_url": config.modeld_url,
                        "heartbeat_hz": config.heartbeat_hz,
                        "board_watchdog_ms": config.board_watchdog_ms,
                    },
                    "work_dir": str(resolve_work_dir(config)),
                    "note": "check-config 不打开串口、不启动子进程、不监听端口",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    log.info(
        "启动 robotd %s（instance 即将生成）sim=%s bind=%s:%s",
        __version__,
        config.sim,
        config.bind,
        config.http_port,
    )
    if not config.sim:
        log.warning(
            "真机模式：串口适配（R11）尚未实现。本进程不会打开 %s，"
            "也不会驱动电机；旧 TS robotd 若在运行请勿同时占用该串口。",
            config.serial_port,
        )

    app = App(config)
    if config.sim:
        from .devices.sim import SimBoard

        app.attach_sim_board(SimBoard())
    try:
        app.start()
    except RobotdError as exc:
        log.error("启动失败：%s", exc.message)
        return 1

    # 语音桥（R14）：**在板侧就绪之后装配**，且失败不阻断启动——
    # 语音坏掉时用户仍要能通过 /v1/robot/stop 停下机器人。
    if args.audio_bridge is not None:
        from pathlib import Path as _Path

        if args.audio_bridge.lower() == "auto":
            from .app import resolve_work_dir as _resolve

            bridge_path = _resolve(config) / "bin" / "AudioBridge.app"
        else:
            bridge_path = _Path(args.audio_bridge).expanduser().resolve()
        app.attach_audio_bridge(bridge_path, locale=args.audio_locale, aec=args.audio_aec)

    app.install_signal_handlers()

    from .api.http import serve

    try:
        server = serve(app, bind=config.bind, port=config.http_port, debug=config.debug)
    except RobotdError as exc:
        log.error("%s", exc.message)
        app.shutdown()
        return 1
    except OSError as exc:
        log.error("无法监听 %s:%s：%s", config.bind, config.http_port, exc.strerror or exc)
        app.shutdown()
        return 1

    app.transport = server
    thread = threading.Thread(target=server.serve_forever, name="robotd-http", daemon=True)
    thread.start()
    log.info(
        "listening http://%s:%s  instance_id=%s  debug=%s  sim=%s",
        config.bind,
        config.http_port,
        app.instance_id,
        config.debug,
        config.sim,
    )
    log.info("state=%s", json.dumps(app.snapshot(), ensure_ascii=False))
    try:
        app._stopping.wait()
    finally:
        server.shutdown()
        server.server_close()
        app.shutdown()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
