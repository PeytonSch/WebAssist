# Debug Hub

Records what happens during a local development session and shows it in one timeline:
browser console and network activity from Chrome, Tomcat application and access logs, and
Postgres slow queries and errors. Select a failed request and the server events it caused
appear beside it.

Everything runs on your machine. The server binds to `127.0.0.1` and sends nothing anywhere.

## Status

| Phase | State |
|---|---|
| 0 Discovery | **Open.** Run `npm run doctor` on the development machine (see below). |
| 1 Browser capture | Built. Passes `npm run acceptance` against a real Chromium. |
| 2 Tomcat capture | Built. Tested with Tomcat-format fixture logs, not yet with your Tomcat. |
| 3 Timeline UI | Built. |
| 4 Request-ID correlation | Hub side built. The app-side changes are in `docs/correlation.md`, not applied. |
| 5 Postgres | Log tailing built (slow queries, `auto_explain` plans, errors). The stats poller is not built. |
| 6 Polish | Markers, shortcuts and filter presets built. |

Deviations from the plan are listed in `docs/decisions.md`.

## Desktop app

Debug Hub also runs as a desktop app that updates itself: open it, a splash screen checks
GitHub for a newer release, installs it, and the window opens on the new version. Download the
`.dmg` from the releases page for the first install on a computer. Config and sessions are
under the app's File menu. Releasing is `git tag vX.Y.Z && git push origin vX.Y.Z`; details in
`docs/updates.md`.

## Quick start (from source)

Requires Node.js 18 or later.

```
npm install
```

**Try it without your stack.** Three terminals:

```
npm run demo                 # a stand-in app on :4010 that writes Tomcat- and Postgres-format logs
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/dh-profile http://localhost:4010
npm run demo:hub             # the hub on http://localhost:4000
```

Open http://localhost:4000 in any browser and click the buttons in the demo app.

**Use it with your stack.**

1. Start the IntelliJ session (Vite, Tomcat, Chrome) as usual.
2. `npm run doctor -- --project /path/to/your/app --out docs/environment.md` and read the result.
3. `cp debug-hub.config.example.json debug-hub.config.json` and fill in the paths `doctor` found.
4. `npm start`, then open http://localhost:4000.

## Configuration

`debug-hub.config.json` in the directory you start the hub from (or `--config <file>`).
Relative paths are relative to the config file. Everything is optional.

| Key | Default | Meaning |
|---|---|---|
| `port` | `4000` | UI port. Also `--port`. |
| `sessionsDir` | `sessions` | Where session files are written. |
| `chrome.port` | `9222` | Chrome's remote debugging port. Also `--cdp-port`. |
| `chrome.captureBodies` | `true` | Capture text and JSON response bodies. |
| `chrome.bodyResourceTypes` | `XHR, Fetch, Document` | Resource types whose bodies are captured. |
| `tomcat.enabled` | `false` | Turn on the Tomcat collectors. |
| `tomcat.appLogs` | `[]` | Application logs. `*` is allowed in the file name. |
| `tomcat.accessLogs` | `[]` | Access logs. |
| `tomcat.accessDurationUnit` | `ms` | Unit of `%D`: `ms` up to Tomcat 9, `us` from Tomcat 10. |
| `postgres.enabled`, `postgres.logs` | `false`, `[]` | Postgres server logs. |
| `tail.fromStart` | `false` | Read existing log content at startup, not only new lines. |
| `redact.headers` | `authorization, proxy-authorization, cookie, set-cookie` | Header values replaced with `[redacted]` before writing. |
| `maxBodyBytes` | `65536` | Bodies above this are truncated; the event records the original size. |
| `correlation.header` | `X-Request-Id` | Header that carries the request ID. |
| `correlation.logPatterns` | `rid=…`, `requestId=…` | Regexes (one capture group) that find the ID in a log line or SQL comment. |
| `correlation.timeWindowMs` | `2000` | Window for the timing fallback. |

## Collectors

**Chrome.** Attaches to the running browser over CDP; it never launches one, and it does not
enable the Debugger domain, so it runs alongside IntelliJ's JavaScript debugger. Records
console messages, uncaught exceptions, and requests with status, timing, headers and bodies.
New tabs are attached as they open. If Chrome restarts, the hub reconnects within about a
second. The hub's own UI tab is skipped.

**Tomcat application logs.** Follows the files, including date-rotated ones and truncation.
A line without a leading timestamp is treated as a continuation, so a stack trace is one
event. Understands the Tomcat JUL layout and common Logback, Log4j2 and Spring Boot layouts.

**Tomcat access logs.** Parses the common pattern, and the extended pattern in
`docs/correlation.md` that adds duration and the request ID.

**Postgres.** Follows the server log. Slow statements and `auto_explain` plans become query
events with the SQL and plan separated; `DETAIL`, `HINT` and `STATEMENT` lines are folded
into the error above them.

## Using the timeline

- Filter by source, level and kind; shift-click a filter to show only that one. Search matches
  URLs, messages, bodies and request IDs.
- "Hide assets" hides scripts, styles, images and fonts unless they failed.
- Select a row for details. For a browser request the panel shows the server events that
  share its request ID, or, when there is no ID, events matched by path and time (labelled as
  such).
- The session menu switches between the live session and saved ones.
- Shortcuts: `/` search, `M` marker, `J`/`K` or arrows to move, `E` errors only, `F` follow,
  `R` reset filters, `Esc` close, `?` help.

## Sessions and privacy

Each session is one JSONL file in `sessions/`, one event per line, and is kept until you
delete it. `sessions/` is in `.gitignore`.

Credential headers are redacted, but **session files can still contain personal data**:
request and response bodies, URLs, query strings, log messages and SQL are stored as captured.
Treat them like application logs.

The API rejects requests whose `Host` is not `localhost` or `127.0.0.1`, and requests from
other origins, so another site open in your browser cannot read a session.

## Development

```
npm test              # unit tests (parsers, tailer, store, correlation)
npm run acceptance    # end-to-end against a real Chrome; set CHROME_PATH if it is not found
npm run typecheck
npm run app           # the desktop app, from source
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Chrome stays "waiting" | Nothing is listening on `chrome.port`. Check `curl http://localhost:9222/json`. IntelliJ may start Chrome with `--remote-debugging-pipe` or a random port; `npm run doctor` says which, and how to add `--remote-debugging-port=9222`. |
| Tomcat shows "No files match" | The paths are wrong, or Tomcat has not written a log yet. IntelliJ's `CATALINA_BASE` is not the Tomcat install directory; `doctor` prints the real one. |
| No application log lines | IntelliJ shows Tomcat's stdout in its console and usually does not write `catalina.out`. Log to a file. |
| Access log durations are 1000 times too large | Tomcat 10 or later: set `tomcat.accessDurationUnit` to `"us"`. |
| Postgres events are hours off | `log_timezone` differs from the machine's zone. Set it to the local zone or `UTC`. |
| Server events only "Matched by time" | No request ID is flowing yet. See `docs/correlation.md`. |
| Response body missing | Only text and JSON bodies of the configured resource types are captured, and Chrome discards bodies of pages that have navigated away. |
| Port 4000 in use | `npm start -- --port 4001`. |
