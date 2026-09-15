/**
 * demo MCP stdio server（MCP 网关端到端演示，agent-engine → backend mcp_servers → 本进程）。
 *
 * 仅演示用：weather.query 按 (city × date) 确定性生成模拟天气 + 「带客看房适宜度」，
 * 供 dashboard 场景回答「今天适合带客户看房吗」类问题。纯只读、无外部依赖、无 DB。
 * 走 @modelcontextprotocol/sdk server 端（ListTools/CallTool handler）。
 *
 * 运行：node mcp-demo/weather.mjs（由 agent-engine McpManager 以 kind=stdio command 拉起）
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// 确定性伪天气池：(天气, 低温, 高温, 风力, 湿度, PM, 看房适宜)
const POOL = [
  ["晴", 22, 31, "微风2级", 45, "良", true],
  ["晴转多云", 21, 30, "微风2级", 50, "良", true],
  ["多云", 20, 28, "东南风3级", 55, "良", true],
  ["阴", 19, 25, "东北风3级", 62, "良", false],
  ["小雨", 18, 23, "东风3级", 78, "优", false],
  ["雷阵雨", 24, 30, "西南风4级", 82, "良", false],
  ["中雨", 17, 21, "北风4级", 88, "优", false],
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function weatherFor(city, date) {
  const key = `${city || "北京"}|${date || todayStr()}`;
  const [cond, lo, hi, wind, hum, aqi, suitable] = POOL[hashStr(key) % POOL.length];
  const tips = suitable
    ? "适合带客户看房：天气晴好、体感舒适，利于户外动线带看与样板间讲解；建议备遮阳伞与瓶装水。"
    : "不建议安排户外看房：天气不佳影响动线体验；可转为室内沙盘/样板间讲解或改约。";
  return {
    city: city || "北京",
    date: date || todayStr(),
    condition: cond,
    temp_low_c: lo,
    temp_high_c: hi,
    wind,
    humidity_pct: hum,
    aqi,
    suitable_for_viewing: suitable,
    note: tips,
  };
}

const server = new Server(
  { name: "demo-weather-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "weather.query",
      description:
        "查指定城市某日（默认今天）的模拟天气与「带客看房适宜度」：天气现象/气温区间/风力/湿度/空气质量，" +
        "并给出适合不适合带客户看房及注意事项。回答“今天适合带客户看房吗/天气怎么样/看房天气”必用。",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名，默认北京" },
          date: { type: "string", description: "日期 YYYY-MM-DD，默认今天" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== "weather.query") {
    return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
  }
  const a = (args ?? {}) || {};
  const w = weatherFor(String(a.city ?? ""), String(a.date ?? ""));
  const text = [
    `天气速报：${w.date} ${w.city}`,
    `天气：${w.condition}　气温 ${w.temp_low_c}~${w.temp_high_c}℃　${w.wind}　湿度${w.humidity_pct}%　空气质量：${w.aqi}`,
    `带客看房适宜度：${w.suitable_for_viewing ? "适宜" : "不适宜"}。${w.note}`,
  ].join("\n");
  return { content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
