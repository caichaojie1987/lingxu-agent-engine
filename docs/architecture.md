# 架构总览

## 分层

```
业务后端 (FastAPI / Spring / …)                ← 鉴权、租户数据、审批、审计
   │  X-Service-Token（共享令牌）
   ▼
agent-engine（本仓库，Node sidecar）            ← 模型会话编排
   ├─ src/server.mjs        HTTP/SSE 服务：场景注册表、会话 LRU、配额拦截、重试降级
   ├─ src/scenes/*          场景：systemPrompt + 工具表（业务专属，按需增删）
   ├─ src/pi-adapter.mjs    内核适配层：引擎只依赖它的 5 类原语（换 harness 只改这里）
   ├─ src/compliance.mjs    出口合规：词库驱动的 reject/replace（public 场景强制）
   ├─ src/usage.mjs         算力计量：每轮按租户记账、配额前置拦截
   ├─ src/memory.mjs        长期记忆：每轮抽取业务事实，下轮注入前缀（内部场景）
   ├─ src/mcp.mjs           MCP 网关：注册表拉取 + 租户/场景/角色放行 + 调用代理
   ├─ src/resilience.mjs    韧性：可重试错误自动重试、备用模型降级
   └─ src/trace.mjs         trace_id 贯穿：工具调用可回溯到业务审计日志
```

## 一条请求的生命周期（POST /chat）

1. **门禁**：`X-Service-Token` 校验（防直连绕过业务后端）；
2. **配额**：查租户/用户配额，超限直接回提示（不调 LLM，查询故障 fail-open）；
3. **会话**：persist 场景按 `scene:tenant:project[:业务日]:session_key` 取/建长活会话（LRU 淘汰）；
   ephemeral 场景每次新建、用完即弃（落盘仅作审计底料，上下文复用为零）；
4. **驱动**：`session.prompt()`，事件归一化为 `delta / usage / end`；工具调用经 `pi.on("tool_call")`
   计数并透传 SSE `tool` 事件；
5. **韧性**：可重试错误自动重试——本轮已吐字或已调工具即停（`canRetry`），避免重复输出；
   无状态路径重试耗尽后降级备用模型重建会话（持久会话不降级：模型句柄与会话绑定）；
6. **出口**：public 场景先过合规词库（reject 整段替换 / replace 就地替换），再过自述句清洗；
7. **记账**：usage（token/费用/首字延迟/尝试次数）随响应返回，并异步落库。

## 设计原则

- **业务后端是唯一数据出口**：引擎不连业务库；工具执行 = 调后端内部只读 API（demo 场景除外）。
  这样鉴权、数据权限、审计全部留在后端，引擎保持无状态可横向扩。
- **内核可替换**：引擎对 pi 的依赖只有 5 类原语（见 adapter-contract），其余全自持。
  换 harness 的成本被压到一个文件。
- **安全面最小化**：内核以 `noTools:"builtin"` 启动（无文件/命令/网络内置工具）；
  单发端点根本不建会话/不注册工具——无工具即无触达面。
- **一切可审计**：会话 JSONL 按租户落盘、trace_id 贯穿工具调用、usage 按轮记账——
  评测（golden-qa / replay / eval）都吃这套底料。
