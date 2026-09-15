/**
 * AI 助手长期记忆（P2，2026-09-10）：跨会话业务事实记忆的引擎侧。
 *
 * 两条路径（都走 FastAPI internal 通道，引擎侧零业务逻辑）：
 *   读：fetchPrefix(ctx) → GET  /internal/v1/memory?scene=&user_id=...
 *       返回后端拼好的 <memory> 前缀（≤800 字），本轮拼到用户问题前注入。
 *   写：saveFromTurn(...) → 单发 LLM 抽取业务事实 → POST /internal/v1/memory
 *       写入前由后端 services/ai_memory.redact 强制脱敏（手机号 → 138****1234）。
 *
 * 隐私与成本边界：
 *   - 只对内部场景（advisor/dashboard）读写；C 端对外场景（consultant/inbox）不碰，
 *     且后端会再挡一道（写场景白名单 403）。
 *   - 抽取是"尽力而为"：异步 fire-and-forget + 超时，失败只记日志，绝不影响本轮回答。
 *   - 记忆是用户资产：工作台可查看/删除（/api/v1/ai/memory），这里不隐藏任何写入。
 */
import { config } from "./config.mjs";
import { singleShot } from "./pi-adapter.mjs";

/** 允许读写记忆的内部场景（与后端 _MEMORY_WRITE_SCENES 同口径）。 */
const MEMORY_SCENES = new Set(["advisor", "dashboard"]);

const FETCH_TIMEOUT_MS = 2500;
const EXTRACT_TIMEOUT_MS = 12000;
const MAX_ITEMS = 3;

/** 取本轮注入前缀；不可用/无记忆返回空串（调用方原样拼接，空串=零影响）。 */
export async function fetchPrefix(ctx, { scene, limit = 8 } = {}) {
  if (!MEMORY_SCENES.has(scene) || !ctx?.userId) return "";
  const params = new URLSearchParams({
    tenant_id: String(ctx.tenantId ?? 0),
    user_id: String(ctx.userId ?? 0),
    project_id: String(ctx.projectId ?? 0),
    scene: scene || "",
    limit: String(limit),
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${config.backendUrl}/internal/v1/memory?${params}`, {
      headers: { "X-Service-Token": config.serviceToken },
      signal: ac.signal,
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return typeof data?.prefix === "string" ? data.prefix : "";
  } catch (e) {
    console.warn(`[memory] 读取失败（本轮不注入）: ${e?.message ?? e}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

const EXTRACT_SYSTEM = [
  "你是业务助理的记忆整理器。从一轮对话中提取值得跨会话记住的业务事实。",
  "",
  "只提取四类：",
  "1. customer：客户信息（姓名+意向产品/预算/关注点/顾虑）",
  "2. todo：待办承诺（答应客户或领导要做的事，含时间）",
  "3. preference：用户本人的工作偏好（关注指标、汇报习惯）",
  "4. fact：**不易变**的项目级口径（政策/规则/流程/合作约定/称呼口径，如\"本团队对某指标的习惯叫法\"）",
  "",
  "铁律：**绝不记录会变的数字**——价格/单价/均价/总价/表价/底价/货值/优惠、库存套数、",
  "在售/已售/认购数、去化率、回款与逾期金额、佣金金额、到访组数、面积统计等，一律不写。",
  "这些每次必须现查工具（记下来会在下一轮变成过期数字，比不记更糟）。",
  "一句话里既有口径又有数字时，只留口径部分，删掉数字。",
  "",
  "不提取：闲聊、常识、工具查询结果本身、系统与权限信息。",
  "禁止输出手机号/身份证号/银行卡号——遇到一律省略，不要写占位符。",
  "",
  "输出 JSON 数组，最多 3 条，每条：",
  '{"kind":"customer|todo|preference|fact","subject":"客户名或主题（≤20字）","content":"一句话事实（≤60字）"}',
  "无值得记住的内容就输出 []。只输出 JSON，不要解释、不要代码块围栏。",
].join("\n");

function parseItems(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === "object" && String(x.content || "").trim())
      .slice(0, MAX_ITEMS)
      .map((x) => ({
        kind: String(x.kind || "fact"),
        subject: String(x.subject || "").slice(0, 80),
        content: String(x.content).slice(0, 1000),
      }));
  } catch {
    return [];
  }
}

/**
 * 一轮对话后抽取并写入记忆（尽力而为，调用方不必 await）。
 * @param {{question:string, answer:string, ctx:object, runtime:object, model:object, scene:string}} args
 */
export async function saveFromTurn({ question, answer, ctx, runtime, model, scene }) {
  if (!MEMORY_SCENES.has(scene) || !ctx?.userId) return { saved: 0, skipped: 0 };
  const q = String(question || "").trim();
  const a = String(answer || "").trim();
  if (q.length < 2 || a.length < 2) return { saved: 0, skipped: 0 };   // 空转/失败轮不记忆
  try {
    const res = await singleShot(runtime, model, {
      system: EXTRACT_SYSTEM,
      user: `用户问题：${q.slice(0, 1200)}\n\n助手回答：${a.slice(0, 2500)}`,
      temperature: 0,
      maxTokens: 600,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    const items = parseItems(res.text);
    if (!items.length) return { saved: 0, skipped: 0 };
    const resp = await fetch(`${config.backendUrl}/internal/v1/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": config.serviceToken },
      body: JSON.stringify({
        tenant_id: ctx.tenantId ?? 0,
        user_id: ctx.userId ?? 0,
        project_id: ctx.projectId ?? 0,
        scene: scene || "",
        source: "chat",
        items,
      }),
    });
    const out = resp.ok ? await resp.json() : { saved: 0, skipped: items.length };
    console.log(`[memory] 场景 ${scene} 用户 ${ctx.userId}：抽取 ${items.length} 条 → 落库 ${out.saved} 条`);
    return out;
  } catch (e) {
    console.warn(`[memory] 抽取/写入失败（不影响本轮回答）: ${e?.message ?? e}`);
    return { saved: 0, skipped: 0 };
  }
}
