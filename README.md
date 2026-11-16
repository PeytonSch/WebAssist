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
GitHub for a newer release, installs it, and the window opens on the new version. For the
first install on a computer, download the Windows installer (or the macOS `.dmg`) from the
releases page. Everything is set up in **Settings** (File → Settings…, or `Ctrl+,`), which opens
by itself on the first run; the sessions folder is under the File menu too. On Windows the app
draws its own title bar in the app's theme: the ☰ button at the top left opens the menu
(File, Edit, View, Window), and the top bar drags the window (double-click to maximize). On
macOS the usual window buttons stay at the top left. Releasing is `git tag vX.Y.Z && git push origin vX.Y.Z`; details in
`docs/updates.md`.

## Quick start (from source)

Requires Node.js 18 or later.

```
npm install
```

**Try it without your stack.** Two terminals:

```
npm run demo                 # a stand-in app on :4010 that writes Tomcat- and Postgres-format logs
npm run demo:hub             # the hub on http://localhost:4000
```

Open http://localhost:4000, click **Start Chrome**, open http://localhost:4010 in the Chrome
window that appears and click the buttons in the demo app.

**Use it with your stack.**

1. Start the IntelliJ session (Vite, Tomcat, Chrome) as usual.
2. `npm run doctor -- --project /path/to/your/app --out docs/environment.md` and read the result.
3. `npm start`, open http://localhost:4000, click **Settings** and fill in the paths `doctor`
   found.

## Configuration

The **Settings** screen edits everything below. Each log path shows which files it matches as
you type, and saving applies the change at once without a restart (except `port`). Settings
are stored in `debug-hub.config.json` in the directory you start the hub from (or
`--config <file>`); in the desktop app, in its user-data folder. Keys added by hand are kept
when Settings saves the file.

Relative paths are relative to the config file. Everything is optional. Windows paths can be
written with forward slashes or pasted as they are (`C:\Users\me\logs`).

| Key | Default | Meaning |
|---|---|---|
| `port` | `4000` | UI port. Also `--port`. |
| `sessionsDir` | `sessions` | Where session files are written. |
| `chrome.port` | `9222` | Chrome's remote debugging port. Also `--cdp-port`. |
| `chrome.profileDir` | `chrome-profile` | The `--user-data-dir` that **Start Chrome** uses. Must not be Chrome's everyday profile (see below). |
| `chrome.executable` | empty | Chrome for **Start Chrome**. Empty: the usual install locations (Program Files and `%LOCALAPPDATA%` on Windows, `/Applications` and `~/Applications` on macOS, `google-chrome`/`chromium` on `PATH` on Linux). |
| `chrome.captureBodies` | `true` | Capture text and JSON response bodies. |
| `chrome.bodyResourceTypes` | `XHR, Fetch, Document` | Resource types whose bodies are captured. |
| `tomcat.enabled` | `false` | Turn on the Tomcat collectors. |
| `tomcat.logsDir` | (empty) | A Tomcat logs folder, usually `CATALINA_BASE/logs`. Every log in it is followed; see below. |
| `tomcat.appLogs` | `[]` | Application logs outside the logs folder. `*` is allowed in the file name. |
| `tomcat.accessLogs` | `[]` | Access logs outside the logs folder. |
| `tomcat.webappsDir`, `tomcat.disabledDir` | (empty) | Webapp folders. Their contents are the webapp names used to label events. |
| `tomcat.accessDurationUnit` | `ms` | Unit of `%D`: `ms` up to Tomcat 9, `us` from Tomcat 10. |
| `postgres.enabled`, `postgres.logs` | `false`, `[]` | Postgres server logs. |
| `tail.fromStart` | `false` | Read existing log content at startup, not only new lines. |
| `redact.headers` | `authorization, proxy-authorization, cookie, set-cookie` | Header values replaced with `[redacted]` before writing. |
| `maxBodyBytes` | `65536` | Bodies above this are truncated; the event records the original size. |
| `correlation.header` | `X-Request-Id` | Header that carries the request ID. |
| `correlation.logPatterns` | `rid=…`, `requestId=…` | Regexes (one capture group) that find the ID in a log line or SQL comment. |
| `correlation.timeWindowMs` | `2000` | Window for the timing fallback. |

## Collectors

**Chrome.** Attaches to a running browser over CDP, and does not enable the Debugger domain,
so it runs alongside IntelliJ's JavaScript debugger. Records console messages, uncaught
exceptions, and requests with status, timing, headers and bodies. New tabs are attached as they
open. If Chrome restarts, the hub reconnects within about a second. The hub's own UI tab is
skipped.

Chrome has to be started with a debugging port **and a profile folder of its own**: Chrome 136
and later silently keep the port closed on the everyday profile, and a Chrome that is already
running on the profile you start takes the new window over and drops the flags. The easiest
way is the **Start Chrome** button (in the timeline while Chrome is not connected, on the
Chrome status pill in the top bar, and under Settings > Browser). It starts Chrome directly,
with `--remote-debugging-port=<chrome.port> --user-data-dir=<chrome.profileDir>`, does nothing
if Chrome already answers on the port, and says what went wrong if the port does not open.
Settings > Browser also shows the same command to run yourself (on Windows, for Command Prompt
and for PowerShell) with every path written out, so it can go into a shortcut or an IntelliJ
browser configuration.

**Tomcat logs folder.** With `tomcat.logsDir` set, every file in the folder is followed:
names containing `access_log` as access logs, everything else as application logs, and files
that appear later (the next day's logs) as they appear. Compressed archives and lock files are
skipped, and a file also listed under `appLogs` or `accessLogs` is left to that list. Old
rotated files cost almost nothing: files not written for an hour are only checked every few
seconds, and even with `tail.fromStart` files older than a day are not replayed.

**Tomcat application logs.** Follows the files, including date-rotated ones and truncation.
A line that starts with neither a timestamp nor a level is treated as a continuation, so a
stack trace is one event. Understands the Tomcat JUL layout, JUL's two-line default layout,
and common Logback, Log4j, Log4j2 and Spring Boot layouts, including level-first lines without
a timestamp (`DEBUG com.example.Foo - …`) that console appenders write into `catalina.out`.

**Webapp labels.** Each Tomcat log entry and access-log request is labelled with the webapp it
came from, where that can be told: by the log file's name (`shop.2026-11-16.log` is `shop`;
Tomcat's own `catalina`, `localhost` and `manager` logs name no webapp), by Tomcat's context
markers in the message (`in context with path [/shop]`, `Deploying web application directory
[…/webapps/shop]`), and for requests by their context path. Request paths are only matched
against webapps the hub knows: the contents of `tomcat.webappsDir` and `tomcat.disabledDir`
(or the `webapps` folder next to the logs folder), plus names seen in log file names and
deployment messages. `ROOT` is the `/` app.

**Tomcat access logs.** Parses the common pattern, and the extended pattern in
`docs/correlation.md` that adds duration and the request ID.

**Postgres.** Follows the server log. Slow statements and `auto_explain` plans become query
events with the SQL and plan separated; `DETAIL`, `HINT` and `STATEMENT` lines are folded
into the error above them.

## Using the timeline

- Filter by source, level and kind; shift-click a filter to show only that one. Search matches
  URLs, messages, bodies, request IDs and webapp names.
- Tomcat rows show their webapp next to the event. Once there are labelled events, a Webapp
  filter appears (a menu when there are more than three choices) that hides Tomcat events of
  webapps you are not working on; "No webapp" covers Tomcat events without a label. It does not
  affect browser or Postgres events, and is saved with filter presets.
- "Hide assets" hides scripts, styles, images and fonts unless they failed.
- Select a row for details. For a browser request the panel shows the server events that
  share its request ID, or, when there is no ID, events matched by path and time (labelled as
  such).
- Click the Time column header (or press `O`) to show the newest events at the top instead
  of the bottom. Follow then keeps the top of the list in view. The choice is remembered.
- The session menu switches between the live session and saved ones.
- Shortcuts: `/` search, `M` marker, `J`/`K` or arrows to move, `E` errors only, `F` follow,
  `O` newest/oldest first, `R` reset filters, `Esc` close, `?` help.

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
| Chrome stays "waiting" | Hover the Chrome pill for the reason. "Nothing is listening": Chrome was started without the port, or on its everyday profile (Chrome 136 and later ignore the port there; `chrome://version` then shows no `--user-data-dir` and a Profile Path under `Google\Chrome\User Data`), or a Chrome already running on that profile swallowed the flags. Close Chrome on that profile and use **Start Chrome**. "Something other than Chrome": another program has the port; pick another `chrome.port`. IntelliJ may start Chrome with `--remote-debugging-pipe` or a random port; `npm run doctor` says which. |
| The copied command does nothing in PowerShell | PowerShell needs `&` before a quoted program path and does not expand `%VARIABLES%`. Use the PowerShell line under Settings > Browser. |
| Tomcat shows "No files match" | The paths are wrong, or Tomcat has not written a log yet. IntelliJ's `CATALINA_BASE` is not the Tomcat install directory; `doctor` prints the real one (on Windows, usually under `%LOCALAPPDATA%\JetBrains\<IDE version>\tomcat\`). |
| No application log lines | IntelliJ shows Tomcat's stdout in its console and usually does not write `catalina.out`. Log to a file. |
| Access log durations are 1000 times too large | Tomcat 10 or later: set `tomcat.accessDurationUnit` to `"us"`. |
| Postgres events are hours off | `log_timezone` differs from the machine's zone. Set it to the local zone or `UTC`. |
| Server events only "Matched by time" | No request ID is flowing yet. See `docs/correlation.md`. |
| Response body missing | Only text and JSON bodies of the configured resource types are captured, and Chrome discards bodies of pages that have navigated away. |
| Port 4000 in use | `npm start -- --port 4001`. |
