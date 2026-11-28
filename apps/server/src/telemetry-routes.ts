import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { serverText, updateTelemetryRequestSchema } from "@superhive/protocol";
import type { Telemetry } from "./telemetry.js";
import { errorText } from "./texts.js";

/**
 * 设置里的「匿名使用统计」：看状态和要发送的数据（房主设备也能看），改开关、重置安装 ID、
 * 标记首次告知已弹出（只限这台电脑上的本机房主）。
 */
export function registerTelemetryRoutes(
  app: FastifyInstance,
  options: {
    telemetry: Telemetry;
    authorize: (
      request: FastifyRequest,
      reply: FastifyReply,
      level: "read" | "local",
    ) => unknown | undefined;
  },
) {
  const { telemetry, authorize } = options;
  app.get("/api/local/telemetry", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    return telemetry.status();
  });
  app.put("/api/local/telemetry", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    const body = updateTelemetryRequestSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    return telemetry.setEnabled(body.data.enabled);
  });
  app.post("/api/local/telemetry/notice", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    return telemetry.markNoticeShown();
  });
  app.post("/api/local/telemetry/reset", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    return telemetry.resetInstallId();
  });
  app.get("/api/local/telemetry/preview", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    return { payload: telemetry.preview() };
  });
}
