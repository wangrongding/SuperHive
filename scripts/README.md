# Live development supervisor

`pnpm dev` runs the dependency-free `dev.mjs` launcher, which runs the mutable
`dev-supervisor.mjs` outside Hive Server and its managed Agents. Restart an older
`pnpm dev` once to adopt the new launcher. Keep the root `dev` entry pointing to
`node scripts/dev.mjs`; the bootstrap does not execute arbitrary replacement dev commands.

- Web source changes use Vite HMR. Use the Vite URL (normally port 5188), not
  the Server's previously built static UI.
- Server, protocol and Bridge source/config changes are debounced for 1.5 seconds.
  Each update stages the protocol build and checks Server + Bridge types before
  stopping the old Server. Only successful checks publish the protocol output.
- Server runs checked JavaScript with its original source module URLs, **without**
  its own `tsx watch`. The supervisor owns restarts; Server continues to own its
  autostart-enabled local Agents.
- A new Server must answer `/health` with its unique instance identity before
  the generation becomes `ready`. This does not assert that every Agent has
  finished connecting or that a previous task completed.
- Atomic status writes follow `apps/web/src/dev-status.ts`. Diagnostics shown
  on the public development page are bounded summaries; compiler/runtime output
  remains in the local terminal.
- Failed checks keep the previous Server. Successful checks also cache the Server's
  emitted JavaScript; automatic recovery uses that published output, not unvalidated
  source edits. A dev-only Node loader preserves original module URLs and dependency
  resolution, including the development CLI and repository paths.
- Unexpected exits and startup failures retry after 1, 2, 5, 10 and then at most
  30 seconds. Five failures within 60 seconds stop automatic recovery and publish
  an actionable `failed` status. The floating status banner shows the attempt count
  or the crash-loop stop reason. Source edits reset the guard and take priority over
  pending recovery; checks and launches remain serialized. `Ctrl+C` and supervisor
  self-update pauses cancel recovery timers. Vite stays alive during Server recovery.
  There is no automatic rollback or replay of interrupted Agent tasks.
- Generated output, databases, logs, status files and `node_modules` do not
  trigger updates. Manual/remote Agents are not upgraded by this supervisor.
- Local Agents survive every Server generation change: code edits, supervisor
  self-updates, a replacement that fails its health check, and stopping
  `pnpm dev` itself (`Ctrl+C`, closing the terminal, Vite exiting). The
  supervisor writes the handover marker before the Server exits, so the Server
  leaves its Agents running; the next Server adopts them by pid and their running
  tasks continue, replies delivered once it is up. With no new Server, Agents go
  offline by themselves after a 2-minute grace. Start with `HIVE_DEV_KEEP_AGENTS=0`
  to have stopping `pnpm dev` take local Agents down too. Bridge
  (`packages/superhive`) changes reach an Agent through the Server's
  restart-when-idle auto-update; a busy Agent is never restarted mid-task.
- `Ctrl+C` stops the managed processes. Occupied ports cause an error, never a
  kill of another dev instance. `HIVE_PORT`/`HIVE_HOST` still configure Server;
  `HIVE_DEV_WEB_PORT` optionally changes Vite's port. For a non-default Server
  endpoint, set the existing frontend setting `VITE_HIVE_SERVER` explicitly.
- Runtime scripts under `scripts/` (excluding the fixed bootstrap and tests/smoke scripts), root
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and package manifests
  under `apps/` / `packages/` are content-watched separately. A quiet 1.5 seconds
  schedules one self-update, serialized against application builds.
- Manifest/lock/workspace changes run `pnpm install --no-frozen-lockfile
--prefer-offline --prod=false` first (non-interactive; three-minute timeout).
  Runtime scripts are syntax-checked, then the supervisor is actually imported
  in a short-lived child to validate ESM links and module evaluation before
  shutdown (10-second limit; `--eval` does not activate its CLI main guard).
  Failures retain the old processes where possible, publish `failed`, and retry
  self-update after a real control-file edit. Ordinary source builds are resumed,
  including queued edits. Their progress retains the control error, and even a
  healthy rebuilt application is reported as `failed` with an explicit "application
  updated, self-update still unresolved" message until a successful supervisor
  handoff. Application success must not pretend a failed installation succeeded. Dependency installation modifies `node_modules` in place: failure is not
  a dependency rollback and cannot guarantee all old lazy imports keep working.
- pnpm owns the lockfile during installation. Its resulting lock content is
  acknowledged without another reload; package/helper edits made concurrently
  are retained. Avoid hand-editing the lockfile during an install. Network-only
  recovery without a file edit does not trigger unlimited background retries.
- A successful self-update writes `restarting`, stops all owned children and
  exits with code 75. The launcher starts a fresh supervisor; its first healthy
  generation continues from `status.json`. If replacement startup fails, the
  launcher stays alive and waits for a code/config correction, not a crash loop.
  Vite is briefly offline across this handoff, so page polling resumes when it
  returns. `dev.mjs` itself is the fixed bootstrap, not a recursively self-modifying
  entry point; edits to its own loop require a fresh terminal launch.

Tests:

```sh
pnpm test:dev        # controller, real watcher/process/health integration
pnpm test:dev:smoke  # isolated copy of the real app; compiles and boots Vite + Server
pnpm test:dev:handover  # isolated copy with a real local Agent mid-task across restarts
```

The handover smoke runs a real `hive join` (echo provider that waits
`HIVE_ECHO_DELAY_MS` before replying) under an isolated `pnpm dev` with its own
ports, database and `HOME`. Mid-task it edits Server code, then stops and restarts
`pnpm dev`; both times the same Agent pid must be adopted and the reply delivered.

The smoke test edits only a temporary source copy, uses separate ephemeral ports
and a temporary SQLite database, and disables local Agent startup. It checks all
three backend source roots, frontend source, build/runtime failures, self-reload,
unexpected exits, cached-output recovery with broken sources, favicon imports,
manifest/lock changes, installer failure, source-build recovery without clearing
control errors, real ESM-link validation, generation continuity and cleanup.
The full-app smoke uses a mock installer because its dependency links reference
the checkout; it must never install through those links. A separate regression
runs real offline pnpm install in a dependency-free temporary project. Browser
reload and live provider-task verification remain separate. Full app tests remain
part of `pnpm test`.

The opt-in smoke allows three minutes per build/update phase on busy development
machines; this does not change the Server's health timeout or recovery backoff.
Its temporary Server and pnpm processes are recorded by PID at startup and cleaned
up on failure as well as success, with ownership checked again before signaling.
