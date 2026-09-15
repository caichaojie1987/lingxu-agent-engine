/**
 * AI 算力计量与配额（P1 第二档 C-1，2026-09-09，公网部署）。
 *
 * 背景：公网部署后 AI 调用必须可归因、可封顶。此前引擎（8020）侧调用**完全不记账**，
 * 且全链路无上限——余额烧穿既拦不住也查不出是谁用的。
 *
 * 两条路径（都走 FastAPI internal 通道，引擎侧零业务逻辑）：
 *   查：checkQuota(ctx) → GET  /internal/v1/quota?tenant_id=&user_id=
 *       返回今日已用 + 限额 + exceeded；exceeded=true 时调用方**不调 LLM**直接回提示。
 *   记：recordUsage({ctx, scene, model, usage}) → POST /internal/v1/usage
 *       每轮结束 fire-and-forget 落 agent_usage（与 backend 侧同表同型）。
 *
 * 边界：
 *   - 记账/查询失败**绝不阻断对话**（只记日志）：配额是省钱手段，不是可用性单点。
 *   - 限额三项均 0 = 不限（演示默认）；上线按企业设 AI_DAILY_* 环境变量。
 *   - 超限提示为中文业务文案，不暴露内部字段名。
 */
import { config } from "./config.mjs";

const QUOTA_TIMEOUT_MS = 2000;
const RECORD_TIMEOUT_MS = 3000;

/** 超限文案（对外统一口径，改这里即可）。 */
export function quotaMessage(q) {
  const parts = [];
  if (q?.limit_tokens) parts.push(`企业每日上限 ${q.limit_tokens} tokens`);
  if (q?.limit_user_tokens) parts.push(`个人每日上限 ${q.limit_user_tokens} tokens`);
  if (q?.limit_cost_usd) parts.push(`企业每日成本上限 ${q.limit_cost_usd} 美元`);
  return `今日 AI 算力额度已用完${parts.length ? "（" + parts.join("，") + "）" : ""}，`
       + "请明天再试，或联系管理员调整额度。";
}

function authHeaders() {
  return { "X-Service-Token": config.serviceToken, "Content-Type": "application/json" };
}

/**
 * 查今日配额。不可用/超时一律返回 {exceeded:false}（fail-open：宁可放行也不能因记账故障停服）。
 * @param {{tenantId:number, userId:number}} ctx
 */
export async function checkQuota(ctx) {
  if (!ctx?.tenantId) return { exceeded: false };
  const params = new URLSearchParams({
    tenant_id: String(ctx.tenantId ?? 0),
    user_id: String(ctx.userId ?? 0),
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), QUOTA_TIMEOUT_MS);
  try {
    const resp = await fetch(`${config.backendUrl}/internal/v1/quota?${params}`, {
      headers: { "X-Service-Token": config.serviceToken },
      signal: ac.signal,
    });
    if (!resp.ok) return { exceeded: false };
    const data = await resp.json();
    return { exceeded: Boolean(data?.exceeded), ...data };
  } catch (e) {
    console.warn(`[usage] 配额查询失败（放行本轮）: ${e?.message ?? e}`);
    return { exceeded: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一轮对话结束记账（尽力而为，调用方不必 await）。
 * @param {{ctx:object, scene:string, model:string, usage:object, channel?:string}} args
 */
export async function recordUsage({ ctx, scene, model, usage, channel = "engine" }) {
  if (!ctx?.tenantId || !usage) return { ok: false, skipped: "no-ctx-or-usage" };
  if (!(usage.total_tokens || usage.input_tokens || usage.output_tokens)) {
    return { ok: false, skipped: "empty-usage" };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RECORD_TIMEOUT_MS);
  try {
    const resp = await fetch(`${config.backendUrl}/internal/v1/usage`, {
      method: "POST",
      headers: authHeaders(),
      signal: ac.signal,
      body: JSON.stringify({
        tenant_id: ctx.tenantId, user_id: ctx.userId ?? 0, project_id: ctx.projectId ?? 0,
        scene: scene || "", model: model || "", channel, usage,
      }),
    });
    if (!resp.ok) {
      console.warn(`[usage] 记账失败 HTTP ${resp.status}`);
      return { ok: false };
    }
    return await resp.json();
  } catch (e) {
    console.warn(`[usage] 记账异常: ${e?.message ?? e}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
