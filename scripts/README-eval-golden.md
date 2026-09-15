# 黄金问答集主动评测（eval-golden）

`scripts/eval-golden.mjs` + `scripts/golden-qa.json`：**主动**向引擎发问、当场断言回答，用于换模型 / 改 prompt / 改工具后的**回归对比**。

与 `eval.mjs` 的分工：

| 脚本 | 方式 | 时机 | 看什么 |
|---|---|---|---|
| `eval.mjs` | 回放已落盘会话 JSONL | 事后审计 | 回合数、工具调用、token/成本、收敛性、编数静态红线 |
| `eval-golden.mjs` | 主动 POST `/chat` 逐条发问 | 事前回归 | 该问题**有没有调对工具**、答案口径**有没有说对**、有没有编数 |

## 怎么用

```bash
cd agent-engine
node scripts/eval-golden.mjs                       # 跑全部 20 条，控制台表格 + 默认写 sessions/eval-golden-report.json
node scripts/eval-golden.mjs --json                # 结果 JSON 打到 stdout
node scripts/eval-golden.mjs --out reports/g.json  # 指定报告落盘路径
node scripts/eval-golden.mjs --no-report           # 不落盘
node scripts/eval-golden.mjs --strict              # 有 FAIL 时 exit 1（CI 卡口）
node scripts/eval-golden.mjs --scene advisor       # 只跑某场景
node scripts/eval-golden.mjs --only g01,g15        # 只跑指定 id
npm run eval:golden                                # 等价于默认全跑
```

可选参数：`--base <url>`（默认 `http://127.0.0.1:8020`）、`--timeout <ms>`（默认 120000，单条同步阻塞）、`--usd-rmb <rate>`（默认 7.2，用于成本换算）。

**令牌**：优先环境变量 `AGENT_SERVICE_TOKEN`，否则读 `../backend/.env` 的 `AGENT_SERVICE_TOKEN=` 行。令牌只进请求头，不写入 stdout、报告或日志。

**前置**：引擎需在 `127.0.0.1:8020` 运行（`cd agent-engine && node src/server.mjs`，首次约 35s 才 listen）。脚本会先探 `/health`，探不到也会继续尝试 `/chat`。

## 断言语义

每条题目任一断言不过即该条 `FAIL`：

| code | 含义 |
|---|---|
| `E_TOOL_MISS` | `expect_tools` 未**全部命中**（工具名归一：点→下划线、忽略大小写，兼容 `customer.dedupe`/`customer_dedupe`） |
| `E_MUST_CONTAIN` | `must_contain` 里有词**未出现**在答案中（全部必须出现） |
| `E_MUST_CONTAIN_ANY` | `must_contain_any` 里**任一候选词**都没出现（语义等价措辞，如「重复/同名/重名」，避免模型换个说法就误判 FAIL） |
| `E_MUST_NOT` | `must_not_contain` 里的词**出现**在答案中（如内部工具名泄漏） |
| `A_NO_TOOL` | 答案出现「数字+单位」（沿用 `eval.mjs` 的 `NUM_RE`）但本轮**没有任何工具调用** → 编数风险 |
| `E_EMPTY` / `E_HTTP` / `E_TIMEOUT` | 空答案 / 请求失败 / 超时 |

汇总输出：通过率、总 token（in/out）、总耗时、成本估算（`$` 与 `¥`）、实际模型。

## 数据集（golden-qa.json）

每条字段：

```json
{"id":"g01","scene":"advisor","question":"...","expect_tools":["query_deal_stats"],
 "must_contain":["成交"],"must_not_contain":[],"note":"考什么"}
```

- `expect_tools`：该问题**必须命中**的工具名，`[]` = 只要求不编数。
- `must_contain` / `must_not_contain`：答案关键词断言（前者全部必须出现、后者一律不得出现），可为 `[]`。
- `must_contain_any`：**任一候选词出现即通过**，用于同一语义的多种说法（例：g19 查重断言 `["重复","同名","重名","冲突"]`）。
  断言设计原则：**工具命中是判定核心，措辞断言只用来防答非所问**——不要用单一字面词卡语义等价的正确答案。
- 覆盖：成交问数、到访问数、回款预警、客户评级、顾问业绩、渠道费效/排名、销控房源、项目概况、客户统计、客户档案/时间线/画像、成交预判、房贷计算、户型查询、抗性 TOP、知识库检索、客户查重、话术素材包。

新增题目直接往 `golden-qa.json` 加一条即可，无需改脚本。

## 换模型回归怎么做

1. 换模型/改 prompt 前，先在旧模型跑一遍存档：`node scripts/eval-golden.mjs --out sessions/golden-baseline.json`。
2. 切模型（管理端切换或 `AGENT_MODEL` 环境变量）重启引擎后，再跑一遍：`node scripts/eval-golden.mjs --out sessions/golden-after.json`。
3. 对比两份报告的 `pass_rate` 与 `items[].verdict`/`failures`：通过率下降或原本 PASS 的条目变 FAIL，即为回归；用 `--only <失败的 id>` 可快速复跑定位。CI 里加 `--strict` 可让回归直接卡住流水线。

> 注意：每次运行都会真实消耗 LLM token 并落库记账，回归时按需用 `--scene` / `--only` 缩小范围，避免无意义地反复全量跑。
