/**
 * 黄金问答集【主动】评测 —— 主动向引擎发问、检查回答，用于换模型/改 prompt 后的回归。
 *
 * 与 eval.mjs 的分工：
 *   eval.mjs        回放式：扫描已落盘会话 JSONL，算客观指标 + 静态断言（事后审计）
 *   eval-golden.mjs 主动式：按 golden-qa.json 逐条 POST /chat，当场断言工具命中与答案口径（事前回归）
 *
 * 数据集：scripts/golden-qa.json（每条 {id,scene,question,expect_tools,must_contain,must_not_contain,note}）
 *
 * 断言语义（任一不过即该条 FAIL）：
 *   E_TOOL_MISS      expect_tools 未全部命中（工具名归一：点→下划线、忽略大小写）
 *   E_MUST_CONTAIN   must_contain 有词未出现在答案里
 *   E_MUST_NOT       must_not_contain 的词出现在答案里
 *   A_NO_TOOL        回答里出现"数字+单位"但本轮没有任何工具调用（编数风险，沿用 eval.mjs 的 NUM_RE）
 *   E_HTTP / E_TIMEOUT / E_EMPTY  请求失败、超时、空答案
 *
 * 令牌来源：优先环境变量 AGENT_SERVICE_TOKEN，否则读 ../backend/.env 的 AGENT_SERVICE_TOKEN= 行。
 *   令牌只用于请求头，绝不写入 stdout/报告/日志。
 *
 * 用法：
 *   node scripts/eval-golden.mjs                      # 跑全部，控制台表格 + 默认写 sessions/eval-golden-report.json
 *   node scripts/eval-golden.mjs --json               # 结果 JSON 打到 stdout
 *   node scripts/eval-golden.mjs --out <path>         # 指定报告落盘路径
 *   node scripts/eval-golden.mjs --no-report          # 不落盘
 *   node scripts/eval-golden.mjs --strict             # 有 FAIL 时 exit 1（CI 卡口）
 *   node scripts/eval-golden.mjs --scene advisor      # 只跑某场景
 *   node scripts/eval-golden.mjs --only g01,g15       # 只跑指定 id
 *   node scripts/eval-golden.mjs --base http://127.0.0.1:8020 --timeout 120000 --usd-rmb 7.2
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.join(__dirname, "..");
const DATASET_PATH = path.join(__dirname, "golden-qa.json");
const DEFAULT_REPORT = path.join(ENGINE_ROOT, "sessions", "eval-golden-report.json");

// 回答里的数字口径片段（与 eval.mjs 保持一致）：数字 + 单位
const NUM_RE = /(\d+(?:\.\d+)?)\s*(套|组|万|元|㎡|平|%|个|人)/g;

/** 工具名归一：PI 返回可能把 customer.dedupe 写成 customer_dedupe */
const normTool = (s) => String(s ?? "").replace(/\./g, "_").toLowerCase();

/** 解析命令行参数 */
function parseArgs(argv) {
  const flags = new Set();
  const opts = {
    base: process.env.AGENT_ENGINE_URL || "http://127.0.0.1:8020",
    out: null,
    scene: null,
    only: null,
    timeout: 120000,
    usdRmb: 7.2,
    noReport: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.add("json");
    else if (a === "--strict") flags.add("strict");
    else if (a === "--no-report") opts.noReport = true;
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--scene") opts.scene = argv[++i];
    else if (a === "--only") opts.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--base") opts.base = argv[++i];
    else if (a === "--timeout") opts.timeout = Number(argv[++i]) || opts.timeout;
    else if (a === "--usd-rmb") opts.usdRmb = Number(argv[++i]) || opts.usdRmb;
  }
  return { flags, opts };
}

/** 令牌：env 优先，否则读 ../backend/.env（参考 src/config.mjs 的读法） */
function resolveToken() {
  if (process.env.AGENT_SERVICE_TOKEN && process.env.AGENT_SERVICE_TOKEN.trim()) {
    return process.env.AGENT_SERVICE_TOKEN.trim();
  }
  const envPath = path.join(ENGINE_ROOT, ".env");
  if (!existsSync(envPath)) return "";
  const line = readFileSync(envPath, "utf-8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("AGENT_SERVICE_TOKEN="));
  return line ? line.slice("AGENT_SERVICE_TOKEN=".length).trim() : "";
}

function loadDataset() {
  const raw = readFileSync(DATASET_PATH, "utf-8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || !arr.length) throw new Error("golden-qa.json 为空或格式不对");
  return arr;
}

/** 单条断言 */
function assertItem(item, resp, elapsedMs) {
  const failures = [];
  const answer = String(resp.answer ?? "");
  const toolNames = Array.isArray(resp.tool_names) ? resp.tool_names.map(String) : [];
  const toolSet = new Set(toolNames.map(normTool));

  // 1) expect_tools 全部命中
  for (const t of item.expect_tools ?? []) {
    if (!toolSet.has(normTool(t))) {
      failures.push({ code: "E_TOOL_MISS", msg: `未命中工具 ${t}（实际调用: ${toolNames.join(",") || "无"}）` });
    }
  }
  // 2) must_contain 全部出现
  for (const k of item.must_contain ?? []) {
    if (!answer.includes(k)) failures.push({ code: "E_MUST_CONTAIN", msg: `答案缺少关键词「${k}」` });
  }

  // 2b) must_contain_any：任一候选词出现即通过——语义等价措辞（如「重复/同名/重名」）
  // 不应因模型换个说法就判 FAIL（判定要点仍是工具命中，措辞断言只防答非所问）
  const anyList = item.must_contain_any ?? [];
  if (anyList.length && !anyList.some((k) => answer.includes(k))) {
    failures.push({ code: "E_MUST_CONTAIN_ANY", msg: `答案未出现任一候选词「${anyList.join(" / ")}」` });
  }
  // 3) must_not_contain 全部不出现
  for (const k of item.must_not_contain ?? []) {
    if (answer.includes(k)) failures.push({ code: "E_MUST_NOT", msg: `答案出现禁止词「${k}」` });
  }
  // 3b) 语言硬约束（2026-09-09 实测漏网：模型偶发以 "Let me check the sales stats…" 开场）：
  //     答案不得出现白名单外的英文单词——产品要求"全程简体中文"，此项为全局断言，不依赖单条配置。
  const EN_WHITELIST = new Set([
    "a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z",
    "lpr","vr","ar","ai","crm","app","wx","wifi","logo","ip","gps","pdf","excel","ppt","word","ok","id","sku","url","api","html","css","js","ui","ux","ceo","cfo","kpi","gmv","roi","cpm","cpl","b端","c端",
  ]);
  const enWords = [...new Set((answer.match(/[A-Za-z]{2,}/g) ?? []).map((w) => w.toLowerCase()))]
    .filter((w) => !EN_WHITELIST.has(w));
  if (enWords.length) {
    failures.push({ code: "E_LANG_EN", msg: `答案出现白名单外英文单词: ${enWords.slice(0, 6).join(", ")}` });
  }

  // 4) 编数检查：回答含"数字+单位"但本轮无任何工具调用
  const nums = [...answer.matchAll(NUM_RE)].map((m) => m[0]);
  if (nums.length && toolNames.length === 0) {
    failures.push({ code: "A_NO_TOOL", msg: `回答含数字单位 ${nums.slice(0, 3).join(",")} 但本轮无任何工具调用（编数风险）` });
  }
  // 5) 空答案
  if (!answer.trim()) failures.push({ code: "E_EMPTY", msg: "答案为空" });

  return { failures, answer, toolNames, elapsedMs };
}

/** 调用一次 /chat（同步阻塞，整段答案） */
async function askChat(item, token, opts) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout);
  try {
    const res = await fetch(`${opts.base}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": token },
      body: JSON.stringify({
        scene: item.scene || "advisor",
        tenant_id: item.tenant_id ?? 1,
        project_id: item.project_id ?? 1,
        question: item.question,
        user_id: item.user_id ?? 3,
        role: item.role ?? "advisor",
        stream: false,
        trace_id: `golden-${item.id}-${Date.now()}`,
      }),
      signal: ctrl.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      return { resp: {}, elapsedMs: Date.now() - t0, error: { code: "E_HTTP", msg: `HTTP ${res.status}: ${bodyText.slice(0, 200)}` } };
    }
    let resp;
    try { resp = JSON.parse(bodyText); }
    catch { return { resp: {}, elapsedMs: Date.now() - t0, error: { code: "E_HTTP", msg: `响应非 JSON: ${bodyText.slice(0, 200)}` } }; }
    return { resp, elapsedMs: Date.now() - t0, error: null };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return { resp: {}, elapsedMs: Date.now() - t0, error: { code: aborted ? "E_TIMEOUT" : "E_HTTP", msg: aborted ? `超时 ${opts.timeout}ms` : String(e?.message ?? e) } };
  } finally {
    clearTimeout(timer);
  }
}

function pad(s, n) {
  const str = String(s ?? "");
  // 粗略按显示宽度补齐（CJK 记 2）
  let w = 0;
  for (const ch of str) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return str + " ".repeat(Math.max(0, n - w));
}

function printTable(records) {
  console.log(`\n${pad("ID", 6)}${pad("场景", 10)}${pad("判定", 8)}${pad("耗时", 9)}${pad("工具", 40)}失败原因`);
  console.log("-".repeat(120));
  for (const r of records) {
    const reason = r.verdict === "PASS" ? "-" : r.failures.map((f) => `${f.code}:${f.msg}`).join(" | ");
    console.log(
      `${pad(r.id, 6)}${pad(r.scene, 10)}${pad(r.verdict, 8)}${pad(r.elapsed_ms + "ms", 9)}${pad((r.tool_names.join(",") || "无").slice(0, 38), 40)}${reason}`,
    );
  }
}

function summarize(records, opts) {
  const tokens = { input: 0, output: 0, total: 0 };
  let costUsd = 0;
  let duration = 0;
  const models = new Set();
  for (const r of records) {
    const u = r.usage ?? {};
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.total += u.total_tokens ?? 0;
    costUsd += u.cost_usd ?? 0;
    duration += r.elapsed_ms;
    if (r.model) models.add(r.model);
  }
  const pass = records.filter((r) => r.verdict === "PASS").length;
  return {
    total: records.length,
    pass,
    fail: records.length - pass,
    pass_rate: records.length ? Number((pass / records.length).toFixed(4)) : 0,
    tokens,
    cost_usd: Number(costUsd.toFixed(6)),
    cost_rmb: Number((costUsd * opts.usdRmb).toFixed(6)),
    usd_rmb: opts.usdRmb,
    duration_ms: duration,
    models: [...models],
  };
}

function buildView(records, summary, opts) {
  return {
    generated_at: new Date().toISOString(),
    base_url: opts.base,
    scene: opts.scene ?? "all",
    only: opts.only ?? null,
    total: summary.total,
    pass: summary.pass,
    fail: summary.fail,
    pass_rate: summary.pass_rate,
    tokens: summary.tokens,
    cost_usd: summary.cost_usd,
    cost_rmb: summary.cost_rmb,
    usd_rmb: summary.usd_rmb,
    duration_ms: summary.duration_ms,
    models: summary.models,
    items: records.map((r) => ({
      id: r.id,
      scene: r.scene,
      question: r.question,
      note: r.note,
      expect_tools: r.expect_tools,
      tool_names: r.tool_names,
      must_contain: r.must_contain,
      must_contain_any: r.must_contain_any,
      must_not_contain: r.must_not_contain,
      verdict: r.verdict,
      failures: r.failures,
      elapsed_ms: r.elapsed_ms,
      usage: r.usage ?? null,
      model: r.model ?? null,
      answer: r.answer,
    })),
  };
}

async function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));

  const token = resolveToken();
  if (!token) {
    console.error("缺少 AGENT_SERVICE_TOKEN（环境变量未设置，且 ../backend/.env 未读到）");
    process.exit(2);
  }

  let dataset = loadDataset();
  if (opts.scene) dataset = dataset.filter((d) => (d.scene || "advisor") === opts.scene);
  if (opts.only && opts.only.length) {
    const want = new Set(opts.only);
    dataset = dataset.filter((d) => want.has(d.id));
  }
  if (!dataset.length) {
    console.error("筛选后没有可跑的题目（检查 --scene / --only）");
    process.exit(2);
  }

  // 健康检查（只读，失败不致命）
  try {
    const h = await fetch(`${opts.base}/health`, { signal: AbortSignal.timeout(5000) });
    const hj = await h.json();
    if (!flags.has("json")) console.log(`引擎健康: ${JSON.stringify(hj)}`);
  } catch {
    if (!flags.has("json")) console.log(`⚠ 无法访问 ${opts.base}/health（继续尝试 /chat）`);
  }

  const records = [];
  for (const item of dataset) {
    if (!flags.has("json")) process.stdout.write(`… ${item.id} ${item.question.slice(0, 24)} `);
    const { resp, elapsedMs, error } = await askChat(item, token, opts);
    let rec;
    if (error) {
      rec = {
        ...item,
        tool_names: [],
        answer: "",
        usage: null,
        model: null,
        elapsed_ms: elapsedMs,
        verdict: "FAIL",
        failures: [error],
      };
    } else {
      const { failures, answer, toolNames } = assertItem(item, resp, elapsedMs);
      rec = {
        ...item,
        tool_names: toolNames,
        answer,
        usage: resp.usage ?? null,
        model: resp.model ?? null,
        elapsed_ms: elapsedMs,
        verdict: failures.length ? "FAIL" : "PASS",
        failures,
      };
    }
    records.push(rec);
    if (!flags.has("json")) console.log(rec.verdict === "PASS" ? "PASS" : "FAIL");
  }

  const summary = summarize(records, opts);
  const view = buildView(records, summary, opts);

  // 报告落盘（默认 sessions/eval-golden-report.json；--no-report 关闭）
  const reportPath = opts.noReport ? null : (opts.out ?? DEFAULT_REPORT);
  if (reportPath) {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(view, null, 2), "utf-8");
  }

  if (flags.has("json")) {
    console.log(JSON.stringify(view, null, 2));
  } else {
    printTable(records);
    const s = summary;
    console.log(`\n===== 汇总：${s.pass}/${s.total} 通过（通过率 ${(s.pass_rate * 100).toFixed(1)}%）| 总 token ${s.tokens.total}（in ${s.tokens.input} / out ${s.tokens.output}）| 总耗时 ${(s.duration_ms / 1000).toFixed(1)}s | 成本估算 $${s.cost_usd} ≈ ¥${s.cost_rmb}（汇率 ${s.usd_rmb}）| 模型 ${s.models.join(",") || "-"} =====`);
    if (reportPath) console.log(`报告已写入: ${reportPath}`);
  }

  if (flags.has("strict") && summary.fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("评测脚本异常:", e?.stack ?? e);
  process.exit(2);
});
