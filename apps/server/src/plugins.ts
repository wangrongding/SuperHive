import { randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_MANIFEST_FILE,
  pluginGrantSchema,
  pluginManifestSchema,
  pluginMcpProviders,
  satisfiesEngine,
  type LocalPlugin,
  type LocalPluginMcp,
  type PluginGrant,
  type PluginManifest,
  type PluginMcpProvider,
  type PluginSummary,
} from "@superhive/protocol";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * 插件原型（docs/research/plugin-system.md 第一阶段）：
 * - 插件放在数据目录的 plugins/<id>/ 下，根上是 superhive-plugin.json；Server 不执行插件里的任何代码；
 * - 清单申请的权限要房主在本机批准，批准记在 plugins/.grants.json，撤销即刻生效；
 * - 网页面板经一次性前缀的地址加载，响应头带 CSP sandbox（无同源、不能联网），
 *   和宿主之间只能 postMessage，宿主按批准的权限回答。
 */

const GRANTS_FILE = ".grants.json";
const grantsFileSchema = z.record(pluginGrantSchema);

/** 面板里允许的静态文件；其它扩展名一律 404，不按内容猜类型 */
const ASSET_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

type Loaded =
  | { id: string; dir: string; manifest: PluginManifest; problem?: undefined }
  | { id: string; dir: string; manifest?: undefined; problem: string };

/**
 * 把插件的 MCP 写进本机 Agent 运行时的全局配置（Server 里由 RuntimeConfigStore 实现）。
 * 只写 stdio：命令是绝对路径或 PATH 上的程序名，参数原样，不经过 shell。
 */
export type PluginMcpWriter = {
  put: (
    provider: PluginMcpProvider,
    entry: string,
    server: { command: string; args: string[] },
  ) => void;
  remove: (provider: PluginMcpProvider, entry: string) => void;
};

export class PluginError extends Error {
  constructor(
    readonly code:
      | "PLUGIN_NOT_FOUND"
      | "PLUGIN_INVALID"
      | "PLUGIN_NOT_APPROVED"
      | "PLUGIN_MCP_NOT_FOUND"
      | "PLUGIN_MCP_UNAVAILABLE"
      | "PLUGIN_MCP_WRITE_FAILED",
    message: string,
  ) {
    super(message);
  }
}

/** 写进运行时配置的名字：带上插件 id，和房主自己配的 MCP 分开，也方便撤销时找回来 */
export function pluginMcpEntryName(pluginId: string, name: string): string {
  return `plugin-${pluginId.replace(/\./g, "-")}-${name}`;
}

/**
 * 清单里的命令和参数按插件目录解析：以 ./ 开头的是插件里的文件（解析成绝对路径，不能跳出插件目录），
 * 别的（node、python3、uvx…）当 PATH 上的程序名原样写。不支持 shell 语法。
 */
export function resolvePluginMcpCommand(
  dir: string,
  server: { command: string; args: string[] },
): { command: string; args: string[] } {
  const root = path.resolve(dir);
  const inside = (value: string) => {
    const resolved = path.resolve(root, value);
    if (resolved !== root && !resolved.startsWith(root + path.sep))
      throw new PluginError("PLUGIN_INVALID", `${value} 跳出了插件目录`);
    return resolved;
  };
  const local = (value: string) => value.startsWith("./") || value.startsWith("../");
  if (!local(server.command) && /[\\/]/.test(server.command))
    throw new PluginError("PLUGIN_INVALID", "MCP 命令要么是 ./ 开头的插件内文件，要么是程序名");
  return {
    command: local(server.command) ? inside(server.command) : server.command,
    args: server.args.map((arg) => (local(arg) ? inside(arg) : arg)),
  };
}

export class PluginRegistry {
  readonly dir: string;
  private readonly hostVersion: string;
  /** 批准记录的缓存：文件的修改时间和大小没变就不重读；房主手动删改 .grants.json 也随即生效 */
  private grantsCache: { stamp: string; value: Record<string, PluginGrant> } | undefined;
  private readonly onChange: (() => void) | undefined;
  private mcpWriter: PluginMcpWriter | undefined;

  constructor(options: {
    dir: string;
    hostVersion: string;
    /** 批准、撤销、MCP 确认后调用：Server 借此通知网页 */
    onChange?: () => void;
    mcp?: PluginMcpWriter;
  }) {
    this.dir = options.dir;
    this.hostVersion = options.hostVersion;
    this.onChange = options.onChange;
    this.mcpWriter = options.mcp;
  }

  /** 运行时配置在本机路由注册时才有，晚一步接上 */
  setMcpWriter(writer: PluginMcpWriter | undefined): void {
    this.mcpWriter = writer;
  }

  get canWriteMcp(): boolean {
    return Boolean(this.mcpWriter);
  }

  private grantsStamp(): string {
    try {
      const stat = statSync(path.join(this.dir, GRANTS_FILE));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  private get grants(): Record<string, PluginGrant> {
    const stamp = this.grantsStamp();
    if (this.grantsCache?.stamp === stamp) return this.grantsCache.value;
    let value: Record<string, PluginGrant> = {};
    try {
      const parsed = grantsFileSchema.safeParse(
        JSON.parse(readFileSync(path.join(this.dir, GRANTS_FILE), "utf8")),
      );
      if (parsed.success) value = parsed.data;
    } catch {
      // 没有或读不懂：当作什么都没批准（宁可停用，也不按猜的放行）
    }
    this.grantsCache = { stamp, value };
    return value;
  }

  private async writeGrants(): Promise<void> {
    const value = this.grants;
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, GRANTS_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
    this.grantsCache = { stamp: this.grantsStamp(), value };
  }

  /** 每次现扫目录：插件不多，装上、删掉、改清单都不用重启 */
  private scan(): Loaded[] {
    if (!existsSync(this.dir)) return [];
    const result: Loaded[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(this.dir, entry.name);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path.join(dir, PLUGIN_MANIFEST_FILE), "utf8"));
      } catch {
        result.push({ id: entry.name, dir, problem: `缺少或无法解析 ${PLUGIN_MANIFEST_FILE}` });
        continue;
      }
      const parsed = pluginManifestSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        result.push({
          id: entry.name,
          dir,
          problem: `清单不合法：${issue?.path.join(".") || "(根)"} ${issue?.message ?? ""}`.trim(),
        });
        continue;
      }
      if (parsed.data.id !== entry.name) {
        result.push({ id: entry.name, dir, problem: `清单 id ${parsed.data.id} 和目录名不一致` });
        continue;
      }
      if (!satisfiesEngine(this.hostVersion, parsed.data.engines.superhive)) {
        result.push({
          id: entry.name,
          dir,
          problem: `要求 SuperHive ${parsed.data.engines.superhive}，当前是 ${this.hostVersion}`,
        });
        continue;
      }
      result.push({ id: entry.name, dir, manifest: parsed.data });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  private describe(item: Loaded): LocalPlugin {
    const grant = this.grants[item.id];
    if (!item.manifest)
      return {
        id: item.id,
        dir: item.dir,
        requested: [],
        mcpServers: [],
        ...(grant ? { grant } : {}),
        state: "invalid",
        problem: item.problem,
      };
    const { manifest } = item;
    // 升级后多申请了权限：整体停用，等房主重新批准；没多申请的小版本升级照常可用
    const covered = Boolean(
      grant && manifest.permissions.every((permission) => grant.permissions.includes(permission)),
    );
    const mcpServers: LocalPluginMcp[] = manifest.contributes.mcpServers.map((server) => {
      const approved = grant?.mcp?.[server.name];
      if (!approved) return { ...server, providers: [], state: "pending" };
      let same = false;
      try {
        const resolved = resolvePluginMcpCommand(item.dir, server);
        same =
          resolved.command === approved.command &&
          JSON.stringify(resolved.args) === JSON.stringify(approved.args);
      } catch {
        same = false;
      }
      return { ...server, providers: approved.providers, state: same ? "confirmed" : "changed" };
    });
    return {
      id: item.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      ...(manifest.author ? { author: manifest.author } : {}),
      dir: item.dir,
      requested: manifest.permissions,
      guests: manifest.guests,
      panels: manifest.contributes.panels,
      commands: manifest.contributes.commands,
      mcpServers,
      ...(grant ? { grant } : {}),
      state: covered ? "enabled" : "needs-approval",
    };
  }

  list(): LocalPlugin[] {
    return this.scan().map((item) => this.describe(item));
  }

  private enabledManifest(id: string): { manifest: PluginManifest; dir: string } | undefined {
    const item = this.scan().find((candidate) => candidate.id === id);
    if (!item?.manifest || this.describe(item).state !== "enabled") return undefined;
    return { manifest: item.manifest, dir: item.dir };
  }

  /** 当前查看者能用的插件；访客只看到清单写了 guests: true 的 */
  enabled(viewer: "owner" | "guest"): PluginSummary[] {
    const result: PluginSummary[] = [];
    for (const item of this.scan()) {
      if (!item.manifest || this.describe(item).state !== "enabled") continue;
      if (viewer === "guest" && !item.manifest.guests) continue;
      result.push({
        id: item.id,
        name: item.manifest.name,
        version: item.manifest.version,
        description: item.manifest.description,
        // 只给批准过的（等于清单申请的，见 describe）
        permissions: this.grants[item.id]!.permissions.filter((permission) =>
          item.manifest.permissions.includes(permission),
        ),
        panels: item.manifest.contributes.panels,
        commands: item.manifest.contributes.commands,
      });
    }
    return result;
  }

  /** 按清单当前申请的权限批准；返回批准后的状态 */
  async grant(id: string, now = new Date()): Promise<LocalPlugin | undefined> {
    const item = this.scan().find((candidate) => candidate.id === id);
    if (!item?.manifest) return item ? this.describe(item) : undefined;
    const previous = this.grants[id];
    this.grants[id] = {
      permissions: [...item.manifest.permissions],
      version: item.manifest.version,
      grantedAt: now.toISOString(),
      ...(previous?.mcp ? { mcp: previous.mcp } : {}),
    };
    await this.writeGrants();
    this.onChange?.();
    return this.describe(item);
  }

  /** 撤销：面板、命令立即失效，写进运行时的 MCP 一并删掉 */
  async revoke(id: string): Promise<boolean> {
    const grant = this.grants[id];
    if (!grant) return false;
    for (const approved of Object.values(grant.mcp ?? {}))
      for (const provider of approved.providers) this.removeEntry(provider, approved.entry);
    delete this.grants[id];
    await this.writeGrants();
    this.onChange?.();
    return true;
  }

  private removeEntry(provider: PluginMcpProvider, entry: string) {
    try {
      this.mcpWriter?.remove(provider, entry);
    } catch {
      // 房主已经手动删掉、或配置文件读不懂：撤销照样完成，不留着批准记录
    }
  }

  /**
   * 房主确认一个 MCP 写进哪些运行时；providers 为空等于不再给任何运行时用。
   * 要先批准插件本身；命令按插件目录解析成绝对路径再写，之后清单改了命令要重新确认。
   */
  async setMcp(
    id: string,
    name: string,
    providers: PluginMcpProvider[],
    now = new Date(),
  ): Promise<LocalPlugin> {
    const item = this.scan().find((candidate) => candidate.id === id);
    if (!item) throw new PluginError("PLUGIN_NOT_FOUND", id);
    if (!item.manifest) throw new PluginError("PLUGIN_INVALID", item.problem);
    const grant = this.grants[id];
    if (!grant || this.describe(item).state !== "enabled")
      throw new PluginError("PLUGIN_NOT_APPROVED", "先批准插件，再确认它的 MCP");
    const server = item.manifest.contributes.mcpServers.find((entry) => entry.name === name);
    if (!server) throw new PluginError("PLUGIN_MCP_NOT_FOUND", name);
    const writer = this.mcpWriter;
    if (!writer && providers.length)
      throw new PluginError("PLUGIN_MCP_UNAVAILABLE", "这台 Server 没有管理本机运行时配置");
    const wanted = [...new Set(providers)].filter((provider) =>
      (pluginMcpProviders as readonly string[]).includes(provider),
    );
    const resolved = resolvePluginMcpCommand(item.dir, server);
    const entry = pluginMcpEntryName(id, name);
    const previous = grant.mcp?.[name];
    // 先写新的，全部成功后再删不要的；中途失败把这次写进去的撤回，批准记录不变
    const written: PluginMcpProvider[] = [];
    try {
      for (const provider of wanted) {
        writer!.put(provider, entry, resolved);
        written.push(provider);
      }
    } catch (error) {
      for (const provider of written)
        if (!previous?.providers.includes(provider)) this.removeEntry(provider, entry);
      throw new PluginError(
        "PLUGIN_MCP_WRITE_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const provider of previous?.providers ?? [])
      if (!wanted.includes(provider)) this.removeEntry(provider, previous!.entry);
    const mcp = { ...grant.mcp };
    if (wanted.length)
      mcp[name] = { providers: wanted, ...resolved, entry, grantedAt: now.toISOString() };
    else delete mcp[name];
    this.grants[id] = { ...grant, ...(Object.keys(mcp).length ? { mcp } : {}) };
    if (!Object.keys(mcp).length) delete this.grants[id]!.mcp;
    await this.writeGrants();
    this.onChange?.();
    return this.describe(item);
  }

  /**
   * 面板静态文件的真实路径；插件没启用、扩展名不在表里、跳出插件目录（含软链）时返回 undefined。
   * 每次都重新核对启用状态，撤销后已打开的面板再取文件也会失败。
   */
  asset(id: string, relative: string): { file: string; type: string } | undefined {
    const plugin = this.enabledManifest(id);
    if (!plugin) return undefined;
    const type = ASSET_TYPES[path.extname(relative).toLowerCase()];
    if (!type || relative.includes("\0")) return undefined;
    const root = realpathSync(plugin.dir);
    const candidate = path.resolve(root, relative);
    if (!existsSync(candidate)) return undefined;
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(root + path.sep)) return undefined;
    if (!statSync(real).isFile()) return undefined;
    return { file: real, type };
  }

  panelEntry(id: string, panelId: string): string | undefined {
    return this.enabledManifest(id)?.manifest.contributes.panels.find(
      (panel) => panel.id === panelId,
    )?.entry;
  }
}

/** 插件面板的响应头：无同源沙箱、不能联网、不能被别的页面嵌入 */
export function pluginFrameCsp(ancestor?: string): string {
  return [
    // 不给 allow-same-origin：面板是不透明源，读不到网页的 localStorage、Cookie，也不能带凭证调 API
    "sandbox allow-scripts allow-forms",
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // 第一阶段不开放联网；要联网的插件等第二阶段的 network 权限（按域名放行）
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors 'self'${ancestor ? ` ${ancestor}` : ""}`,
  ].join("; ");
}

const FRAME_TTL_MS = 60 * 60_000;

const PLUGIN_ERROR_STATUS: Record<PluginError["code"], number> = {
  PLUGIN_NOT_FOUND: 404,
  PLUGIN_MCP_NOT_FOUND: 404,
  PLUGIN_INVALID: 409,
  PLUGIN_NOT_APPROVED: 409,
  PLUGIN_MCP_UNAVAILABLE: 409,
  PLUGIN_MCP_WRITE_FAILED: 500,
};

const setMcpBodySchema = z.object({
  providers: z.array(z.enum(pluginMcpProviders)).max(pluginMcpProviders.length),
});

/** 本机房主管理插件：列出、批准、撤销、逐个确认 MCP */
export function registerPluginLocalRoutes(
  app: FastifyInstance,
  options: {
    registry: PluginRegistry;
    authorizeLocal: (request: FastifyRequest, reply: FastifyReply) => boolean;
    audit?: (action: "grant" | "revoke" | "mcp", id: string, detail: string[]) => void;
  },
): void {
  const { registry, authorizeLocal } = options;
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof PluginError)
      return reply
        .code(PLUGIN_ERROR_STATUS[error.code])
        .send({ code: error.code, message: error.message });
    throw error;
  };
  app.get("/api/local/plugins", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    return reply.header("Cache-Control", "no-store").send({
      dir: registry.dir,
      mcpProviders: registry.canWriteMcp ? pluginMcpProviders : [],
      plugins: registry.list(),
    });
  });
  app.post<{ Params: { id: string } }>("/api/local/plugins/:id/grant", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    const plugin = await registry.grant(request.params.id);
    if (!plugin) return reply.code(404).send({ code: "PLUGIN_NOT_FOUND" });
    if (plugin.state === "invalid")
      return reply.code(409).send({ code: "PLUGIN_INVALID", message: plugin.problem });
    options.audit?.("grant", plugin.id, plugin.grant?.permissions ?? []);
    return { plugin };
  });
  app.delete<{ Params: { id: string } }>("/api/local/plugins/:id/grant", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    const revoked = await registry.revoke(request.params.id);
    if (revoked) options.audit?.("revoke", request.params.id, []);
    return { revoked };
  });
  app.put<{ Params: { id: string; name: string } }>(
    "/api/local/plugins/:id/mcp/:name",
    async (request, reply) => {
      if (!authorizeLocal(request, reply)) return reply;
      const body = setMcpBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST" });
      try {
        const plugin = await registry.setMcp(
          request.params.id,
          request.params.name,
          body.data.providers,
        );
        options.audit?.("mcp", request.params.id, [request.params.name, ...body.data.providers]);
        return { plugin };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}

/** 房间里用插件：列出能用的、申请面板地址、取面板文件 */
export function registerPluginRoomRoutes(
  app: FastifyInstance,
  options: {
    registry: PluginRegistry;
    /** 能进这个房间时返回查看者身份；不能时已发出响应 */
    authorizeRoom: (
      request: FastifyRequest,
      reply: FastifyReply,
      roomId: string,
    ) => "owner" | "guest" | undefined;
    frameAncestorOf: (origin: string | undefined) => string | undefined;
    now?: () => number;
  },
): void {
  const { registry } = options;
  const clock = options.now ?? Date.now;
  const frames = new Map<
    string,
    { pluginId: string; viewer: "owner" | "guest"; expiresAt: number; ancestor?: string }
  >();

  app.get<{ Params: { roomId: string } }>("/api/rooms/:roomId/plugins", async (request, reply) => {
    const viewer = options.authorizeRoom(request, reply, request.params.roomId);
    if (!viewer) return reply;
    return reply.header("Cache-Control", "no-store").send({ plugins: registry.enabled(viewer) });
  });

  // iframe 带不了 Authorization 头：先凭登录换一个限时前缀，面板及其相对路径的资源都挂在前缀下
  app.post<{ Params: { roomId: string; id: string; panel: string } }>(
    "/api/rooms/:roomId/plugins/:id/panels/:panel/frame",
    async (request, reply) => {
      const viewer = options.authorizeRoom(request, reply, request.params.roomId);
      if (!viewer) return reply;
      const visible = registry.enabled(viewer).some((plugin) => plugin.id === request.params.id);
      const entry = visible
        ? registry.panelEntry(request.params.id, request.params.panel)
        : undefined;
      if (!entry) return reply.code(404).send({ code: "PLUGIN_NOT_FOUND" });
      const now = clock();
      for (const [key, frame] of frames) if (frame.expiresAt <= now) frames.delete(key);
      const token = randomBytes(24).toString("base64url");
      const ancestor = options.frameAncestorOf(request.headers.origin);
      frames.set(token, {
        pluginId: request.params.id,
        viewer,
        expiresAt: now + FRAME_TTL_MS,
        ...(ancestor ? { ancestor } : {}),
      });
      return reply
        .header("Cache-Control", "no-store")
        .send({ url: `/api/plugin-frames/${token}/${entry}` });
    },
  );

  app.get<{ Params: { token: string; "*": string } }>(
    "/api/plugin-frames/:token/*",
    async (request, reply) => {
      const frame = frames.get(request.params.token);
      const notFound = () =>
        reply
          .code(404)
          .header("Content-Type", "text/plain; charset=utf-8")
          .header("Content-Security-Policy", "default-src 'none'; sandbox")
          .send("not found");
      if (!frame || frame.expiresAt <= clock()) return notFound();
      // 撤销批准、访客失去可见性后，已发出的前缀也取不到文件
      if (!registry.enabled(frame.viewer).some((plugin) => plugin.id === frame.pluginId))
        return notFound();
      const asset = registry.asset(frame.pluginId, request.params["*"]);
      if (!asset) return notFound();
      return (
        reply
          .header("Content-Type", asset.type)
          .header("X-Content-Type-Options", "nosniff")
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          // 面板是不透明源，它加载自己的脚本、样式也算跨源；same-origin 会把它们全拦掉。
          // 能不能取由一次性前缀把关，不靠这个头
          .header("Cross-Origin-Resource-Policy", "cross-origin")
          .header("Content-Security-Policy", pluginFrameCsp(frame.ancestor))
          .send(createReadStream(asset.file))
      );
    },
  );
}
