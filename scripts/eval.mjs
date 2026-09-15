/**
 * M4 评测回放 v2 —— 会话 JSONL → 客观评测摘要 + 静态断言
 *
 * 输入：agent-engine 落盘的 PI 会话（sessions/t<租户>/*.jsonl，PI session-v3 格式：
 *   session/model_change/thinking_level_change/message 四类行；message 行 role=
 *   user|assistant|toolResult，assistant 带 usage{input,output,cacheRead,cacheWrite,
 *   reasoning,totalTokens,cost}、content 含 text/toolCall、stopReason(toolUse|stop)，
 *   toolResult 带 toolName/toolCallId/isError）。
 *
 * 客观维度（全部可从 JSONL 直接算出，不依赖主观判分）：
 *   回合数 / assistant 步数 / 工具调用次数 / token(in,out,cache,reasoning,total) /
 *   cost(¥) / 时长 / 工具错误率(toolResult.isError) / 多跳收敛性：
 *     - 轮内步数超上限（默认 12 步，--max-steps 可调）→ D_MAXSTEPS FAIL
 *     - 同名同参工具连续重复 ≥3 次 → D_LOOP FAIL（死循环信号）
 *     - 轮末 assistant 仍 stopReason=toolUse（工具悬挂、未收敛收尾）→ D_NONTERMINAL WARN
 *   场景标记：JSONL 无场景字段，按会话主用工具客观推导（见 TOOL_SCENE 表）。
 *   达标判定：会话无 FAIL=PASS / 有 WARN=WARN / 有 FAIL=FAIL。
 *
 * 静态断言（v1 保留，数据红线）：
 *   A. 数据类问题未调任何工具直接作答 = 编数风险 FAIL
 *   B. 未调工具但复述历史工具结果数字 = 陈旧口径 WARN
 *   C. 回答数字在本会话工具结果中找不到出处 = 疑似编数 FAIL/WARN
 *
 * 用法：
 *   node scripts/eval.mjs                 # 全部租户会话（t<数字> 目录）
 *   node scripts/eval.mjs --all           # 含归档等非租户目录
 *   node scripts/eval.mjs t1              # 租户 1
 *   node scripts/eval.mjs t1 <文件前缀>    # 指定会话
 *   node scripts/eval.mjs t1 xxx --json   # JSON 输出到 stdout（供流水线）
 *   node scripts/eval.mjs --out sessions/eval-report.json  # 报告落盘
 *   node scripts/eval.mjs --max-steps 8   # 调收敛步数上限
 *   node scripts/eval.mjs --strict        # 有 FAIL 时 exit 1（供 CI 卡口）
 * 默认同时写 sessions/eval-report.json（--no-report 关闭）。
 */
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "sessions");
const statSyncSafe = (p) => { try { return statSync(p); } catch { return null; } };

// 数据类问题触发词（命中即要求该轮存在工具调用依据）
const DATA_WORDS = /签约|认购|成交|回款|到访|接待|客户|线索|渠道|抗性|评级|均价|金额|几套|多少|排名|业绩|佣金|费效|转化/;
// 回答里的数字口径片段：数字+单位
const NUM_RE = /(\d+(?:\.\d+)?)\s*(套|组|万|元|㎡|平|%|个|人)/g;
// 工具名 → 场景（客观推导：会话主用工具即其场景；新工具在此登记）
const TOOL_SCENE = {
  query_deal_stats: "成交问数",
  query_visit_stats: "到访问数",
  query_payment_alert: "回款预警",
  query_grade_distribution: "客户评级",
  query_sales_by_consultant: "顾问业绩",
};

function walk(tenantArg, fileArg, all) {
  const out = [];
  if (!statSyncSafe(ROOT)) return out;
  for (const td of readdirSync(ROOT)) {
    const tp = path.join(ROOT, td);
    if (!statSyncSafe(tp)?.isDirectory()) continue;
    if (!all && !/^t\d+$/.test(td)) continue; // 默认只扫租户目录（t<数字>）
    if (tenantArg && td !== tenantArg) continue;
    for (const f of readdirSync(tp).filter((x) => x.endsWith(".jsonl"))) {
      if (fileArg && !f.includes(fileArg)) continue;
      out.push({ tenant: td, file: f, abs: path.join(tp, f) });
    }
  }
  out.sort((a, b) => (a.tenant + a.file < b.tenant + b.file ? -1 : 1));
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join(" ");
  }
  return "";
}

/** 把 JSONL 行解析为轮次结构（user → assistant* / toolResult* → 下一 user） */
function parseRows(rows) {
  const rounds = [];
  let cur = null;
  let toolResults = []; // 会话内累计工具返回原文（陈旧/编数判定的出处池）
  for (const r of rows) {
    if (r.type !== "message") continue;
    const m = r.message;
    const role = m?.role;
    const ts = r.timestamp ?? "";
    if (role === "user") {
      const q = textOf(m.content).trim();
      if (!q) continue;
      cur = { ts, question: q, toolCalls: [], toolErrors: [], answer: "", usage: null,
              steps: 0, toolResultHits: [], stopReasons: [],
              toolResultsBefore: [...toolResults] };
      rounds.push(cur);
    } else if (role === "assistant" && cur) {
      cur.steps += 1;
      const t = textOf(m.content).trim();
      if (t) cur.answer += (cur.answer ? "\n" : "") + t;
      for (const tc of (m.content ?? []).filter((c) => c.type === "toolCall" || c.type === "tool_use")) {
        const nm = tc.name ?? tc.toolName ?? (tc.input && tc.input.name);
        if (nm) cur.toolCalls.push({ name: String(nm), args: stableJson(tc.arguments ?? tc.input ?? {}) });
      }
      if (m.stopReason) cur.stopReasons.push(m.stopReason);
      if (m.usage && !cur.usage) cur.usage = m.usage;
    } else if (role === "toolResult") {
      const raw = textOf(m.content);
      const bad = m.isError === true;
      if (bad && cur) cur.toolErrors.push(m.toolName ?? "?");
      if (cur) { cur.toolResultHits.push(raw); toolResults.push(raw); }
      else toolResults.push(raw); // 会话开头工具结果（异常场景）
    }
  }
  return rounds;
}

function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
}

// ---------- 静态断言（v1：数据红线 A/B/C） ----------
function checkRound(round) {
  const issues = [];
  const isDataQ = DATA_WORDS.test(round.question);
  const hasTool = round.toolCalls.length > 0 || round.toolResultHits.length > 0;
  const ansNums = [...round.answer.matchAll(NUM_RE)].map((x) => x[0]);

  // A. 数据类问题、无任何工具依据
  if (isDataQ && !hasTool) {
    issues.push({ level: "FAIL", code: "A_NO_TOOL", msg: "数据类问题未调用任何工具，直接给出回答，存在编数/陈旧口径风险" });
  }
  // C. 回答含数字但会话内无任何工具结果可出处
  const allToolText = round.toolResultsBefore.join("\n") + "\n" + round.toolResultHits.join("\n");
  const missing = ansNums.filter((n) => !allToolText.includes(n.replace("㎡", "平").split(" ")[0]) && !allToolText.includes(n.split(" ")[0]) && !allToolText.includes(n));
  if (ansNums.length && !hasTool && !allToolText.trim()) {
    issues.push({ level: "FAIL", code: "C_NO_SOURCE", msg: `回答含数字 ${ansNums.slice(0, 5).join(",")} 但会话内无任何工具返回，疑似编数` });
  } else if (ansNums.length && missing.length && !round.toolCalls.length) {
    issues.push({ level: "WARN", code: "C_NUM_UNSOURCED", msg: `回答数字 ${missing.slice(0, 5).join(",")} 在本轮工具结果中无出处（可能引用历史或编造）` });
  }
  // B. 数据问题、本轮未调工具、但复述了历史工具结果 → 陈旧口径风险
  if (isDataQ && !hasTool && round.toolResultsBefore.length) {
    const echoed = ansNums.filter((n) => round.toolResultsBefore.some((t) => t.includes(n.split(" ")[0])));
    if (echoed.length) {
      issues.push({ level: "WARN", code: "B_STALE", msg: `未重新调工具，直接复述历史工具结果的数字 ${echoed.slice(0, 5).join(",")}（长活会话数据时效风险）` });
    }
  }
  return issues;
}

// ---------- 收敛性 / 错误率（v2 新增，客观可算） ----------
function checkConvergence(round, maxSteps) {
  const issues = [];
  // D1. 轮内步数超上限
  if (round.steps > maxSteps) {
    issues.push({ level: "FAIL", code: "D_MAXSTEPS", msg: `轮内 assistant 步数 ${round.steps} 超上限 ${maxSteps}（多跳未收敛）` });
  }
  // D2. 同名同参连续重复 ≥3 次 = 死循环信号
  let runKey = null, runLen = 0, loop = null;
  for (const tc of round.toolCalls) {
    const key = tc.name + tc.args;
    if (key === runKey) { runLen += 1; } else { runKey = key; runLen = 1; }
    if (runLen >= 3 && !loop) loop = `${tc.name} 同名同参连续调用 ${runLen}+ 次`;
  }
  if (loop) issues.push({ level: "FAIL", code: "D_LOOP", msg: `工具链疑似死循环：${loop}` });
  // D3. 轮末仍以 toolUse 收尾（最后一步发起了工具调用但无后续收敛文本）
  const lastStop = round.stopReasons[round.stopReasons.length - 1];
  if (lastStop === "toolUse") {
    issues.push({ level: "WARN", code: "D_NONTERMINAL", msg: "轮末 assistant 停在 toolUse（工具悬挂/未见收敛收尾）" });
  }
  // E. 工具错误
  if (round.toolErrors.length) {
    issues.push({ level: "WARN", code: "E_TOOL_ERROR", msg: `本轮工具报错 ${round.toolErrors.length} 次（${round.toolErrors.join(",")}，isError=true）` });
  }
  return issues;
}

// ---------- 计量 ----------
function measure(rows) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  let cost = 0;
  let msgCount = 0, parseErrors = 0;
  const seen = new Set();
  const models = new Set();
  let firstTs = null, lastTs = null;
  for (const r of rows) {
    if (r && r.__parseError) { parseErrors += 1; continue; }
    if (r?.timestamp) { if (!firstTs) firstTs = r.timestamp; lastTs = r.timestamp; }
    if (r?.type === "model_change" && r.modelId) models.add(`${r.provider ?? "?"}/${r.modelId}`);
    if (r?.type !== "message") continue;
    msgCount += 1;
    const u = r.message?.usage;
    if (!u) continue;
    const key = `${r.timestamp ?? ""}|${r.message?.role ?? ""}`; // 去重防同刻重复行
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.input += u.input ?? 0;
    tokens.output += u.output ?? 0;
    tokens.cacheRead += u.cacheRead ?? 0;
    tokens.cacheWrite += u.cacheWrite ?? 0;
    tokens.reasoning += u.reasoning ?? 0;
    tokens.total += u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0));
    cost += u.cost?.total ?? 0;
  }
  const duration_s = firstTs && lastTs ? Math.max(0, (Date.parse(lastTs) - Date.parse(firstTs)) / 1000) : 0;
  return { tokens, cost, msgCount, parseErrors, models: [...models], duration_s: Number(duration_s.toFixed(1)) };
}

function sceneOf(rounds) {
  const cnt = {};
  for (const r of rounds) for (const tc of r.toolCalls) cnt[tc.name] = (cnt[tc.name] ?? 0) + 1;
  const names = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
  if (!names.length) return { scene: "无工具直答", tools: {} };
  return { scene: names.map((n) => TOOL_SCENE[n] ?? n).join("+"), tools: cnt };
}

function evalFile(f, maxSteps) {
  const raw = readFileSync(f.abs, "utf-8");
  let parseErrors = 0;
  const rows = raw.split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { parseErrors += 1; return { __parseError: true }; }
  });
  const rounds = parseRows(rows);
  const checks = rounds.map((r) => ({ ...r, issues: [...checkRound(r), ...checkConvergence(r, maxSteps)] }));
  const meas = measure(rows);
  meas.parseErrors += parseErrors;
  const { scene, tools } = sceneOf(checks);
  const toolCalls = checks.reduce((s, r) => s + r.toolCalls.length, 0);
  const toolErrors = checks.reduce((s, r) => s + r.toolErrors.length, 0);
  const issues = checks.flatMap((c) => c.issues);
  const fails = issues.filter((i) => i.level === "FAIL");
  const warns = issues.filter((i) => i.level === "WARN");
  const verdict = fails.length ? "FAIL" : warns.length ? "WARN" : "PASS";
  return {
    tenant: f.tenant, file: f.file, scene, tools, verdict,
    rounds: checks, measures: meas,
    stats: {
      round_count: checks.length,
      assistant_steps: checks.reduce((s, r) => s + r.steps, 0),
      tool_calls: toolCalls,
      tool_errors: toolErrors,
      error_rate: toolCalls + meas.parseErrors ? Number((toolErrors / Math.max(1, toolCalls)).toFixed(3)) : 0,
      max_round_steps: Math.max(0, ...checks.map((r) => r.steps)),
      fail_count: fails.length, warn_count: warns.length,
      rounds_with_error: checks.filter((r) => r.toolErrors.length).length,
    },
    issues: issues.map((i) => ({ level: i.level, code: i.code, msg: i.msg })),
  };
}

function aggregate(results) {
  const byScene = {};
  for (const r of results) {
    const g = (byScene[r.scene] ??= { scene: r.scene, sessions: 0, round_count: 0, tool_calls: 0,
      tool_errors: 0, cost: 0, tokens_total: 0, verdicts: { PASS: 0, WARN: 0, FAIL: 0 }, converged: 0 });
    g.sessions += 1;
    g.round_count += r.stats.round_count;
    g.tool_calls += r.stats.tool_calls;
    g.tool_errors += r.stats.tool_errors;
    g.cost += r.measures.cost;
    g.tokens_total += r.measures.tokens.total;
    g.verdicts[r.verdict] += 1;
    if (r.verdict !== "FAIL") g.converged += 1;
  }
  const totals = {
    sessions: results.length,
    round_count: results.reduce((s, r) => s + r.stats.round_count, 0),
    assistant_steps: results.reduce((s, r) => s + r.stats.assistant_steps, 0),
    tool_calls: results.reduce((s, r) => s + r.stats.tool_calls, 0),
    tool_errors: results.reduce((s, r) => s + r.stats.tool_errors, 0),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    cost_rmb: Number(results.reduce((s, r) => s + r.measures.cost, 0).toFixed(6)),
    fail: results.reduce((s, r) => s + r.stats.fail_count, 0),
    warn: results.reduce((s, r) => s + r.stats.warn_count, 0),
    parse_errors: results.reduce((s, r) => s + r.measures.parseErrors, 0),
    verdicts: { PASS: 0, WARN: 0, FAIL: 0 },
  };
  for (const r of results) {
    for (const k of Object.keys(totals.tokens)) totals.tokens[k] += r.measures.tokens[k];
    totals.verdicts[r.verdict] += 1;
  }
  totals.tool_error_rate = totals.tool_calls ? Number((totals.tool_errors / totals.tool_calls).toFixed(3)) : 0;
  for (const g of Object.values(byScene)) {
    g.cost_rmb = Number(g.cost.toFixed(6)); delete g.cost;
    g.tool_error_rate = g.tool_calls ? Number((g.tool_errors / g.tool_calls).toFixed(3)) : 0;
  }
  return { byScene, totals };
}

function jsonView(results, agg) {
  return {
    generated_at: new Date().toISOString(),
    max_round_steps_limit: agg.maxSteps,
    sessions: results.map((r) => ({
      tenant: r.tenant, file: r.file, scene: r.scene, verdict: r.verdict,
      model: r.measures.models.join(","), duration_s: r.measures.duration_s,
      tokens: r.measures.tokens, cost_rmb: Number(r.measures.cost.toFixed(6)),
      ...r.stats,
      rounds: r.rounds.map((c) => ({ q: c.question.slice(0, 60), steps: c.steps,
        tools: c.toolCalls.map((t) => t.name), errors: c.toolErrors,
        issues: c.issues.map((i) => `${i.level}:${i.code}`) })),
      issues: r.issues,
    })),
    by_scene: agg.byScene,
    totals: agg.totals,
  };
}

function printHuman(results, agg) {
  for (const r of results) {
    const m = r.measures;
    console.log(`\n════ ${r.tenant}/${r.file} ════`);
    console.log(`  场景=${r.scene} 判定=${r.verdict} 模型=${m.models.join(",")} 时长=${m.duration_s}s`);
    console.log(`  回合=${r.stats.round_count} 步数=${r.stats.assistant_steps}(最大轮内 ${r.stats.max_round_steps}) 工具调用=${r.stats.tool_calls} 工具报错=${r.stats.tool_errors}(错误率 ${(r.stats.error_rate * 100).toFixed(1)}%)`);
    console.log(`  token in/out=${m.tokens.input}/${m.tokens.output} cacheR=${m.tokens.cacheRead} 总=${m.tokens.total} 成本=¥${m.cost.toFixed(6)}`);
    r.rounds.forEach((c, i) => {
      const marks = c.issues.map((x) => `[${x.level}]${x.code}`).join(" ");
      console.log(`  ·轮${i + 1} ${c.steps}步 工具${c.toolCalls.length}(${c.toolCalls.map((t) => t.name).join(",") || "无"}) 错${c.toolErrors.length} ${marks ? "⚠ " + marks : "✓"} 问:${c.question.slice(0, 40)}`);
    });
    for (const it of r.issues) {
      console.log(`    [${it.level}] ${it.code}: ${it.msg}`);
    }
  }
  console.log(`\n──── 按场景 ────`);
  console.log(`场景 | 会话 | 回合 | 工具调用 | 报错(率) | 成本¥ | 判定 PASS/WARN/FAIL`);
  for (const g of Object.values(agg.byScene)) {
    console.log(`${g.scene} | ${g.sessions} | ${g.round_count} | ${g.tool_calls} | ${g.tool_errors}(${(g.tool_error_rate * 100).toFixed(1)}%) | ${g.cost_rmb.toFixed ? g.cost_rmb.toFixed(6) : g.cost_rmb} | ${g.verdicts.PASS}/${g.verdicts.WARN}/${g.verdicts.FAIL}`);
  }
  const t = agg.totals;
  console.log(`\n===== 汇总：${t.sessions} 会话 / ${t.round_count} 回合 / ${t.assistant_steps} 步 / 工具调用 ${t.tool_calls}(报错 ${t.tool_errors}, 率 ${(t.tool_error_rate * 100).toFixed(1)}%) / token ${t.tokens.total} / 成本 ¥${t.cost_rmb} / 判定 ${t.verdicts.PASS}/${t.verdicts.WARN}/${t.verdicts.FAIL} =====`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pos = [];
  let outPath = null, maxSteps = 12;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") outPath = argv[++i];
    else if (argv[i] === "--max-steps") maxSteps = Number(argv[++i]) || 12;
    else if (!argv[i].startsWith("--")) pos.push(argv[i]);
  }
  const [tenantArg, fileArg] = pos;
  const files = walk(tenantArg, fileArg, flags.has("--all"));
  if (!files.length) { console.log("未找到会话文件（sessions/ 为空？先让 dashboard 场景产生一次对话）"); process.exit(0); }
  const results = files.map((f) => evalFile(f, maxSteps));
  const agg = aggregate(results);
  agg.maxSteps = maxSteps;

  // 报告落盘（默认 sessions/eval-report.json；--no-report 关闭）
  const reportPath = outPath ?? (flags.has("--no-report") ? null : path.join(ROOT, "eval-report.json"));
  const view = jsonView(results, agg);
  if (reportPath) {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(view, null, 2), "utf-8");
  }

  if (flags.has("--json")) console.log(JSON.stringify(view, null, 2));
  else printHuman(results, agg);
  if (reportPath && !flags.has("--json")) console.log(`报告已写入: ${reportPath}`);

  if (flags.has("--strict") && agg.totals.fail > 0) process.exit(1);
}

main();
