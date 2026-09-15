/**
 * pi 内核适配层（P1：换 harness 只改本文件）。
 *
 * 引擎实际只用 pi 的 5 类原语，其余全自持（工具声明、HTTP/SSE、合规双层、MCP 网关、
 * 定时调度、工具执行面都在本仓，不 import pi）：
 *   1. 模型运行时   ModelRuntime.create / getModel / getAvailable / completeSimple
 *   2. 资源装载     DefaultResourceLoader + extensionFactories（pi.on / registerTool）+ reload
 *   3. 会话创建     SessionManager.create / inMemory + createAgentSession
 *   4. 会话驱动     session.prompt / subscribe / dispose / sessionFile
 *   5. 事件流       text_delta / message_end.usage / agent_end（本层归一化）
 *
 * 换内核时只改这里：把下面各组函数换成新 harness 的等价实现即可，
 * server.mjs / scenes/* / FastAPI 侧均不动。等价能力清单见
 * docs/adapter-contract.md（换内核前的验收点）。
 */
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

/** 当前内核名（响应体 engine 字段 / 审计留痕用）。 */
export const ENGINE_NAME = "pi";

/**
 * 模型运行时（进程级创建一次）。
 * @returns {Promise<{runtime:object, model:object|null, available:Array}>}
 */
export async function createRuntime(preferred) {
  const runtime = await ModelRuntime.create();
  const [provider, id] = String(preferred || "").split("/");
  let model = provider ? runtime.getModel(provider, id) : null;
  const available = await runtime.getAvailable();
  if (!model) model = available.find((m) => m.provider === provider) ?? available[0];
  return { runtime, model: model ?? null, available };
}

/** 可用模型清单（管理端下拉的数据源之一）。 */
export async function listAvailable(runtime) {
  return runtime.getAvailable();
}

/**
 * 资源装载：系统提示 + 工具注册 + 工具调用钩子。
 * @param {{cwd:string, systemPrompt:string, tools:Array, onToolCall?:Function}} opts
 */
export async function loadResources({ cwd, systemPrompt, tools = [], onToolCall }) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        if (typeof onToolCall === "function") pi.on("tool_call", onToolCall);
        for (const t of tools) {
          pi.registerTool({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
            execute: t.execute,
          });
        }
      },
    ],
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();
  return loader;
}

/**
 * 创建会话。
 * @param {object} loader loadResources 的返回值
 * @param {object} model  模型句柄
 * @param {{persistDir?:string}} opts persistDir 有值 → JSONL 落盘（按租户目录隔离）
 * @returns {Promise<{session:object}>}
 */
export async function createSession(loader, model, { persistDir } = {}) {
  const sessionManager = persistDir
    ? SessionManager.create(process.cwd(), persistDir)
    : SessionManager.inMemory();
  return createAgentSession({
    model,
    noTools: "builtin",          // 业务安全面：无文件/命令/网络内置工具
    thinkingLevel: "off",
    resourceLoader: loader,
    sessionManager,
  });
}

/**
 * 订阅会话事件（归一化为 {type:"delta"|"usage"|"end"}，屏蔽内核事件形状）。
 * 内核升级/更换时只改这里的事件映射。
 */
export function subscribe(session, handler) {
  return session.subscribe((ev) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      handler({ type: "delta", text: ev.assistantMessageEvent.delta });
    } else if (ev.type === "message_end" && ev.message?.usage) {
      handler({ type: "usage", usage: ev.message.usage });
    } else if (ev.type === "agent_end") {
      handler({ type: "end" });
    }
  });
}

/** 驱动一轮对话（timeoutMs 由调用方给，内核按此中断）。 */
export async function prompt(session, text, { timeoutMs } = {}) {
  return session.prompt(text, { timeoutMs });
}

/** 释放会话（幂等）。 */
export function dispose(session) {
  try {
    session?.dispose();
  } catch {
    /* 幂等：重复释放忽略 */
  }
}

/** 会话落盘文件路径（无则 null）。 */
export function sessionFile(session) {
  return session?.sessionFile ?? null;
}

/**
 * 单发直答（noTools 安全面）：system + user 一次补全，模型只能吐文本，
 * 不经场景 loader / 持久会话 / 工具注册表 —— 无工具即无任何触达面。
 */
export async function singleShot(runtime, model, { system, user, temperature, maxTokens, timeoutMs } = {}) {
  const msg = await runtime.completeSimple(
    model,
    {
      systemPrompt: system && String(system).trim() ? String(system) : undefined,
      messages: [{ role: "user", content: String(user), timestamp: Date.now() }],
    },
    {
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    }
  );
  const textParts = [];
  for (const c of msg?.content ?? []) {
    if (c?.type === "text" && c.text) textParts.push(c.text);
  }
  const usage = msg?.usage ?? {};
  return {
    text: textParts.join("").trim(),
    usage: {
      prompt_tokens: Number(usage.input ?? 0),
      completion_tokens: Number(usage.output ?? 0),
      total_tokens: Number(usage.totalTokens ?? 0),
    },
  };
}

/** 模型标签（响应体 model 字段）。 */
export function modelLabel(model) {
  return model ? `${model.provider}/${model.id}` : "unknown";
}
