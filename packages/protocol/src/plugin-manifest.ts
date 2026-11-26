import { z } from "zod";

/**
 * 插件清单（原型，见 docs/research/plugin-system.md）。
 *
 * 插件是一个目录，根上放 superhive-plugin.json。第一阶段只开放三类扩展点：
 * - panels：右侧栏的一个标签页，网页在无同源的 sandbox iframe 里跑，和宿主只能 postMessage；
 * - commands：输入框里的斜杠命令，交给插件自己的面板处理；
 * - mcpServers：给本机 Agent 用的 MCP 工具（声明，经房主确认后写进运行时配置）。
 *
 * 默认什么权限都没有；清单里列的只是「申请」，房主在本机确认后才生效，随时可撤销。
 */

export const PLUGIN_MANIFEST_FILE = "superhive-plugin.json";

/** 插件 id：反向域名或短横线小写，和目录名一致 */
const pluginIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "插件 id 只能用小写字母、数字、点和短横线");

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "版本号要写成 x.y.z");

/** 第一阶段可申请的权限。不在表里的一律拒绝，不做「先放行再说」 */
export const pluginPermissions = [
  /** 读当前房间最近的消息（面板打开期间、当前查看者能看到的那些） */
  "room:read",
  /** 读当前房间成员列表（名字、类型、在线状态） */
  "members:read",
  /** 往输入框里填文字；发不发由人决定 */
  "composer:write",
] as const;
export type PluginPermission = (typeof pluginPermissions)[number];

const panelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  title: z.string().min(1).max(24),
  /** 插件目录里的相对路径，只能是 .html */
  entry: z
    .string()
    .regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.html$/, "entry 要是插件目录里的 .html 相对路径"),
});

const commandSchema = z.object({
  /** 不带斜杠，例如 "roll" 对应输入 /roll */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  description: z.string().min(1).max(80),
  /** 由哪个面板处理：输入 /name 参数 后打开这个面板并把参数交给它 */
  panel: z.string(),
});

const mcpServerSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  /** 只支持 stdio：命令和参数都相对插件目录解析，不经过 shell */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** 给房主看的说明：这个 MCP 会给 Agent 什么能力 */
  description: z.string().min(1).max(200),
});

export const pluginManifestSchema = z
  .object({
    id: pluginIdSchema,
    name: z.string().min(1).max(40),
    version: semverSchema,
    description: z.string().max(200).default(""),
    author: z.string().max(80).optional(),
    homepage: z.string().url().optional(),
    /** 要求的 SuperHive 版本范围，例如 ">=0.5.0"、"^0.5.0" */
    engines: z.object({ superhive: z.string().min(1) }),
    permissions: z.array(z.enum(pluginPermissions)).default([]),
    /** 访客（凭邀请进来的人）能不能看到这个插件的面板和命令；默认不能 */
    guests: z.boolean().default(false),
    contributes: z
      .object({
        panels: z.array(panelSchema).max(4).default([]),
        commands: z.array(commandSchema).max(16).default([]),
        mcpServers: z.array(mcpServerSchema).max(4).default([]),
      })
      .default({}),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const panels = new Set(manifest.contributes.panels.map((panel) => panel.id));
    if (panels.size !== manifest.contributes.panels.length)
      ctx.addIssue({ code: "custom", message: "面板 id 重复", path: ["contributes", "panels"] });
    manifest.contributes.commands.forEach((command, index) => {
      if (!panels.has(command.panel))
        ctx.addIssue({
          code: "custom",
          message: `命令 /${command.name} 指向不存在的面板 ${command.panel}`,
          path: ["contributes", "commands", index, "panel"],
        });
    });
  });
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** 房主批准过的状态：只放行批准时清单里申请的那些，清单后来多申请的不会自动生效 */
export const pluginGrantSchema = z.object({
  permissions: z.array(z.enum(pluginPermissions)),
  /** 批准的是哪个版本；升级后申请的权限变多要重新批准 */
  version: semverSchema,
  grantedAt: z.string(),
});
export type PluginGrant = z.infer<typeof pluginGrantSchema>;

/** 网页拿到的插件条目（已过滤掉当前查看者不能用的） */
export const pluginSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  permissions: z.array(z.enum(pluginPermissions)),
  panels: z.array(panelSchema),
  commands: z.array(commandSchema),
});
export type PluginSummary = z.infer<typeof pluginSummarySchema>;

/** 房主在本机管理时看到的条目：申请了什么、批准了什么、为什么不能用 */
export const localPluginSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
  dir: z.string(),
  requested: z.array(z.enum(pluginPermissions)),
  mcpServers: z.array(mcpServerSchema),
  grant: pluginGrantSchema.optional(),
  /** enabled：已批准且清单没多申请；needs-approval：没批准或升级后多申请了；invalid：清单不合法或版本不兼容 */
  state: z.enum(["enabled", "needs-approval", "invalid"]),
  problem: z.string().optional(),
});
export type LocalPlugin = z.infer<typeof localPluginSchema>;

/* ---------------- 插件和宿主之间的 postMessage 协议 ---------------- */

/** 插件 → 宿主：调用一个方法，宿主按 id 回 result 或 error */
export type PluginRequest = {
  superhive: 1;
  kind: "request";
  id: number;
  method: PluginMethod;
  params?: unknown;
};
/** 宿主 → 插件 */
export type PluginHostMessage =
  | { superhive: 1; kind: "result"; id: number; result: unknown }
  | { superhive: 1; kind: "error"; id: number; code: PluginErrorCode; message: string }
  | { superhive: 1; kind: "event"; event: "command"; data: { name: string; args: string } }
  | { superhive: 1; kind: "event"; event: "context"; data: PluginContext };

export type PluginErrorCode = "PERMISSION_DENIED" | "UNKNOWN_METHOD" | "BAD_PARAMS" | "FAILED";

export type PluginContext = {
  roomId: string;
  locale: string;
  theme: "dark" | "light";
  /** 当前查看者是不是访客 */
  viewer: "owner" | "guest";
};

/** 每个方法需要哪条权限；null 表示不需要（只给插件自己的上下文） */
export const pluginMethodPermissions = {
  "context.get": null,
  "room.messages": "room:read",
  "room.members": "members:read",
  "composer.insert": "composer:write",
} as const satisfies Record<string, PluginPermission | null>;
export type PluginMethod = keyof typeof pluginMethodPermissions;

/* ---------------- 版本范围 ---------------- */

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * 只认最常用的几种写法：`*`、`x.y.z`、`>=x.y.z`、`<x.y.z`、`^x.y.z`、`~x.y.z`，空格分隔表示同时满足。
 * 写不认识的范围时当作不兼容，宁可不加载也不要在不认识的版本上跑。
 */
export function satisfiesEngine(current: string, range: string): boolean {
  const version = parseVersion(current);
  if (!version) return false;
  const parts = range.trim().split(/\s+/);
  return parts.every((part) => {
    if (part === "*") return true;
    const match = /^(>=|<=|>|<|\^|~|=)?(\d+\.\d+\.\d+)$/.exec(part);
    if (!match) return false;
    const target = parseVersion(match[2]!)!;
    const diff = compare(version, target);
    switch (match[1]) {
      case ">=":
        return diff >= 0;
      case "<=":
        return diff <= 0;
      case ">":
        return diff > 0;
      case "<":
        return diff < 0;
      case "^":
        // 0.x 时次版本号就是破坏性变更，和 npm 一致
        return (
          diff >= 0 &&
          (target[0] > 0
            ? version[0] === target[0]
            : target[1] > 0
              ? version[0] === 0 && version[1] === target[1]
              : version[0] === 0 && version[1] === 0 && version[2] === target[2])
        );
      case "~":
        return diff >= 0 && version[0] === target[0] && version[1] === target[1];
      default:
        return diff === 0;
    }
  });
}
