/**
 * agent-engine 出口合规预过滤（合规双层·第一层引擎侧）。
 *
 * 词库单一事实源 = backend/app/gateway/compliance_lexicon.json（与 FastAPI 出口
 * 强制过滤（第二层，app/gateway/compliance.py）读同一文件——两层核对同一口径，
 * 换词库不用改代码）。public 场景（consultant/inbox）答案在引擎出口先过一遍：
 *   - reject 命中 → 整段替换为引导话术（不泄露红线原文）
 *   - replace 命中 → 就地中性替换
 * FastAPI agentclient 仍会再过一次（防引擎被绕过/直连时的兜底），行为一致幂等。
 *
 * 词库文件读不到时 fail-safe：返回通过但打告警（出口层 Python 强制过滤仍把关）。
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEXICON = path.join(__dirname, "..", "config", "compliance_lexicon.demo.json");

const FALLBACK_DENY =
  "这个问题涉及具体承诺，我这边不便直接答复。" +
  "您可以留下联系方式，客服同事会与您详细说明。";

let cache = null; // {mtimeMs, rules}

function loadLexicon() {
  const p = process.env.COMPLIANCE_LEXICON_PATH || DEFAULT_LEXICON;
  if (!existsSync(p)) {
    console.warn(`[compliance] 词库文件不存在: ${p}（引擎侧预过滤跳过，Python 出口仍强制）`);
    return null;
  }
  const mtimeMs = statSync(p).mtimeMs;
  if (cache && cache.path === p && cache.mtimeMs === mtimeMs) return cache.lex;
  const data = JSON.parse(readFileSync(p, "utf-8"));
  const reject = [];
  const replace = [];
  for (const r of data.rules || []) {
    const w = (r.word || "").trim();
    if (!w) continue;
    let action = r.action === "replace" ? "replace" : "reject";
    if (action === "replace" && !(r.replacement || "").trim()) action = "reject";
    const rule = { word: w, lower: w.toLowerCase(), action,
                   replacement: (r.replacement || "").trim(),
                   exempt: (r.exempt || []).map((e) => e.toLowerCase()) };
    (action === "reject" ? reject : replace).push(rule);
  }
  const lex = {
    version: String(data.version || ""),
    publicFallback: (data.public_fallback || "").trim() || FALLBACK_DENY,
    reject, replace, all: [...reject, ...replace],
  };
  for (const w of (process.env.COMPLIANCE_BLOCK_WORDS || "").split(",")) {
    const t = w.trim();
    if (!t) continue;
    if (lex.all.some((r) => r.word === t)) continue;   // 词库已有（含 replace 档）以词库为准
    lex.reject.push({ word: t, lower: t.toLowerCase(), action: "reject", replacement: "", exempt: [] });
  }
  lex.all = [...lex.reject, ...lex.replace];
  cache = { path: p, mtimeMs, lex };
  console.log(`[compliance] 词库已加载 ${path.basename(p)} v${lex.version}（reject=${reject.length} replace=${replace.length}）`);
  return lex;
}

function _coveredByExempt(low, pos, wlen, exempt) {
  const end = pos + wlen;
  for (const e of exempt) {
    let j = 0;
    while (true) {
      const k = low.indexOf(e, j);
      if (k < 0) break;
      if (k <= pos && end <= k + e.length) return true;
      j = k + 1;
    }
  }
  return false;
}

function _scan(text, lex) {
  const low = text.toLowerCase();
  const hits = [];
  for (const rule of lex.all) {
    const i = low.indexOf(rule.lower);
    if (i < 0) continue;
    if (rule.exempt.length && _coveredByExempt(low, i, rule.word.length, rule.exempt)) continue;
    hits.push(rule);
  }
  return hits;
}

function _ciReplace(text, word, replacement) {
  const low = text.toLowerCase();
  const w = word.toLowerCase();
  let out = "", i = 0;
  while (true) {
    const j = low.indexOf(w, i);
    if (j < 0) return out + text.slice(i);
    out += text.slice(i, j) + replacement;
    i = j + w.length;
  }
}

/**
 * 出口强制过滤。返回 {passed, text, reason, action, hits}——
 * 与 Python compliance.enforce 语义逐字段对齐。
 */
export function enforcePublic(text) {
  const lex = loadLexicon();
  if (!lex) return { passed: true, text, reason: "", action: "", hits: [] };
  if (!text) return { passed: true, text, reason: "", action: "", hits: [] };
  const hits = _scan(text, lex);
  if (!hits.length) return { passed: true, text, reason: "", action: "", hits: [] };
  const rejectHits = hits.filter((r) => r.action === "reject");
  if (rejectHits.length) {
    return { passed: false, text: lex.publicFallback,
             reason: `红线词: ${rejectHits[0].word}` +
                     (rejectHits.length > 1 ? `（共${rejectHits.length}词）` : ""),
             action: "reject", hits: rejectHits.map((r) => r.word) };
  }
  let out = text;
  const applied = [];
  for (const rule of [...hits].sort((a, b) => b.word.length - a.word.length)) {
    out = _ciReplace(out, rule.word, rule.replacement);
    applied.push(rule.word);
  }
  const residual = _scan(out, lex).filter((r) => r.action === "reject");
  if (residual.length) {
    console.warn(`[compliance] 替换后仍含红线词 ${residual.map((r) => r.word)}，降级 reject`);
    return { passed: false, text: lex.publicFallback,
             reason: `红线词: ${residual[0].word}`,
             action: "reject", hits: [...applied, ...residual.map((r) => r.word)] };
  }
  return { passed: true, text: out, reason: `中性替换: ${applied.join(",")}`,
           action: "replace", hits: applied };
}
