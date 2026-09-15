/**
 * demo 场景（开源示例）：一个可脱离业务后端独立运行的最小场景。
 *
 * 两个注册名（见 src/server.mjs 的 SCENES）：
 *   - faq       临时场景（ephemeral + public）：每次请求独立会话，用完即弃，
 *               回答出口先过合规词库（config/compliance_lexicon.demo.json）
 *   - assistant 持久场景（内部）：长活会话，多轮上下文（LRU 上限见 AGENT_MAX_SESSIONS）
 *
 * 工具 query_orders 演示两种执行写法：
 *   A. 内置 mock（默认）——开箱即跑，配合 scripts/golden-qa.json 的黄金问答评测；
 *   B. 业务 API（注释模板）——真实项目换成调业务后端的内部只读 API。
 */
import { Type } from "typebox";
import { config } from "../config.mjs";

/** 演示数据：真实项目里这份数据来自你的业务后端。 */
const MOCK_ORDERS = {
  "ORD-1001": { status: "已发货", carrier: "顺丰", eta: "明天 18:00 前", amount_yuan: 199 },
  "ORD-2002": { status: "待付款", amount_yuan: 89 },
  "ORD-3003": { status: "已完成", amount_yuan: 1299 },
};

const tools = [
  {
    name: "query_orders",
    label: "订单查询",
    description:
      "按订单号查询订单状态（状态/物流/金额）。回答'订单/发货/物流/到哪一步'类问题必用；一次查一个订单号。",
    parameters: Type.Object({
      order_id: Type.String({ description: "订单号，如 ORD-1001" }),
    }),
  },
];

const systemPrompt = `你是产品客服助手。规则：
1. 涉及订单/数据的事实时必须调用工具查询，禁止凭记忆编造。
2. 回答口语化、简洁（3 句以内），先答结论再补充。
3. 一切数字（金额/日期/状态）必须逐字取自工具返回值，查不到就如实说"未查到"，绝不外推。
4. 不承诺无法兑现的事项；涉及时引导用户联系人工客服。`;

/**
 * 构建场景定义。
 * @param {{tenantId:number, projectId:number, userId?:number, role?:string}} ctx 请求上下文
 * @param {{ephemeral?:boolean}} opts faq 场景传 {ephemeral:true}
 */
export function makeDemoScene(ctx, { ephemeral = false } = {}) {
  return {
    scene: ephemeral ? "faq" : "assistant",
    systemPrompt,
    tools: tools.map((t) => ({
      ...t,
      execute: async (_toolCallId, params) => {
        // ── 写法 A（开箱即跑）：内置 mock ──────────────────────────────
        let payload;
        if (params?.order_id && MOCK_ORDERS[params.order_id]) {
          payload = { ok: true, order: { order_id: params.order_id, ...MOCK_ORDERS[params.order_id] } };
        } else {
          payload = { ok: false, error: `未找到订单 ${params?.order_id ?? ""}（演示数据仅含 ORD-1001/2002/3003）` };
        }
        // ── 写法 B（真实项目）：调业务后端内部只读 API ─────────────────
        // const resp = await fetch(`${config.backendUrl}/internal/v1/tools/${t.name}`, {
        //   method: "POST",
        //   headers: { "Content-Type": "application/json", "X-Service-Token": config.serviceToken },
        //   body: JSON.stringify({ tenant_id: ctx.tenantId, project_id: ctx.projectId, params: params ?? {} }),
        // });
        // payload = await resp.json();
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: { source: "mock" } };
      },
    })),
  };
}
