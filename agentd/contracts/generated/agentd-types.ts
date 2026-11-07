export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 存活探针
         * @description 只表示 agentd 进程活着。**不表示机器人正常、模型可用或身体停稳**。
         */
        get: operations["agentd_healthz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 取本地会话凭证与 CSRF 令牌
         * @description UI 同源加载后调用一次，拿到写操作所需的 CSRF 令牌。令牌由服务端在启动时生成，
         *     只通过同源 GET 下发；跨源请求因 Origin 校验失败拿不到。
         */
        get: operations["agentd_session"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 总览聚合状态
         * @description 一次返回总览需要的全部东西：服务自身、活动任务、身体观测（带来源与新鲜度）、
         *     模型与语音状态、最近语义事件。**每个观测都带 `observed_at` 与 `freshness`**，
         *     客户端据此显示「状态已过期」而不是把旧数据当现状。
         */
        get: operations["agentd_state"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出会话（游标分页） */
        get: operations["agentd_list_sessions"];
        put?: never;
        /** 新建会话 */
        post: operations["agentd_create_session"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sessions/{session_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 会话详情与分页消息 */
        get: operations["agentd_get_session"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 提交一次请求（文本）
         * @description 幂等：同一 `idempotency_key` 重复提交只产生一个 run，返回同一个 `run_id`。
         *     活动 run 上限为 1；遇忙返回 409，**不排队后突然执行**。
         *
         *     执行路径由 agentd 的 Input/Router 决定：命中确定性快速路由 → 直接走能力调用
         *     （仍经同一审批门）；否则交给 Harness 理解。响应里的 `route` 说明实际走了哪条。
         *
         *     **需要澄清（`route=clarified`）不创建 run**：没有执行意图就不占活动名额，
         *     响应里没有 `run_id` / `status`，只带 `clarify`（或 `ambiguous`）。因此澄清之后
         *     可以立即再提交下一条请求，不会被 `E_BUSY` 挡住。
         *
         *     受保护的停止规则（`stop_robot`）是安全旁路：即使已有活动 run 也允许提交，
         *     不受「活动 run 上限 1」限制；其余请求遇忙仍返回 409。
         */
        post: operations["agentd_submit_run"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出任务 */
        get: operations["agentd_list_runs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 任务详情（步骤、工具调用、审批、证据） */
        get: operations["agentd_get_run"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{run_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 取消任务（终止编排）
         * @description **这不是「停止机器人」。** 取消会中断 Harness、作废待审批与未消费授权、
         *     取消关联的 robotd 任务；若涉及运动，会请求一次 `robot_stop`。
         *     「已请求停止」与「已确认停稳」是两个状态，详情里分别给出。
         */
        post: operations["agentd_cancel_run"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 软件停止编排（不依赖模型与 Harness）
         * @description 立即中断活动 run、作废待审批与未消费授权，并**直达 robotd 请求一次 stop**。
         *     不等 Harness、不等模型、不走审批。
         *
         *     响应里的 `body_stop` 明确区分三种结局：
         *     `requested`（已发出，未确认）/ `confirmed`（robotd 回了 200 且 board_ack=true）/
         *     `unknown`（robotd 不可达或超时）。**`requested` 与 `unknown` 都不能显示为「已停稳」。**
         */
        post: operations["agentd_stop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 语义事件历史（游标分页、服务端过滤）
         * @description 默认返回人类可读的业务事件，**不含 token 片段、心跳、每帧位姿**。
         *     每条带确定性中文摘要（模板生成，不调用模型），所以模型离线也能读懂历史。
         */
        get: operations["agentd_list_events"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/events/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 实时事件推送（WebSocket）
         * @description GET 升级为 WebSocket。连接后先发 `hello`；客户端发 `hello`/`subscribe` 后服务端回
         *     `subscribed` 并带 `cursor`，随后推送 `event`。断线重连时带 `cursor` 与 `boot_id`：
         *     同一 boot 且游标仍在保留窗口内 → 补发缺失；否则回 `resync_required`，
         *     客户端必须重新 `GET /api/state` 与 `/api/events` 首页（**不悄悄跳过**）。
         */
        get: operations["agentd_events_live"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/model-profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出模型 profile（凭证只显示是否已设置） */
        get: operations["agentd_list_model_profiles"];
        put?: never;
        /** 新建 profile（生成 revision 1，默认不激活） */
        post: operations["agentd_create_model_profile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/model-profiles/{profile_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读取 profile 与其 revision 历史 */
        get: operations["agentd_get_model_profile"];
        /**
         * 产生新 revision（不可变历史，乐观锁）
         * @description 传入 `base_revision` 做 CAS：与当前最新 revision 不一致即 409，
         *     **不后写覆盖**。旧 revision 与其凭证引用保留，不被原地改写。
         */
        put: operations["agentd_update_model_profile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/model-profiles/{profile_id}/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 分项兼容探测（不发送任何用户数据）
         * @description 逐项检查：连接 / 认证 / 模型存在 / 流式 / 工具调用 / 取消 / Harness 接入。
         *     探测使用固定 fixture 输入，不含用户会话，不执行机器人动作。
         *     **HTTP 200 或模型列表成功不等于「可用于 Agent」**——只有全部必需项通过才会
         *     `verdict=compatible`，否则只能保存草稿，不能激活。
         */
        post: operations["agentd_validate_model_profile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/model-profiles/{profile_id}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 激活一个已验证的 revision
         * @description 只允许激活 `verdict=compatible` 且未失效的 revision。配置/凭证/适配器/Harness
         *     版本任一变化都会让旧验证失效，需重测。激活动作写激活事件；
         *     回退也是「激活一个旧 revision」，同样产生新事件，不改写历史。
         *     活动 run 不受影响：它固定在自己启动时的 revision 上。
         */
        post: operations["agentd_activate_model_profile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/approvals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 审批观测（只读）
         * @description **正常界面没有批准写入口。** 本端点只返回审批请求、复述参数摘要、确认窗口与结论。
         *     浏览器不能在此批准；批准只来自经过验证的语音确认（内部通道）。
         */
        get: operations["agentd_list_approvals"];
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
        Error: {
            /** @enum {boolean} */
            ok: false;
            error: {
                /** @description 稳定错误码，见 x-agentd-errors */
                code: string;
                /** @description 给人看的说明；调用方不得解析它做分支 */
                message: string;
                details?: {
                    [key: string]: unknown;
                };
                /** @description 可选的下一步建议（如「到设置 → 高级模型测试连接」） */
                hint?: string;
            };
        };
        Healthz: {
            ok: boolean;
            /** @enum {string} */
            daemon: "agentd";
            pid: number;
            /** @description 每次进程启动生成；WS 重连据此判断是否需要 resync */
            boot_id: string;
            /** Format: date-time */
            started_at: string;
            contract_version: string;
            store?: {
                path?: string;
                writable?: boolean;
                migrated_to?: number;
            };
            /** @description 显式测试模式的标志位；生产运行时两项都应为 false */
            test_mode?: {
                allow_manual_approve?: boolean;
                allow_auto_approve?: boolean;
            };
        };
        LocalSession: {
            ok: boolean;
            boot_id: string;
            /** @description 写操作需在 X-Agentd-CSRF 头回传 */
            csrf: string;
            origin?: string;
        };
        Overview: {
            ok: boolean;
            /** Format: date-time */
            generated_at: string;
            self: {
                boot_id?: string;
                /** Format: date-time */
                started_at?: string;
                uptime_s?: number;
            };
            body: components["schemas"]["Observation"];
            /** @description agentd/Harness/模型的健康；与身体观测分开，服务 alive 不等于身体停稳 */
            brain: {
                /** @enum {string} */
                daemon?: "ok" | "degraded" | "error";
                harness?: components["schemas"]["HarnessStatus"];
                model?: components["schemas"]["ModelStatus"];
                /** @enum {string} */
                store?: "ok" | "read_only" | "error";
            };
            active_run: components["schemas"]["RunSummary"] | null;
            recent_events: components["schemas"]["EventView"][];
            /** @description 按严重度排序，第一项是「最该先处理的一件事」 */
            issues: components["schemas"]["Issue"][];
        };
        /**
         * @description 身体观测。**不是第二份可写状态**：全部字段来自 robotd 的公开接口，只读。
         *     每种结局都必须可区分：未接入 / 无数据 / 过期 / 离线 / 正常。
         */
        Observation: {
            /** @enum {string} */
            state: "ok" | "stale" | "offline" | "not_connected" | "unknown";
            /** @example robotd */
            source: string;
            endpoint?: string;
            /** Format: date-time */
            observed_at: string | null;
            freshness: {
                age_ms?: number | null;
                threshold_ms?: number;
                expired?: boolean;
            };
            instance_id?: string | null;
            robot?: {
                mode?: string;
                devices?: {
                    [key: string]: unknown;
                };
                battery?: Record<string, never> | null;
                pose?: Record<string, never> | null;
                task_id?: string | null;
            } | null;
            /** @description 不可用时的原因（给人看的） */
            note?: string;
        };
        HarnessStatus: {
            /** @enum {string} */
            state: "not_configured" | "ready" | "running" | "error" | "unavailable";
            binary?: string | null;
            version?: string | null;
            /** @enum {string} */
            approval_mode?: "voice" | "manual_test" | "auto_test";
            /**
             * @description Harness 专属会话历史目录（CODEX_HOME）。**必须如实上报**，让用户能自行确认
             *     agentd 没有在读写主机的 ~/.codex。为空表示未确定，不要用 ~/.codex 顶上。
             */
            codex_home?: string | null;
            last_error?: string | null;
        };
        ModelStatus: {
            /** @enum {string} */
            state: "not_configured" | "active" | "invalid" | "error";
            active_profile_id?: string | null;
            active_profile_name?: string | null;
            active_revision?: number | null;
            /** Format: date-time */
            validated_at?: string | null;
            note?: string;
        };
        Issue: {
            /** @enum {string} */
            severity: "error" | "warning" | "info";
            title: string;
            detail?: string;
            /** @description 可点击的去处，如 settings/models、run:<id> */
            action?: string;
        };
        Session: {
            session_id: string;
            title: string;
            /** @enum {string} */
            status: "active" | "archived";
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
            last_run_id?: string | null;
        };
        SessionPage: {
            ok: boolean;
            sessions: components["schemas"]["Session"][];
            next_cursor: string | null;
        };
        SessionDetail: {
            ok: boolean;
            session: components["schemas"]["Session"];
            messages: components["schemas"]["Message"][];
            next_cursor: string | null;
        };
        Message: {
            message_id: string;
            /** @enum {string} */
            role: "user" | "agent" | "system";
            text: string;
            streaming?: boolean;
            /** @description text / asr / route */
            source?: string;
            /** Format: date-time */
            created_at: string;
        };
        RunRequest: {
            prompt: string;
            /** @description 调用方生成；同一键重复提交只产生一个 run */
            idempotency_key?: string;
            session_id?: string;
            /** @enum {string} */
            source?: "text" | "asr";
            asr_meta?: {
                utterance_id?: string;
                instance_id?: string;
                seq?: number;
            };
        };
        RunAccepted: {
            ok: boolean;
            /**
             * @description 本次请求对应的 run。`route=clarified` 时**为 null**（或缺失）：
             *     澄清没有执行意图，不创建 run，也不占用活动名额。
             */
            run_id?: string | null;
            /** @description run 的初始状态。`route=clarified` 时没有 run，因此为 null（或缺失）。 */
            status?: string | null;
            /**
             * @description fast=确定性快速路由；harness=交给模型理解；clarified=需澄清
             * @enum {string}
             */
            route: "fast" | "harness" | "clarified";
            /** @description 命中的规则 ID@version，用于追溯 */
            fast_rule?: string | null;
            /** Format: date-time */
            created_at: string;
            /** @description 幂等键命中已有 run 时为 true；澄清不建 run，因此不会出现该字段 */
            duplicate?: boolean;
            /**
             * @description `route=clarified` 且原因是**多条快速规则同时命中**时，列出候选规则 ID@version。
             *     出现这个字段表示「没有执行任何动作」，也不创建 run——歧义时按规格要求先问清楚，
             *     不按第一条命中执行。
             */
            ambiguous?: string[];
            /** @description `route=clarified` 时的澄清内容。澄清同样是**未执行**状态，且不创建 run。 */
            clarify?: {
                /** @description 面向用户的一句话，说明为什么没执行、需要什么 */
                question?: string;
                /** @description 缺失项，如 `capability:robot.follow`、`precondition` */
                missing?: string[];
            } | null;
        };
        RunSummary: {
            run_id: string;
            session_id?: string | null;
            prompt: string;
            /** @enum {string} */
            status: "accepted" | "understanding" | "planning" | "waiting_input" | "waiting_confirmation" | "executing" | "succeeded" | "failed" | "cancelled" | "interrupted" | "outcome_unknown";
            /** @enum {string} */
            route: "fast" | "harness" | "clarified";
            /** @enum {string} */
            source?: "text" | "asr";
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            finished_at?: string | null;
            duration_ms?: number | null;
            model_revision?: number | null;
            /**
             * @description 本次任务实际命中的快速规则 `ID@version`；未走快速路由时为 null。
             *     规格要求「任务事件记录实际命中的规则 ID/版本」——历史记录的是**当时**命中的那条，
             *     规则停用或回退不改写历史。
             */
            fast_rule?: string | null;
            blocking_reason?: string | null;
        };
        RunDetail: {
            ok: boolean;
            run: components["schemas"]["RunSummary"];
            steps: components["schemas"]["RunStep"][];
            tool_calls: components["schemas"]["ToolCall"][];
            approvals?: components["schemas"]["Approval"][];
            result: components["schemas"]["RunResult"];
            diagnostics?: {
                harness_exit_code?: number | null;
                error_code?: string | null;
                config_revision?: number | null;
            };
        };
        RunStep: {
            step_id: string;
            index: number;
            title: string;
            /** @enum {string} */
            state: "done" | "active" | "waiting" | "pending" | "failed" | "skipped";
            /** Format: date-time */
            started_at?: string | null;
            /** Format: date-time */
            finished_at?: string | null;
            note?: string | null;
        };
        ToolCall: {
            tool_call_id: string;
            capability: string;
            /** @description 规范化、脱敏后的参数摘要（用于复述与审计） */
            args_summary?: string;
            /** @description 本次调用是否需要（且已经获得）语音审批 */
            requires_approval?: boolean;
            /** @description 绑定到本次调用的审批记录；批准只对原 capability 与原参数有效 */
            approval_id?: string | null;
            /** @enum {string} */
            state: "requested" | "awaiting_approval" | "running" | "succeeded" | "failed" | "outcome_unknown" | "denied";
            robot_task_id?: string | null;
            /** Format: date-time */
            requested_at?: string;
            /** Format: date-time */
            finished_at?: string | null;
            /** @description 结论依据；「模型说完成了」不构成证据 */
            evidence?: string | null;
        };
        RunResult: {
            /**
             * @description `outcome_unknown` 只在「工具已发出、结果未确认」时出现。
             *     它与 `failed` 不同：不能当作未执行而重试。
             * @enum {string}
             */
            outcome: "succeeded" | "failed" | "cancelled" | "interrupted" | "outcome_unknown" | "in_progress";
            completed_steps?: string[];
            incomplete_steps?: string[];
            reason?: string | null;
            robot_task_ids?: string[];
        };
        RunPage: {
            ok: boolean;
            runs: components["schemas"]["RunSummary"][];
            next_cursor: string | null;
        };
        StopResult: {
            ok: boolean;
            cancelled_run_id: string | null;
            cancelled_approvals?: number;
            revoked_authorizations?: number;
            body_stop: {
                /** @enum {string} */
                state: "requested" | "confirmed" | "unknown" | "not_applicable";
                detail?: string;
                board_ack?: boolean | null;
            };
            /** Format: date-time */
            at: string;
        };
        EventView: {
            event_id: string;
            cursor: string;
            /** @description 稳定事件类型，如 run.accepted */
            type: string;
            /** @enum {string} */
            severity: "info" | "warning" | "error";
            /** Format: date-time */
            occurred_at: string;
            /** Format: date-time */
            received_at?: string;
            source?: string;
            /** @description 确定性中文标题（模板生成，不调用模型） */
            title: string;
            /** @description 确定性中文摘要（模板生成）；总是有值 */
            summary: string;
            /** @description 影响什么 */
            impact?: string | null;
            /** @description 可以做什么 */
            advice?: string | null;
            /** @description 这是否是一条「已恢复」事件 */
            recovered?: boolean;
            recovery_of?: string | null;
            run_id?: string | null;
            session_id?: string | null;
            approval_id?: string | null;
            robot_task_id?: string | null;
            code?: string | null;
            /** @description 脱敏结构化证据，只在「展开详情」时取；键名由事件类型决定，值必须是可序列化的原始类型 */
            data?: {
                [key: string]: unknown;
            } | null;
        };
        EventPage: {
            ok: boolean;
            events: components["schemas"]["EventView"][];
            next_cursor: string | null;
            /** @description 当前最新游标；用于「有 N 条新事件」提示 */
            head_cursor?: string;
            gap?: {
                from?: string;
                to?: string;
                reason?: string;
                note?: string;
            } | null;
        };
        ModelProfileDraft: {
            name: string;
            /**
             * @description 只列已实现的适配器
             * @enum {string}
             */
            provider: "openai_compatible";
            /** @description 必须是 http(s) URL，不含内嵌凭证 */
            endpoint: string;
            model: string;
            /** @description 只写字段；服务端只存引用，永不回显 */
            credential?: string;
            /** @enum {string} */
            reasoning_effort?: "minimal" | "low" | "medium" | "high";
            max_output_tokens?: number;
            temperature?: number;
            request_timeout_ms?: number;
            budget_tokens?: number | null;
            /**
             * @description 首版只允许 local_only；云端需先单独记录数据边界决策
             * @enum {string}
             */
            data_boundary?: "local_only";
        };
        ModelProfileUpdate: {
            base_revision: number;
            name?: string;
            provider?: string;
            endpoint?: string;
            model?: string;
            credential?: string;
            clear_credential?: boolean;
            reasoning_effort?: string;
            max_output_tokens?: number;
            temperature?: number;
            request_timeout_ms?: number;
            budget_tokens?: number | null;
            data_boundary?: string;
        };
        ModelProfile: {
            profile_id: string;
            name: string;
            latest_revision: number;
            active: boolean;
            active_revision?: number | null;
            /** Format: date-time */
            updated_at?: string;
        };
        ModelProfileList: {
            ok: boolean;
            profiles: components["schemas"]["ModelProfile"][];
            active_profile_id: string | null;
            /** @description 首版恒为 false：外部模型未开放 */
            external_model_open?: boolean;
        };
        ModelProfileDetail: {
            ok: boolean;
            profile: components["schemas"]["ModelProfile"];
            revisions: components["schemas"]["ModelRevision"][];
        };
        ModelRevision: {
            revision: number;
            name?: string;
            provider: string;
            endpoint: string;
            model: string;
            /** @description 只报「已设置/未设置」，绝不返回值本身 */
            credential_set?: boolean;
            reasoning_effort?: string | null;
            max_output_tokens?: number | null;
            temperature?: number | null;
            request_timeout_ms?: number | null;
            budget_tokens?: number | null;
            data_boundary?: string;
            /** Format: date-time */
            created_at: string;
            validation?: components["schemas"]["ValidationSummary"];
        };
        ValidationSummary: {
            /** @enum {string} */
            verdict?: "compatible" | "incompatible" | "not_run" | "stale";
            /** Format: date-time */
            checked_at?: string;
            adapter_version?: string;
            harness_version?: string;
            /** @description 任一项变化即让验证变 stale */
            config_fingerprint?: string;
        } | null;
        ValidationReport: {
            ok: boolean;
            /** @enum {string} */
            verdict: "compatible" | "incompatible";
            /** Format: date-time */
            checked_at: string;
            config_fingerprint?: string;
            checks: {
                /** @enum {string} */
                id: "connect" | "auth" | "model_exists" | "streaming" | "tool_call" | "cancel" | "harness_bridge";
                label: string;
                /** @enum {string} */
                state: "pass" | "fail" | "skip" | "warn";
                detail?: string | null;
                duration_ms?: number;
                required?: boolean;
            }[];
            /** @description 结论解释；HTTP 200 不等于可用，这里会写明 */
            note?: string;
        };
        Approval: {
            approval_id: string;
            run_id?: string | null;
            tool_call_id?: string | null;
            capability: string;
            args_summary?: string;
            /** @enum {string} */
            status: "persisted" | "announced" | "waiting" | "approved" | "denied" | "timeout" | "cancelled";
            /** @description 系统播报的复述文本，与语音确认窗口绑定 */
            prompt_text?: string;
            /** Format: date-time */
            window_opens_at?: string | null;
            /** Format: date-time */
            window_closes_at?: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            decided_at?: string | null;
            /** @enum {string|null} */
            decided_by?: "voice" | "timeout" | "cancel" | "manual_test" | "system" | null;
            authorization?: {
                scope?: string;
                /** Format: date-time */
                expires_at?: string;
                consumed?: boolean;
            } | null;
        };
        ApprovalList: {
            ok: boolean;
            approvals: components["schemas"]["Approval"][];
            /** @description true 表示当前是显式测试模式；生产运行必须是 false */
            manual_approve_enabled: boolean;
        };
    };
    responses: {
        /** @description 输入不合法 */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 资源不存在 */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 状态冲突（遇忙、revision 不一致、幂等键冲突） */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 依赖未就绪 */
        Unavailable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 数据库不可写（副作用已 fail-closed） */
        StoreUnavailable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        /** @description 不透明游标；来自上一页 next_cursor。稳定且不随时间漂移。 */
        Cursor: string;
        Limit: number;
        SessionId: string;
        RunId: string;
        ProfileId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    agentd_healthz: {
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
                    "application/json": components["schemas"]["Healthz"];
                };
            };
        };
    };
    agentd_session: {
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
                    "application/json": components["schemas"]["LocalSession"];
                };
            };
        };
    };
    agentd_state: {
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
                    "application/json": components["schemas"]["Overview"];
                };
            };
            503: components["responses"]["StoreUnavailable"];
        };
    };
    agentd_list_sessions: {
        parameters: {
            query?: {
                /** @description 不透明游标；来自上一页 next_cursor。稳定且不随时间漂移。 */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
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
                    "application/json": components["schemas"]["SessionPage"];
                };
            };
        };
    };
    agentd_create_session: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    title?: string;
                };
            };
        };
        responses: {
            /** @description 已创建 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    agentd_get_session: {
        parameters: {
            query?: {
                /** @description 不透明游标；来自上一页 next_cursor。稳定且不随时间漂移。 */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
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
                    "application/json": components["schemas"]["SessionDetail"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    agentd_submit_run: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunRequest"];
            };
        };
        responses: {
            /** @description 已受理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunAccepted"];
                };
            };
            400: components["responses"]["BadRequest"];
            409: components["responses"]["Conflict"];
            503: components["responses"]["Unavailable"];
        };
    };
    agentd_list_runs: {
        parameters: {
            query?: {
                status?: "accepted" | "understanding" | "planning" | "waiting_input" | "waiting_confirmation" | "executing" | "succeeded" | "failed" | "cancelled" | "interrupted" | "outcome_unknown";
                /** @description 不透明游标；来自上一页 next_cursor。稳定且不随时间漂移。 */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
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
                    "application/json": components["schemas"]["RunPage"];
                };
            };
        };
    };
    agentd_get_run: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: components["parameters"]["RunId"];
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
                    "application/json": components["schemas"]["RunDetail"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    agentd_cancel_run: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description 已受理取消 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunDetail"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    agentd_stop: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已处理（结果见 body_stop.state） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StopResult"];
                };
            };
        };
    };
    agentd_list_events: {
        parameters: {
            query?: {
                since?: string;
                until?: string;
                severity?: "info" | "warning" | "error";
                source?: "agentd" | "robotd" | "harness" | "model" | "store" | "user";
                run_id?: string;
                /** @description 关键词，覆盖可读标题、摘要与错误码 */
                q?: string;
                /** @description 不透明游标；来自上一页 next_cursor。稳定且不随时间漂移。 */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
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
                    "application/json": components["schemas"]["EventPage"];
                };
            };
            /** @description 游标早于保留窗口，必须从头加载 */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    agentd_events_live: {
        parameters: {
            query?: never;
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
    agentd_list_model_profiles: {
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
                    "application/json": components["schemas"]["ModelProfileList"];
                };
            };
        };
    };
    agentd_create_model_profile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModelProfileDraft"];
            };
        };
        responses: {
            /** @description 已创建 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelProfile"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    agentd_get_model_profile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                profile_id: components["parameters"]["ProfileId"];
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
                    "application/json": components["schemas"]["ModelProfileDetail"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    agentd_update_model_profile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                profile_id: components["parameters"]["ProfileId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModelProfileUpdate"];
            };
        };
        responses: {
            /** @description 新 revision 已生成 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelProfileDetail"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    agentd_validate_model_profile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                profile_id: components["parameters"]["ProfileId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    revision?: number;
                };
            };
        };
        responses: {
            /** @description 探测完成（结论见 verdict） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ValidationReport"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    agentd_activate_model_profile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                profile_id: components["parameters"]["ProfileId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    revision: number;
                    /** @description 乐观锁：与当前激活 revision 不一致即 409 */
                    base_active_revision?: number;
                };
            };
        };
        responses: {
            /** @description 已激活 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelProfileDetail"];
                };
            };
            400: components["responses"]["BadRequest"];
            409: components["responses"]["Conflict"];
        };
    };
    agentd_list_approvals: {
        parameters: {
            query?: {
                status?: "persisted" | "announced" | "waiting" | "approved" | "denied" | "timeout" | "cancelled";
                limit?: components["parameters"]["Limit"];
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
                    "application/json": components["schemas"]["ApprovalList"];
                };
            };
        };
    };
}
