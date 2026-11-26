#!/usr/bin/env node
// 示例插件的 MCP：给 Agent 一个 roll_dice 工具。只用 Node 自带模块，走 stdio（一行一条 JSON-RPC）。
// 房主在「设置 · 插件」里逐个确认后，Hive 把它写进所选运行时的 MCP 配置；撤销插件时一并删掉。
import process from "node:process";
import readline from "node:readline";

const tools = [
  {
    name: "roll_dice",
    description: "掷骰子，例如 2d6 表示掷两颗六面骰；返回每颗的点数和总和",
    inputSchema: {
      type: "object",
      properties: { spec: { type: "string", description: "NdM，例如 2d6，默认 1d6" } },
    },
  },
];

function roll(spec = "1d6") {
  const match = /^(\d{1,2})d(\d{1,3})$/i.exec(String(spec).trim());
  if (!match) throw new Error("写成 2d6 这样");
  const values = Array.from(
    { length: Number(match[1]) },
    () => 1 + Math.floor(Math.random() * Number(match[2])),
  );
  return { values, total: values.reduce((a, b) => a + b, 0) };
}

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) return; // 通知（notifications/initialized 等）不用回
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "dice", version: "0.1.0" },
      },
    });
  if (method === "tools/list") return send({ id, result: { tools } });
  if (method === "tools/call" && params?.name === "roll_dice") {
    try {
      const result = roll(params.arguments?.spec);
      return send({
        id,
        result: {
          content: [{ type: "text", text: `${result.values.join(" + ")} = ${result.total}` }],
        },
      });
    } catch (error) {
      return send({
        id,
        result: { isError: true, content: [{ type: "text", text: error.message }] },
      });
    }
  }
  send({ id, error: { code: -32601, message: `没有方法 ${method}` } });
});
