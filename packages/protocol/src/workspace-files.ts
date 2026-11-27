import { z } from "zod";

/**
 * 房间工作区的只读浏览：文件树、文件预览、git 变更与 diff、最近提交、Hive worktree 相对 base 的改动。
 *
 * 路径一律是相对工作区（或所选 worktree）根目录的 POSIX 路径；接口不返回本机绝对路径。
 * 疑似密钥文件（.env、*.pem、id_rsa 等）只列出、不带内容，房主带 reveal 再取才给。
 */

/** 查看哪一份代码：房间工作区本身，或这个房间登记的某个 worktree（用 worktree id） */
export const workspaceSourceSchema = z.union([z.literal("workspace"), z.string().uuid()]);

/** 相对路径：不能是绝对路径、不能有 .. 段或 NUL；空串表示根目录 */
export const workspaceRelativePathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes("\\") &&
      !value.split("/").includes(".."),
    "Invalid path",
  );

export const workspaceSourceInfoSchema = z.object({
  id: workspaceSourceSchema,
  kind: z.enum(["workspace", "worktree"]),
  /** 显示名：工作区目录名，或 worktree 的分支 */
  label: z.string(),
  branch: z.string().optional(),
  /** worktree：创建它的 Agent 与 base 分支 */
  agentName: z.string().optional(),
  base: z.string().optional(),
  missing: z.boolean().optional(),
  /** 以下只在总览带 detail=1 时给：未提交改动的文件数、相对 base 领先的提交数 */
  changeCount: z.number().int().nonnegative().optional(),
  ahead: z.number().int().nonnegative().optional(),
  /** 最近一次改动的时间：未提交文件的修改时间、分出来以后的最新提交，取较晚的；没有改动就没有 */
  activeAt: z.string().optional(),
  /** worktree 已合入（或从没改过）：排到最后，不作为默认选择 */
  merged: z.boolean().optional(),
});

export const workspaceOverviewSchema = z.object({
  /** 房间没有设工作区 */
  configured: z.boolean(),
  /** 工作区目录名（不含上层路径） */
  name: z.string().optional(),
  git: z.boolean(),
  /** 工作区未提交改动的文件数（头部入口上的数字）；不是仓库就没有 */
  changeCount: z.number().int().nonnegative().optional(),
  sources: z.array(workspaceSourceInfoSchema),
  /** 房主是否允许访客查看；只有房主能改 */
  guestsAllowed: z.boolean(),
  /** 当前请求者能否揭示密钥文件内容（只有房主） */
  canReveal: z.boolean(),
});

export const workspaceChangeGroupSchema = z.enum(["staged", "unstaged", "untracked", "conflict"]);

/** git 状态字母：M 修改、A 新增、D 删除、R 重命名、C 复制、T 类型变化、U 冲突、? 未跟踪 */
export const workspaceChangeStatusSchema = z.enum(["M", "A", "D", "R", "C", "T", "U", "?"]);

export const workspaceChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  group: workspaceChangeGroupSchema,
  status: workspaceChangeStatusSchema,
  /** 二进制或没算出来时没有 */
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
  sensitive: z.boolean().optional(),
});

export const workspaceStatusSchema = z.object({
  git: z.boolean(),
  branch: z.string().optional(),
  /** 分离 HEAD 时的短提交号 */
  detached: z.boolean().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  changes: z.array(workspaceChangeSchema),
  /** 改动太多只返回了前一部分 */
  truncated: z.boolean().optional(),
});

export const workspaceCommitSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
});

export const workspaceLogSchema = z.object({
  commits: z.array(workspaceCommitSchema),
});

/** 一组文件改动（某个提交，或 worktree 相对 base） */
export const workspaceChangeSetSchema = z.object({
  commit: workspaceCommitSchema.optional(),
  /** 提交说明全文（只有查看单个提交时） */
  body: z.string().optional(),
  /** 相对 base：base 分支、分叉点、这条线上的提交 */
  base: z.string().optional(),
  mergeBase: z.string().optional(),
  commits: z.array(workspaceCommitSchema).optional(),
  changes: z.array(workspaceChangeSchema),
  truncated: z.boolean().optional(),
});

/** 取哪一种 diff：暂存区、工作区、未跟踪新文件、某个提交、相对 base（含未提交改动） */
export const workspaceDiffModeSchema = z.enum([
  "staged",
  "unstaged",
  "untracked",
  "conflict",
  "commit",
  "base",
]);

export const workspaceTextEncodingSchema = z.enum(["gbk", "utf-16"]);

export const workspaceDiffSchema = z.object({
  path: z.string(),
  binary: z.boolean().optional(),
  /** 超过上限没有返回内容 */
  tooLarge: z.boolean().optional(),
  /** 疑似密钥文件：没有带 reveal 时不返回内容 */
  sensitive: z.boolean().optional(),
  /** git 的统一格式 diff 文本（从第一个 @@ 起） */
  patch: z.string().optional(),
  /** patch 带了整份文件作上下文：未改动的部分可以在网页上展开 */
  full: z.boolean().optional(),
  /** 不是 UTF-8 的文本：按 GBK（GB18030）或 UTF-16 解码后显示，只读 */
  encoding: workspaceTextEncodingSchema.optional(),
});

export const workspaceTreeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** 符号链接按它指向的东西算；指向工作区外面或已失效的是 other */
  type: z.enum(["file", "directory", "other"]),
  size: z.number().int().nonnegative().optional(),
  symlink: z.boolean().optional(),
  ignored: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  /** 指向工作区外面或不存在的符号链接：不能展开或预览 */
  outside: z.boolean().optional(),
  /** 该文件或目录下有改动时的 git 状态（目录取其中任意一个） */
  status: workspaceChangeStatusSchema.optional(),
});

export const workspaceTreeSchema = z.object({
  path: z.string(),
  entries: z.array(workspaceTreeEntrySchema),
  truncated: z.boolean().optional(),
});

export const workspaceFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  binary: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  /** 超过预览上限，只返回了开头一部分 */
  truncated: z.boolean().optional(),
  content: z.string().optional(),
  /** 不是 UTF-8 的文本：按 GBK（GB18030）或 UTF-16 解码后显示，只读 */
  encoding: workspaceTextEncodingSchema.optional(),
});

export const workspaceSearchSchema = z.object({
  paths: z.array(z.string()),
  truncated: z.boolean().optional(),
});

export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;
export type WorkspaceSourceInfo = z.infer<typeof workspaceSourceInfoSchema>;
export type WorkspaceOverview = z.infer<typeof workspaceOverviewSchema>;
export type WorkspaceChangeGroup = z.infer<typeof workspaceChangeGroupSchema>;
export type WorkspaceChangeStatus = z.infer<typeof workspaceChangeStatusSchema>;
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;
export type WorkspaceCommit = z.infer<typeof workspaceCommitSchema>;
export type WorkspaceLog = z.infer<typeof workspaceLogSchema>;
export type WorkspaceChangeSet = z.infer<typeof workspaceChangeSetSchema>;
export type WorkspaceDiffMode = z.infer<typeof workspaceDiffModeSchema>;
export type WorkspaceTextEncoding = z.infer<typeof workspaceTextEncodingSchema>;
export type WorkspaceDiff = z.infer<typeof workspaceDiffSchema>;
export type WorkspaceTreeEntry = z.infer<typeof workspaceTreeEntrySchema>;
export type WorkspaceTree = z.infer<typeof workspaceTreeSchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;
export type WorkspaceSearch = z.infer<typeof workspaceSearchSchema>;

/** 原始字节的临时链接：只对一个文件的一个版本有效，几分钟后过期 */
export const workspaceRawUrlSchema = z.object({
  /** 相对 Server 根的路径（带签名参数），直接用作 <img>/<video>/<audio> 的 src */
  url: z.string(),
  expiresAt: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  /** 能在页面里显示；false 时只给下载（类型不在白名单或超过 200MB） */
  inline: z.boolean(),
});

export type WorkspaceRawUrl = z.infer<typeof workspaceRawUrlSchema>;
