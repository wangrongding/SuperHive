---
title: Feedback and contributing
description: Report SuperHive bugs or feature requests safely, inspect the diagnostic report, and ask your local Agent to reproduce, fix and prepare a PR.
---

## Start in the bottom-left corner

The identity card still opens your user menu. The separate feedback icon next to it opens **Feedback and contributing**, also available from the user menu. Select a bug or feature, then enter a title and description. Bugs have optional reproduction steps, expected and actual results. [Search existing issues](https://github.com/wangrongding/SuperHive/issues) first.

## Inspect diagnostics and the final report

The version, commit, distribution, OS, browser and Agent CLI versions are displayed and can be excluded. Unavailable runtime versions are marked unknown; feedback never installs tools or signs in for you. Older servers fall back to the web build version.

The optional recent incident summary is unchecked by default. It only includes source, status, count, commit and code file locations. Room messages, raw errors, dispatch history, credentials and raw logs are not read. Common tokens, invite links, home directories, IPs and host identifiers are additionally redacted. **Inspect the final title and body yourself: automatic filtering cannot identify every secret.**

Choose **Preview final report**, inspect or copy it, or return to editing. No issue exists until you submit on GitHub.

## Confirm in your own GitHub account

**Confirm on GitHub** opens the bug or feature form in `wangrongding/SuperHive`. SuperHive holds no GitHub credentials. The form uses field IDs for prefilling. When a report exceeds the safe link length, copy it first, follow the short link and paste the full Markdown into Description. If clipboard access fails, select and copy the preview manually.

## Report an incident or fix it yourself

On an incident in the left-hand **Incidents** panel, choose **Send to SuperHive** for a safe prefilled title and description, or **Let my Agent fix it** to expand the contribution controls. An external model or network failure is not necessarily a SuperHive bug; check ownership first.

Select an online, writable local Agent in the current shared room and a dedicated contribution directory. An existing SuperHive issue URL is optional; without one, the task will not create an issue. The task and directory are visible to room members and posted under your human identity. Visitors and remote pages cannot dispatch local contribution tasks. The Agent's existing access profile is not elevated.

The Agent checks that `gh` is installed and authenticated, reads `AGENTS.md` and `CONTRIBUTING.md`, then reproduces the problem, makes a focused patch and adds tests on a clean branch. It asks before overwriting or changing access. **Before push and ordinary, non-draft PR creation it must call `hive_ask_human` and wait for your approval.** It never auto-merges or asks for tokens, and explains the manual workflow if `gh` is missing. If a task receipt is uncertain, check the room instead of dispatching a duplicate.

## Development and PR conventions

Use Node.js 22.12+, pnpm 10 and Git. See [CONTRIBUTING.md](https://github.com/wangrongding/SuperHive/blob/main/CONTRIBUTING.md) for environment setup, tests, commit conventions, forks and PR creation, plus [Development and extensions](/en/reference/development/) and [Task directories](/en/guides/worktrees/). Distinguish passed, inspected and not-run checks, and include screenshots for UI changes.
