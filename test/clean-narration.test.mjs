// cleanNarration 单测（node --test）——P2 修复锁定（2026-09-09）：
// 成品敬语"我需要您…"必须保留；自述"我先查…/我需要查一下…"必须删除。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 从 server.mjs 提取 cleanNarration 函数体（轻量源码测试，避免重构导出面）
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs"), "utf-8");
const fnSrc = src.slice(src.indexOf("function cleanNarration"), src.indexOf("async function readBody"));
const cleanNarration = new Function(`${fnSrc}; return cleanNarration;`)();

test("成品敬语保留：我需要您确认一下到访时间（邀约常见形态）", () => {
  const s = "王姐您好，周末方便来案场看看吗？我需要您确认一下到访时间，我好提前安排置业顾问接待。";
  const out = cleanNarration(s);
  assert.ok(out.includes("我需要您确认一下到访时间"), `被误删: ${out}`);
  assert.ok(out.includes("王姐您好"), `头部丢失: ${out}`);
});

test("成品敬语保留：我需要您配合提供证件", () => {
  const s = "赵女士您好，认购前我需要您配合提供身份证和户口本复印件。";
  const out = cleanNarration(s);
  assert.ok(out.includes("我需要您配合提供"), `被误删: ${out}`);
});

test("自述删除：我先查一下客户档案", () => {
  const s = "我先查一下赵女士的客户档案和素材包。赵女士想看125平左右，最贴近的是2栋2201。";
  const out = cleanNarration(s);
  assert.ok(!out.includes("我先查一下"), `未删: ${out}`);
  assert.ok(out.includes("赵女士想看125平"), `成品被伤: ${out}`);
});

test("自述删除：我需要查一下数据（无'您'=非敬语）", () => {
  const s = "我需要查一下这个项目的回款数据。未来一周待收42万。";
  const out = cleanNarration(s);
  assert.ok(!out.includes("我需要查一下"), `未删: ${out}`);
  assert.ok(out.includes("42万"), `成品被伤: ${out}`);
});

test("自述删除：拿到ID过渡句", () => {
  const s = "拿到客户ID（3），我来拉取素材包。赵女士是新客户、学区购房。";
  const out = cleanNarration(s);
  assert.ok(!out.includes("拿到客户ID"), `未删: ${out}`);
  assert.ok(out.includes("学区购房"), `成品被伤: ${out}`);
});

test("md 结构保留：表格行不被压平", () => {
  const s = "对比表：\n| 顾问 | 客户数 |\n| --- | --- |\n| 小张 | 3 |\n建议优先跟进小张名下客户。";
  const out = cleanNarration(s);
  assert.ok(out.includes("| 顾问 | 客户数 |"), `表格头丢失: ${out}`);
  assert.ok(out.includes("| 小张 | 3 |"), `表格行丢失: ${out}`);
});

test('开头自述句"接下来拉取…素材包"整句删除', () => {
  const out = cleanNarration('接下来拉取她的完整档案、成交预判和话术素材包。我已掌握吴大姐（尾号2222，顾问小张）的档案、预判与素材包，现生成客户分析。\n\n**吴大姐客户分析**');
  assert.equal(out.includes('接下来拉取'), false);
  assert.equal(out.includes('我已掌握'), false);
  assert.ok(out.includes('**吴大姐客户分析**'));
});
test('敬语"接下来您…"保留不被误删', () => {
  const out = cleanNarration('接下来您确认一下到访时间，我好提前安排。');
  assert.ok(out.includes('接下来您确认一下到访时间'));
});

test('开篇工具转述段多形态删除（我定位/现在并行/我完成）', () => {
  const out = cleanNarration('我定位到了吴大姐（档案ID 29）。 现在并行拉取她的画像、成交预判、时间线及话术素材包。 我完成了吴大姐（档案ID 29）的开盘分析。\n\n## 吴大姐客户分析');
  assert.equal(out.includes('我定位到了'), false);
  assert.equal(out.includes('现在并行拉取'), false);
  assert.equal(out.includes('我完成了'), false);
  assert.ok(out.includes('## 吴大姐客户分析'));
});
test('成品句"现在给您发案场定位"不被误删', () => {
  const out = cleanNarration('现在给您发案场定位，周末案场有样板间开放。');
  assert.ok(out.includes('现在给您发案场定位'));
});

test("英文自述剥离：Let me check… 后接中文正文（2026-09-09 实测漏网）", () => {
  const s = "Let me check the sales stats for this month.本月（截至9月9日）成交为0套，认购也还是0套。";
  const out = cleanNarration(s);
  assert.ok(!out.includes("Let me check"), `英文自述未剥离: ${out}`);
  assert.ok(out.includes("本月（截至9月9日）成交为0套"), `正文丢失: ${out}`);
});

test("英文自述剥离：Now let me / I'll 形态", () => {
  const a = cleanNarration("Now let me look up the customer profile.张先生目前是A级客户。");
  assert.ok(!a.includes("Now let me"), `未剥离: ${a}`);
  assert.ok(a.includes("张先生目前是A级客户"), `正文丢失: ${a}`);
  const b = cleanNarration("I'll pull the payment records.本月应收120万，已收90万。");
  assert.ok(!b.includes("I'll pull"), `未剥离: ${b}`);
  assert.ok(b.includes("已收90万"), `正文丢失: ${b}`);
});

test("正常英文不被误剥：无句号的专有名词/品牌", () => {
  const s = "推荐给客户 Let's Talk 主题活动，附上项目 LOGO。";
  const out = cleanNarration(s);
  assert.ok(out.includes("Let's Talk"), `被误剥: ${out}`);
  assert.ok(out.includes("LOGO"), `被误剥: ${out}`);
});

test("业务字段名兜底映射：due/pending 等英文键名译中（2026-09-09 实测漏网）", () => {
  const s = "首付20万 due 2026-09-09 状态 pending，另有按揭款 due_date 2026-11-30 overdue_days 3";
  const out = cleanNarration(s);
  assert.ok(!/\bdue\b/.test(out), `due 未译: ${out}`);
  assert.ok(!/\bpending\b/.test(out), `pending 未译: ${out}`);
  assert.ok(out.includes("到期 2026-09-09"), `译错: ${out}`);
  assert.ok(out.includes("待付"), `译错: ${out}`);
  assert.ok(out.includes("到期日 2026-11-30"), `due_date 未译: ${out}`);
  assert.ok(out.includes("逾期天数 3"), `overdue_days 未译: ${out}`);
});

test("字段名映射不误伤含相同字母的中文/正常词", () => {
  const s = "客户已按期付款，本月已付10万，待付20万。";
  const out = cleanNarration(s);
  assert.ok(out.includes("已付10万") && out.includes("待付20万"), `被误改: ${out}`);
});
