/**
 * 带到别人房间的 Agent（设置 → 这台电脑 → 带到别处的 Agent）：列出、带进去、离线、重新上线、移除。
 * 清单和 CLI 的 hive agents / hive leave 是同一份（~/.superhive/remote-joins，见 remote-joins.ts）。
 * 带进去由本机 CLI 的 `hive join … --background` 完成，Server 只负责拉起它并读清单。
 */
import { execFile } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createRemoteJoinRequestSchema,
  serverText,
  type RemoteJoin,
  type RemoteJoinListResponse,
  type RemoteJoinRemoveResponse,
  type RemoteJoinResponse,
} from "@superhive/protocol";
import { errorText } from "./texts.js";
import {
  forgetRemoteJoin,
  leaveRemoteRoom,
  listRemoteJoins,
  readRecord,
  readToken,
  recordRunning,
  remoteJoinId,
  remoteJoinsDir,
  restartRemoteJoin,
  stopRemoteJoin,
  viewOf,
  waitForOnline,
} from "./remote-joins.js";
import type { LocalAgentSupervisor } from "./local-agents.js";

type Caller = { kind: "local" } | { kind: "device"; id: string; name: string };

export type RunJoinCli = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ ok: true } | { ok: false; message: string }>;

const defaultRunJoinCli: RunJoinCli = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { env, timeout: 75_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ ok: true });
        // CLI 的错误以「[hive] 」开头写在标准错误里；取最后几行给人看
        const text = String(stderr || error.message)
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-6)
          .join("\n")
          .replace(/^\[hive\]\s*/, "");
        resolve({ ok: false, message: text || error.message });
      },
    );
  });

export function registerRemoteJoinRoutes(
  app: FastifyInstance,
  options: {
    supervisor: LocalAgentSupervisor;
    authorize: (
      request: FastifyRequest,
      reply: FastifyReply,
      level: "read" | "manage",
    ) => Caller | undefined;
    dir?: string;
    runJoinCli?: RunJoinCli;
  },
): void {
  const dir = options.dir ?? remoteJoinsDir();
  const runJoinCli = options.runJoinCli ?? defaultRunJoinCli;
  const { supervisor, authorize } = options;

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({
      ...errorText(serverText("error.remoteJoin.notFound")),
      code: "REMOTE_JOIN_NOT_FOUND",
    });

  function view(id: string): RemoteJoin | undefined {
    const record = readRecord(dir, id);
    return record ? viewOf(record) : undefined;
  }

  app.get(
    "/api/local/remote-joins",
    async (request, reply): Promise<RemoteJoinListResponse | FastifyReply> => {
      if (!authorize(request, reply, "read")) return reply;
      return { joins: listRemoteJoins(dir) };
    },
  );

  app.post("/api/local/remote-joins", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const parsed = createRemoteJoinRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    const body = parsed.data;
    const base = body.agentId ? supervisor.configOf(body.agentId) : undefined;
    if (body.agentId && !base) {
      return reply.code(404).send({
        ...errorText(serverText("error.localAgent.notFound")),
        code: "LOCAL_AGENT_NOT_FOUND",
      });
    }
    const runtime = body.runtime ?? base!.provider;
    const access = body.access ?? base?.access ?? "read-only";
    const cwd = body.cwd ?? base?.cwd ?? undefined;
    const model = body.model ?? base?.model ?? undefined;
    if (access !== "read-only" && !cwd) {
      return reply.code(400).send({
        ...errorText(serverText("error.remoteJoin.cwdRequired")),
        code: "REMOTE_JOIN_CWD_REQUIRED",
      });
    }
    // 完全访问等于把这台电脑交给对方房间里的人：只能在这台电脑上点
    if (access === "full" && caller.kind !== "local") {
      return reply
        .code(403)
        .send({ ...errorText(serverText("error.remoteJoin.fullLocalOnly")), code: "LOCAL_ONLY" });
    }
    const server = body.server.replace(/\/+$/, "");
    const id = remoteJoinId(server, body.roomId ?? null, body.name);
    const existing = readRecord(dir, id);
    if (existing && recordRunning(existing)) {
      return reply.code(409).send({
        ...errorText(serverText("error.remoteJoin.running", { name: body.name })),
        code: "REMOTE_JOIN_RUNNING",
      });
    }
    const launcher = supervisor.remoteJoinLauncher();
    const result = await runJoinCli(
      launcher.command,
      [
        ...launcher.args,
        "join",
        `--server=${server}`,
        `--name=${body.name}`,
        `--provider=${runtime}`,
        `--access=${access}`,
        ...(body.roomId ? [`--room=${body.roomId}`] : []),
        ...(cwd ? [`--cwd=${cwd}`] : []),
        ...(model ? [`--model=${model}`] : []),
        "--background",
      ],
      // token 走环境变量：命令行参数会被同机其他用户通过 ps 看到
      { ...launcher.env, HIVE_AGENT_TOKEN: body.token, HIVE_REMOTE_JOINS_DIR: dir },
    );
    const join = view(id);
    if (!result.ok || !join) {
      return reply.code(502).send({
        ...errorText(
          serverText("error.remoteJoin.failed", {
            reason: result.ok ? "后台进程没有登记" : result.message,
          }),
        ),
        code: "REMOTE_JOIN_FAILED",
      });
    }
    request.log.info(
      { remoteJoin: { id, server, roomId: body.roomId ?? null, name: body.name } },
      "remote join",
    );
    return reply.code(201).send({ join } satisfies RemoteJoinResponse);
  });

  app.post<{ Params: { id: string } }>(
    "/api/local/remote-joins/:id/stop",
    async (request, reply) => {
      if (!authorize(request, reply, "manage")) return reply;
      if (!/^[0-9a-f]{16}$/.test(request.params.id) || !readRecord(dir, request.params.id))
        return notFound(reply);
      await stopRemoteJoin(dir, request.params.id);
      return { join: view(request.params.id)! } satisfies RemoteJoinResponse;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/local/remote-joins/:id/start",
    async (request, reply) => {
      const caller = authorize(request, reply, "manage");
      if (!caller) return reply;
      const id = request.params.id;
      const record = /^[0-9a-f]{16}$/.test(id) ? readRecord(dir, id) : undefined;
      if (!record) return notFound(reply);
      if (record.access === "full" && caller.kind !== "local") {
        return reply
          .code(403)
          .send({ ...errorText(serverText("error.remoteJoin.fullLocalOnly")), code: "LOCAL_ONLY" });
      }
      if (recordRunning(record)) return { join: viewOf(record) } satisfies RemoteJoinResponse;
      try {
        const pid = await restartRemoteJoin(dir, id, supervisor.remoteJoinLauncher().env);
        const outcome = await waitForOnline(dir, id, pid, 20_000);
        if (outcome === "exited")
          throw new Error(readRecord(dir, id)?.lastError ?? "进程启动后退出了");
      } catch (error) {
        return reply.code(502).send({
          ...errorText(
            serverText("error.remoteJoin.restartFailed", {
              reason: error instanceof Error ? error.message : String(error),
            }),
          ),
          code: "REMOTE_JOIN_FAILED",
        });
      }
      return { join: view(id)! } satisfies RemoteJoinResponse;
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { leave?: string } }>(
    "/api/local/remote-joins/:id",
    async (request, reply) => {
      if (!authorize(request, reply, "manage")) return reply;
      const id = request.params.id;
      const record = /^[0-9a-f]{16}$/.test(id) ? readRecord(dir, id) : undefined;
      if (!record) return notFound(reply);
      await stopRemoteJoin(dir, id);
      const leave = request.query.leave === "1" || request.query.leave === "true";
      let response: RemoteJoinRemoveResponse = { removed: true, left: false };
      if (leave) {
        const token = readToken(dir, id);
        const result = token
          ? await leaveRemoteRoom(record.server, token)
          : ({ left: false, error: "没有记下这个 Agent 的 token" } as const);
        response = result.left
          ? { removed: true, left: true }
          : { removed: true, left: false, leaveError: result.error };
      }
      forgetRemoteJoin(dir, id);
      return response;
    },
  );
}
