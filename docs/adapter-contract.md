# 内核适配契约（换 harness 只改 pi-adapter.mjs）

引擎对模型内核的全部依赖收敛在 `src/pi-adapter.mjs`（约 160 行）。换内核 = 用新 harness 实现
下面 **5 类原语**，`server.mjs / scenes/* / 调用方` 一律不动。

## 5 类原语

| # | 原语 | 当前实现（pi） | 换内核要提供什么 |
|---|---|---|---|
| 1 | 模型运行时 | `ModelRuntime.create / getModel / getAvailable / completeSimple` | 进程级运行时；按 `provider/model` 取模型句柄；可用模型清单；无工具单发补全 |
| 2 | 资源装载 | `DefaultResourceLoader + extensionFactories（pi.on / registerTool）+ reload` | 注入 system prompt、注册工具（name/label/description/parameters/execute）、工具调用钩子 |
| 3 | 会话创建 | `SessionManager.create / inMemory + createAgentSession` | 持久化会话（目录落盘）与内存会话两种；`noTools:"builtin"` 语义 = 不给文件/命令/网络内置工具 |
| 4 | 会话驱动 | `session.prompt / dispose / sessionFile` | 驱动一轮对话（支持超时中断）；幂等释放；落盘文件路径（无则 null） |
| 5 | 事件流 | `session.subscribe` → 归一化 `{type:"delta"\|"usage"\|"end"}` | 文本增量、终态消息 usage（input/output/cacheRead/cacheWrite/reasoning/totalTokens/cost）、回合结束 |

## 换内核步骤

1. 新建 `src/<kernel>-adapter.mjs`，按上表实现同名导出（`ENGINE_NAME` 改成新内核名）；
2. `server.mjs` 的 import 从 `./pi-adapter.mjs` 切到新 adapter——**这是唯一要改的业务侧文件**；
3. 过下面的验收点（全绿才算换完）。

## 验收点（换内核前逐条打勾）

- [ ] `GET /health` 返回 `model` 与内核名正确；
- [ ] faq 场景（ephemeral + public）：单问回答正常；连续两问互不串话（独立会话）；
- [ ] assistant 场景（persist）：多轮上下文生效；LRU 超限淘汰不报错；
- [ ] 工具调用：demo 的 `query_orders` 被真实调用（`tool_calls ≥ 1`，`tool_names` 含工具名）；
- [ ] 流式：`stream:true` 依次收到 `tool`/`delta`/`done` 事件，`delta` 文本拼接 == 整段结果；
- [ ] 超时：把 `AGENT_PROMPT_TIMEOUT_MS` 调到 1000，能触发重试且不悬挂；
- [ ] 重试：拔掉模型 Key 触发可重试错误，日志出现 `模型重试` 且 `timing.attempts > 1`；
- [ ] 降级：配置 `AGENT_LLM_FALLBACK_MODEL`，主模型不可用时降级一次并返回 `degraded:true`；
- [ ] usage：`usage.total_tokens` 与内核账单一致量级；cost 字段可空；
- [ ] 合规：faq 问到词库 reject 词，答案被整段替换为 `public_fallback`；
- [ ] 评测：`npm run eval:golden` 全 PASS（结果与换核前基线一致）；
- [ ] 审计：`GET /sessions` 能看到新落盘 JSONL；`scripts/replay.mjs` 能转可读对话。

## 已知语义坑（换内核时最容易踩）

- **持久会话与模型句柄绑定**：换模型必须重建会话（丢上下文），所以持久路径只重试不降级；
- **usage 是按 message_end 累计的**：工具多轮会多次 message_end，按问累计 = 真实消耗，别按次覆盖；
- **prompt 超时中断后内核状态**：确认新内核超时中断后可安全 dispose，不挂句柄；
- **事件归一化别漏 `message_update` 外层**：pi 的 text_delta 藏在 `assistantMessageEvent` 里，
  换内核时照 `pi-adapter.subscribe` 的形状做映射即可。
