# Decisions that deviate from the plan

| # | Plan said | What was done | Why |
|---|---|---|---|
| 1 | Finish Phase 0 and get sign-off before writing capture code. | Capture code was written first. Every environment fact is a config value, and `debug-hub doctor` performs the Phase 0 discovery on the real machine. | The owner asked to start building, and the build environment cannot see the development machine. Phase 0 is still open; see `environment.md`. |
| 2 | Do not start Phase 4 until Phases 1 to 3 pass. | The hub side of Phase 4 (linking by request ID in the UI) and the Postgres log tailer from Phase 5 are built. | Phases 1 to 3 pass against a fixture app and a real Chromium (`npm run acceptance`). They have not been run against the owner's stack, and the app-side Phase 4 changes (proxy hook, access log pattern, MDC filter) are documented but not applied. |
| 3 | File watching with `chokidar`. | A small polling tailer (`src/server/collectors/tail.ts`). | Tomcat on Windows keeps log files open and file-change events are unreliable there; polling behaves the same on every platform and removes a dependency. |
| 4 | `fastify`, or plain `ws`. | Node's `http` module plus `ws`. | Six routes do not need a framework. `ws` is the only runtime dependency. |
| 5 | React or plain TypeScript UI. | Plain TypeScript, bundled with esbuild, no UI framework. | Dependency-light, as the plan asked. |
| 6 | `source` is `browser`, `tomcat` or `postgres`; `kind` has six values. | Added `source: "hub"` and `kind: "marker"` for user markers. | Markers need to live in the session file so they replay. |
| 7 | Request-ID injection: set `X-Request-Id` on proxied requests. | The proxy hook also echoes the ID on the response. | The browser never sees headers the proxy adds to the upstream request, so the response is the only place Chrome can read the ID from. |
| 8 | UI shows request and response events. | Both are stored as separate events, but the UI folds a response into its request's row. | One row per HTTP exchange is easier to read. |
| 9 | Postgres stats collector (optional). | Not built. | Optional in the plan, and it needs a live database to test against. |
| 10 | Timestamps converted to a single time zone. | Log timestamps with no zone, or a zone abbreviation other than UTC/GMT, are read as the hub machine's local time. | Abbreviations such as `PST` are ambiguous. If Postgres has `log_timezone` set to something other than the machine's zone or UTC, its events will be offset. |
| 11 | Session files kept or deleted (open question). | Kept. | Replay needs them. Delete files from `sessions/` to remove them. |
| 12 | A local process with a web UI on `localhost:4000`. | Also ships as a desktop app (Electron) that updates itself from GitHub Releases. `npm start` still works. | Requested by the owner after the first build. See `updates.md`. |
| 13 | n/a | The updater replaces a small payload in the user-data folder instead of the installed app, unlike GooseFluence's updater, which swaps the whole `.app`. | Updating has to finish before the window opens, so it must be fast; and leaving the bundle untouched keeps the ad-hoc signature valid. The cost: changes to the shell itself need a reinstall. |
| 14 | n/a | macOS only in CI. | Matches the owner's GooseFluence setup. The updater and shell also ran on Linux during testing; Windows is untested. |
