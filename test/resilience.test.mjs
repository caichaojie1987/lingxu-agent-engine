// resilience 单测（node --test）——P0-1 重试/降级韧性层锁定（2026-09-09）。
// 覆盖：错误分类、重试次数与退避、流式保护（canRetry=false 立即停）、
// 不可重试错误 fail-fast、失败后原始错误上抛、用户话术不泄露细节。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isRetryable, statusOf, withRetry, describeError, friendlyError,
} from "../src/resilience.mjs";

const errWith = (msg, extra = {}) => Object.assign(new Error(msg), extra);

// ── 错误分类 ────────────────────────────────────────────────
test("isRetryable：5xx / 429 / 408 可重试", () => {
  assert.equal(isRetryable(errWith("boom", { status: 500 })), true);
  assert.equal(isRetryable(errWith("boom", { status: 503 })), true);
  assert.equal(isRetryable(errWith("boom", { statusCode: 429 })), true);
  assert.equal(isRetryable(errWith("boom", { response: { status: 408 } })), true);
});

test("isRetryable：401/403/400/404 不重试（fail-fast）", () => {
  for (const st of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryable(errWith("nope", { status: st })), false, `status ${st} 不该重试`);
  }
});

test("isRetryable：余额不足/密钥非法/内容审核 一律不重试", () => {
  assert.equal(isRetryable(errWith("Insufficient Balance")), false);
  assert.equal(isRetryable(errWith("invalid_api_key provided")), false);
  assert.equal(isRetryable(errWith("content filter triggered")), false);
  assert.equal(isRetryable(errWith("This model's maximum context length is 65536")), false);
});

test("isRetryable：网络抖动/超时/限流关键词可重试", () => {
  assert.equal(isRetryable(errWith("fetch failed")), true);
  assert.equal(isRetryable(errWith("socket hang up", { code: "ECONNRESET" })), true);
  assert.equal(isRetryable(errWith("request timed out")), true);
  assert.equal(isRetryable(errWith("Rate limit reached for requests")), true);
});

test("isRetryable：未知错误默认不重试（不放大确定性故障）", () => {
  assert.equal(isRetryable(errWith("something weird happened")), false);
});

test("statusOf：从嵌套 cause/response 挖状态码，非法值返回 0", () => {
  assert.equal(statusOf(errWith("x", { cause: { status: 502 } })), 502);
  assert.equal(statusOf(errWith("x", { status: 99999 })), 0);
  assert.equal(statusOf(null), 0);
});

// ── 重试行为 ────────────────────────────────────────────────
test("withRetry：首次成功只调用一次，返回 attempts=1", async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return "ok"; }, { baseDelayMs: 1 });
  assert.equal(r.value, "ok");
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
});

test("withRetry：可重试错误重试到成功，attempts 反映实际次数", async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 3) throw errWith("bad gateway", { status: 502 });
    return "finally";
  }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(r.value, "finally");
  assert.equal(r.attempts, 3);
  assert.equal(calls, 3);
});

test("withRetry：不可重试错误立即上抛，不消耗剩余尝试", async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw errWith("invalid api key", { status: 401 }); },
      { attempts: 5, baseDelayMs: 1 }),
    /invalid api key/,
  );
  assert.equal(calls, 1);
});

test("withRetry：耗尽尝试后抛出最后一次的原始错误", async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw errWith(`attempt-${calls}`, { status: 500 }); },
      { attempts: 3, baseDelayMs: 1 }),
    /attempt-3/,
  );
  assert.equal(calls, 3);
});

test("withRetry：canRetry=false 立即停止（流式已输出保护）", async () => {
  let calls = 0;
  let produced = false;
  await assert.rejects(
    () => withRetry(async () => {
      calls++;
      produced = true;                    // 模拟已吐出 delta
      throw errWith("boom", { status: 500 });
    }, { attempts: 3, baseDelayMs: 1, canRetry: () => !produced }),
    /boom/,
  );
  assert.equal(calls, 1, "已产出内容后不得重试（否则向用户重复输出）");
});

test("withRetry：onRetry 回调带上尝试序号/退避/状态码", async () => {
  const seen = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls < 2) throw errWith("service unavailable", { status: 503 });
    return "ok";
  }, { attempts: 2, baseDelayMs: 1, onRetry: (i) => seen.push(i) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].attempt, 1);
  assert.equal(seen[0].maxAttempts, 2);
  assert.equal(seen[0].status, 503);
});

test("withRetry：attempts=1 等价于不重试", async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw errWith("boom", { status: 500 }); },
      { attempts: 1, baseDelayMs: 1 }),
    /boom/,
  );
  assert.equal(calls, 1);
});

// ── 对外话术 ────────────────────────────────────────────────
test("describeError：只给状态/可重试/截断消息，不含堆栈", () => {
  const d = describeError(errWith("a".repeat(500), { status: 503 }));
  assert.equal(d.status, 503);
  assert.equal(d.retryable, true);
  assert.ok(d.message.length <= 300);
});

test("friendlyError：按状态给中文话术，不泄露上游细节", () => {
  assert.match(friendlyError(errWith("x", { status: 429 })), /限流/);
  assert.match(friendlyError(errWith("x", { status: 502 })), /波动/);
  assert.match(friendlyError(errWith("x", { status: 401 })), /联系管理员/);
  for (const st of [429, 500, 401]) {
    const s = friendlyError(errWith("sk-secret-abc", { status: st }));
    assert.ok(!s.includes("sk-secret-abc"), "话术不得回显上游错误原文");
  }
});
