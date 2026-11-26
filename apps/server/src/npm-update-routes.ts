import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { NpmUpdates } from "./npm-updates.js";

export function registerNpmUpdateRoutes(
  app: FastifyInstance,
  options: {
    manager: NpmUpdates;
    authorizeLocal: (request: FastifyRequest, reply: FastifyReply) => boolean;
  },
) {
  const { manager, authorizeLocal } = options;
  app.get("/api/local/update", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    try {
      return { info: await manager.inspect(true), job: manager.current() };
    } catch {
      return reply.code(503).send({ error: "Update check unavailable" });
    }
  });
  app.get("/api/local/update/current", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    return { job: manager.current() };
  });
  app.post("/api/local/update", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    const body = z
      .object({
        target: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
        choice: z.enum(["wait", "now"]).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid update request" });
    try {
      const info = await manager.inspect(true);
      if (!info.canUpdate || !info.latest || info.latest !== body.data.target)
        return reply
          .code(409)
          .send({ error: "Update eligibility or version changed", code: "UPDATE_CHANGED", info });
      if (!info.canHandover && info.busyAgents.length && !body.data.choice)
        return reply
          .code(409)
          .send({ error: "Busy Agents require confirmation", code: "UPDATE_BUSY", info });
      const job = await manager.launch(body.data.target, body.data.choice);
      app.log.info({ jobId: job.id, target: job.target }, "npm update started by local owner");
      return reply.code(202).send({ job });
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "Update could not start" });
    }
  });
}
