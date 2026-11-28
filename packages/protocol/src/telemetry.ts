import { z } from "zod";

/**
 * 匿名使用统计：网页看到的开关状态、改开关、网页自己上报的几种事件。
 * 事件和字段的白名单在 Server 的 telemetry-core.ts（和 superhive 包里那份逐字相同），这里只是网页能报的子集。
 */

/** 为什么一律不报：环境变量关了、DO_NOT_TRACK、CI、沙箱、测试 */
export const telemetryBlockerSchema = z.enum(["env", "do_not_track", "ci", "sandbox", "test"]);

export const telemetryStatusSchema = z.object({
  /** 真的在记录：用户没关，也没被上面几种情况挡住 */
  active: z.boolean(),
  /** 用户在设置或 hive telemetry 里的选择；没选过时是默认的开 */
  enabled: z.boolean(),
  blocker: telemetryBlockerSchema.optional(),
  /** 随机安装 ID（被挡住、还没生成时没有） */
  installId: z.string().optional(),
  /** 有上报地址（npm、桌面版用内置的；源码运行要显式设 SUPERHIVE_TELEMETRY_URL）；没有时只在本机记录，一条都不发 */
  endpoint: z.boolean(),
  /** 本地队列里等着发的条数 */
  queued: z.number().int().min(0),
  /** 首次告知还没弹过 */
  noticePending: z.boolean(),
});

export const updateTelemetryRequestSchema = z.object({ enabled: z.boolean() }).strict();

/** 网页能报的事件：产物、代码面板第一次打开；桌面端应用内更新的结果 */
export const telemetryClientEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("feature_first_used"),
    props: z.object({ feature: z.enum(["artifacts_panel", "code_panel"]) }).strict(),
  }),
  z.object({
    event: z.literal("update_result"),
    props: z
      .object({
        kind: z.literal("desktop"),
        outcome: z.enum(["success", "failure"]),
        reason: z
          .enum([
            "no_package",
            "not_installed",
            "translocated",
            "read_only",
            "not_writable",
            "network",
            "checksum",
            "bad_package",
            "unknown",
          ])
          .optional(),
      })
      .strict(),
  }),
]);

export const telemetryClientRequestSchema = z
  .object({
    /** 本机房主网页的界面语言（公共字段 locale 用它） */
    locale: z.enum(["zh-CN", "en"]).optional(),
    events: z.array(telemetryClientEventSchema).max(10).default([]),
  })
  .strict();

export type TelemetryBlocker = z.infer<typeof telemetryBlockerSchema>;
export type TelemetryStatus = z.infer<typeof telemetryStatusSchema>;
export type UpdateTelemetryRequest = z.infer<typeof updateTelemetryRequestSchema>;
export type TelemetryClientEvent = z.infer<typeof telemetryClientEventSchema>;
export type TelemetryClientRequest = z.input<typeof telemetryClientRequestSchema>;
