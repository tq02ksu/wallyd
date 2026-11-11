export interface paths {
    "/v1/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 服务存活与版本信息 */
        get: operations["robot_health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/robot/state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 机器人整体状态快照 */
        get: operations["robot_state"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/robot/odometry/calibration": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 读取当前标定参数（steps_per_m / wheelbase_mm）与生效层
         * @description 标定值归属与下发见 ADR-0002：`steps_per_m` / `wheelbase_mm` 由 robotd 掌握并下发给板侧，
         *     改参数**不需要重刷固件**。返回 `source` 表示当前值来自默认、板侧回读还是 host 覆盖。
         */
        get: operations["robot_calibration_get"];
        /** 设置标定参数并下发到板侧（无需重刷固件） */
        put: operations["robot_calibration_set"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/robot/speak": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 请求机器人播报 */
        post: operations["robot_speak"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/robot/announce": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 系统播报审批复述（不调用需审批的 robot_speak）
         * @description robotd 内部的系统播报路径：只接受结构化的审批复述请求，由 robotd 用固定模板渲染，
         *     **不接受任意自由文本**（没有 `text` 字段；未知字段一律 400）。
         *
         *     与 `/v1/robot/speak` 的区别是契约级的，不是「调用方自觉」：
         *
         *     - 本端点不要求审批，因为它本身就是审批链路的一环；
         *     - 因此它只念审批复述与系统提示，参数必须来自 agentd 的审批记录
         *       （`approval_id` + 固定 `kind` + 有界 `action_label`/`args_summary`）；
         *     - 播报完成后由 `speech.tts_finished`（带 `approval_id`/`kind`）告知调用方
         *       **真的播完了**，而不是「请求已受理」。agentd 必须等这条事件才开启确认窗口。
         *
         *     可被 `robot_stop` 打断：停止会中止当前播报并发出 `speech.tts_cancelled`，
         *     调用方不得因「请求已受理」就认为已经问过用户。
         */
        post: operations["robot_announce"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/audio/state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 音频现状（常听开关 / 识别状态 / 本底门限 / 最近一句），识别结果经 /v1/events 事件流实时推送 */
        get: operations["audio_state"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/audio/mute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 暂停常听（不产生 utterance、不跑 ASR） */
        post: operations["audio_mute"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/audio/unmute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 恢复常听 */
        post: operations["audio_unmute"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/speech/listen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 开始流式听音（默认说完自动收尾），识别结果经 /v1/events 推送 */
        post: operations["speech_listen"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/speech/abort": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 中止当前播报（barge-in 的对外能力），幂等
         * @description **这是「停止播报」，不是「取消任务」**：barge-in 是正常结束，调用方不应把
         *     未播完的句子当成失败。无活动播报时同样返回 200（幂等），因为用户可能连说两次「停」。
         *     终态以 `speech.tts_cancelled{reason, played, dropped?, queue_dropped?}` 为准；
         *     本端点只表示请求已受理。
         *     `response_id` 省略表示停掉当前所有播报；给了就只停对应那一轮。
         */
        post: operations["speech_abort"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/robot/follow": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 跟随目标人物
         * @description 机器人语义能力：调用方表达「跟随哪个目标」，robotd 负责目标跟踪、跟随控制、运动任务与安全停止。
         *     不是通用自然语言接口，不保证是无人看护安全的自主行驶。
         *     **目标绑定来源必须唯一**：给 `target_track_id` 就只跟这条 track；只给 `target` 时是语义描述，
         *     需要机器人自行确定目标，歧义时由调用方澄清而非机器人私自切换。
         *     目标丢失、观测过期、相机/链路故障时**停止并提交明确终态**，默认不自动旋转搜索。
         */
        post: operations["robot_follow"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/robot/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 立即停止运动，幂等可抢占
         * @description 有序软件停止：无 task id、无需审批、幂等、可抢占普通运动任务。**不是硬件急停**，
         *     不保证断开驱动使能。响应只表示访问已受理，**不表示物理静止**（板侧应答 ≠ 物理静止证明）。
         *     是否连带取消语音/音频任务见 `x-cancels`。超时未收到板侧应答时返回 504/E_TIMEOUT，
         *     调用方不得据此认为机器人仍在运动。
         */
        post: operations["robot_stop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 列出任务（可按状态过滤）
         * @description 只读快照；不按时间淘汰，反映内核任务表当前内容。
         */
        get: operations["task_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tasks/{task_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 查询任务状态 */
        get: operations["task_get"];
        put?: never;
        post?: never;
        /** 取消指定任务 */
        delete: operations["task_cancel"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tasks/{task_id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 暂停运动任务：速度归零、位置保持、任务不终结（幂等）
         * @description 语义是「先别动了，等我一下」，**不是停止、不是取消、不是静音**：
         *
         *     - 先把有序停止下发板侧（速度归零），成功后才把任务转 `paused`；
         *       板侧联系不上时**不进入 paused**——不允许「daemon 挂着、板子以为在跑」。
         *     - `paused` 期间任务仍在任务表里，运动槽位仍被占用（新运动任务仍 `409/E_BUSY`）；
         *       `GET /v1/tasks/{id}` 的 `state` 为 `paused`，`finished_at` 保持 null。
         *     - 事件流发 `task.paused`（不是 `task.completed`/`task.cancelled`）。
         *     - 暂停有上限（robotd 配置 `pause_max_seconds`，默认 120s）；到期仍在 paused
         *       会发 `task.pause_expired` 并转 `cancelled`（`reason: pause_timeout`），
         *       同时尽力播报固定提示。**不允许无限期悬着**。
         *     - 只对运动任务有效；`soft` 任务（语音等）返回 `409/E_STATE`。
         *     - 幂等：已 `paused` 时再调用返回当前任务，不重复发事件。
         *     - **不需要审批**：暂停只降低风险；恢复也不需要重新签发凭据（见 resume）。
         *     - `robot_stop` 仍能打断 paused（它仍是取消），语义不变。
         */
        post: operations["task_pause"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tasks/{task_id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 从 paused 恢复原任务（幂等；不重新签发审批凭据）
         * @description 从 `paused` 回到 `running`，**不新建任务、不重新调用任何动作能力**：
         *
         *     - 任务 id 不变，事件流只发 `task.resumed`，不会出现第二个 `task.started`、
         *       也不会出现第二次审批（`approval.waiting`）。这是本条与「取消后重发 follow」
         *       的本质区别：目标、距离、速度上限全都没有变。
         *     - 恢复后由该能力自己的运动控制继续执行；`robot_follow` 等能力尚未实现时，
         *       恢复仅改变任务状态，不宣称已经产生真实速度曲线（R15/R17 未完成）。
         *     - 已 `running` 时幂等返回；终态任务返回 `409/E_STATE`，不复活。
         *     - 只对运动任务有效；`soft` 任务返回 `409/E_STATE`。
         *     - 板侧链路不可用时返回 `503/E_LINK` 且**保持 `paused`**：恢复意味着「身体可以继续动」，
         *       联系不上板侧就不能声称已恢复。任务不会因此变成无限期 running——暂停截止时间照旧，
         *       到期仍会转 `cancelled`（`reason: pause_timeout`）。
         *     - **不需要审批**：没有改变任何被用户确认并绑定过的参数（见 approval-digest 的
         *       `risk_policy`：降低风险的变更不触发重签，提高风险的才触发）。
         */
        post: operations["task_resume"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * WebSocket 事件订阅端点
         * @description 普通 GET 升级为 WebSocket。消息全部是 UTF-8 JSON 文本帧，形状见
         *     `#/components/schemas/WsServerMessage` 与 `#/components/schemas/WsClientMessage`。
         *
         *     服务端连接后**先发** `hello`（含每次进程启动生成的 `instance_id`），客户端发 `subscribe`
         *     后服务端回 `subscription.accepted`，随后发 `state.snapshot`（含 `event_seq` 游标），
         *     再按序发 `seq > event_seq` 的匹配事件。服务端在捕获快照游标的那一刻开始缓冲，
         *     因此快照与增量之间不存在竞态。
         *
         *     `resume_from_seq` 仅在 `instance_id` 相同且保留日志仍覆盖该游标时有效；否则服务端发
         *     `resync_required`，客户端必须重拉 `/v1/robot/state`。补发是有限日志上的尽力而为，
         *     不是持久事件存储。经过滤的订阅看不到某些全局 `seq` **不代表丢包**。
         */
        get: operations["events_subscribe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/debug/serial": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 直发板侧 op（接线核对、钉电平、脉冲、ENA） */
        post: operations["debug_serial"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/debug/state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** debug 界面读取运行时原始状态 */
        get: operations["debug_state"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/debug/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** debug 界面读取最近事件（保留窗口内） */
        get: operations["debug_events"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Health: {
            ok: boolean;
            /** @enum {string} */
            service: "robotd";
            /** @description 服务实现版本（robotd 契约主版本） */
            version: number;
            /** @description 本次进程启动实例标识；重启后必变，用于识别事件序号断代 */
            instance_id: string;
            /** @description 板侧线协议版本（当前 2） */
            protocol?: number;
            /** @enum {string} */
            transport?: "sim" | "serial";
            /** @description 板侧可观测性，取值同 DeviceStatus */
            esp32?: string;
            /** @description 与 RobotState.mode 同一推导函数 */
            mode?: string;
            pid?: number;
        };
        /**
         * @description 机器人整体状态的**单次一致性视图**。调用方不得拆成多个查询再拼接。
         *     本节所有字段只有 robotd 一个权威快照；写入由事件归并路径完成，传输 handler 只读。
         */
        RobotState: {
            robot_id: string;
            /** @description 状态 schema 版本（当前 1） */
            version: number;
            mode: components["schemas"]["RobotMode"];
            pose: components["schemas"]["Pose"];
            odometry: components["schemas"]["Odometry"];
            devices: components["schemas"]["Devices"];
            battery: components["schemas"]["Battery"];
            /** @description 当前独占运动任务 id；无活动任务为 null */
            task_id: string | null;
            /** @description 最近握手得到的固件标识；未知为 null */
            firmware?: string | null;
            /** @enum {string} */
            transport?: "sim" | "serial";
            /** @description 快照生成时间，Unix epoch 毫秒 */
            ts: number;
            /**
             * @description **快照游标**：生成该快照时已提交的全局事件序号。WS 订阅以此为边界，
             *     只接收 `seq > event_seq` 的增量。与快照在同一事件归并序列中读取，不单独产生。
             */
            event_seq: number;
        };
        /**
         * @description 由 robotd 根据设备链路状态与任务状态**统一推导**（单一 derive_mode）：
         *     链路不可用 → degraded；存在**未暂停**的排他运动任务 → moving；否则 idle。
         *     暂停中的运动任务不产生 `moving`：机器人确实没在动，任务状态由 `Task.state` 表达。
         *     调用方不得自行合成该字段。
         * @enum {string}
         */
        RobotMode: "idle" | "moving" | "degraded";
        /**
         * @description robotd 里程积分估计。坐标系固定为右手机器人系：x 向前、y 向左、theta 逆时针为正。
         *     单位为米与弧度（不是度）。**板侧复位使来源失效时必须把 valid 置 false**，
         *     在重新回零/标定前位姿不可当作事实使用。
         */
        Pose: {
            /** @description 米 */
            x: number;
            /** @description 米 */
            y: number;
            /** @description 弧度；范围不做折叠，调用方自行归一化 */
            theta: number;
            /** @description false = 位姿来源已失效（板复位 / 标定变更 / 未回零） */
            valid: boolean;
        };
        /**
         * @description robotd 对设备可观测性的归一化状态。**未探测时必须是 `unknown`**，
         *     不得把未知改报成 `absent` 或 `ready`。
         */
        Devices: {
            esp32: components["schemas"]["DeviceStatus"];
            camera: components["schemas"]["DeviceStatus"];
            audio?: components["schemas"]["DeviceStatus"];
            /**
             * @description 水泵执行器状态；未接线时保持 unknown，不臆造 off
             * @enum {string}
             */
            pump?: "on" | "off" | "unknown";
        };
        /**
         * @description `unknown` 未探测；`starting` 正在握手；`ready` 可用；`absent` 确认不存在；
         *     `error` 探测到但不可用；`lost` 曾就绪后失联。
         * @enum {string}
         */
        DeviceStatus: "unknown" | "starting" | "ready" | "absent" | "error" | "lost";
        /** @description 未接 BMS 时必须 `source: unimplemented` 且测量值为 null，**不得估算或伪造**。 */
        Battery: {
            /** @enum {string} */
            source: "bms" | "unimplemented";
            /** @description 伏特；无权威源时为 null */
            voltage: number | null;
            /** @description 0–100；无权威源时为 null */
            percent: number | null;
        };
        /**
         * @description 里程与丢步观测（归属见 ADR-0002：板侧如实上报「应发/实走」，robotd 做判断）。
         *     `*_commanded` 是固件发出的脉冲数（应发），`*_actual_encoder` 是编码器测得的脉数（实走）。
         *     **应发步数不是实际位移证明**；两者差异即开环步进的丢步量。
         *     未装编码器时 `*_actual_encoder` 与 `slip_ratio` 必须为 null，不得用应发值顶替。
         */
        Odometry: {
            /** @enum {string} */
            source: "open_loop" | "encoder";
            /** @description 左轮累计应发脉冲数（固件计数） */
            left_commanded: number;
            /** @description 右轮累计应发脉冲数（固件计数） */
            right_commanded: number;
            /** @description 左轮累计编码器计数（未装编码器时为 null） */
            left_actual_encoder?: number | null;
            /** @description 右轮累计编码器计数（未装编码器时为 null） */
            right_actual_encoder?: number | null;
            /** @description 丢步比 = |应发 − 实走| / 应发；由 robotd 计算，超阈值触发告警/重走 */
            slip_ratio?: number | null;
            /** @description Unix epoch 毫秒 */
            ts?: number;
        };
        /**
         * @description 标定值权威在 robotd（ADR-0002）。`source` 表示当前生效值来自哪一层：
         *     `default` 固件默认、`board` 板侧持久化回读、`host` 本次运行 host 覆盖。
         *     `persisted` 表示板侧是否已写盘；写盘失败不改运行时值，必须如实报 false。
         */
        Calibration: {
            /** @description 每米脉冲数（轮径 × 细分推导），决定「走 1 米」发多少脉冲 */
            steps_per_m: number;
            /** @description 轮距（毫米），差速转向解算用；**不是米** */
            wheelbase_mm: number;
            /** @enum {string} */
            source: "default" | "board" | "host";
            /** @description 板侧是否已持久化（掉电保留）；仅本次运行有效时为 false */
            persisted?: boolean;
            /** @description 最近一次成功下发的 Unix epoch 毫秒；从未下发为 null */
            applied_at?: number | null;
            ts: number;
        };
        CalibrationUpdate: {
            steps_per_m?: number;
            wheelbase_mm?: number;
            /**
             * @description 是否要求板侧持久化（掉电保留）；默认仅本次运行有效
             * @default false
             */
            persist?: boolean;
        };
        /**
         * @description 审批复述请求。**故意没有 `text` 字段**：任意自由文本必须走需审批的
         *     `robot_speak`，否则本端点就成了它的免审批版本。
         */
        AnnounceRequest: {
            /** @description agentd 审批记录的 ID；robotd 只用于回显与事件关联，不持有审批状态。 */
            approval_id: string;
            /**
             * @description 固定播报种类；当前只允许审批复述。
             * @enum {string}
             */
            kind: "approval_repeat";
            /** @description 动作的人类可读名称，来自 agentd 的审批记录。 */
            action_label: string;
            /** @description 关键参数摘要，来自 agentd 的审批记录；robotd 用固定模板念出。 */
            args_summary: string;
        };
        AnnounceAccepted: {
            task_id: string;
            /** @enum {string} */
            status: "accepted";
            approval_id: string;
            /** @enum {string} */
            kind: "approval_repeat";
            /** @description robotd 实际交给 TTS 的完整句子（固定模板渲染结果），供 agentd 存审计。 */
            text: string;
        };
        SpeakRequest: {
            text: string;
            voice?: string;
            rate?: number;
            /** @default true */
            interruptible?: boolean;
        };
        ListenRequest: {
            /** @default 300 */
            max_seconds?: number;
            /** @default zh_CN */
            locale?: string;
            /** @default true */
            auto_endpoint?: boolean;
        };
        SpeechAbortRequest: {
            /** @description 只中止这一轮播报；省略表示停掉当前所有播报。 */
            response_id?: string;
        };
        /**
         * @description 目标绑定来源二选一，至少给一个：
         *     - `target_track_id`：跟某条已存在的 track（唯一、无歧义，优先使用）；
         *     - `target`：语义描述，需要 robotd 自行确定目标；歧义时应失败并让调用方澄清，
         *       **不得私自切换成画面内另一个人**。
         *     两个都给时以 `target_track_id` 为准。
         */
        FollowRequest: {
            /** @description 已存在的 track id；过期或不存在时返回 400/E_VALIDATION */
            target_track_id?: string;
            /** @description 语义目标（如「人」）；仅在没有 target_track_id 时使用 */
            target?: string;
            /**
             * @description 跟随速度上限（米/秒）。上限是**安全边界**，实现不得自行放宽
             * @default 0.15
             */
            max_speed_mps?: number;
            /**
             * @description 停止时的目标框宽度占比。**这是几何代理量，不是米制距离**；
             *     单目框大小不能冒充可靠测距。
             */
            stop_width_ratio?: number;
            /**
             * @description 任务硬时限；到期停止并提交 cancelled/failed 终态
             * @default 120
             */
            max_seconds?: number;
        };
        /** @description 受理响应。**accepted 不代表已经开始运动**；进度与终态通过任务查询与事件流获取。 */
        TaskAccepted: {
            task_id: string;
            /** @enum {string} */
            status: "accepted";
            /** @description 降级/限制说明；不影响受理语义，但调用方应读 */
            warnings?: string[];
        };
        /**
         * @description 任务生命周期：`accepted → running → completed | failed | cancelled`，
         *     以及 `running → paused → running | cancelled | failed`。
         *     `paused` **不是终态**：任务不终结、`finished_at` 仍为 null，只是运动速度归零；
         *     `pause`/`resume` 只对运动任务有效，恢复时不需要重新签发审批凭据
         *     （没有改变任何被确认过的参数）。
         *     终态不可再转移；任务仅在当前进程生命周期内可查询（不持久化）。
         */
        Task: {
            task_id: string;
            /** @description 触发该任务的能力名（与 operationId 对应） */
            capability: string;
            state: components["schemas"]["TaskState"];
            /** @description 0–1；未知进度时保持 0，不得编造 */
            progress: number;
            /** @description Unix epoch 毫秒 */
            started_at: number;
            /** @description 终态时间，Unix epoch 毫秒；未结束（含 paused）为 null */
            finished_at?: number | null;
            /**
             * @description 仅 `paused` 时出现：本次暂停的自动取消截止时间（Unix epoch 毫秒）。
             *     到期仍在 paused 会转 `cancelled`（`reason: pause_timeout`），
             *     **不允许无限期悬着**。其他状态为 null 或不出现。
             */
            pause_expires_at?: number | null;
            cancelable: boolean;
            /**
             * @description `motion` 为独占运动任务（同一时刻仅一个）；`soft` 为语音等非运动任务，
             *     按类别去重但可与运动任务并存。
             * @enum {string}
             */
            exclusivity?: "motion" | "soft";
            /** @description 稳定错误码；未失败的任务该字段为 null（见 TaskError）。 */
            error?: components["schemas"]["TaskError"] | null;
        };
        /**
         * @description `paused` 是运动任务的中间态：速度归零、位置保持、任务不终结；
         *     它既不是 `cancelled` 也不是 `completed`，也不是 `superseded`。
         * @enum {string}
         */
        TaskState: "accepted" | "running" | "paused" | "completed" | "failed" | "cancelled";
        /** @description 稳定错误码，调用方按码分支，**不得解析 message 猜原因**。 */
        TaskError: {
            /** @description 见 `x-robotd-errors` */
            code: string;
            message: string;
            details?: {
                [key: string]: unknown;
            };
        };
        Error: {
            /** @enum {boolean} */
            ok: false;
            error: components["schemas"]["TaskError"];
        };
        /**
         * @description 常听（always_on）音频现状。识别结果本身走事件流（`speech.*`），本快照只给状态。
         *     未接麦克风 / 未授权 / 桥退出时必须显式体现，不得伪装成「在听但没说话」。
         */
        AudioState: {
            /**
             * @description 常听是否由 AudioRuntime 维持。`always_on` = 桥就绪、未静音、未停止，
             *     自动续听已武装；`idle` = 静音 / 桥丢失 / 显式停止，不再自动开新轮。
             *     这个值由会话状态机计算，不是常量。
             * @enum {string}
             */
            mode: "always_on" | "idle";
            /**
             * @description 会话状态机当前阶段。`listening` = 已开一轮在听；`thinking` = final 有文本、
             *     等待 agentd 播报；`speaking` = 正在播报；`idle` = 两轮之间（`inter_utterance_ms`
             *     防抖窗口）。播报结束必须经过 `speaking → idle → listening`，不得跳步。
             * @enum {string}
             */
            phase: "idle" | "listening" | "thinking" | "speaking";
            /** @description true = 常听已暂停（不产生 utterance、不跑 ASR） */
            muted: boolean;
            /** @description 当前是否正在播报（等价于有活动 response） */
            speaking: boolean;
            bridge: components["schemas"]["DeviceStatus"];
            /** @description 本底噪声是否已校准 */
            calibrated?: boolean;
            /** @description 当前未定稿的识别文本；无则 null */
            partial?: string | null;
            /** @description 最近一句定稿文本；无则 null */
            last_final?: string | null;
            /** @description 本底噪声（dBFS）；未测量为 null，**不填估算值** */
            ambient_db?: number | null;
            speech_db?: number | null;
            silence_db?: number | null;
            /** @description 采集格式描述（如 `48000/1ch/float32`）；未知为空串 */
            mic_format?: string;
            /**
             * @description 打断门限 `max(ambient_db + 本值, speech_db)` 里**实际生效**的 ERLE 余量（dB）。
             *     默认 15（推导见 `docs/design/GH-6.md` §4），可由配置文件
             *     `barge_in_erle_margin_db` 或环境变量 `ROBOTD_BARGE_IN_ERLE_MARGIN_DB` 覆盖；
             *     真机出现自听误触发时回退到 30。回显的是判定实际使用的值，不是默认值。
             */
            barge_in_erle_margin_db?: number;
            /**
             * @description `aec_erle_db` 能作为打断判据的**可用性底线**（dB），默认 20。
             *     低于它视为「AEC 没压住」→ `speech.gate` 落 `no_erle`；可配置覆盖。
             */
            barge_in_erle_floor_db?: number;
            /**
             * @description 哪几项打断门限被显式配置覆盖（相对默认值）。空数组 = 两项都用默认值。
             *     真机上据此确认判据跑在什么门限下，不必翻代码。
             */
            barge_in_erle_overridden?: ("margin" | "floor")[];
            ts?: number;
        };
        /** @description 服务端 → 客户端（UTF-8 JSON 文本帧），按 `type` 区分 */
        WsServerMessage: components["schemas"]["WsHello"] | components["schemas"]["WsSubscriptionAccepted"] | components["schemas"]["WsStateSnapshot"] | components["schemas"]["WsEvent"] | components["schemas"]["WsResyncRequired"] | components["schemas"]["WsPong"];
        WsHello: {
            /** @enum {string} */
            type: "hello";
            /** @enum {integer} */
            version: 1;
            /** @enum {string} */
            server: "robotd";
            /** @description 每次进程启动生成；用于识别 seq 断代 */
            instance_id: string;
            /** @description 当前最新全局事件序号 */
            last_seq: number;
            /** @description 支持订阅的事件类型（精确名或 `prefix.*`） */
            supported_event_types: string[];
            /** @description 保留日志条数上限；`resume_from_seq` 早于该窗口即触发 resync */
            replay_window?: number;
        };
        WsSubscriptionAccepted: {
            /** @enum {string} */
            type: "subscription.accepted";
            subscription_id: string;
            event_types: string[];
            resume_from_seq?: number | null;
        };
        /** @description 初始快照控制帧。`event_seq` 与 `state.event_seq` 必须一致，作为后续增量的起点。 */
        WsStateSnapshot: {
            /** @enum {string} */
            type: "state.snapshot";
            /** @enum {integer} */
            version: 1;
            event_seq: number;
            state: components["schemas"]["RobotState"];
        };
        /**
         * @description 事件封套。`seq` 在本实例运行期内严格递增；重启后可重新开始，靠 `instance_id` 识别。
         *     `timestamp` 为 UTC ISO 8601 毫秒精度。
         *     **内部字段（单调时钟、模型自检中间文本）不得出现在 payload 中。**
         */
        WsEvent: {
            /** @enum {integer} */
            version: 1;
            /** @description 事件名，必须是 `WsHello.supported_event_types` 可匹配的名字 */
            type: string;
            /** @description 跨实例唯一，形如 `evt_<instance_id>_<seq>` */
            event_id: string;
            seq: number;
            /** Format: date-time */
            timestamp: string;
            payload: {
                [key: string]: unknown;
            };
        };
        /**
         * @description 补发不可用（游标早于保留窗口 / instance_id 不一致 / 游标非法）。
         *     客户端必须重拉 `/v1/robot/state` 重建基线，**不得用部分事件自行修补状态**。
         */
        WsResyncRequired: {
            /** @enum {string} */
            type: "resync_required";
            /** @enum {string} */
            reason: "instance_changed" | "cursor_expired" | "invalid_cursor";
            instance_id?: string;
            last_seq?: number;
            /** @description 附带的最新快照游标，便于客户端立即重建 */
            event_seq?: number;
        };
        WsPong: {
            /** @enum {string} */
            type: "pong";
            seq: number;
        };
        /** @description 客户端 → 服务端 */
        WsClientMessage: {
            /** @enum {string} */
            type: "subscribe";
            /** @description 精确事件名或 `prefix.*`；空数组合法（表示暂不订阅，仅取快照） */
            event_types: string[];
            instance_id?: string;
            resume_from_seq?: number;
        } | {
            /** @enum {string} */
            type: "unsubscribe";
            /** @description 省略 = 取消全部订阅 */
            event_types?: string[];
        } | {
            /** @enum {string} */
            type: "ping";
            nonce?: string;
        };
    };
    responses: never;
    parameters: {
        /**
         * @description agentd 在用户语音确认后签发的一次性授权凭据：
         *     `<base64url(payload-json)>.<base64url(hmac-sha256(secret, payload-segment))>`。
         *     robotd 校验签发者、capability、参数摘要、有效期与 nonce 未消费；
         *     失败或缺失一律 `403` + `E_APPROVAL`。凭据与共享秘密格式见
         *     `docs/design/GH-18.md`。
         */
        ApprovalCredential: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    robot_health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
        };
    };
    robot_state: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RobotState"];
                };
            };
        };
    };
    robot_calibration_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Calibration"];
                };
            };
        };
    };
    robot_calibration_set: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description agentd 在用户语音确认后签发的一次性授权凭据：
                 *     `<base64url(payload-json)>.<base64url(hmac-sha256(secret, payload-segment))>`。
                 *     robotd 校验签发者、capability、参数摘要、有效期与 nonce 未消费；
                 *     失败或缺失一律 `403` + `E_APPROVAL`。凭据与共享秘密格式见
                 *     `docs/design/GH-18.md`。
                 */
                "X-Wally-Approval": components["parameters"]["ApprovalCredential"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CalibrationUpdate"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Calibration"];
                };
            };
            /** @description 参数越界或板侧拒绝 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    robot_speak: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description agentd 在用户语音确认后签发的一次性授权凭据：
                 *     `<base64url(payload-json)>.<base64url(hmac-sha256(secret, payload-segment))>`。
                 *     robotd 校验签发者、capability、参数摘要、有效期与 nonce 未消费；
                 *     失败或缺失一律 `403` + `E_APPROVAL`。凭据与共享秘密格式见
                 *     `docs/design/GH-18.md`。
                 */
                "X-Wally-Approval": components["parameters"]["ApprovalCredential"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SpeakRequest"];
            };
        };
        responses: {
            /** @description 已受理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskAccepted"];
                };
            };
            /** @description 已有任务在跑 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    robot_announce: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AnnounceRequest"];
            };
        };
        responses: {
            /** @description 已受理（受理不等于播完；以 speech.tts_finished 为准） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnnounceAccepted"];
                };
            };
            /** @description 参数不合法或试图传入自由文本 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 已有一条同类系统播报在跑 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 音频桥不可用（播报失败会同时发 speech.announce_failed 事件） */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    audio_state: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 音频现状快照 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AudioState"];
                };
            };
            /** @description 音频桥不可用（未配置或已退出） */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    audio_mute: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已切换 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AudioState"];
                };
            };
            /** @description 音频桥不可用 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    audio_unmute: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已切换 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AudioState"];
                };
            };
            /** @description 音频桥不可用 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    speech_listen: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ListenRequest"];
            };
        };
        responses: {
            /** @description 已受理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskAccepted"];
                };
            };
            /** @description 已有任务在跑 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    speech_abort: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["SpeechAbortRequest"];
            };
        };
        responses: {
            /** @description 已受理；无活动播报时也是 200（幂等） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskAccepted"];
                };
            };
            /** @description 字段不合法 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    robot_follow: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description agentd 在用户语音确认后签发的一次性授权凭据：
                 *     `<base64url(payload-json)>.<base64url(hmac-sha256(secret, payload-segment))>`。
                 *     robotd 校验签发者、capability、参数摘要、有效期与 nonce 未消费；
                 *     失败或缺失一律 `403` + `E_APPROVAL`。凭据与共享秘密格式见
                 *     `docs/design/GH-18.md`。
                 */
                "X-Wally-Approval": components["parameters"]["ApprovalCredential"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FollowRequest"];
            };
        };
        responses: {
            /** @description 已受理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskAccepted"];
                };
            };
            /** @description 目标不可确定或参数不合法 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 已有排他任务在跑 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 跟踪能力未就绪（相机不可用 / 检测后端未启用） */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    robot_stop: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已受理停止 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ok: boolean;
                        /** @description 本进程侧是否已发出停止（不代表板侧已处理，更不代表物理静止） */
                        stopped: boolean;
                        /** @description 受理时间，Unix epoch 毫秒 */
                        at: number;
                        /** @description 是否收到板侧 stop 应答；未收到为 false（此时应报 504，不返回 200） */
                        board_ack?: boolean | null;
                    };
                };
            };
            /** @description 板侧未在时限内应答（不表示未执行） */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    task_list: {
        parameters: {
            query?: {
                state?: "accepted" | "running" | "paused" | "completed" | "failed" | "cancelled";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        tasks: components["schemas"]["Task"][];
                    };
                };
            };
        };
    };
    task_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                task_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
            /** @description 无此任务 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    task_cancel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                task_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
            /** @description 无此任务 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    task_pause: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                task_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已受理（任务已转 paused；不代表板侧物理静止证明） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
            /** @description 无此任务 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 任务状态不允许暂停（终态 / 非运动任务） */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 无板侧适配或链路不可用，无法确认速度已归零 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    task_resume: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                task_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已恢复运行 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
            /** @description 无此任务 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 任务不在 paused（或已终结），不允许恢复 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 板侧链路不可用；任务保持 paused，由暂停上限负责收尾 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    events_subscribe: {
        parameters: {
            query?: {
                /** @description 逗号分隔的初始订阅类型，例如 `task.*,speech.*` */
                types?: string;
                resume_from_seq?: number;
                /** @description 与 `resume_from_seq` 配套；不一致时服务端忽略补发并发 `resync_required` */
                instance_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Switching Protocols */
            101: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    debug_serial: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    op: string;
                    args?: Record<string, never>;
                    timeout?: number;
                };
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description 调试旁路未开启 */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    debug_state: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description 调试旁路未开启 */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    debug_events: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description 调试旁路未开启 */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
