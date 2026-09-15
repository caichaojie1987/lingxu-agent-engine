/**
 * agent-engine 常驻服务（PI 内核 sidecar）—— Phase1/2
 *
 * 职责：接收业务后端的 /chat，按场景驱动模型会话：
 *   - 持久场景（assistant）：按 (scene × session_key) 长活会话（原生多轮 + compaction）
 *   - 临时场景（faq，public 对外）：每次请求独立会话，用完即弃（防跨客户串话；
 *     对外回答出口先过引擎侧合规词库，业务后端可再做第二层）
 * 工具执行两种形态：内置 mock（demo 开箱即跑）或经业务后端内部只读 API（X-Service-Token）。
 *
 * 运行：npm start（node src/server.mjs），默认端口 8020
 *   POST /chat  {"scene":"dashboard|inbox","tenant_id":1,"project_id":1,
 *                "question":"...", "session_key":"可选，同一对话维度复用会话"}
 *   POST /internal/v1/llm/single  {system,user,temperature,max_tokens,tenant_id,project_id}
 *                → {text, model, usage}（L2 结构化单发 noTools 直答：不经场景/
 *                无工具/无会话副作用——对齐 agentic-blueprint noTools 安全面）
 *   GET  /health
 */
import http from "node:http";
import { readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ENGINE_NAME,
  createRuntime,
  createSession as kernelCreateSession,
  dispose as kernelDispose,
  listAvailable as kernelListAvailable,
  loadResources as kernelLoadResources,
  modelLabel as kernelModelLabel,
  prompt as kernelPrompt,
  sessionFile as kernelSessionFile,
  singleShot as kernelSingleShot,
  subscribe as kernelSubscribe,
} from "./pi-adapter.mjs";

import { config } from "./config.mjs";
import { enforcePublic } from "./compliance.mjs";
import { traceStore } from "./trace.mjs";
import { mcpManager } from "./mcp.mjs";
// P2（2026-09-10）：AI 长期记忆——每轮结束抽取业务事实、下轮注入提示前缀。
// 仅内部场景（advisor/dashboard）生效；C 端场景 fetchPrefix 直接返回空串，零影响。
import { fetchPrefix as fetchMemoryPrefix, saveFromTurn as saveTurnMemory } from "./memory.mjs";
// P1 第二档 C-1（2026-09-09）：AI 算力计量与配额——每轮记账、超限不调 LLM。
import { checkQuota, recordUsage, quotaMessage } from "./usage.mjs";
// P0-1（2026-09-09）：模型调用韧性——可重试错误自动重试（流式已产出即不重试）；
// 无状态路径（单发/临时场景）重试耗尽后降级备用模型。持久会话与模型句柄绑定，只重试不降级。
import { withRetry, isRetryable, friendlyError, describeError } from "./resilience.mjs";
import { makeDemoScene } from "./scenes/demo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_ROOT = path.join(__dirname, "..", "sessions");   // 持久会话落盘根（按租户隔离）

// 当前请求的统计对象（工具执行时经 ALS 取出，跨并发请求安全）
const callCtx = new AsyncLocalStorage();

// ── 模型运行时（进程级一次） ───────────────────────────────
// ── 模型运行时（进程级一次；内核细节封装在 pi-adapter，换 harness 不动此处） ──
const { runtime: modelRuntime, model: bootModel } = await createRuntime(config.model);
let model = bootModel;
if (!model) {
  console.error("[agent-engine] 无可用模型（请先配置模型 provider key）");
  process.exit(1);
}
console.log(`[agent-engine] model = ${kernelModelLabel(model)}`);

// 场景 make 统一入口（批次4：deriveTools 场景的 make 为 async——工具可用清单先从
// 后端 GET /internal/v1/tools?scene= 派生，schema 仍取本地声明交集；失败回退本地全表）
async function sceneDefMake(def, ctx) {
  const built = def.make(ctx);
  return built && typeof built.then === "function" ? await built : built;
}

// ── 场景注册表 ────────────────────────────────────────────
// public=true：对外场景，出口先过引擎侧合规预过滤（词库与 FastAPI 出口同源，
// M4 合规双层·第一层；业务后端第二层 第二层仍强制，两层核对同一词库）
const SCENES = {
  // 场景开发见 docs/scene-guide.md：make(ctx) 返回 {systemPrompt, tools}；
  // persist=true 长活会话（多轮），public=true 出口过合规词库（对外安全面）。
  assistant: { make: makeDemoScene, persist: true, public: false },
  faq: { make: (ctx) => makeDemoScene(ctx, { ephemeral: true }), persist: false, public: true },
};

// ── 资源加载器缓存：场景工具/系统提示只构建一次，会话/请求共享 ──
/** @type {Map<string, DefaultResourceLoader>} */
const loaderCache = new Map();

function loaderKey(scene, tenantId, projectId, role) {
  // 批次4：派生场景（工具表按 role 从后端裁剪）须按 role 分键，否则先到的角色被缓存串用
  return `${scene}:${tenantId}:${projectId}${role ? `:${role}` : ""}`;
}

async function getLoader(scene, ctx) {
  const def = SCENES[scene];
  const needsRole = Boolean(def?.deriveTools);
  const key = loaderKey(scene, ctx.tenantId, ctx.projectId, needsRole ? (ctx.role || "-") : "");
  let loader = loaderCache.get(key);
  if (loader) return loader;

  const built = await sceneDefMake(def, ctx);
  loader = await kernelLoadResources({
    cwd: path.join(__dirname, ".."),
    systemPrompt: built.systemPrompt,
    tools: built.tools,
    onToolCall: async (event) => {
      const s = callCtx.getStore();
      if (s) {
        s.toolCalls = (s.toolCalls || 0) + 1;
        s.toolNames = s.toolNames ?? [];
        s.toolNames.push(event.toolName);
        if (typeof s.emit === "function") s.emit("tool", { name: event.toolName });
      }
    },
  });
  loaderCache.set(key, loader);
  console.log(`[agent-engine] +资源 ${key}`);
  return loader;
}

function makeSession(loader, { persistDir, useModel } = {}) {
  // 会话创建细节（SessionManager + createAgentSession）封装在 pi-adapter
  // useModel：降级路径用备用模型句柄；缺省=当前主模型
  return kernelCreateSession(loader, useModel ?? model, { persistDir });
}

/** 备用模型句柄（config.llmFallbackModel 为 "provider/model"；空/不可用返回 null）。 */
function fallbackModel() {
  const ref = config.llmFallbackModel;
  if (!ref || !ref.includes("/")) return null;
  const [prov, id] = ref.split("/");
  try {
    const m = modelRuntime.getModel(prov, id);
    if (!m) console.warn(`[agent-engine] 备用模型不可用: ${ref}`);
    return m ?? null;
  } catch (e) {
    console.warn(`[agent-engine] 备用模型取用失败 ${ref}: ${e.message}`);
    return null;
  }
}

// ── 持久会话管理：长活 + LRU ──────────────────────────────
/** @type {Map<string, {session:any, loader, buffer:string, toolCalls:number, enqueue:Function, lastUsed:number}>} */
const sessions = new Map();

function makeQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

async function getOrCreatePersistent(scene, key, ctx) {
  let holder = sessions.get(key);
  if (holder) return holder;

  const loader = await getLoader(scene, ctx);
  const persistDir = path.join(SESSIONS_ROOT, `t${ctx.tenantId}`);   // 按租户隔离落盘
  const { session } = await makeSession(loader, { persistDir });
  const holderObj = {
    session,
    loader,
    buffer: "",
    toolCalls: 0,
    toolNames: [],
    usage: emptyUsage(),
    enqueue: makeQueue(),
    lastUsed: Date.now(),
  };
  const sessFile = kernelSessionFile(session);
  if (sessFile) console.log(`[agent-engine] 会话落盘: ${sessFile}`);
  kernelSubscribe(session, (ev) => {
    if (ev.type === "delta") {
      if (!holderObj.turnFirstDelta) holderObj.turnFirstDelta = Date.now();   // P1-2：本轮首字时刻
      holderObj.buffer += ev.text;
      if (typeof holderObj.emit === "function") holderObj.emit("delta", { text: ev.text });
    } else if (ev.type === "usage") {
      accumulateUsage(holderObj, ev.usage);
    } else if (ev.type === "end") {
      holderObj.lastUsed = Date.now();
    }
  });
  sessions.set(key, holderObj);
  evictPersistent();
  console.log(`[agent-engine] +会话 ${key}（当前 ${sessions.size}）`);
  return holderObj;
}

function evictPersistent() {
  while (sessions.size > config.maxSessions) {
    const oldestKey = sessions.keys().next().value;
    const h = sessions.get(oldestKey);
    kernelDispose(h?.session);
    sessions.delete(oldestKey);
    console.log(`[agent-engine] -会话 ${oldestKey}（LRU 淘汰）`);
  }
}

/** 持久场景：长活会话内排队执行一次提问 */
async function chatPersistent(scene, key, ctx, question, traceId = "", emitFn = null) {
  const holder = await getOrCreatePersistent(scene, key, ctx);
  const queuedAt = Date.now();
  return holder.enqueue(async () => {
    const t0 = Date.now();                       // P1-2：本轮起点（排队结束）
    holder.turnFirstDelta = 0;
    holder.buffer = "";
    holder.toolCalls = 0;
    holder.toolNames = [];
    holder.usage = emptyUsage();   // 本问清零重计（跨问不混）
    holder.traceId = traceId;   // 本问的工具调用透传给 backend（AgentLog 同 trace 串联）
    holder.emit = emitFn;       // SSE 流式：本问期间工具/文本增量透出（无则 null）
    let retryStat = null;       // P1-2：本轮重试统计
    // P2：注入长期记忆前缀（仅内部场景；无记忆=空串，对本轮零影响）
    const memPrefix = await fetchMemoryPrefix(ctx, { scene });
    const promptText = memPrefix ? `${memPrefix}\n\n${question}` : question;
    try {
      // P0-1：可重试错误自动重试；本轮已吐字/已调工具即停（canRetry），避免重复输出。
      // 持久会话不降级：模型句柄与会话绑定，换模型须重建会话（丢上下文）。
      retryStat = await withRetry(
        () => traceStore.run(traceId, () => callCtx.run(holder, () => kernelPrompt(holder.session, promptText, { timeoutMs: config.promptTimeoutMs }))),
        { attempts: config.llmAttempts, baseDelayMs: config.llmRetryBaseDelayMs,
          canRetry: () => holder.buffer.length === 0 && holder.toolCalls === 0,
          onRetry: (i) => console.warn(`[agent-engine] 模型重试 ${i.attempt}/${i.maxAttempts} scene=${scene} status=${i.status} ${i.error}`) },
      );
    } finally {
      holder.emit = null;
    }
    const result = {
      answer: holder.buffer.trim(),
      tool_calls: holder.toolCalls,
      tool_names: holder.toolNames,
      session_id: key,
      engine: ENGINE_NAME,
      model: kernelModelLabel(model),
      usage: holder.usage,
      // P1-2 耗时分解：排队/模型总耗时/首字延迟/尝试次数（答错时区分"慢"还是"错"）
      timing: {
        queue_ms: t0 - queuedAt,
        prompt_ms: Date.now() - t0,
        ttft_ms: holder.turnFirstDelta ? holder.turnFirstDelta - t0 : 0,
        attempts: retryStat?.attempts ?? 1,
        retries: Math.max(0, (retryStat?.attempts ?? 1) - 1),
      },
    };
    // P2：本轮结束后抽取业务事实落库（异步 fire-and-forget；失败只记日志，不影响回答）
    void saveTurnMemory({ question, answer: result.answer, ctx, runtime: modelRuntime, model, scene });
    // C-1：本轮算力记账（异步 fire-and-forget；失败只记日志，不影响回答）
    void recordUsage({ ctx, scene, model: result.model, usage: result.usage });
    return result;
  });
}

/** 临时场景：一次性会话，问完即弃（无跨请求上下文）。
 *  M4 治理（2026-09-07）：会话仍按租户 JSONL 落盘作审计/评测底料（replay.mjs/eval.mjs 读 sessions/）。
 *  串话风险评估：SessionManager.create() 每次新建独立会话文件，不扫描/不续读目录内旧文件，
 *  落盘只是"写出"，上下文复用为零 —— 与"用完即弃"语义正交，不引入跨客户串话。 */
async function chatEphemeral(scene, ctx, question, traceId = "", emitFn = null) {
  // 任一次尝试是否已向用户吐字——已产出即不得降级重跑（否则重复输出）
  let produced = false;

  /** 单次尝试：useModel 缺省=主模型；降级路径传入备用模型句柄（重建会话） */
  const attempt = async (useModel) => {
    const t0 = Date.now();                       // P1-2：本轮起点
    let firstDelta = 0;
    const loader = await getLoader(scene, ctx);
    const buf = { buffer: "", toolCalls: 0, toolNames: [], traceId, emit: emitFn, usage: emptyUsage() };
    const persistDir = path.join(SESSIONS_ROOT, `t${ctx.tenantId}`);   // 与持久场景同租户目录，每问一个新文件
    const { session } = await makeSession(loader, { persistDir, useModel });
    kernelSubscribe(session, (ev) => {
      if (ev.type === "usage") accumulateUsage(buf, ev.usage);
      else if (ev.type === "delta") {
        if (!firstDelta) firstDelta = Date.now();
        produced = true;
        buf.buffer += ev.text;
        if (typeof buf.emit === "function") buf.emit("delta", { text: ev.text });
      }
    });
    try {
      // P2：注入长期记忆前缀（仅内部场景生效；C 端场景 fetchMemoryPrefix 返回空串）
      const memPrefix = await fetchMemoryPrefix(ctx, { scene });
      const promptText = memPrefix ? `${memPrefix}\n\n${question}` : question;
      // P0-1：可重试错误自动重试；已吐字/已调工具即停
      const retryStat = await withRetry(
        () => traceStore.run(traceId, () => callCtx.run(buf, () => kernelPrompt(session, promptText, { timeoutMs: config.promptTimeoutMs }))),
        { attempts: config.llmAttempts, baseDelayMs: config.llmRetryBaseDelayMs,
          canRetry: () => buf.buffer.length === 0 && buf.toolCalls === 0,
          onRetry: (i) => console.warn(`[agent-engine] 模型重试 ${i.attempt}/${i.maxAttempts} scene=${scene} status=${i.status} ${i.error}`) },
      );
      const result = {
        answer: buf.buffer.trim(),
        tool_calls: buf.toolCalls,
        tool_names: buf.toolNames,
        session_id: `eph:${ctx.tenantId}:${ctx.projectId}`,
        engine: ENGINE_NAME,
        model: kernelModelLabel(useModel ?? model),
        usage: buf.usage,
        // P1-2 耗时分解（临时场景无排队）
        timing: {
          queue_ms: 0,
          prompt_ms: Date.now() - t0,
          ttft_ms: firstDelta ? firstDelta - t0 : 0,
          attempts: retryStat?.attempts ?? 1,
          retries: Math.max(0, (retryStat?.attempts ?? 1) - 1),
        },
      };
      // P2：抽取记忆（内部场景才真正写入；C 端场景 saveTurnMemory 内部直接返回）
      void saveTurnMemory({ question, answer: result.answer, ctx, runtime: modelRuntime, model: useModel ?? model, scene });
      // C-1：本轮算力记账（异步 fire-and-forget；失败只记日志，不影响回答）
      void recordUsage({ ctx, scene, model: result.model, usage: result.usage });
      return result;
    } finally {
      kernelDispose(session);
    }
  };

  try {
    return await attempt(model);
  } catch (e) {
    const fb = fallbackModel();
    if (!fb || produced || !isRetryable(e)) throw e;   // 已吐字/不可重试/无备用 → 原样上抛
    console.warn(`[agent-engine] 重试耗尽，降级备用模型 ${config.llmFallbackModel} scene=${scene} status=${e?.status ?? 0}`);
    return await attempt(fb);   // 降级仅一次；再失败则上抛
  }
}

// ── L2 结构化单发：noTools 直答（收尾 B 新增） ─────────────────
/** 单发直答（noTools 安全面）：不经场景 loader/持久会话/工具注册表——
 *   system+user 一次 completeSimple，模型只能吐文本（无工具=无任何触达面，
 *   对齐 agentic-blueprint noTools 概念）。返回 {text, model, usage}。
 *   合规出口由 业务后端出口层 强制（本端点不透 audience，语义与 legacy
 *   gateway.chat 的出口过滤同口径，单层即可——不因换内核缺失）。 */
async function runSingleShot({ system, user, temperature, maxTokens }) {
  // noTools 单发（内核细节在 pi-adapter.singleShot）：模型只能吐文本，无工具触达面
  const call = (useModel) => kernelSingleShot(modelRuntime, useModel ?? model, {
    system, user, temperature, maxTokens, timeoutMs: config.singleTimeoutMs,
  });
  try {
    // P0-1：无流式（整段返回），重试安全
    const r = (await withRetry(() => call(model), {
      attempts: config.llmAttempts, baseDelayMs: config.llmRetryBaseDelayMs,
      onRetry: (i) => console.warn(`[agent-engine] 单发重试 ${i.attempt}/${i.maxAttempts} status=${i.status} ${i.error}`),
    })).value;
    return { text: r.text, model: kernelModelLabel(model), usage: r.usage };
  } catch (e) {
    const fb = fallbackModel();
    if (!fb || !isRetryable(e)) throw e;
    console.warn(`[agent-engine] 单发降级备用模型 ${config.llmFallbackModel} status=${e?.status ?? 0}`);
    const r = await call(fb);   // 降级仅一次；再失败上抛
    return { text: r.text, model: kernelModelLabel(fb), usage: r.usage, degraded: true };
  }
}

// ── HTTP 服务 ─────────────────────────────────────────────
function listSessionFiles() {
  // 返回按租户分组的持久会话文件清单（评测/审计用）
  const out = {};
  if (!existsSync(SESSIONS_ROOT)) return out;
  for (const dir of readdirSync(SESSIONS_ROOT)) {
    const dpath = path.join(SESSIONS_ROOT, dir);
    if (!statSync(dpath).isDirectory()) continue;
    out[dir] = readdirSync(dpath)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const st = statSync(path.join(dpath, f));
        return { file: f, kb: Math.round(st.size / 1024), mtime: st.mtime.toISOString() };
      });
  }
  return out;
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// ── token/费用计量（2026-09-10：每企业算力用量）──
// pi 终态消息 usage 形态：{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost:{…}}
// 每次 LLM 调用（含工具轮）都会 message_end 一次——按问累计=该次请求真实消耗。
function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
           reasoning_tokens: 0, total_tokens: 0, cost_usd: 0 };
}
function accumulateUsage(bag, u) {
  if (!u) return;
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  bag.usage.input_tokens += n(u.input ?? u.input_tokens ?? u.prompt_tokens);
  bag.usage.output_tokens += n(u.output ?? u.output_tokens ?? u.completion_tokens);
  bag.usage.cache_read_tokens += n(u.cacheRead ?? u.cache_read_tokens);
  bag.usage.cache_write_tokens += n(u.cacheWrite ?? u.cache_write_tokens);
  bag.usage.reasoning_tokens += n(u.reasoning ?? u.reasoning_tokens);
  bag.usage.total_tokens += n(u.totalTokens ?? u.total_tokens ?? (u.input ?? 0) + (u.output ?? 0));
  bag.usage.cost_usd += n(u.cost?.total ?? u.cost_usd ?? u.cost);
}

// ── 输出清洗（2026-09-08）：去掉模型"我先查/让我调"式过程自述——工具过程前端已可视化，正文自述=噪音。
// 双层：整行自述（短行）整删；成品行内的自述短句按句级删（句号切分、保留换行与 md 结构）。──
function cleanNarration(text) {
  if (!text) return text;
  // 行首英文自述剥离（2026-09-09 实测漏网：模型偶发以 "Let me check the sales stats for this month."
  // 开头再跟中文正文，LANG_HINT 与中文自述正则都拦不住，客户会直接看到英文）。
  // 只剥行首一句、保留其后正文，避免误删整行内容。
  const EN_NARRATION = /^(?:let\s+me|i'?ll|i\s+will|now\s+let\s+me|first,?\s*let\s+me|let\s+us|let'?s|i\s+need\s+to|i'?m\s+going\s+to|i\s+am\s+going\s+to|checking|looking\s+up|i'?ve|i\s+have)\b[^.。!！?？]*[.。!！?？]\s*/i;
  // 业务字段名兜底映射（2026-09-09 实测：工具返回英文键名，模型偶发原样写进正文，
  // 客户会看到 "首付20万 due 2026-09-09 状态 pending"）。只替换独立词，避免误伤。
  const FIELD_MAP = [
    // 示例：模型偶发把工具返回的英文键名原样写进正文，这里做兜底中文映射。
    // 按你自己的业务字段扩展（键名 → 展示名），详见 cleanNarration 上方注释。
    [/(?<![A-Za-z])order_id(?![A-Za-z])/g, "订单号"],
    [/(?<![A-Za-z])amount_yuan(?![A-Za-z])/g, "金额(元)"],
    [/(?<![A-Za-z])due_date(?![A-Za-z])/g, "到期日"],
    [/(?<![A-Za-z])status(?![A-Za-z])/g, "状态"],
    [/(?<![A-Za-z])amount(?![A-Za-z])/g, "金额"],
    [/(?<![A-Za-z])pending(?![A-Za-z])/g, "待处理"],
    [/(?<![A-Za-z])paid(?![A-Za-z])/g, "已付"],
    [/(?<![A-Za-z])overdue(?![A-Za-z])/g, "逾期"],
  ];
  const lines = String(text).split("\n").map((ln) => {
    let s = ln.replace(EN_NARRATION, "");
    for (const [re, zh] of FIELD_MAP) s = s.replace(re, zh);
    return s;
  });
  const out = [];
  for (const raw of lines) {
    const t = raw.trimEnd();
    if (!t.trim()) { out.push(""); continue; }
    const s = t.trim();
    const shortLine = s.length <= 60;
    const head = s.replace(/^["“'『\s]+/, "").slice(0, 16);
    const isNarration = /^(我先|让我|我来|我查|稍等|先让|这边我|我先拉|我先调|等我|我这边|让我按|我先用|我马上|好的，?我|嗯，?我|我需要(?!您)|我已|我定位|我完成|我这就|现在(?!您|你))/.test(head);
    const opWord = /(检索|查询|拉取|调取|获取|档案|素材包|工具|数据|定位|客户信息|确认一下)/.test(s.slice(0, 60));
    const isIdMid = /^(拿到|找到|确认(了|到)?(客户)?id|已定位|拉取(到)?|已查到|查到了|客户id(为|是|：|:)|该客户)/.test(head) && !/^(查到|找到)(了)?\d/.test(head);
    const isFill = /^(好的|嗯|好的呢|可以|没问题|收到)$/.test(head);
    const pureNarrationLine = (isNarration && opWord || isIdMid || isFill) && shortLine && !s.includes("|") && !s.includes("。") && !s.includes("！") && !s.includes("？");
    if (pureNarrationLine) continue;   // 整行=单句无标点自述（如"我先查一下数据"）才整行删
    // 句级：把明显自述短句从行里剔除（按句号切分保留标点），成品句保留
    const cleaned = s.split(/(?<=[。！？!?])/).map(seg => {
      const sg = seg.trim();
      if (!sg) return "";
      const h2 = sg.replace(/^["“'『\s]+/, "").slice(0, 12);
      const short = sg.length <= 50;
      const n2 = /^(我先|让我|我来|我查|稍等|先让|这边我|我先拉|我先调|等我|我这边|让我按|我先用|我马上|我需要(?!您)|我拉|我调|我拿|我取|我再看|我准备|我来写|我已|我定位|我完成|接下来(?!您|你们|客户)|随后我|下面我|我这就|让我先|现在(?!您|你|他|她|客户)|目前我|我先给)/.test(h2) && short && /(检索|查询|拉取|调取|获取|档案|素材包|工具|数据|定位|客户信息|确认一下|写|整理|组织|掌握|分析)/.test(sg);
      const m2 = /^(拿到|找到|确认(了|到)?(客户)?id|已定位|拉取(到)?|已查到|查到了|客户id(为|是|：|:)|该客户)/.test(h2) && short && !/^(查到|找到)(了)?\d/.test(h2);
      const m3 = /id\s*[=：:]\s*\d+/.test(sg) && /我(拉|调|查|取|来)/.test(sg) && short;
      const f2 = /^(好的|嗯|好的呢|可以|没问题|收到)$/.test(sg.replace(/[。！？!?]/g, ""));
      return (n2 || m2 || m3 || f2) ? "" : sg;
    }).filter(Boolean).join(" ");
    if (cleaned.trim()) out.push(cleaned);
  }
  const joined = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // 防止清洗伤文：几乎全删（<8字）→ 保原文（短成品句如"未来一周待收42万"不会被误保）
  return joined.length >= 8 ? joined : String(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/admin/models" && req.method === "GET") {
      // 可用模型清单（pi getAvailable 同源：provider+已配 key 的模型）
      if (req.headers["x-service-token"] !== config.serviceToken) return send(res, 401, { detail: "service token 无效" });
      const avail = await kernelListAvailable(modelRuntime);
      const list = (avail || []).map((m) => ({ provider: m.provider, id: m.id, label: `${m.provider}/${m.id}` }));
      return send(res, 200, { models: list, active: `${model.provider}/${model.id}` });
    }
    if (url.pathname === "/admin/model" && req.method === "POST") {
      // 管理端热切主模型（provider/model）——无需重启；重启后回落 env AGENT_MODEL
      if (req.headers["x-service-token"] !== config.serviceToken) {
        return send(res, 401, { detail: "service token 无效" });
      }
      const body = await readBody(req);
      const ref = String(body?.model || "").trim();
      if (!ref.includes("/")) return send(res, 400, { detail: "格式: provider/model（如 deepseek/deepseek-v4-flash）" });
      const [prov, mid] = ref.split("/");
      const m2 = modelRuntime.getModel(prov, mid);
      if (!m2) return send(res, 400, { detail: `provider/models 不存在：${ref}（可先到管理端配置该供应商 Key）` });
      model = m2;
      config.model = ref;
      console.log(`[agent-engine] 主模型热切 -> ${model.provider}/${model.id}`);
      return send(res, 200, { ok: true, model: `${model.provider}/${model.id}` });
    }
    if (url.pathname === "/health" && req.method === "GET") {
      return send(res, 200, {
        status: "ok",
        model: kernelModelLabel(model),
        sessions: sessions.size,
        loaders: loaderCache.size,
        mcp: mcpManager.stats(),   // 网关连接统计（ready/failed/工具数）
        uptime_s: Math.round(process.uptime()),
      });
    }
    if (url.pathname === "/internal/v1/mcp/tools" && req.method === "GET") {
      // MCP 网关·场景工具清单：返回本租户 scene_scope 放行且连接成功的 mcp.* 工具
      // （供 dashboard 等场景 loader 合并 / 外部自检；同 /chat 门禁）
      if (req.headers["x-service-token"] !== config.serviceToken) {
        return send(res, 401, { detail: "service token 无效" });
      }
      const scene = url.searchParams.get("scene") ?? "";
      const role = url.searchParams.get("role") ?? "";
      const tenantId = Number(url.searchParams.get("tenant_id") ?? 1) || 1;
      const projectId = Number(url.searchParams.get("project_id") ?? 0) || 0;
      const tools = await mcpManager.describeSceneTools({ tenantId, projectId, scene, role });
      return send(res, 200, {
        scene,
        role,
        tenant_id: tenantId,
        project_id: projectId,
        count: tools.length,
        tools,
        mcp: mcpManager.stats(),
      });
    }
    if (url.pathname === "/internal/v1/mcp/call" && req.method === "POST") {
      // MCP 网关·工具调用代理：{tenant_id, server, tool, arguments} → McpManager.callTool
      if (req.headers["x-service-token"] !== config.serviceToken) {
        return send(res, 401, { detail: "service token 无效" });
      }
      const body = await readBody(req);
      const { tenant_id: tid, project_id: pid, server: srv, tool: toolName, arguments: args } = body ?? {};
      if (!srv || !toolName) return send(res, 400, { detail: "需要 {server, tool}" });
      const r = await mcpManager.callTool({
        tenantId: Number(tid ?? 1) || 1,
        projectId: Number(pid ?? 0) || 0,
        server: String(srv),
        tool: String(toolName),
        arguments: args ?? {},
      });
      if (!r.ok) {
        const notFound = r.error.includes("未启用或不存在") || r.error.includes("不在「");
        return send(res, notFound ? 404 : 502, { detail: r.error });
      }
      return send(res, 200, { server: srv, tool: toolName, ok: true, is_error: !!r.is_error, text: r.text, content: r.content });
    }
    if (url.pathname === "/sessions" && req.method === "GET") {
      // 持久会话落盘清单（评测/审计）
      return send(res, 200, { root: SESSIONS_ROOT, by_tenant: listSessionFiles() });
    }
    if (url.pathname === "/chat" && req.method === "POST") {
      if (req.headers["x-service-token"] !== config.serviceToken) {
        return send(res, 401, { detail: "service token 无效" });
      }
      const body = await readBody(req);
      const { scene, tenant_id, project_id, question, session_key, user_id, role, trace_id } = body ?? {};
      console.log(`[chat-req] scene=${scene} persist=${SCENES[scene]?.persist} ${req.headers['x-service-token'] === config.serviceToken ? 'tok-ok' : 'tok-BAD'}`);
      if (!SCENES[scene] || !tenant_id || !project_id || !question?.trim()) {
        return send(res, 400, { detail: `需要 scene ∈ ${Object.keys(SCENES)} 且 tenant_id/project_id/question 非空` });
      }
      const ctx = { tenantId: Number(tenant_id), projectId: Number(project_id),
                    userId: Number(user_id ?? 0) || 0, role: role ?? "" };
      // B10 批次4：全链 trace（业务后端 生成 → 场景工具调用透传 → AgentLog 同 id）
      const traceId = String(trace_id || `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).slice(0, 32);
      const wantStream = body.stream === true;   // SSE 流式：tool/delta 事件 + 尾部 done（2026-09-08）
      // 安全面：流式仅内部场景（advisor/dashboard）使用——对外 public 场景保持整段+双层合规（delta 流不经词级过滤不启用）
      if (wantStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8",
                             "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      }
      const sseSend = wantStream
        ? (type, payload) => {
            try { res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* 连接已断 */ }
          }
        : null;
      const emitFn = wantStream
        ? (type, payload) => {
            // tool 事件发生在 loader 的 pi.on（extensionFactories 捕获时 s=holder 已有 emit）
            sseSend(type, payload);
          }
        : null;
      // C-1：配额前置拦截（超限直接回提示、不调 LLM——省钱且可追责；查询故障 fail-open）
      const quota = await checkQuota(ctx);
      if (quota.exceeded) {
        console.log(`[agent-engine] 配额超限拦截 t${ctx.tenantId} u${ctx.userId} scene=${scene}`);
        const payload = { answer: quotaMessage(quota), tool_calls: 0, tool_names: [],
                          session_id: `quota:${ctx.tenantId}`, engine: ENGINE_NAME,
                          model: kernelModelLabel(model), usage: emptyUsage(),
                          trace_id: traceId, quota_exceeded: true };
        if (wantStream) { sseSend("done", payload); return res.end(); }
        return send(res, 200, payload);
      }
      try {
        const def = SCENES[scene];
        let r;
        if (def.persist) {
          // 持久场景默认 key：scene:tenant:project[:业务日]——业务日维度防跨日陈旧口径
          // （2026-09-05 实测：工具口径修复后 dashboard:1:1 旧会话仍复述修复前假数 100套，
          //   因未重新调工具。按日切会话让问数始终以当日新上下文调工具，AgentLog/session_id 仅留痕用）
          const day = new Date().toISOString().slice(0, 10);
          const key = `${scene}:${session_key || `${ctx.tenantId}:${ctx.projectId}`}${session_key ? "" : `:${day}`}`;
          r = await chatPersistent(scene, key, ctx, question, traceId, emitFn);
        } else {
          r = await chatEphemeral(scene, ctx, question, traceId, emitFn);
        }
        // 对外场景：引擎侧出口合规预过滤（M4 双层·第一层，词库与 FastAPI 出口同源）
        if (def.public && r?.answer) {
          const c = enforcePublic(r.answer);
          if (!c.passed || c.action === "replace") {
            r.answer = c.text;
            r.compliance = { action: c.action, reason: c.reason };
            console.log(`[agent-engine] 合规出口 ${scene}: ${c.action} ${c.reason}`);
          }
        }
        if (r?.answer) r.answer = cleanNarration(r.answer);   // 自述句清洗（工具过程已可视化，正文不自述）
        r.trace_id = traceId;
        // P1-2：一行结构化耗时日志（排障不必翻 SSE 时间轴）
        const tm = r.timing ?? {};
        console.log(`[agent-engine] chat ok scene=${scene} model=${r.model} tok=${r.usage?.total_tokens ?? 0} tools=${r.tool_calls ?? 0} ttft=${tm.ttft_ms ?? 0}ms prompt=${tm.prompt_ms ?? 0}ms retries=${tm.retries ?? 0}`);
        if (wantStream) {
          sseSend("done", r);
          return res.end();
        }
        return send(res, 200, r);
      } catch (e) {
        // P0-1：日志留结构化细节（状态码/可重试），回给用户的是中文话术（不泄露上游原文）
        console.error(`[agent-engine] chat 失败: ${JSON.stringify(describeError(e))}`);
        const detail = friendlyError(e);
        if (wantStream) {
          res.write(`event: error\ndata: ${JSON.stringify({ detail })}\n\n`);
          return res.end();
        }
        return send(res, 502, { detail });
      }
    }
    if (url.pathname === "/internal/v1/llm/single" && req.method === "POST") {
      // L2 单发 noTools 直答端点（收尾 B）：门禁与 /chat 同款 X-Service-Token。
      // {system,user,temperature,max_tokens,tenant_id,project_id} → {text, model, usage}
      // tenant_id/project_id 仅留痕审计，不参与调用语义。
      if (req.headers["x-service-token"] !== config.serviceToken) {
        return send(res, 401, { detail: "service token 无效" });
      }
      const body = await readBody(req);
      const { system, user, temperature, max_tokens } = body ?? {};
      if (user == null || !String(user).trim()) {
        return send(res, 400, { detail: "需要非空 user" });
      }
      try {
        const r = await runSingleShot({
          system: system == null ? "" : String(system),
          user: String(user),
          temperature: typeof temperature === "number" ? temperature : NaN,
          maxTokens: Number(max_tokens),
        });
        const tid = Number(body?.tenant_id ?? 0) || 0;
        const pid = Number(body?.project_id ?? 0) || 0;
        console.log(`[agent-engine] llm/single ok t${tid} p${pid} tok=${r.usage.total_tokens} model=${r.model}`);
        return send(res, 200, r);
      } catch (e) {
        console.error(`[agent-engine] llm/single 失败: ${JSON.stringify(describeError(e))}`);
        return send(res, 502, { detail: friendlyError(e) });
      }
    }
    return send(res, 404, { detail: "Not Found" });
  } catch (e) {
    return send(res, 500, { detail: e.message });
  }
});

server.listen(config.port, config.host ?? "127.0.0.1", () => {
  console.log(`[agent-engine] listening on http://127.0.0.1:${config.port}`);
});
