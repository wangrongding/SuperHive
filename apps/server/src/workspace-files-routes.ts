import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { userFsPromises } from "./user-fs.js";
import path from "node:path";
import {
  serverText,
  workspaceDiffModeSchema,
  workspaceRelativePathSchema,
  workspaceSourceSchema,
  type ManagedWorktree,
  type RoomSummary,
  type ServerTextKey,
  type WorkspaceOverview,
  type WorkspaceSourceInfo,
} from "@superhive/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { HiveError } from "./database.js";
import {
  WorkspaceView,
  inlineMediaType,
  isBlobRef,
  isSensitivePath,
  normalizeRelative,
} from "./workspace-files.js";
import { slowOps } from "./slow-ops.js";
import { errorText } from "./texts.js";

const { realpath } = userFsPromises;

/**
 * 房间工作区只读浏览的接口（GET /api/rooms/:roomId/workspace/...）。
 *
 * 谁能看：房主（总令牌、房主设备）；访客要房主在房间设置里打开「允许访客查看工作区文件」，由这里校验。
 * 疑似密钥文件的内容只给房主，且要带 reveal=1。响应一律 no-store；审计只记谁看了哪个路径，不记内容。
 */

/** 查看者；id 是能撤销的凭证（访客会话、房主设备），签发的临时链接用它复核还有效 */
export type WorkspaceViewer = { kind: "admin" | "guest"; who: string; id?: string };

/** 临时链接的有效期：够打开和拖动一段视频，过期后网页重新签一个 */
export const RAW_URL_TTL_MS = 10 * 60 * 1000;
/** 超过这么大的文件不在页面里显示，只给下载 */
export const RAW_INLINE_LIMIT = 200 * 1024 * 1024;

/** 临时链接里签进去的内容：哪个房间、哪份代码、哪个文件的哪个版本、谁、能不能看密钥文件、何时过期 */
type RawGrant = {
  room: string;
  source: string;
  path: string;
  ref: string;
  viewer: WorkspaceViewer;
  reveal: boolean;
  download: boolean;
  expires: number;
};

const ERRORS: Record<string, { status: number; key: ServerTextKey }> = {
  WORKSPACE_PATH_INVALID: { status: 400, key: "error.workspaceFiles.pathInvalid" },
  WORKSPACE_PATH_OUTSIDE: { status: 403, key: "error.workspaceFiles.pathOutside" },
  WORKSPACE_PATH_NOT_FOUND: { status: 404, key: "error.workspaceFiles.notFound" },
  WORKSPACE_NOT_FILE: { status: 400, key: "error.workspaceFiles.notFound" },
  WORKSPACE_NOT_DIRECTORY: { status: 400, key: "error.workspaceFiles.notFound" },
  WORKSPACE_NOT_GIT: { status: 409, key: "error.workspaceFiles.notGit" },
  WORKSPACE_REF_INVALID: { status: 400, key: "error.workspaceFiles.refNotFound" },
  WORKSPACE_REF_NOT_FOUND: { status: 404, key: "error.workspaceFiles.refNotFound" },
  WORKSPACE_TOO_LARGE: { status: 413, key: "error.workspaceFiles.tooLarge" },
  WORKSPACE_GIT_TIMEOUT: { status: 504, key: "error.workspaceFiles.timeout" },
  WORKSPACE_REVEAL_FORBIDDEN: { status: 403, key: "error.workspaceFiles.revealOwnerOnly" },
  WORKSPACE_SENSITIVE: { status: 403, key: "error.workspaceFiles.revealRequired" },
};

const sourceQuery = z.object({ source: workspaceSourceSchema.default("workspace") });
const flag = z
  .enum(["0", "1", "true", "false"])
  .optional()
  .transform((value) => value === "1" || value === "true");

const querySchemas = {
  status: sourceQuery,
  log: sourceQuery.extend({ skip: z.coerce.number().int().min(0).max(100_000).default(0) }),
  commit: sourceQuery.extend({ commit: z.string().min(4).max(64) }),
  compare: sourceQuery.extend({ base: z.string().min(1).max(200).optional() }),
  diff: sourceQuery.extend({
    path: workspaceRelativePathSchema.pipe(z.string().min(1)),
    oldPath: workspaceRelativePathSchema.optional(),
    mode: workspaceDiffModeSchema,
    commit: z.string().min(4).max(64).optional(),
    base: z.string().min(1).max(200).optional(),
    reveal: flag,
    full: flag,
  }),
  tree: sourceQuery.extend({ path: workspaceRelativePathSchema.default(""), ignored: flag }),
  file: sourceQuery.extend({
    path: workspaceRelativePathSchema.pipe(z.string().min(1)),
    reveal: flag,
  }),
  search: sourceQuery.extend({ q: z.string().max(200).default("") }),
  refs: sourceQuery.extend({ q: z.string().max(4000).default("") }),
  "raw-url": sourceQuery.extend({
    path: workspaceRelativePathSchema.pipe(z.string().min(1)),
    ref: z.string().max(210).default("worktree").refine(isBlobRef),
    reveal: flag,
    download: flag,
  }),
};

export function registerWorkspaceFileRoutes(
  app: FastifyInstance,
  options: {
    room: (roomId: string) => RoomSummary | undefined;
    /** 通过返回查看者；不通过时已经回复了错误（401/403） */
    authorize: (
      request: FastifyRequest,
      reply: FastifyReply,
      roomId: string,
    ) => WorkspaceViewer | undefined;
    /** 这个房间登记的 worktree */
    worktrees: (roomId: string) => ManagedWorktree[];
    /** 工作区仓库的默认分支（worktree 默认的 base）；不是仓库或找不到时 undefined */
    defaultBranch: (workspace: string) => Promise<string | undefined>;
    /** 签发过的临时链接被使用时复核：访客会话、房主设备是否仍有效 */
    viewerActive: (viewer: WorkspaceViewer) => boolean;
    /** 这个房间里已合入的 worktree（按 worktree 管理那套判断，含 squash 合入） */
    mergedWorktrees: (roomId: string) => Promise<Set<string>>;
    now?: () => number;
  },
): void {
  const now = options.now ?? Date.now;
  // 每次启动换一把钥匙：重启后旧链接全部失效
  const secret = randomBytes(32);
  const sign = (payload: string) =>
    createHmac("sha256", secret).update(payload).digest("base64url");
  const issue = (grant: RawGrant) => {
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };
  const verify = (token: string): RawGrant | undefined => {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return undefined;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    try {
      const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RawGrant;
      return grant.expires > now() ? grant : undefined;
    } catch {
      return undefined;
    }
  };
  const send = (reply: FastifyReply, status: number, key: ServerTextKey, params = {}) =>
    reply
      .code(status)
      .header("Cache-Control", "no-store")
      .send({ ...errorText(serverText(key, params)), code: key });

  /** 解析成一个只读视图；不能看时已经回复。given 是临时链接里签好的查看者（不再看请求头） */
  async function viewFor(
    request: FastifyRequest<{ Params: { roomId: string } }>,
    reply: FastifyReply,
    source: string,
    given?: WorkspaceViewer,
  ): Promise<
    { view: WorkspaceView; viewer: WorkspaceViewer; record?: ManagedWorktree } | undefined
  > {
    const roomId = request.params.roomId;
    const viewer = given ?? options.authorize(request, reply, roomId);
    if (!viewer) return undefined;
    const room = options.room(roomId);
    if (!room) return void send(reply, 404, "error.room.notFound");
    if (viewer.kind === "guest" && !room.workspaceFilesGuests)
      return void send(reply, 403, "error.workspaceFiles.guestsDisabled");
    if (!room.workspace) return void send(reply, 404, "error.workspaceFiles.notConfigured");
    let root: string;
    let record: ManagedWorktree | undefined;
    if (source === "workspace") root = room.workspace;
    else {
      record = options.worktrees(roomId).find((item) => item.id === source);
      if (!record) return void send(reply, 404, "error.workspaceFiles.sourceNotFound");
      root = record.path;
    }
    try {
      root = await realpath(root);
    } catch {
      return void send(
        reply,
        404,
        record ? "error.workspaceFiles.sourceNotFound" : "error.workspaceFiles.missing",
      );
    }
    return { view: new WorkspaceView(root), viewer, ...(record ? { record } : {}) };
  }

  function failed(reply: FastifyReply, error: unknown) {
    if (error instanceof HiveError) {
      const mapped = ERRORS[error.code];
      if (mapped) return send(reply, mapped.status, mapped.key);
      if (error.code === "WORKSPACE_GIT_FAILED")
        return send(reply, 500, "error.workspaceFiles.failed", { reason: error.message });
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return send(reply, 404, "error.workspaceFiles.notFound");
    if (code === "EACCES" || code === "EPERM")
      return send(reply, 403, "error.workspaceFiles.missing");
    throw error;
  }

  function audit(
    request: FastifyRequest<{ Params: { roomId: string } }>,
    viewer: WorkspaceViewer,
    action: "file" | "diff" | "raw",
    detail: { source: string; path: string; ref?: string; revealed?: boolean },
  ) {
    request.log.info(
      { workspaceFiles: { room: request.params.roomId, by: viewer.who, action, ...detail } },
      "workspace file viewed",
    );
  }

  function route<K extends keyof typeof querySchemas>(
    name: K,
    handler: (input: {
      request: FastifyRequest<{ Params: { roomId: string } }>;
      query: z.infer<(typeof querySchemas)[K]>;
      view: WorkspaceView;
      viewer: WorkspaceViewer;
      record?: ManagedWorktree;
    }) => Promise<unknown>,
  ) {
    app.get<{ Params: { roomId: string } }>(
      `/api/rooms/:roomId/workspace/${name}`,
      async (request, reply) => {
        const parsed = querySchemas[name].safeParse(request.query);
        if (!parsed.success) return send(reply, 400, "error.request.invalid");
        const query = parsed.data as z.infer<(typeof querySchemas)[K]>;
        const resolved = await viewFor(request, reply, query.source);
        if (!resolved) return reply;
        try {
          const body = await handler({ request, query, ...resolved });
          return reply.header("Cache-Control", "no-store").send(body);
        } catch (error) {
          return failed(reply, error);
        }
      },
    );
  }

  /** 总览：工作区名、是否 git、可切换的来源（工作区 + 这个房间的 worktree）、未提交改动数 */
  app.get<{ Params: { roomId: string }; Querystring: { detail?: string } }>(
    "/api/rooms/:roomId/workspace",
    async (request, reply) => {
      const roomId = request.params.roomId;
      const viewer = options.authorize(request, reply, roomId);
      if (!viewer) return reply;
      const room = options.room(roomId);
      if (!room) return send(reply, 404, "error.room.notFound");
      const detail = request.query.detail === "1";
      const guestsAllowed = Boolean(room.workspaceFilesGuests);
      if (viewer.kind === "guest" && !guestsAllowed)
        return send(reply, 403, "error.workspaceFiles.guestsDisabled");
      const base: WorkspaceOverview = {
        configured: Boolean(room.workspace),
        git: false,
        sources: [],
        guestsAllowed,
        canReveal: viewer.kind === "admin",
      };
      if (!room.workspace) return reply.header("Cache-Control", "no-store").send(base);
      let root: string;
      try {
        root = await realpath(room.workspace);
      } catch {
        return send(reply, 404, "error.workspaceFiles.missing");
      }
      const view = new WorkspaceView(root);
      const name = path.basename(root);
      const sources: WorkspaceSourceInfo[] = [{ id: "workspace", kind: "workspace", label: name }];
      const overview: WorkspaceOverview = { ...base, name, sources };
      try {
        const status = await view.status({ counts: false });
        if (status.git) {
          overview.git = true;
          if (status.branch) sources[0]!.branch = status.branch;
          // 工作区不在默认分支上时，可以看它相对默认分支的改动
          const defaultBranch = await options.defaultBranch(root);
          if (defaultBranch && !status.detached && status.branch !== defaultBranch)
            sources[0]!.base = defaultBranch;
          overview.changeCount = new Set(status.changes.map((item) => item.path)).size;
          for (const record of options.worktrees(roomId)) {
            const missing = await realpath(record.path).then(
              () => false,
              () => true,
            );
            sources.push({
              id: record.id,
              kind: "worktree",
              label: record.branch,
              branch: record.branch,
              agentName: record.agentName,
              base: record.base,
              ...(missing ? { missing } : {}),
            });
          }
          // 面板打开时要挑默认显示哪份代码：补上每份的改动数、领先提交数、最近改动时间、是否已合入
          if (detail)
            await slowOps.track("workspace.overviewDetail", { repo: root, roomId }, async () => {
              const merged = await options.mergedWorktrees(roomId).catch(() => new Set<string>());
              await Promise.all(
                sources.map(async (source) => {
                  if (source.missing) return;
                  const record =
                    source.kind === "worktree"
                      ? options.worktrees(roomId).find((item) => item.id === source.id)
                      : undefined;
                  const sourceRoot = record ? await realpath(record.path) : root;
                  const activity = await slowOps
                    .track("workspace.activity", { repo: sourceRoot }, () =>
                      new WorkspaceView(sourceRoot).activity(record ? record.base : source.base),
                    )
                    .catch(() => undefined);
                  if (activity) Object.assign(source, activity);
                  if (
                    record &&
                    // 还有未提交改动的不算已合入（刚分出来、正在改的任务线 HEAD 也在目标分支里）
                    !activity?.changeCount &&
                    (merged.has(record.id) || !activity?.ahead)
                  )
                    source.merged = true;
                }),
              );
            });
        }
      } catch (error) {
        request.log.warn({ err: error }, "workspace overview failed");
      }
      return reply.header("Cache-Control", "no-store").send(overview);
    },
  );

  route("status", ({ view }) => view.status());

  route("log", async ({ view, query }) => ({ commits: await view.log({ skip: query.skip }) }));

  route("commit", ({ view, query }) => view.commit(query.commit));

  /** 相对 base 的改动：worktree 默认它登记的 base，工作区默认仓库的默认分支 */
  route("compare", async ({ view, query, record }) => {
    const base = query.base ?? record?.base ?? (await options.defaultBranch(view.root));
    if (!base) throw new HiveError("WORKSPACE_REF_NOT_FOUND", "No base");
    return view.compare(base);
  });

  route("diff", async ({ request, view, viewer, query, record }) => {
    if (query.reveal && viewer.kind !== "admin")
      throw new HiveError("WORKSPACE_REVEAL_FORBIDDEN", "Owner only");
    const base =
      query.mode === "base"
        ? (query.base ?? record?.base ?? (await options.defaultBranch(view.root)))
        : undefined;
    const diff = await view.diff({
      path: query.path,
      oldPath: query.oldPath,
      mode: query.mode,
      commit: query.commit,
      base,
      reveal: query.reveal,
      full: query.full,
    });
    audit(request, viewer, "diff", {
      source: query.source,
      path: diff.path,
      ...(diff.sensitive && query.reveal ? { revealed: true } : {}),
    });
    return diff;
  });

  route("tree", ({ view, query }) => view.tree(query.path, { ignored: query.ignored }));

  route("file", async ({ request, view, viewer, query }) => {
    if (query.reveal && viewer.kind !== "admin")
      throw new HiveError("WORKSPACE_REVEAL_FORBIDDEN", "Owner only");
    const file = await view.file(query.path, query.reveal);
    audit(request, viewer, "file", {
      source: query.source,
      path: file.path,
      ...(file.sensitive && query.reveal ? { revealed: true } : {}),
    });
    return file;
  });

  route("search", ({ view, query }) => view.search(query.q));

  /**
   * 聊天消息、白板里出现的提交号和分支名，哪些能在「代码」面板里打开：
   * 提交号必须是这个仓库里真实存在的提交（任务线和工作区共用同一份对象库，按工作区查就够）；
   * 分支名必须是这个房间登记的某条任务线，或工作区当前的分支。一次最多查 100 个。
   */
  route("refs", async ({ request, view }) => {
    const tokens = [...new Set(refTokensOf(request.query))].slice(0, 100);
    const commits = await view.resolveCommits(tokens);
    const branches: Record<string, string> = {};
    const records = options.worktrees(request.params.roomId);
    const current = (await view.status({ counts: false }).catch(() => undefined))?.branch;
    for (const token of tokens) {
      const record = records.find((item) => item.branch === token);
      if (record) branches[token] = record.id;
      else if (current && token === current) branches[token] = "workspace";
    }
    return { commits: Object.fromEntries(commits), branches };
  });

  /**
   * 原始字节的临时链接：<img>/<video>/<audio> 带不了请求头，又不能把房主令牌放进 URL，
   * 所以先用正常凭证换一个只对这一个文件的这一个版本有效、10 分钟过期、绑定查看者的签名链接。
   * 审计在签发时记一次（视频拖动会发很多个 Range 请求，不逐个记）。
   */
  route("raw-url", async ({ request, view, viewer, query }) => {
    if (query.reveal && viewer.kind !== "admin")
      throw new HiveError("WORKSPACE_REVEAL_FORBIDDEN", "Owner only");
    const relative = normalizeRelative(query.path);
    const sensitive = isSensitivePath(relative);
    if (sensitive && !query.reveal)
      throw new HiveError(
        viewer.kind === "admin" ? "WORKSPACE_SENSITIVE" : "WORKSPACE_REVEAL_FORBIDDEN",
        "Sensitive",
      );
    const blob = await view.blob(relative, query.ref);
    const type = inlineMediaType(relative);
    const inline = Boolean(type) && blob.size <= RAW_INLINE_LIMIT && !query.download;
    const expires = now() + RAW_URL_TTL_MS;
    const token = issue({
      room: request.params.roomId,
      source: query.source,
      path: relative,
      ref: query.ref,
      viewer,
      reveal: query.reveal,
      download: !inline,
      expires,
    });
    audit(request, viewer, "raw", {
      source: query.source,
      path: relative,
      ref: query.ref,
      ...(sensitive ? { revealed: true } : {}),
    });
    return {
      url: `/api/rooms/${encodeURIComponent(request.params.roomId)}/workspace/raw?t=${token}`,
      expiresAt: new Date(expires).toISOString(),
      size: blob.size,
      contentType: inline ? type : "application/octet-stream",
      inline,
    };
  });

  /** 用临时链接取原始字节：支持单段 Range；SVG 等一律在沙箱里、禁止嗅探 */
  app.get<{ Params: { roomId: string }; Querystring: { t?: string } }>(
    "/api/rooms/:roomId/workspace/raw",
    async (request, reply) => {
      const grant = typeof request.query.t === "string" ? verify(request.query.t) : undefined;
      if (!grant || grant.room !== request.params.roomId || !options.viewerActive(grant.viewer))
        return send(reply, 403, "error.workspaceFiles.linkExpired");
      const resolved = await viewFor(request, reply, grant.source, grant.viewer);
      if (!resolved) return reply;
      if (isSensitivePath(grant.path) && !(grant.reveal && grant.viewer.kind === "admin"))
        return send(reply, 403, "error.workspaceFiles.revealOwnerOnly");
      let blob: Awaited<ReturnType<WorkspaceView["blob"]>>;
      try {
        blob = await resolved.view.blob(grant.path, grant.ref);
      } catch (error) {
        return failed(reply, error);
      }
      const name = grant.path.slice(grant.path.lastIndexOf("/") + 1);
      const type = grant.download ? undefined : inlineMediaType(grant.path);
      void reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Accept-Ranges", "bytes")
        .header("Content-Type", type ?? "application/octet-stream")
        .header(
          "Content-Disposition",
          `${type ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
      // PDF 要用浏览器自带的查看器，沙箱会挡住它；其余（尤其 SVG）一律沙箱、不加载任何外部资源
      if (type !== "application/pdf")
        void reply.header(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        );
      const range = parseRange(request.headers.range, blob.size);
      if (range === "invalid") {
        return reply.code(416).header("Content-Range", `bytes */${blob.size}`).send();
      }
      if (blob.size === 0) return reply.header("Content-Length", "0").send(Buffer.alloc(0));
      const [start, end] = range ?? [0, blob.size - 1];
      void reply.header("Content-Length", String(end - start + 1));
      if (range) void reply.code(206).header("Content-Range", `bytes ${start}-${end}/${blob.size}`);
      return reply.send(blob.open(start, end));
    },
  );
}

function refTokensOf(query: unknown): string[] {
  const raw = (query as { q?: unknown } | undefined)?.q;
  return typeof raw === "string"
    ? raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item && item.length <= 200)
    : [];
}

/** 解析单段 Range（bytes=a-b、a-、-n）；多段或认不出的当没有；越界返回 invalid（416） */
export function parseRange(
  header: string | undefined,
  size: number,
): [number, number] | "invalid" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "invalid";
  return [start, end];
}
