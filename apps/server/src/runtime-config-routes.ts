import {
  addRuntimeMcpRequestSchema,
  putRuntimeMcpServerRequestSchema,
  runtimeInstallApplyRequestSchema,
  runtimeInstallRequestSchema,
  skillInstallApplyRequestSchema,
  skillInstallPreviewRequestSchema,
  type SkillInstallPreview,
  type SkillInstallResult,
  runtimeCredentialProviderSchema,
  serverText,
  syncRuntimeItemRequestSchema,
  toggleRuntimeSkillRequestSchema,
  type RuntimeInstallPlan,
  type RuntimeInstallRequest,
  type RuntimeInstallResult,
  type RuntimeOverview,
  type ServerText,
  zhText,
  updateRuntimeConfigFieldsRequestSchema,
  updateRuntimeConfigFileRequestSchema,
  type RuntimeCredentialProvider,
  createRuntimeProfileRequestSchema,
  importCcSwitchProvidersRequestSchema,
  switchRuntimeProfileRequestSchema,
  updateRuntimeProfileRequestSchema,
  verifyRuntimeMcpRequestSchema,
  type VerifyRuntimeMcpResult,
} from "@superhive/protocol";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HiveError } from "./database.js";
import type { LocalAgentSupervisor } from "./local-agents.js";
import { invalid, RuntimeConfigStore } from "./runtime-config.js";
import {
  McpHealthStore,
  mcpFingerprint,
  toHealth,
  type McpHealthPersistence,
} from "./mcp-health.js";
import type { RuntimeProfileStore } from "./runtime-profiles.js";
import {
  RUNTIME_CREDENTIAL_PROVIDERS,
  type RuntimeCredentialStore,
} from "./runtime-credentials.js";
import { catalogEntry, MCP_CATALOG, MCP_CATALOG_VERSION } from "./mcp-catalog.js";
import {
  checkRuntime,
  InstallPlans,
  resolveRecipe,
  stalePlan,
  unknownRecipe,
} from "./runtime-install.js";
import { RUNTIME_LABELS, RuntimeSkillStore } from "./runtime-skills.js";
import { SkillInstallPlans, SkillMarket } from "./skill-market.js";
import { errorText, hiveErrorBody } from "./texts.js";
import { openTerminal } from "./open-terminal.js";

/**
 * Agent CLI 配置面板的接口：只限本机房主（local 级，和运行时地址与密钥一样），
 * 房主的其他设备、Agent 的总令牌、别的电脑都拒绝。原始配置里有密钥，整份原文要单独确认后才取（POST），
 * 响应不缓存；审计只记谁、哪个运行时、改了哪一项或哪个文件，不记值。
 */

const ERROR_STATUS: Record<string, number> = {
  RUNTIME_CREDENTIALS_NOT_EDITABLE: 409,
  RUNTIME_CREDENTIALS_UNREADABLE: 409,
  RUNTIME_CREDENTIALS_WRITE_FAILED: 500,
  RUNTIME_PROFILE_NOT_SWITCHABLE: 409,
  RUNTIME_PROFILE_NOT_FOUND: 404,
  RUNTIME_PROFILE_NOTHING_TO_SAVE: 409,
  CC_SWITCH_UNAVAILABLE: 404,
  RUNTIME_CONFIG_INVALID: 400,
  RUNTIME_CONFIG_CHANGED: 409,
  RUNTIME_SKILL_NOT_FOUND: 404,
  RUNTIME_SKILL_EXISTS: 409,
  RUNTIME_INSTALL_UNKNOWN: 404,
  RUNTIME_INSTALL_PLAN_STALE: 409,
  SKILL_MARKET_UNAVAILABLE: 502,
  SKILL_MARKET_NOT_FOUND: 404,
  SKILL_MARKET_BAD_PACKAGE: 422,
  SKILL_MARKET_PLAN_STALE: 409,
};

export function registerRuntimeConfigRoutes(
  app: FastifyInstance,
  options: {
    credentials: RuntimeCredentialStore | undefined;
    supervisor: LocalAgentSupervisor;
    /** 通过本机房主校验返回 true；不通过时已经发出了响应 */
    authorizeLocal: (request: FastifyRequest, reply: FastifyReply) => boolean;
    /** 从网上搜索、下载 skill；测试注入替身，不真正访问外网 */
    skillMarket?: SkillMarket;
    /** 多套供应商与官方订阅的切换；没有时这组接口返回 404 */
    profiles?: RuntimeProfileStore;
    /** 在终端里运行登录命令（复用「在终端打开会话」）；测试注入 */
    openTerminal?: (command: string) => Promise<void>;
    /** MCP 测试结果存在哪（Server 的小设置）；不给就只记在内存里 */
    mcpHealth?: McpHealthPersistence;
    now?: () => number;
  },
): void {
  const { credentials, supervisor, authorizeLocal } = options;
  const market = options.skillMarket ?? new SkillMarket();
  const skillPlans = new SkillInstallPlans();
  const plans = new InstallPlans();
  const store = credentials ? new RuntimeConfigStore(credentials) : undefined;
  const skills = credentials ? new RuntimeSkillStore(credentials) : undefined;
  const health = new McpHealthStore(options.mcpHealth);
  const now = options.now ?? Date.now;

  const agentsOf = (provider: RuntimeCredentialProvider) =>
    supervisor
      .list()
      .filter((agent) => agent.provider === provider)
      .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
  const contextOf = (provider: RuntimeCredentialProvider) => ({
    cwds: [
      ...new Set(
        supervisor
          .list()
          .filter((agent) => agent.provider === provider && agent.cwd)
          .map((agent) => agent.cwd!),
      ),
    ],
  });

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof HiveError && ERROR_STATUS[error.code]) {
      return reply.code(ERROR_STATUS[error.code]!).send(hiveErrorBody(error));
    }
    throw error;
  };
  const badRequest = (reply: FastifyReply) =>
    reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });

  function audit(
    request: FastifyRequest,
    action:
      | "view"
      | "update"
      | "delete"
      | "sync"
      | "install-preview"
      | "install"
      | "skill-search"
      | "switch"
      | "import"
      | "login"
      | "verify",
    provider: RuntimeCredentialProvider,
    target: string[],
  ) {
    request.log.info(
      { runtimeConfig: { by: "local-owner", ip: request.ip, action, provider, target } },
      "runtime config " + action,
    );
  }

  /** 校验并取出运行时；不通过时已经发出响应 */
  function begin(
    request: FastifyRequest<{ Params: { provider: string } }>,
    reply: FastifyReply,
  ):
    | { store: RuntimeConfigStore; skills: RuntimeSkillStore; provider: RuntimeCredentialProvider }
    | undefined {
    if (!authorizeLocal(request, reply)) return undefined;
    if (!store || !skills) {
      void reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
      return undefined;
    }
    const provider = runtimeCredentialProviderSchema.safeParse(request.params.provider);
    if (!provider.success) {
      void badRequest(reply);
      return undefined;
    }
    return { store, skills, provider: provider.data };
  }

  /** 改完返回最新配置，并带上要重启的本机 Agent */
  const result = (store: RuntimeConfigStore, provider: RuntimeCredentialProvider) => ({
    config: store.get(provider, contextOf(provider)),
    agents: agentsOf(provider),
  });

  app.get<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/fields",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = updateRuntimeConfigFieldsRequestSchema.safeParse(request.body);
      if (!body.success || !Object.keys(body.data.values).length) return badRequest(reply);
      try {
        const changed = ok.store.updateFields(ok.provider, body.data.values);
        audit(request, "update", ok.provider, changed);
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/mcp",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = putRuntimeMcpServerRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        ok.store.putMcp(ok.provider, body.data.name, body.data.server, body.data.previousName);
        audit(request, "update", ok.provider, [`mcp:${body.data.name}`]);
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete<{ Params: { provider: string; name: string } }>(
    "/api/local/runtime-config/:provider/mcp/:name",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        ok.store.deleteMcp(ok.provider, request.params.name);
        audit(request, "delete", ok.provider, [`mcp:${request.params.name}`]);
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string; name: string } }>(
    "/api/local/runtime-config/:provider/mcp/:name/toggle",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        ok.store.toggleMcp(ok.provider, request.params.name, body.data.enabled);
        audit(request, "update", ok.provider, [`mcp:${request.params.name}:enabled`]);
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** 整份文件原文：提示词或原始配置。原始配置里有密钥，页面在确认后才调 */
  app.post<{ Params: { provider: string; file: string } }>(
    "/api/local/runtime-config/:provider/files/:file/read",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        const file = ok.store.readFile(ok.provider, request.params.file);
        audit(request, "view", ok.provider, [`file:${request.params.file}`]);
        void reply.header("Cache-Control", "no-store");
        return file;
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { provider: string; file: string } }>(
    "/api/local/runtime-config/:provider/files/:file",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = updateRuntimeConfigFileRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        const { hash } = ok.store.writeFile(
          ok.provider,
          request.params.file,
          body.data.content,
          body.data.baseHash,
        );
        audit(request, "update", ok.provider, [`file:${request.params.file}`]);
        return { ...result(ok.store, ok.provider), hash };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /* ---------- 多套供应商与官方订阅：key 只在 Server 里，列表打码，审计只记哪一套 ---------- */

  const profileStore = options.profiles;
  const profilesResult = async (
    store: RuntimeConfigStore,
    profiles: RuntimeProfileStore,
    provider: RuntimeCredentialProvider,
    extra: Record<string, unknown> = {},
  ) => ({
    profiles: await profiles.list(provider),
    ...result(store, provider),
    ...extra,
  });
  function beginProfiles(
    request: FastifyRequest<{ Params: { provider: string } }>,
    reply: FastifyReply,
  ) {
    const ok = begin(request, reply);
    if (!ok) return undefined;
    if (!profileStore) {
      void reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
      return undefined;
    }
    return { ...ok, profiles: profileStore };
  }

  app.get<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/profiles",
    async (request, reply) => {
      const ok = beginProfiles(request, reply);
      if (!ok) return reply;
      try {
        void reply.header("Cache-Control", "no-store");
        return await profilesResult(ok.store, ok.profiles, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/profiles",
    async (request, reply) => {
      const ok = beginProfiles(request, reply);
      if (!ok) return reply;
      const body = createRuntimeProfileRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        const id = ok.profiles.create(ok.provider, body.data);
        audit(request, "update", ok.provider, [`profile:${id}:create`]);
        return await profilesResult(ok.store, ok.profiles, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { provider: string; id: string } }>(
    "/api/local/runtime-config/:provider/profiles/:id",
    async (request, reply) => {
      const ok = beginProfiles(request, reply);
      if (!ok) return reply;
      const body = updateRuntimeProfileRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        ok.profiles.update(ok.provider, request.params.id, body.data);
        const fields = (["name", "baseUrl", "apiKey"] as const).filter(
          (field) => body.data[field] !== undefined,
        );
        audit(request, "update", ok.provider, [`profile:${request.params.id}:${fields.join(",")}`]);
        return await profilesResult(ok.store, ok.profiles, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete<{ Params: { provider: string; id: string } }>(
    "/api/local/runtime-config/:provider/profiles/:id",
    async (request, reply) => {
      const ok = beginProfiles(request, reply);
      if (!ok) return reply;
      try {
        ok.profiles.remove(ok.provider, request.params.id);
        audit(request, "delete", ok.provider, [`profile:${request.params.id}`]);
        return await profilesResult(ok.store, ok.profiles, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/profiles/switch",
    async (request, reply) => {
      const ok = beginProfiles(request, reply);
      if (!ok) return reply;
      const body = switchRuntimeProfileRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        const { saved } = ok.profiles.switchTo(ok.provider, body.data);
        audit(request, "switch", ok.provider, [
          "official" in body.data ? "official" : `profile:${body.data.profileId}`,
        ]);
        return await profilesResult(ok.store, ok.profiles, ok.provider, saved ? { saved } : {});
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/profiles/import",
    async (request, reply) => {
      const ok = beginProfiles(request, reply);
      if (!ok) return reply;
      const body = importCcSwitchProvidersRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        const imported = ok.profiles.importCcSwitch(ok.provider, body.data.ids);
        audit(
          request,
          "import",
          ok.provider,
          body.data.ids.map((id) => `cc-switch:${id}`),
        );
        return await profilesResult(ok.store, ok.profiles, ok.provider, { imported });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** 官方订阅还没登录：在这台电脑上开一个终端运行登录命令，登录由人在终端里完成 */
  app.post<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/login",
    async (request, reply) => {
      const ok = beginProfiles(request, reply);
      if (!ok) return reply;
      const command = ok.profiles.loginCommand(ok.provider);
      if (!command) return badRequest(reply);
      try {
        await (options.openTerminal ?? openTerminal)(command);
      } catch {
        return reply
          .code(500)
          .send({ ...errorText(serverText("error.runtimeProfiles.terminal", { command })) });
      }
      audit(request, "login", ok.provider, [command]);
      return { ok: true };
    },
  );

  /* ---------- 全局 skills ---------- */

  const skillsResult = (skills: RuntimeSkillStore, provider: RuntimeCredentialProvider) => ({
    skills: skills.list(provider),
    agents: agentsOf(provider),
  });

  app.get<{ Params: { provider: string } }>(
    "/api/local/runtime-skills/:provider",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        return skillsResult(ok.skills, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string; id: string } }>(
    "/api/local/runtime-skills/:provider/:id/read",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        const file = ok.skills.read(ok.provider, request.params.id);
        audit(request, "view", ok.provider, [`skill:${request.params.id}`]);
        void reply.header("Cache-Control", "no-store");
        return file;
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string; id: string } }>(
    "/api/local/runtime-skills/:provider/:id/toggle",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = toggleRuntimeSkillRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        ok.skills.toggle(ok.provider, request.params.id, body.data.enabled);
        audit(request, "update", ok.provider, [`skill:${request.params.id}:enabled`]);
        return skillsResult(ok.skills, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete<{ Params: { provider: string; id: string } }>(
    "/api/local/runtime-skills/:provider/:id",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        const { backup } = ok.skills.remove(ok.provider, request.params.id);
        audit(request, "delete", ok.provider, [`skill:${request.params.id}`]);
        return { ...skillsResult(ok.skills, ok.provider), backup };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string; id: string } }>(
    "/api/local/runtime-skills/:provider/:id/sync",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = syncRuntimeItemRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        ok.skills.sync(ok.provider, request.params.id, body.data.targets);
        audit(request, "sync", ok.provider, [
          `skill:${request.params.id}`,
          ...body.data.targets.map((target) => `to:${target}`),
        ]);
        return { overview: runtimeOverview(ok.store, ok.skills, health) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string; name: string } }>(
    "/api/local/runtime-config/:provider/mcp/:name/sync",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = syncRuntimeItemRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        ok.store.syncMcp(ok.provider, request.params.name, body.data.targets);
        audit(request, "sync", ok.provider, [
          `mcp:${request.params.name}`,
          ...body.data.targets.map((target) => `to:${target}`),
        ]);
        return { overview: runtimeOverview(ok.store, ok.skills, health) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** 统一管理里新增 MCP：一次写进多个运行时，目标里有同名的整体拒绝 */
  app.post("/api/local/runtime-overview/mcp", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    if (!store || !skills) {
      return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    }
    const body = addRuntimeMcpRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply);
    try {
      store.addMcp(body.data.targets, body.data.name, body.data.server);
      for (const provider of new Set(body.data.targets)) {
        audit(request, "update", provider, [`mcp:${body.data.name}`]);
      }
      return { overview: runtimeOverview(store, skills, health) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---------- MCP 快速安装：精选清单 → 预览冻结计划 → 按计划写 ---------- */

  /** 只给本机房主、功能开着时取出存储；不通过时已经发出响应 */
  const beginInstall = (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorizeLocal(request, reply)) return undefined;
    if (!store || !skills) {
      void reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
      return undefined;
    }
    return { store, skills };
  };

  /** 解析配方和参数，检查每个目标能装（配方声明了、CLI 支持全局 MCP、没有同名） */
  const prepare = (body: RuntimeInstallRequest) => {
    const entry = catalogEntry(body.recipeId);
    if (!entry) throw unknownRecipe();
    const resolved = resolveRecipe(entry, body.params);
    const targets = [...new Set(body.targets)];
    for (const target of targets) checkRuntime(entry, target);
    return { entry, resolved, targets, digest: plans.digest(body, targets) };
  };

  app.get("/api/local/runtime-install/catalog", async (request, reply) => {
    if (!beginInstall(request, reply)) return reply;
    return MCP_CATALOG;
  });

  app.post("/api/local/runtime-install/preview", async (request, reply) => {
    const ok = beginInstall(request, reply);
    if (!ok) return reply;
    const body = runtimeInstallRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply);
    try {
      const { entry, resolved, targets, digest } = prepare(body.data);
      const files = targets.map((target) => ({
        provider: target,
        ...ok.store.preflightMcp(target, body.data.name),
      }));
      const { id, expiresAt } = plans.create(
        digest,
        Object.fromEntries(files.map((item) => [item.provider, item.hash])),
      );
      for (const target of targets) {
        audit(request, "install-preview", target, [`mcp:${body.data.name}`, `recipe:${entry.id}`]);
      }
      const plan: RuntimeInstallPlan = {
        id,
        expiresAt,
        recipeId: entry.id,
        catalogVersion: MCP_CATALOG_VERSION,
        name: body.data.name,
        transport: resolved.input.transport,
        ...(resolved.display.command
          ? { command: resolved.display.command, args: resolved.display.args ?? [] }
          : { url: resolved.display.url ?? "" }),
        env: resolved.display.env,
        headers: resolved.display.headers,
        targets: files.map((item) => ({
          provider: item.provider,
          file: item.file,
          agents: agentsOf(item.provider),
        })),
      };
      void reply.header("Cache-Control", "no-store");
      return { plan };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * 按预览过的计划写：参数摘要和各目标文件哈希都对得上、没过期才动手，否则什么都不写。
   * 再逐个目标检查并写入，某个目标失败不影响已写好的，结果分目标报回去；不重启 Agent
   */
  app.post("/api/local/runtime-install/apply", async (request, reply) => {
    const ok = beginInstall(request, reply);
    if (!ok) return reply;
    const body = runtimeInstallApplyRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply);
    try {
      const { entry, resolved, targets, digest } = prepare(body.data);
      const hashes = Object.fromEntries(
        targets.map((target) => [target, ok.store.mcpFileHash(target)]),
      );
      if (!plans.take(body.data.planId, digest, hashes)) throw stalePlan();
      const results: RuntimeInstallResult["results"] = [];
      for (const target of targets) {
        let file: string | undefined;
        try {
          file = ok.store.preflightMcp(target, body.data.name).file;
          ok.store.putMcp(target, body.data.name, resolved.input, undefined, resolved.headers);
          audit(request, "install", target, [`mcp:${body.data.name}`, `recipe:${entry.id}`]);
          results.push({ provider: target, ok: true, file });
        } catch (error) {
          // 只回报错误码和文案，不带原始异常（里面可能有路径以外的内容）
          const text =
            error instanceof HiveError && error.text
              ? error.text
              : serverText("error.runtimeCredentials.writeFailed", {
                  file: file ?? target,
                  reason: (error as NodeJS.ErrnoException).code ?? "write error",
                });
          request.log.warn(
            {
              runtimeInstall: {
                provider: target,
                recipe: entry.id,
                code: (error as HiveError).code,
              },
            },
            "runtime install target failed",
          );
          results.push({
            provider: target,
            ok: false,
            ...(file ? { file } : {}),
            error: zhText(text),
            text,
          });
        }
      }
      const result: RuntimeInstallResult = {
        results,
        overview: runtimeOverview(ok.store, ok.skills, health),
      };
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * 测一个已经写进 CLI 配置的 MCP 能不能用：读那个 CLI 配置里的这一项，在单独的进程里连上去读工具列表。
   * 装完由网页自动调一次（stdio 要人在安装时勾了「装好后试运行一次」才调，因为会真的运行那条命令、
   * 第一次还要下载）；列表里出了问题的也可以点「再测一次」。结果按名字记下，总览和状态栏角标用
   */
  app.post("/api/local/runtime-overview/mcp/verify", async (request, reply) => {
    const ok = beginInstall(request, reply);
    if (!ok) return reply;
    const body = verifyRuntimeMcpRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply);
    const { name } = body.data;
    try {
      const candidates = body.data.provider
        ? [body.data.provider]
        : RUNTIME_CREDENTIAL_PROVIDERS.filter((provider) => ok.skills.installed(provider));
      let found:
        | {
            provider: RuntimeCredentialProvider;
            launch: NonNullable<ReturnType<RuntimeConfigStore["mcpLaunchConfig"]>>;
          }
        | undefined;
      for (const provider of candidates) {
        let launch: ReturnType<RuntimeConfigStore["mcpLaunchConfig"]>;
        try {
          launch = ok.store.mcpLaunchConfig(provider, name);
        } catch {
          launch = undefined;
        }
        if (launch) {
          found = { provider, launch };
          break;
        }
      }
      if (!found) throw invalid(name);
      audit(request, "verify", found.provider, [`mcp:${name}`]);
      const measurement = await supervisor.checkMcp(found.launch);
      const result = toHealth(measurement, now());
      health.set(name, mcpFingerprint(found.launch), result);
      const response: VerifyRuntimeMcpResult = { health: result };
      return response;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---------- 从网上装 skill：skills.sh 搜索 → 下载到内存预览 → 按同一份内容写 ---------- */

  const skillTargets = (skillStore: RuntimeSkillStore, name: string, dirName: string) =>
    RUNTIME_CREDENTIAL_PROVIDERS.filter((provider) => skillStore.installed(provider)).map(
      (provider) => {
        const target = skillStore.installTarget(provider, name, dirName);
        return {
          provider,
          path: target.path,
          exists: target.exists,
          sharedWith: target.sharedWith,
        };
      },
    );

  app.get<{ Querystring: { q?: string; owner?: string } }>(
    "/api/local/skill-market/search",
    async (request, reply) => {
      if (!beginInstall(request, reply)) return reply;
      const query = typeof request.query.q === "string" ? request.query.q : "";
      const owner =
        typeof request.query.owner === "string" && request.query.owner
          ? request.query.owner
          : undefined;
      try {
        const skills = await market.search(query, owner);
        request.log.info(
          { runtimeConfig: { by: "local-owner", action: "skill-search", count: skills.length } },
          "runtime config skill-search",
        );
        return { query: query.trim(), skills };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post("/api/local/skill-market/preview", async (request, reply) => {
    const ok = beginInstall(request, reply);
    if (!ok) return reply;
    const body = skillInstallPreviewRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply);
    try {
      const pkg = await market.fetchSkill(body.data.source, body.data.skillId);
      const { id, expiresAt } = skillPlans.create(pkg);
      const preview: SkillInstallPreview = {
        id,
        expiresAt,
        source: pkg.source,
        skillId: pkg.skillId,
        name: pkg.name,
        description: pkg.description,
        repoPath: pkg.repoPath,
        ...(pkg.commit ? { commit: pkg.commit } : {}),
        verified: pkg.verified,
        url: pkg.url,
        skillMd: pkg.skillMd.length > 200_000 ? pkg.skillMd.slice(0, 200_000) : pkg.skillMd,
        files: pkg.files.map(({ path, size, kind, executable }) => ({
          path,
          size,
          kind,
          executable,
        })),
        skipped: pkg.skipped,
        totalBytes: pkg.totalBytes,
        targets: skillTargets(ok.skills, pkg.name, pkg.dirName),
      };
      request.log.info(
        {
          runtimeConfig: {
            by: "local-owner",
            action: "skill-preview",
            skill: `${pkg.source}/${pkg.skillId}`,
            commit: pkg.commit ?? "snapshot",
          },
        },
        "runtime config skill-preview",
      );
      void reply.header("Cache-Control", "no-store");
      return { preview };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * 按预览时下载好的那一份写：逐个运行时独立写、独立报结果；同名已有的不覆盖。
   * 同一批里前一个目录装好后，后面会读同一个目录的运行时报「已经能用」，不再装第二份
   */
  app.post("/api/local/skill-market/apply", async (request, reply) => {
    const ok = beginInstall(request, reply);
    if (!ok) return reply;
    const body = skillInstallApplyRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply);
    try {
      const pkg = skillPlans.take(body.data.planId);
      const results: SkillInstallResult["results"] = [];
      const written: string[] = [];
      const targets = [...new Set(body.data.targets)];
      // 动手前就已经有的才算「已存在」；写的过程中才出现的，是被这一批前面写的目录带上的
      const existedBefore = new Set(
        targets.filter(
          (target) =>
            ok.skills.installed(target) &&
            ok.skills.installTarget(target, pkg.name, pkg.dirName).exists,
        ),
      );
      for (const target of targets) {
        if (!ok.skills.installed(target)) {
          const text = serverText("error.runtimeInstall.runtime", {
            name: pkg.name,
            target: RUNTIME_LABELS[target],
          });
          results.push({ provider: target, status: "failed", error: zhText(text), text });
          continue;
        }
        const before = ok.skills.installTarget(target, pkg.name, pkg.dirName);
        if (before.exists) {
          const shared = !existedBefore.has(target) && written.length > 0;
          const text = shared
            ? serverText("skillMarket.shared", { path: written[0]! })
            : serverText("error.runtimeSkills.exists", {
                target: RUNTIME_LABELS[target],
                name: pkg.name,
              });
          results.push({
            provider: target,
            status: shared ? "shared" : "exists",
            path: before.path,
            error: zhText(text),
            text,
          });
          continue;
        }
        try {
          const file = ok.skills.installFiles(target, pkg.name, pkg.dirName, pkg.files);
          written.push(file);
          audit(request, "install", target, [
            `skill:${pkg.name}`,
            `source:${pkg.source}/${pkg.skillId}@${pkg.commit ?? "snapshot"}`,
          ]);
          results.push({ provider: target, status: "installed", path: file });
        } catch (error) {
          const text =
            error instanceof HiveError && error.text
              ? error.text
              : serverText("error.runtimeSkills.moveFailed", {
                  path: before.path,
                  reason: (error as NodeJS.ErrnoException).code ?? "write error",
                });
          results.push({
            provider: target,
            status: "failed",
            path: before.path,
            error: zhText(text),
            text,
          });
        }
      }
      const result: SkillInstallResult = {
        results,
        overview: runtimeOverview(ok.store, ok.skills, health),
      };
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** 跨运行时总览：同一个 MCP / skill 在哪些运行时里有、是否启用。只列有配置目录的运行时 */
  app.get("/api/local/runtime-overview", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    if (!store || !skills) {
      return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    }
    try {
      return { overview: runtimeOverview(store, skills, health) };
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/** 这个 MCP 在各 CLI 里当前配置的指纹；某个 CLI 读不出来就跳过 */
function* fingerprintsOf(
  store: RuntimeConfigStore,
  name: string,
  entries: Array<{ provider: RuntimeCredentialProvider }>,
) {
  for (const entry of entries) {
    let launch: ReturnType<RuntimeConfigStore["mcpLaunchConfig"]>;
    try {
      launch = store.mcpLaunchConfig(entry.provider, name);
    } catch {
      launch = undefined;
    }
    if (launch) yield mcpFingerprint(launch);
  }
}

/** 一个运行时读不懂（配置写坏了）不影响别的运行时出现在总览里 */
export function runtimeOverview(
  store: RuntimeConfigStore,
  skills: RuntimeSkillStore,
  health?: McpHealthStore,
): RuntimeOverview {
  const result: RuntimeOverview = { providers: [], mcp: [], skills: [] };
  const mcp = new Map<string, RuntimeOverview["mcp"][number]>();
  const skillMap = new Map<string, RuntimeOverview["skills"][number]>();
  for (const provider of RUNTIME_CREDENTIAL_PROVIDERS) {
    if (!skills.installed(provider)) continue;
    let servers: ReturnType<RuntimeConfigStore["mcpOf"]> | undefined;
    try {
      servers = store.mcpOf(provider);
    } catch {
      servers = undefined;
    }
    const mcpNote = servers?.supported ? undefined : servers?.noteText;
    result.providers.push({
      provider,
      mcpSupported: Boolean(servers?.supported),
      mcpCanToggle: Boolean(servers?.supported && servers.canToggle),
      ...(mcpNote ? { mcpNote: zhText(mcpNote as ServerText), mcpNoteText: mcpNote } : {}),
    });
    for (const server of servers?.supported ? servers.servers : []) {
      const row = mcp.get(server.name) ?? { name: server.name, entries: [] };
      row.entries.push({ provider, enabled: server.enabled, transport: server.transport });
      mcp.set(server.name, row);
    }
    let list: ReturnType<RuntimeSkillStore["list"]>["skills"] = [];
    try {
      list = skills.list(provider).skills;
    } catch {
      list = [];
    }
    for (const skill of list) {
      const row = skillMap.get(skill.name) ?? { name: skill.name, entries: [] };
      // 同一运行时里同名的出现在多个目录时只记第一个（运行时按目录优先级取一个）
      if (!row.entries.some((entry) => entry.provider === provider)) {
        row.entries.push({
          provider,
          id: skill.id,
          enabled: skill.enabled,
          source: skill.source,
          canToggle: skill.canToggle,
          canSync: skill.canSync,
          ...(skill.note && !skill.canToggle
            ? { note: skill.note, ...(skill.noteText ? { noteText: skill.noteText } : {}) }
            : {}),
        });
      }
      skillMap.set(skill.name, row);
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  result.mcp = [...mcp.values()].sort(byName);
  // 测过的才去读完整配置算指纹；配置在测之后改过就不带旧结果
  if (health) {
    for (const row of result.mcp) {
      if (!health.has(row.name)) continue;
      const found = health.get(row.name, fingerprintsOf(store, row.name, row.entries));
      if (found) row.health = found;
    }
  }
  result.skills = [...skillMap.values()].sort(byName);
  return result;
}
