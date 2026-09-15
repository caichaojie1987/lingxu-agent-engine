/**
 * MCP 网关·引擎侧 client 管理（agent-engine → backend mcp_servers 注册表 → MCP server）。
 *
 * 目标架构（docs/architecture-tool-registry-20260907.md 场景工具派生 + MCP 网关试点）：
 * - 注册表单源在 backend：GET /internal/v1/mcp/servers?tenant_id=（只读、X-Service-Token 门），
 *   字段契约与兄弟任务 CRUD 一致（id/tenant_id/project_id/name/kind/command/url/headers/
 *   enabled/scene_scope/audit）。本模块只消费 enabled 行，不写库。
 * - 懒连接：工具发现（listTools）或首次调用时才 spawn（kind=stdio，command 数组）或
 *   StreamableHTTP（kind=http，url + headers）；进程级单例连接复用，失败即标记 failed，
 *   场景工具表为空 + 日志（fail-closed：MCP 故障不炸 dashboard 等场景）。
 * - 场景裁剪：server.scene_scope 声明放行的场景才把其工具并入场景清单
 *   （契约：空/缺省 = 全场景放行；条目支持 "scene" 或 "scene:role" 精确裁剪）。
 *   项目裁剪：project_id NULL/0 = 租户全项目；非空 = 仅该 project 的会话可见。
 * - 命名：mcp.<server名>.<tool名>，如 mcp.demo.weather.query。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";

import { config } from "./config.mjs";

const CONNECT_TIMEOUT_MS = 8_000;   // 连接/工具发现超时（stdio 起进程慢也给足）
const CALL_TIMEOUT_MS = 30_000;     // 单次工具调用超时
const LIST_TTL_MS = 60_000;         // listTools 结果缓存
const ROWS_TTL_MS = 5_000;          // 注册表行缓存（演示期够用；改库后 ≤5s 生效）
const LOG_COOLDOWN_MS = 30_000;     // 同类失败日志节流

const log = (msg) => console.log(`[agent-engine][mcp] ${msg}`);
const warn = (msg) => console.warn(`[agent-engine][mcp] ${msg}`);

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${what} 超时(${ms}ms)`)), ms);
      t.unref?.();
    }),
  ]);
}

/** MCP JSON Schema（子集）→ TypeBox（pi registerTool.parameters 需要 TypeBox 声明）。 */
function propToTypeBox(prop) {
  if (!prop || typeof prop !== "object") return Type.Any();
  switch (prop.type) {
    case "string":
      return Type.String({ description: prop.description ?? "" });
    case "number":
      return Type.Number({ description: prop.description ?? "" });
    case "integer":
      return Type.Integer({ description: prop.description ?? "" });
    case "boolean":
      return Type.Boolean({ description: prop.description ?? "" });
    case "array":
      return Type.Array(prop.items ? propToTypeBox(prop.items) : Type.Any(), {
        description: prop.description ?? "",
      });
    case "object": {
      const props = {};
      const required = new Set(Array.isArray(prop.required) ? prop.required : []);
      for (const [k, v] of Object.entries(prop.properties ?? {})) {
        const tb = propToTypeBox(v);
        props[k] = required.has(k) ? tb : Type.Optional(tb);
      }
      return Type.Object(props, { description: prop.description ?? "" });
    }
    default:
      // 未知 schema（$ref/enum/oneOf…）→ 放通，参数由 execute 原样透传
      return Type.Any({ description: prop.description ?? "" });
  }
}

/** 顶层 inputSchema（type=object）→ TypeBox Object；缺省/异常 → 空参（模型不传参）。 */
export function mcpInputSchemaToTypeBox(inputSchema) {
  if (inputSchema && inputSchema.type === "object") {
    return propToTypeBox(inputSchema);
  }
  return Type.Object({});
}

/** scope 条目匹配：支持 "scene" 或 "scene:role"；空/缺省 scene_scope = 全场景（管理域契约）。 */
function scopeAllows(scope, scene, role) {
  if (!Array.isArray(scope) || scope.length === 0) return true;
  const r = role || "";
  return scope.some((entry) => {
    if (entry === "*") return true;
    const [s, rr] = String(entry).split(":");
    if (s !== scene) return false;
    return rr === undefined || rr === "" || rr === r; // "scene" 对所有角色；"scene:role" 精确
  });
}

/** 项目裁剪：row.project_id NULL/0 = 租户全项目放行；非空 = 仅匹配传入 projectId（未传则不放行）。 */
function projectAllows(rowProjectId, projectId) {
  if (!rowProjectId) return true;
  return Number(projectId) > 0 && Number(rowProjectId) === Number(projectId);
}

class McpManager {
  constructor() {
    /** key = `${tenantId}:${serverName}` → 连接/工具缓存 holder */
    this._holders = new Map();
    /** tenantId → { at, rows } 注册表行缓存 */
    this._rowsCache = new Map();
    /** tenantId → { at } 拉取失败节流 */
    this._lastRowError = new Map();
  }

  // ── 注册表发现（backend 只读端点，AGENT_TOKEN 门） ──────────────
  async _fetchRows(tenantId, projectId = 0) {
    const cacheKey = `${tenantId}:${projectId || 0}`;
    const cache = this._rowsCache.get(cacheKey);
    if (cache && Date.now() - cache.at < ROWS_TTL_MS) return cache.rows;
    try {
      // 带上 project_id：backend 只读端点按「全项目行 ∪ 该项目专属行」预过滤，
      // 引擎侧 projectAllows 再按会话 project 精确裁剪（双保险，防跨项目泄漏）
      const url = `${config.backendUrl}/internal/v1/mcp/servers?tenant_id=${Number(tenantId)}` +
        (projectId ? `&project_id=${Number(projectId)}` : "");
      const resp = await fetch(url, {
        headers: { "X-Service-Token": config.serviceToken },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) throw new Error(`backend 返回 HTTP ${resp.status}`);
      const data = await resp.json();
      const rows = Array.isArray(data?.servers) ? data.servers : [];
      this._rowsCache.set(cacheKey, { at: Date.now(), rows });
      return rows;
    } catch (e) {
      const last = this._lastRowError.get(cacheKey) ?? 0;
      if (Date.now() - last > LOG_COOLDOWN_MS) {
        warn(`拉取 mcp_servers 失败(tenant=${tenantId}, project=${projectId || 0})：${e.message}；沿用上次清单或空(fail-closed)`);
        this._lastRowError.set(cacheKey, Date.now());
      }
      const stale = this._rowsCache.get(cacheKey);
      return stale ? stale.rows : [];   // 后端抖动 → 沿用上次成功清单；从未成功 → 空
    }
  }

  async _enabledRows(tenantId, projectId = 0) {
    const rows = await this._fetchRows(Number(tenantId), Number(projectId || 0));
    return rows.filter(
      (r) => r && Number(r.enabled ?? 1) === 1 && !r.deleted_at && projectAllows(r.project_id, projectId),
    );
  }

  // ── 懒连接 + 工具发现 ──────────────────────────────────────
  _holder(tenantId, row) {
    const key = `${tenantId}:${row.name}`;
    let h = this._holders.get(key);
    if (!h) {
      h = {
        key,
        row,
        client: null,
        transport: null,
        tools: new Map(),       // toolName → {name, description, inputSchema}
        state: "idle",          // idle/connecting/ready/failed
        error: "",
        listAt: 0,
        lock: null,
        logAt: 0,
      };
      this._holders.set(key, h);
    }
    return h;
  }

  _connect(h) {
    if (h.state === "ready") return Promise.resolve();
    if (h.lock) return h.lock;                     // 并发去重：等待进行中的连接
    h.state = "connecting";
    h.error = "";
    const attempt = (async () => {
      const row = h.row;
      let transport = null;
      let client = null;
      try {
        client = new Client({ name: "agent-engine", version: "0.1.0" });
        if (row.kind === "http") {
          const opts = { requestInit: { headers: row.headers && typeof row.headers === "object" ? { ...row.headers } : {} } };
          transport = new StreamableHTTPClientTransport(new URL(row.url), opts);
        } else {
          const cmd = Array.isArray(row.command) && row.command.length ? row.command : [];
          if (!cmd.length || !cmd[0]) throw new Error(`kind=stdio 但 command 为空`);
          transport = new StdioClientTransport({ command: cmd[0], args: cmd.slice(1) });
        }
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${row.name} 连接`);
        const list = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `${row.name} listTools`);
        const toolMap = new Map();
        for (const t of list?.tools ?? []) {
          if (!t?.name) continue;
          toolMap.set(t.name, {
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object" },
          });
        }
        h.tools = toolMap;
        h.client = client;
        h.transport = transport;
        h.listAt = Date.now();
        h.state = "ready";
        h.error = "";
        log(`+MCP server ${row.name}（${row.kind}）就绪，工具 ${toolMap.size} 个` +
          (toolMap.size ? `：${[...toolMap.keys()].join(", ")}` : ""));
        return;
      } catch (e) {
        // fail-closed：连接/发现失败 → 本 server 工具集为空，场景不炸
        h.state = "failed";
        h.error = e.message;
        h.tools = new Map();
        const now = Date.now();
        if (now - h.logAt > LOG_COOLDOWN_MS) {
          warn(`MCP server ${row.name} 连接失败(fail-closed，工具集置空)：${e.message}`);
          h.logAt = now;
        }
        try { await client?.close(); } catch { /* 忽略 */ }
        try { await transport?.close(); } catch { /* 忽略 */ }
      }
    })();
    h.lock = attempt;
    attempt.finally(() => { h.lock = null; }).catch(() => {});   // 释放锁（attempt 内部已消化异常）
    return attempt;
  }

  /** 获取某 server 工具表（连接失败 → 空 Map，不抛）。 */
  async _toolsOf(tenantId, row) {
    const h = this._holder(tenantId, row);
    if (h.state === "failed") return h.tools;
    if (h.state === "ready" && Date.now() - h.listAt < LIST_TTL_MS) return h.tools;
    await this._connect(h);
    return h.tools;
  }

  // ── 场景工具清单（供 engine /internal/v1/mcp/tools 与场景 loader 合并） ──
  /**
   * @param {{tenantId:number, projectId?:number, scene:string, role?:string}} opts
   * @returns {Promise<Array<{name:string, server:string, tool:string, description:string, inputSchema:object}>>}
   */
  async describeSceneTools({ tenantId, scene, role = "", projectId = 0 }) {
    const out = [];
    const rows = await this._enabledRows(tenantId, projectId);
    for (const row of rows) {
      if (!scopeAllows(row.scene_scope, scene, role)) continue;
      const tools = await this._toolsOf(tenantId, row);
      for (const t of tools.values()) {
        out.push({
          name: `mcp.${row.name}.${t.name}`,
          server: row.name,
          tool: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    }
    return out;
  }

  /** 场景工具注册（pi registerTool 形态：TypeBox parameters + execute 代理到本进程 manager）。 */
  async sceneToolRegistrations({ tenantId, scene, role = "", projectId = 0 }) {
    const rows = await this._enabledRows(tenantId, projectId);
    const regs = [];
    for (const row of rows) {
      if (!scopeAllows(row.scene_scope, scene, role)) continue;
      const tools = await this._toolsOf(tenantId, row);
      for (const t of tools.values()) {
        const full = `mcp.${row.name}.${t.name}`;       // 注册表/清单命名（证据口径）
        // LLM API 函数名只允许 ^[a-zA-Z0-9_-]+$（deepseek 实测拒绝带点工具名）：
        // 注册进 pi 的名字做幂等消毒（. → _），execute 仍按原始 server/tool 代理
        const piName = full.replace(/[^a-zA-Z0-9_-]/g, "_");
        const parameters = mcpInputSchemaToTypeBox(t.inputSchema);
        regs.push({
          name: piName,
          label: `${t.name}（MCP·${row.name}）`,
          description: `${t.description || `远端工具 ${full}`}（经 MCP server「${row.name}」代理，只读数据由远端负责）`,
          parameters,
          mcp: { server: row.name, tool: t.name, full },
          execute: async (_toolCallId, params, _signal, _onUpdate) => {
            const r = await this.callTool({
              tenantId: Number(tenantId), projectId: Number(projectId || 0),
              server: row.name, tool: t.name, arguments: params ?? {},
            });
            if (!r.ok) throw new Error(`MCP 工具 ${full} 调用失败: ${r.error}`);
            return {
              content: [{ type: "text", text: r.text }],
              details: { source: `mcp:${row.name}`, is_error: !!r.is_error },
            };
          },
        });
      }
    }
    return regs;
  }

  // ── 工具调用代理（engine POST /internal/v1/mcp/call + 场景 execute 共用） ──
  /**
   * @param {{tenantId:number, projectId?:number, server:string, tool:string, arguments?:object}} opts
   * @returns {Promise<{ok:boolean, text:string, content:Array, is_error?:boolean, error?:string}>}
   */
  async callTool({ tenantId, projectId = 0, server, tool, arguments: args }) {
    const rows = await this._enabledRows(Number(tenantId), Number(projectId || 0));
    const row = rows.find((r) => r.name === server);
    if (!row) {
      const known = rows.map((r) => r.name).join(", ") || "（无 enabled server）";
      return { ok: false, text: "", content: [], error: `MCP server「${server}」未启用或不存在（tenant=${tenantId}，可用: ${known}）` };
    }
    const h = this._holder(Number(tenantId), row);
    if (h.state === "failed") {
      return { ok: false, text: "", content: [], error: `MCP server「${server}」连接不可用: ${h.error}` };
    }
    const tools = await this._toolsOf(Number(tenantId), row);
    if (!tools.has(tool)) {
      return { ok: false, text: "", content: [], error: `MCP 工具「${tool}」不在 server「${server}」清单（可用: ${[...tools.keys()].join(", ") || "空"}）` };
    }
    try {
      const result = await withTimeout(
        h.client.callTool({ name: tool, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS }),
        CALL_TIMEOUT_MS,
        `${server}.${tool} 调用`,
      );
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .map((c) => (c && c.type === "text" ? c.text : (c && typeof c === "object" ? JSON.stringify(c) : String(c))))
        .filter(Boolean)
        .join("\n");
      return { ok: true, text, content, is_error: !!result?.isError };
    } catch (e) {
      // 调用异常（含超时）→ 标记 failed，下次调用自动重连（fail-closed 语义）
      h.state = "failed";
      h.error = e.message;
      try { await h.client?.close(); } catch { /* 忽略 */ }
      try { await h.transport?.close(); } catch { /* 忽略 */ }
      return { ok: false, text: "", content: [], error: e.message };
    }
  }

  /** 进程退出清理：断开全部 stdio/http 连接。 */
  async dispose() {
    for (const h of this._holders.values()) {
      try { await h.client?.close(); } catch { /* 忽略 */ }
      try { await h.transport?.close(); } catch { /* 忽略 */ }
    }
    this._holders.clear();
  }

  stats() {
    const arr = [...this._holders.values()];
    return {
      total: arr.length,
      ready: arr.filter((h) => h.state === "ready").length,
      failed: arr.filter((h) => h.state === "failed").length,
      idle: arr.filter((h) => h.state === "idle").length,
      tools: arr.reduce((n, h) => n + h.tools.size, 0),
    };
  }
}

/** 进程级单例（场景与 HTTP 端点共用同一批连接与工具缓存）。 */
export const mcpManager = new McpManager();

process.on("exit", () => {
  for (const h of mcpManager._holders.values()) {
    try { h.client?.close?.(); } catch { /* 忽略 */ }
    try { h.transport?.close?.(); } catch { /* 忽略 */ }
  }
});
