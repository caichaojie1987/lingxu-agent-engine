/**
 * 会话回放/审计工具：把 agent-engine 落盘的 PI 会话 JSONL 转成可读对话文本。
 *
 * 用法：
 *   node scripts/replay.mjs                      # 回放全部租户的全部会话
 *   node scripts/replay.mjs t1                   # 只看租户 1
 *   node scripts/replay.mjs t1 <文件前缀/路径>     # 只看指定会话文件
 *   node scripts/replay.mjs t1 xxx.jsonl --tail  # 只打印该文件最后若干轮
 *
 * 目的：M3-P3b 评测回放 / 合规审计——从会话文件还原 用户问→工具→回答 完整链路。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "sessions");

function walk() {
  const out = [];
  if (!statSyncSafe(ROOT)) return out;
  for (const tenantDir of readdirSync(ROOT)) {
    const tp = path.join(ROOT, tenantDir);
    if (!statSyncSafe(tp)?.isDirectory()) continue;
    for (const f of readdirSync(tp).filter((x) => x.endsWith(".jsonl"))) {
      out.push({ tenant: tenantDir, file: f, abs: path.join(tp, f) });
    }
  }
  return out;
}
const statSyncSafe = (p) => { try { return statSync(p); } catch { return null; } };

function replayLines(rows) {
  const out = [];
  for (const r of rows) {
    if (r.type !== "message") continue;
    const m = r.message;
    const role = m?.role;
    if (role === "user") {
      const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
      if (text?.trim()) out.push(`[用户] ${text.trim()}`);
    } else if (role === "assistant") {
      const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
      const u = m.usage ?? {};
      const cost = u.cost?.total ? ` ¥${(u.cost.total).toFixed(6)}` : "";
      const usage = u.totalTokens ? ` [tokens≈${u.totalTokens}${cost}]` : "";
      if (text?.trim()) out.push(`[AI]${usage} ${text.trim()}`);
      else if (usage) out.push(`[AI]${usage} （本步仅工具调用）`);
    } else if (role === "tool") {
      out.push(`  └ 工具结果: ${String(m.content ?? "").slice(0, 200)}`);
    }
  }
  return out;
}

async function main() {
  const [tenantArg, fileArg, tailFlag] = process.argv.slice(2);
  const files = walk().filter((f) => (!tenantArg || f.tenant === tenantArg) &&
    (!fileArg || f.file.includes(fileArg)));
  if (!files.length) {
    console.log("未找到会话文件（sessions/ 为空？先让 dashboard 场景产生一次对话）");
    process.exit(0);
  }
  for (const f of files) {
    console.log(`\n════ ${f.tenant}/${f.file} （${Math.round(statSync(f.abs).size / 1024)} KB） ════`);
    const rows = readFileSync(f.abs, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let lines = replayLines(rows);
    if (tailFlag) lines = lines.slice(-24);
    console.log(lines.join("\n"));
  }
}
main();
