/**
 * agent-engine 配置
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 从 backend/.env 读取 AGENT_SERVICE_TOKEN（与 FastAPI 内部 API 共享，不入 git） */
function readBackendEnv(key) {
  // 管理端模型切换持久化在 backend/.env（平台 API _write_env_model）——重启后恢复
  try {
    const envP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", ".env");
    const txt = readFileSync(envP, "utf8");
    const m = txt.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : undefined;
  } catch { return undefined; }
}
function readBackendToken() {
  try {
    const envPath = path.join(__dirname, "..", "..", "backend", ".env");
    if (!existsSync(envPath)) return "";
    const line = readFileSync(envPath, "utf-8").split(/\r?\n/).find((l) => l.startsWith("AGENT_SERVICE_TOKEN="));
    return line ? line.slice("AGENT_SERVICE_TOKEN=".length).trim() : "";
  } catch {
    return "";
  }
}

export const config = {
  port: Number(process.env.AGENT_ENGINE_PORT ?? 8020),
  host: process.env.AGENT_ENGINE_HOST ?? "127.0.0.1",
  backendUrl: process.env.AGENT_BACKEND_URL ?? "http://127.0.0.1:8010", // FastAPI（内部只读 API 目标）
  serviceToken: process.env.AGENT_SERVICE_TOKEN ?? readBackendToken(),
  model: process.env.AGENT_MODEL ?? readBackendEnv("AGENT_MODEL") ?? "deepseek/deepseek-v4-flash", // env > backend/.env（管理端持久化选择）> 默认
  maxSessions: Number(process.env.AGENT_MAX_SESSIONS ?? 32),        // 长活会话上限（LRU）
  promptTimeoutMs: Number(process.env.AGENT_PROMPT_TIMEOUT_MS ?? 100_000),
  singleTimeoutMs: Number(process.env.AGENT_SINGLE_TIMEOUT_MS ?? 30_000), // 单发直答超时（backend 侧另有 15s HTTP 短超时→failover）
  // P0-1 韧性（2026-09-09）：模型调用总尝试次数（含首次）——1=不重试；仅对可重试错误生效
  llmAttempts: Number(process.env.AGENT_LLM_ATTEMPTS ?? 3),
  llmRetryBaseDelayMs: Number(process.env.AGENT_LLM_RETRY_BASE_DELAY_MS ?? 800),
  // 备用模型（provider/model）。空=不降级；仅无状态路径（单发直答/临时场景）启用——
  // 持久会话与模型句柄绑定，换模型须重建会话（丢上下文），故不降级只重试。
  llmFallbackModel: (process.env.AGENT_LLM_FALLBACK_MODEL ?? "").trim(),
};
