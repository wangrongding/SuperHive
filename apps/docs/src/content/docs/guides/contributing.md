---
title: 反馈与贡献
description: 安全反馈 SuperHive 问题或功能建议，预览诊断正文，并让自己的本机 Agent 复现、修复和准备 PR。
---

## 从左下角开始

头像卡片仍打开用户菜单，右侧独立的反馈图标打开「反馈与共建」；用户菜单里也有「反馈问题 / 建议功能」。选择问题或功能建议，填写标题和描述；问题还可填写复现步骤、期望与实际结果。先[搜索已有 issue](https://github.com/wangrongding/SuperHive/issues)，避免重复。

## 检查诊断与最终正文

版本、提交号、运行方式、系统、浏览器和 Agent CLI 版本自动显示，可取消附上。运行时版本不可用时标明未知，不会为了反馈自动安装或登录。旧服务没有版本元数据时回退到网页构建版本。

最近故障单摘要默认不勾选，只取来源、状态、次数、提交号和代码文件位置。不读取房间正文、错误原文、派修历史、凭据或原始日志。常见令牌、邀请链接、主目录、IP 与主机标识会进一步脱敏；**仍须人工检查最终标题和正文，自动过滤不能识别所有秘密**。

点「预览最终正文」，检查、复制或返回修改；直到你在 GitHub 点提交之前，都没有创建 issue。

## 到自己的 GitHub 账号确认

「去 GitHub 确认提交」打开 `wangrongding/SuperHive` 的 bug 或 feature 表单。SuperHive 不持有 GitHub 凭据。表单使用字段 ID 预填，长正文超过链接安全长度时先复制，再点短链接，把完整正文粘贴到描述。剪贴板不可用时可在预览里手动选择复制。

## 从故障单反馈或自己修

在左侧「故障」的单条详情中点「反馈给 SuperHive」，预填安全的标题和描述；点「让我的 Agent 来修」直接展开同一个对话框里的共建区域。外部模型或网络问题不一定是 SuperHive bug，先确认归属。

选择当前共享房间中在线、可写的本机 Agent，并填写专用的贡献目录。可填已提交的 SuperHive issue 链接；没有链接时任务不会代你创建 issue。任务、目录会对房间成员可见，由你的身份发出。访客和远程页面不能派本机贡献任务，Agent 原有访问权限不会提升。

Agent 会检查 `gh` 是否安装和登录，阅读 `AGENTS.md`、`CONTRIBUTING.md`，在干净分支复现、修改和补测试。有目录冲突或需要授权时先问人。**push 和创建普通、非 Draft PR 前必须调用 `hive_ask_human` 并等你确认**，不会自动合入。缺 `gh` 时提供手动流程，不索要 token。任务回执不确定时检查房间，不重复派发。

## 开发与提交约定

需要 Node.js 22.12+、pnpm 10 和 Git。详细开发环境、测试命令、提交规范、fork 与 PR 流程见仓库的 [CONTRIBUTING.zh-CN.md](https://github.com/wangrongding/SuperHive/blob/main/CONTRIBUTING.zh-CN.md)，以及[开发与扩展](/reference/development/)、[独立任务工作区](/guides/worktrees/)。提交说明区分通过、已检查和未运行，界面修改附截图。
