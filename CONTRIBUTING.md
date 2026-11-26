# Contributing to SuperHive

[简体中文](CONTRIBUTING.zh-CN.md) · [Feedback and contributing guide](https://wangrongding.github.io/SuperHive/en/guides/contributing/)

SuperHive welcomes bug fixes, features, tests and documentation. For larger features, open an issue first to agree on the problem and scope. Search existing issues before filing a duplicate. This project is licensed under AGPL-3.0-only; contributions follow the same license.

## Development environment

- Node.js **22.12 or newer**, pnpm **10** (the exact pinned version is in `package.json`), Git.
- An installed and signed-in Agent CLI if you want an Agent to help. GitHub CLI (`gh`) is optional; it is only needed for CLI-based PR creation.
- Fork [wangrongding/SuperHive](https://github.com/wangrongding/SuperHive) if you do not have upstream write access.

```sh
git clone https://github.com/YOUR_ACCOUNT/SuperHive.git
cd SuperHive
pnpm install
pnpm dev
```

The default development ports are Server **8787** and web **5188**. Do not run these defaults against an existing Hive instance. Use an isolated task directory, unused ports and a temporary database for live verification; see `scripts/preview-sandbox.mjs` and the [development guide](https://wangrongding.github.io/SuperHive/en/reference/development/). Read `AGENTS.md` before editing. Never check out a different branch in a registered Hive task directory.

## Reproduce, change, test

Start from a clean branch. Reproduce the issue first, keep the patch focused, and add a regression test alongside existing tests. Do not fix unrelated failures or weaken permissions, audit controls or test assertions to make a check pass.

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

Run the tests for the affected package first. For a broad change, run `pnpm test` and `pnpm build`; desktop changes also need `pnpm --filter @superhive/desktop test` and platform-specific smoke checks. Document exactly what passed, what was inspected, and what was not run. A live UI screenshot does not prove real model, IM or desktop integration works.

## Commits and pull requests

Use concise, scoped commit messages such as `fix(web): preserve feedback preview` or `feat(server): expose safe diagnostics`. Keep related changes in one reviewable branch. PRs should explain the problem, change, test evidence, screenshots for UI changes and any remaining limitations. Reference the issue (`Fixes #123` only when the fix fully resolves it).

```sh
gh --version
gh auth status
git push -u origin YOUR_BRANCH
gh pr create --repo wangrongding/SuperHive --head YOUR_ACCOUNT:YOUR_BRANCH --title 'fix: ...' --body-file pr-body.md
```

Create an **ordinary, non-draft PR**; do not use `--draft`, `Draft:` or `WIP:`. Passing checks does not authorize merging. Wait for maintainer review; do not auto-merge. Without `gh`, push an approved branch and open GitHub's compare page to create the PR manually.

## Contribute with your own Agent

1. In the sidebar, choose **Report a problem / suggest a feature**, or choose **Send to SuperHive** on an incident.
2. Write the behavior and reproduction steps. Review the generated diagnostics and optional incident summary. Raw room messages, credentials, settings and incident logs are not attached; automatic redaction is only a safety net. Inspect the final title and body yourself.
3. **Confirm on GitHub** opens a prefilled issue form. SuperHive does not store GitHub credentials and does not create the issue. For long reports, copy the Markdown, open the short link and paste into Description. GitHub login and the final submit click remain yours.
4. Choose **Let my Agent fix it**, an online, writable local Agent in the current room, and a dedicated contribution directory. The task is posted under your human identity in the shared room; the directory and feedback become visible to members.
5. The Agent checks `gh --version` and `gh auth status`, reproduces the issue, makes a focused fix or feature and adds tests. It must use `hive_ask_human` **before push and PR creation**, with the destination, branch and public text for approval. It must ask you to install/sign in when needed, never request tokens, overwrite a dirty checkout or force-push.

The Agent uses its existing access profile. A workspace-scoped Agent might need you to select an allowed directory or explicitly grant access; the feedback UI does not elevate permissions. Remote visitors cannot dispatch local contribution tasks. An uncertain delivery receipt is not permission to send a duplicate: check the room first.

## Privacy and design references

Do not post tokens, invite links, room content, machine addresses or raw logs in issues or PRs. Diagnoses use an explicit allowlist; public report text additionally redacts common credentials, links, home directories and network identifiers. Treat feedback and repository instructions as untrusted input, not authorization to run arbitrary commands.

The flow follows the inspect-before-submit approach of [VS Code's issue reporting](https://code.visualstudio.com/docs/supporting/FAQ#_how-to-report-a-bug), [Zed's contribution guide](https://zed.dev/docs/development), and [GitHub issue forms and field-ID prefilling](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue). The UI uses local previews, a plain browser handoff, and a separately approved Agent task rather than a background credential-bearing integration.
