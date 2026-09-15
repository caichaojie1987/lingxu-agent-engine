/**
 * 全链 trace 存储（B10 批次4：AI 工具调用 trace_id 落 AgentLog）。
 *
 * server.mjs 处理 /chat 时 traceStore.run(traceId, …prompt…)；场景工具 execute
 * 经 currentTraceId() 取当前请求 trace，透传给 backend /internal/v1（body.trace_id），
 * 使一次提问的 chat 级留痕与其间每次工具调用在 AgentLog 携带同一 trace_id，
 * 与页面按钮 tool_execute 审计同语义对齐（卫宁 E 链）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const traceStore = new AsyncLocalStorage();

export function currentTraceId() {
  return traceStore.getStore() ?? "";
}
