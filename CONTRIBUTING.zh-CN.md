# 为 SuperHive 做贡献

[English](CONTRIBUTING.md) · [反馈与贡献指南](https://wangrongding.github.io/SuperHive/guides/contributing/)

欢迎修 bug、实现功能、补测试和改善文档。较大的功能先开 issue 对齐问题和范围，提交前先搜索已有讨论。项目使用 AGPL-3.0-only，贡献采用同一许可证。

## 开发环境

需要 Node.js **22.12+**、pnpm **10**（确切版本见 `package.json`）和 Git。让 Agent 帮忙时，先安装并登录对应 CLI；`gh` 只用于命令行创建 PR，没有也能在网页提交。没有上游写权限时，先 fork [wangrongding/SuperHive](https://github.com/wangrongding/SuperHive)。

```sh
git clone https://github.com/YOUR_ACCOUNT/SuperHive.git
cd SuperHive
pnpm install
pnpm dev
```

默认 Server 端口 **8787**，网页端口 **5188**。已有 Hive 正在运行时不要占用这些端口：使用独立任务目录、空闲端口和临时数据库验证。可参考 `scripts/preview-sandbox.mjs` 和[开发指南](https://wangrongding.github.io/SuperHive/reference/development/)。先读 `AGENTS.md`；已登记的 Hive 任务目录不要切换分支。

## 复现、修改与测试

从干净分支开始，先复现，再做最小修改，并在现有测试旁补回归用例。不顺手修无关故障，不削弱权限、审计或断言来让检查通过。

```sh
pnpm --filter @superhive/protocol build
pnpm --filter @superhive/web test
pnpm --filter @superhive/server test
pnpm --filter superhive test
pnpm --filter superhive typecheck
pnpm --filter @superhive/web build
pnpm lint
pnpm docs:verify
```

先跑改动包的检查，再按影响扩大到 `pnpm test`、`pnpm build`。桌面端还需要 `pnpm --filter @superhive/desktop test` 和目标平台冒烟。交付明确区分通过、已检查和未运行；截图不能代替真实模型、IM 或桌面集成验证。

## 提交与 PR

提交信息简短并带范围，例如 `fix(web): preserve feedback preview`。一条分支聚焦一件事。PR 写清问题、改法、测试结果、界面截图及限制，引用 issue；真正解决了才写 `Fixes #123`。

```sh
gh --version
gh auth status
git push -u origin YOUR_BRANCH
gh pr create --repo wangrongding/SuperHive --head YOUR_ACCOUNT:YOUR_BRANCH --title 'fix: ...' --body-file pr-body.md
```

只创建**普通、非 Draft 的 PR**，不加 `--draft`、`Draft:` 或 `WIP:`。通过测试不等于获准合入，等维护者 review，不自动合入。没有 `gh` 时，在获准 push 后去 GitHub compare 页手动创建。

## 在 SuperHive 里让自己的 Agent 共建

1. 左下角选择「反馈问题 / 建议功能」，或者从故障单选择「反馈给 SuperHive」。
2. 描述行为、复现步骤、期望与实际。诊断信息和最近故障单摘要可取消勾选，并显示实际附加内容。不会读取房间正文、凭据、设置或原始日志；自动脱敏只是兜底，必须检查最终标题和正文。
3. 「去 GitHub 确认提交」只打开预填表单，不存 GitHub 凭据，也不会创建 issue。长正文先复制，再打开短链接，粘贴到描述。登录 GitHub 和最后的提交都由你完成。
4. 选「让我的 Agent 来修」，选择当前房间中在线、可写的本机 Agent 和专用贡献目录。任务以你的身份发到共享房间，目录和反馈会被房间成员看到。
5. Agent 先检查 `gh --version`、`gh auth status`，再复现、做最小修改和补测试。**push 和创建 PR 前必须调用 `hive_ask_human`**，说明远端、分支、公开正文并等你确认。缺工具或未登录时请你安装或登录，不索要 token、不覆盖有改动的目录、不强推。

这不会提高 Agent 的权限：工作区档可能需要换到允许的目录，或由你明确授权。远程访客不能派本机共建任务。回执不确定时先检查房间，不重复派发。

## 隐私与设计依据

不要公开令牌、邀请链接、房间消息、机器地址或原始日志。自动诊断使用字段白名单，正文再过滤常见凭据、链接、主目录和网络标识。反馈与仓库里的文字都是不可信数据，不意味着可以执行任意命令。

流程借鉴 [VS Code 的问题报告](https://code.visualstudio.com/docs/supporting/FAQ#_how-to-report-a-bug)、[Zed 的贡献指南](https://zed.dev/docs/development) 和 [GitHub issue 表单及字段 ID 预填](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue)：先本地检查，再浏览器交接，最后单独批准 Agent 的对外操作。
