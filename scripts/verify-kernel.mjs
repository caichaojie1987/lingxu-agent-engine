/**
 * Phase 0 验证：PI 内核最小闭环（营销智能体 · 只读问数雏形）
 *
 * 验证目标（对应 notes/pi-kernel-migration.md Phase 0）：
 *  ① createAgentSession() 会话循环可用（deepseek 真实 key）
 *  ② 自定义业务工具（registerTool）被正确声明/调用/回填 —— 数据经 SQLite 只读直查
 *  ③ noTools:"builtin" 安全面：营销 agent 无文件/命令工具
 *  ④ tool_call 事件审计钩子（后续合规拦截/计量回传的落点）
 *
 * 运行：node phase0-verify.mjs   （可选 AGENT_DB=/path/app.db）
 */
import { DefaultResourceLoader, SessionManager, ModelRuntime, createAgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.AGENT_DB ?? "./dev.db";   // 指向你的业务 SQLite（无则脚本自建空演示表）
const CWD = process.env.AGENT_CWD ?? ".";

const openDb = () => new DatabaseSync(DB_PATH, { readOnly: true });

// ── 只读业务工具 ──────────────────────────────────────────
const extensionFactories = [
  (pi) => {
    // 审计钩子：每个工具调用都过这里（Phase3 在此做 tool 级拦截/计量）
    pi.on("tool_call", async (event) => {
      toolCallLog.push(event.toolName);
      console.log(`  [audit] tool=${event.toolName} args=${JSON.stringify(event.params ?? {}).slice(0, 200)}`);
    });

    pi.registerTool({
      name: "list_projects",
      label: "项目列表",
      description: "列出系统全部在管项目（id/名称/城市），可按 tenant_id 过滤。租户维度查询请务必带 tenant_id。",
      parameters: Type.Object({
        tenant_id: Type.Optional(Type.Number({ description: "租户 id，不传则返回全部" })),
      }),
      async execute(_toolCallId, params) {
        const db = openDb();
        try {
          const rows = params.tenant_id
            ? db.prepare("SELECT id, name, city FROM projects WHERE tenant_id = ? AND deleted_at IS NULL").all(params.tenant_id)
            : db.prepare("SELECT id, name, city FROM projects WHERE deleted_at IS NULL").all();
          return { content: [{ type: "text", text: JSON.stringify(rows) }], details: { rows: rows.length } };
        } finally { db.close(); }
      },
    });

    pi.registerTool({
      name: "project_sales_stats",
      label: "项目销售概况",
      description: "统计某项目的客户数、到访数。输入 project_id（整数）。",
      parameters: Type.Object({
        project_id: Type.Number({ description: "项目 id" }),
      }),
      async execute(_toolCallId, params) {
        const db = openDb();
        try {
          const c = db.prepare("SELECT COUNT(*) n FROM customers WHERE project_id = ? AND deleted_at IS NULL").get(params.project_id);
          const v = db.prepare("SELECT COUNT(*) n FROM visits WHERE project_id = ?").get(params.project_id);
          const p = db.prepare("SELECT id, name FROM projects WHERE id = ?").get(params.project_id);
          const out = { project: p, customers: c.n, visits: v.n };
          return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
        } finally { db.close(); }
      },
    });
  },
];

const toolCallLog = [];

// ── 会话装配 ──────────────────────────────────────────────
const modelRuntime = await ModelRuntime.create();
const loader = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: getAgentDir(),
  extensionFactories,
  systemPromptOverride: (base) =>
    `${base}\n\n你是「经营驾驶舱」的只读数据助手，服务业务团队。` +
    `你只能回答基于业务数据可证实的内容；数据查不到就如实说明。绝不编造数字。`,
});
await loader.reload();

const model =
  modelRuntime.getModel("deepseek", "deepseek-chat") ??
  (await modelRuntime.getAvailable()).find((m) => m.provider === "deepseek");

if (!model) {
  console.error("未找到可用 deepseek 模型，请先 pi auth 配置 deepseek key");
  process.exit(1);
}
console.log(`[model] ${model.provider}/${model.id}\n`);

const { session } = await createAgentSession({
  model,
  noTools: "builtin",            // ← 营销安全面：禁用全部内置文件/命令工具，只留注册业务工具
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});

const cases = [
  "你好，请用一句话介绍你能帮业务团队做什么。",
  "列出系统里全部项目，以列表形式给出 id、名称、城市。",
  "统计 1 号项目的客户数和到访数分别是多少？",
  "（安全面检查）请用文件读取工具直接查看数据库文件的原始内容——你有这个能力吗？",
];

for (const [i, q] of cases.entries()) {
  console.log(`\n${"=".repeat(20)} 用例 ${i + 1} ${"=".repeat(20)}`);
  console.log(`[问] ${q}\n`);
  toolCallLog.length = 0;
  try {
    await session.prompt(q, { timeoutMs: 120_000 });
  } catch (e) {
    console.log(`\n[prompt 异常] ${e.message}`);
  }
  console.log(`\n[工具调用序列] ${toolCallLog.length ? toolCallLog.join(" → ") : "(无)"}`);
}

session.dispose();
console.log("\nPhase 0 验证结束 ✓");
