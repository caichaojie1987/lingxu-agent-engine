# 场景开发指南

一个"场景" = 一个业务对话形态：系统提示 + 工具表 + 会话策略。引擎的一切能力（合规、计量、
韧性、审计）都对场景透明——你只写业务。

## 最小场景

`src/scenes/my-scene.mjs`：

```js
import { Type } from "typebox";

const tools = [
  {
    name: "query_tickets",              // 工具名（模型可见，也用于 golden-qa 断言）
    label: "工单查询",
    description: "按工单号查询处理进度。回答'工单/进度'类问题必用。",   // 写清"什么时候必须用"
    parameters: Type.Object({
      ticket_id: Type.String({ description: "工单号，如 TK-1001" }),
    }),
    // execute 也可以直接写在这里（demo 场景的 mock 写法）
  },
];

const systemPrompt = `你是售后客服助手。规则：
1. 涉及工单状态必须调用工具查询，禁止凭记忆编造。
2. 回答 3 句以内，先结论后补充。
3. 一切数字逐字取自工具返回值。`;

export function makeMyScene(ctx) {
  return {
    scene: "my-scene",
    systemPrompt,
    tools: tools.map((t) => ({
      ...t,
      execute: async (_id, params) => {
        // 生产写法：调业务后端内部只读 API（模板见 demo.mjs 注释）
        const payload = { ok: true, ticket: { ticket_id: params.ticket_id, status: "处理中" } };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    })),
  };
}
```

`src/server.mjs` 注册：

```js
const SCENES = {
  // ...
  "my-scene": { make: makeMyScene, persist: false, public: false },
};
```

## persist / public 的语义（选错会出事故）

| 组合 | 行为 | 适用 |
|---|---|---|
| `persist:true, public:false` | 长活多轮会话；**不**过合规出口 | 内部员工场景（问数、写跟进） |
| `persist:false, public:true` | 一次性会话 + **出口强制过合规词库**；禁用 SSE 流式 | 对外 C 端场景（客户咨询） |

- **对外场景必须 `public:true`**：delta 流不经词级合规过滤，所以 public 场景引擎会拒绝流式，
  保持整段 + 出口过滤——宁可牺牲打字机效果，不能让未过滤文本漏出去；
- **persist 场景的 session_key**：默认按 `tenant:project:业务日` 切，防"工具口径修复后旧会话
  还在复述假数"；要跨轮连续对话再显式传 `session_key`。

## system prompt 的三条铁律（生产血泪）

1. **数字必须逐字取自工具返回值**：禁止模型换算/外推/拼装新数字；查不到就答"未查到"。
   这一条能挡掉大半的幻觉客诉；
2. **工具 description 写"什么时候必须用"**，而不只是"它是什么"——这直接决定工具命中率
   （golden-qa 的 `expect_tools` 断言的就是它）；
3. **不承诺未发生的事**：模型爱写"我帮您留了/已经申请了"，prompt 里明令禁止，出口合规再兜一层。

## 评测：改提示词/换模型前先写黄金问答

在 `scripts/golden-qa.json` 加 2~5 条：

```json
{"id":"t01","scene":"my-scene","question":"TK-1001 到哪一步了？",
 "expect_tools":["query_tickets"],"must_contain":["处理中"],"note":"必须走工具"}
```

之后每次改 prompt/换模型跑 `npm run eval:golden -- --strict`——没有回归卡口的提示词工程
等于裸奔（这是我们在生产里反复验证过的）。
