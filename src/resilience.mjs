/**
 * 模型调用韧性层（P0-1：重试 + 超时 + 备用模型降级）。
 *
 * 定位：只包在 pi-adapter 的 prompt / singleShot 外层，**不改内核调用语义**——
 * 换内核时本文件照用（错误分类与内核无关）。
 *
 * 三条硬约束（防止重试造成业务事故）：
 *   1. **流式已产出即不重试**：调用方经 canRetry 回调判断本轮是否"干净"
 *      （还没吐字、还没调工具）。已吐出 delta 再重试会向用户重复输出。
 *   2. **不可重试错误立即上抛**：401/403（密钥）、400（请求非法）、内容审核、
 *      余额不足——重试只是浪费时间和配额。
 *   3. **持久会话不降级**：会话与模型句柄绑定，换模型需重建会话（丢上下文），
 *      故降级只在无状态路径（单发直答 / 临时场景）启用，由调用方决定。
 *
 * 错误分类按"宁可多试一次"取舍：未知错误默认**不重试**（fail-fast，避免把
 * 确定性故障放大成 N 倍等待）。
 */

/** 可从错误对象里挖出的 HTTP 状态码（内核/ fetch / provider SDK 形状不一）。 */
export function statusOf(err) {
  const cands = [err?.status, err?.statusCode, err?.response?.status,
                 err?.cause?.status, err?.error?.status];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 100 && n < 600) return n;
  }
  return 0;
}

/** 错误全文（含 cause 链），用于关键词判定。 */
export function textOf(err) {
  if (!err) return "";
  const parts = [err.message, err.name, err.code, err.type, err.cause?.message, err.cause?.code]
    .filter(Boolean).map(String);
  return parts.join(" | ").toLowerCase();
}

/** 不可重试的信号（优先级高于可重试关键词）。 */
const FATAL_PATTERNS = [
  "insufficient balance", "insufficient_quota", "quota exceeded permanently",
  "invalid api key", "invalid_api_key", "authentication", "unauthorized",
  "invalid_request", "invalid request", "content filter", "content_filter",
  "content policy", "unsafe content", "model not found", "no such model",
  "context length", "maximum context", "token limit exceeded",
];

/** 可重试的信号（网络抖动 / 限流 / 上游 5xx / 超时）。 */
const RETRY_PATTERNS = [
  "econnreset", "econnrefused", "etimedout", "esockettimedout", "enotfound",
  "eai_again", "socket hang up", "network", "fetch failed", "other side closed",
  "rate limit", "too many requests", "server error", "internal server error",
  "bad gateway", "service unavailable", "gateway timeout", "upstream",
  "overloaded", "temporarily unavailable", "timeout", "timed out", "aborted",
];

/**
 * 是否值得重试。判定顺序：显式 fatal → HTTP 状态 → 关键词。
 * @returns {boolean}
 */
export function isRetryable(err) {
  const txt = textOf(err);
  if (FATAL_PATTERNS.some((p) => txt.includes(p))) return false;
  const st = statusOf(err);
  if (st) {
    if (st === 408 || st === 429) return true;
    if (st >= 500 && st < 600) return true;
    return false;                       // 4xx（除 408/429）不重试
  }
  return RETRY_PATTERNS.some((p) => txt.includes(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带指数退避的重试包装。
 *
 * @param {() => Promise<any>} fn 被包装的一次调用
 * @param {object} opts
 * @param {number} [opts.attempts=3]     总尝试次数（含首次；<1 视为 1）
 * @param {number} [opts.baseDelayMs=800] 首次退避基数，按 2^n 递增
 * @param {number} [opts.maxDelayMs=6000] 单次退避上限
 * @param {() => boolean} [opts.canRetry] 每次失败后询问"现在还能安全重试吗"
 *        （流式场景：已输出则返回 false）；缺省视为可重试
 * @param {(info:object) => void} [opts.onRetry] 每次决定重试时回调（打日志/埋点）
 * @returns {Promise<{value:any, attempts:number}>} 成功时的值 + 实际尝试次数
 */
export async function withRetry(fn, {
  attempts = 3, baseDelayMs = 800, maxDelayMs = 6_000, canRetry, onRetry,
} = {}) {
  const total = Math.max(1, Number(attempts) || 1);
  let lastErr = null;
  for (let i = 0; i < total; i++) {
    try {
      const value = await fn();
      return { value, attempts: i + 1 };
    } catch (err) {
      lastErr = err;
      const isLast = i === total - 1;
      if (isLast) break;
      if (!isRetryable(err)) break;
      if (typeof canRetry === "function" && !canRetry()) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** i);
      if (typeof onRetry === "function") {
        onRetry({ attempt: i + 1, maxAttempts: total, delayMs: delay,
                  status: statusOf(err), error: textOf(err).slice(0, 200) });
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** 供日志/响应体使用的错误摘要（不含堆栈、不含密钥）。 */
export function describeError(err) {
  const st = statusOf(err);
  return {
    status: st || 0,
    retryable: isRetryable(err),
    message: (err?.message ? String(err.message) : String(err || "")).slice(0, 300),
  };
}

/** 用户可读的失败话术（不泄露上游细节/密钥）。 */
export function friendlyError(err) {
  const st = statusOf(err);
  if (st === 429) return "当前咨询较多，模型侧限流了，请稍等十几秒再问一次。";
  if (st >= 500 && st < 600) return "AI 服务侧临时波动，已自动重试仍未成功，请再试一次。";
  if (!st && isRetryable(err)) return "网络或 AI 服务临时不通，已自动重试仍未成功，请再试一次。";
  return "AI 服务暂时不可用，请联系管理员查看引擎日志。";
}
