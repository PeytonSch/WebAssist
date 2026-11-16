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
| `chrome.captureBodies` | `true` | Capture text and JSON response bodies. |
| `chrome.bodyResourceTypes` | `XHR, Fetch, Document` | Resource types whose bodies are captured. |
| `tomcat.enabled` | `false` | Turn on the Tomcat collectors. |
| `tomcat.appLogs` | `[]` | Application logs. `*` is allowed in the file name. |
| `tomcat.accessLogs` | `[]` | Access logs. |
| `tomcat.accessDurationUnit` | `ms` | Unit of `%D`: `ms` up to Tomcat 9, `us` from Tomcat 10. |
| `tomcat.webappsDir` | | Tomcat's `webapps` folder, for the Tomcat page and WAR deploys. |
| `tomcat.disabledDir` | | Where disabled webapps are moved. Must be outside `webappsDir`. |
| `tomcat.startScript`, `tomcat.stopScript` | | Scripts run by Start Tomcat and Stop Tomcat (`.bat`, `.cmd`, `.ps1`, `.sh` or any program). |
| `tomcat.manager` | | Optional Tomcat Manager login: `{ "url": "http://localhost:8080/manager/text", "username": …, "password": … }`. The password is stored as plain text. |
| `tomcat.warWatch` | `[]` | Folders where WARs are built; `*` matches any folder name, e.g. `C:/dev/*/target`. |
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
- Click the Time column header (or press `O`) to show the newest events at the top instead
  of the bottom. Follow then keeps the top of the list in view. The choice is remembered.
- The session menu switches between the live session and saved ones.
- Shortcuts: `/` search, `M` marker, `J`/`K` or arrows to move, `E` errors only, `F` follow,
  `O` newest/oldest first, `R` reset filters, `Esc` close, `?` help.

## Tomcat page and WAR deploys

The **Tomcat** button in the top bar (or `#tomcat`) opens a page for running Tomcat from Debug
Hub. Set it up under Settings → Tomcat → Management; the page says what is missing.

- **Server.** Start Tomcat and Stop Tomcat run your own scripts, in the script's folder. The
  last run's output and exit code are shown, and the output also goes on the timeline as
  Tomcat events. Debug Hub does not wait for the script: one that keeps Tomcat in the
  foreground shows as still running, and keeps running when Debug Hub closes.
- **Webapps.** Everything in `webapps`, as WAR and/or unpacked folder. With the Tomcat Manager
  set up (a user with the `manager-script` role in `conf/tomcat-users.xml`), each webapp shows
  whether it is running and can be started, stopped and reloaded in place. Without it, a
  webapp is either deployed or disabled.
- **Disable / Enable.** Disable moves a webapp's WAR and unpacked folder out of `webapps` into
  the disabled folder, so Tomcat undeploys it and forgets it; Enable moves it back. Nothing is
  ever overwritten. On Windows, a running Tomcat can keep files locked; the move is then undone
  and the message says to stop the webapp or the server first. With the Manager set up, a
  running webapp is stopped before it is moved.
- **WAR builds.** WARs in the watch folders are listed with when they were built. When a WAR
  is built or rebuilt while Debug Hub runs, a notice appears on every screen (and a desktop
  notification when the window is in the background, if allowed) once the file has stopped
  changing and is a complete archive. **Deploy** copies it into `webapps` under a temporary
  name and renames it to `<name>.war` when complete, so Tomcat never sees half a file; Tomcat
  (with `autoDeploy`, its default) deploys or redeploys it within seconds. The name is guessed
  from the file name, matching a deployed or disabled webapp, without a Maven version
  (`shop-1.4.0-SNAPSHOT.war` deploys as `shop`), and can be changed. Deploying over a disabled
  webapp brings it back with the new build and deletes the old disabled copy, unless you untick
  that. A webapp deployed as a folder without a WAR must be disabled before a WAR can replace
  it.

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
| Tomcat shows "No files match" | The paths are wrong, or Tomcat has not written a log yet. IntelliJ's `CATALINA_BASE` is not the Tomcat install directory; `doctor` prints the real one (on Windows, usually under `%LOCALAPPDATA%\JetBrains\<IDE version>\tomcat\`). |
| No application log lines | IntelliJ shows Tomcat's stdout in its console and usually does not write `catalina.out`. Log to a file. |
| Access log durations are 1000 times too large | Tomcat 10 or later: set `tomcat.accessDurationUnit` to `"us"`. |
| Postgres events are hours off | `log_timezone` differs from the machine's zone. Set it to the local zone or `UTC`. |
| Server events only "Matched by time" | No request ID is flowing yet. See `docs/correlation.md`. |
| Response body missing | Only text and JSON bodies of the configured resource types are captured, and Chrome discards bodies of pages that have navigated away. |
| Port 4000 in use | `npm start -- --port 4001`. |
