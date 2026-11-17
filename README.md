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
| `tomcat.webappsDir` | | Tomcat's `webapps` folder, for the Tomcat page and WAR deploys. |
| `tomcat.disabledDir` | | Where disabled webapps are moved. Must be outside `webappsDir`. |
| `tomcat.startScript`, `tomcat.stopScript` | | Scripts run by Start Tomcat and Stop Tomcat (`.bat`, `.cmd`, `.ps1`, `.sh` or any program). Empty: Tomcat's own `bin/startup` and `bin/shutdown`. |
| `tomcat.home` | (empty) | `CATALINA_HOME`, for Tomcat's own scripts. Empty: the folder above `webappsDir`, if it has `bin`. |
| `tomcat.javaHome` | (empty) | `JAVA_HOME` for Tomcat's own scripts. Empty: Debug Hub's environment. |
| `tomcat.startCommands` | `[]` | Commands run by Start Tomcat before Tomcat: `{ "name", "command", "cwd", "wait" }`. See below. |
| `tomcat.startChrome` | `false` | Start Tomcat also starts Chrome with its debugging port, last. |
| `tomcat.manager` | | Optional Tomcat Manager login: `{ "url": "http://localhost:8080/manager/text", "username": …, "password": … }`. The password is stored as plain text. |
| `tomcat.warWatch` | `[]` | Folders where WARs are built; `*` matches any folder name, e.g. `C:/dev/*/target`. |
| `tomcat.preserveFiles` | `["config.yaml", "config.js", "log4j2.xml"]` | File names (`*` allowed) a deploy can keep from the deployed copy instead of the new build's. |
| `postgres.enabled`, `postgres.logs` | `false`, `[]` | Postgres server logs. |
| `tail.fromStart` | `false` | Read existing log content at startup, not only new lines. |
| `redact.headers` | `authorization, proxy-authorization, cookie, set-cookie` | Header values replaced with `[redacted]` before writing. |
| `maxBodyBytes` | `65536` | Bodies above this are truncated; the event records the original size. |
| `correlation.header` | `X-Request-Id` | Header that carries the request ID. |
| `correlation.logPatterns` | `rid=…`, `requestId=…` | Regexes (one capture group) that find the ID in a log line or SQL comment. |
| `correlation.timeWindowMs` | `2000` | Window for the timing fallback. |
| `api.specs` | `[]` | OpenAPI/Swagger specs for the API screen: `{ "name", "url" }`, the URL an `http(s)://` or `file://` URL or a path (relative to the config file). |
| `api.baseUrl` | (empty) | What `{{baseUrl}}` stands for, instead of the spec's servers. |
| `api.headers` | `[]` | Default headers sent with every API request: `{ "name", "value" }`. **Stored as plain text.** |
| `api.timeoutMs` | `30000` | How long an API request may take. |
| `api.addRequestId` | `true` | Send `correlation.header` with a fresh ID on API requests, unless the request sets it. |
| `api.insecureTls` | `false` | Accept self-signed and otherwise untrusted https certificates on API requests. |

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
- The find bar at the top of the detail panel searches the selected event: its title, facts,
  related events, headers, request and response bodies (all of a large body, not only the part
  on screen) and the raw event JSON. Press `Ctrl+F` (`Cmd+F` on a Mac) to jump to it; `Enter`
  / `Shift+Enter` or `F3` / `Shift+F3` move between matches, which are highlighted, and `Esc`
  clears it. `Aa` makes it case-sensitive and `.*` takes a regular expression. The query stays
  when you select another event, so you can step through events looking for the same text.
- Network rows show the request's **route** in bold, with the parts that vary muted after it:
  `/user/id/12345?x=1` reads as **user/id** `12345 ?x=1`, so calls to the same endpoint are easy
  to spot. Numbers, UUIDs, long hex strings, dates and long tokens count as IDs; an ID in the
  middle shows as `orders/{id}/items`. When an OpenAPI spec is set up for the API client, its
  path templates are used instead (which also catches IDs that look like words, such as a user
  name), and the tooltip names the operation. Search `route:user/id` for every request with that
  route, or `route:/user/id/{id}` for one exact template; **Only this route** in the detail panel
  does the latter.
- The session menu switches between the live session and saved ones.
- Shortcuts: `/` search, `M` marker, `J`/`K` or arrows to move, `E` errors only, `F` follow,
  `O` newest/oldest first, `R` reset filters, `Ctrl+F` find in the selected event, `V` JSON
  viewer, `Esc` close, `?` help.

### JSON viewer

JSON response and request bodies, the raw event, and console or log messages that contain a
JSON object get a **JSON viewer** button in the detail panel (or press `V` with the event
selected). It opens full-window over the timeline; `Esc` or **Back** returns to the same event.

- **Tree**: open and close objects and arrays with the mouse or the arrow keys (`*` opens
  everything below), or open 1, 2, 3 or all levels at once. Large bodies stay quick: only the
  rows on screen are drawn.
- **Selected value**: its path as `data.items[3].price` and as JSONPath `$.data.items[3].price`,
  with Copy buttons, plus Copy value (as JSON) and the whole value. A string that holds JSON
  can be opened as JSON in its own view.
- **Find** searches keys and values; `Enter` / `Shift+Enter` step through the matches, and
  "Only matching" hides the branches without one.
- **Path** shows part of the document: `data.items`, `items[0].name`, `items[*].price`,
  `items[-1]`, `items[1:3]`, `..id` (any depth), `["a-b"]`, and filters such as
  `items[?(@.price > 10 && @.status == "open")]`. Copied paths can be pasted back in.
- **Table** shows an array of objects (by default the first one in the body, or the selected
  one) with a column per key; click a header to sort, a `{…}` or `[…]` cell to open it.
- **Raw** is the pretty-printed text. Copy all and Download save the JSON.

Numbers are shown exactly as sent, so 64-bit IDs are not rounded (they are marked "big").
When a body was cut off at the body size limit, the viewer shows what was captured, says so,
and marks the values that were cut off; raise "Body size limit" in Settings to capture more.
Text that is not valid JSON is shown as captured, with the position of the error marked.

## Tomcat page and WAR deploys

The **Tomcat** button in the top bar (or `#tomcat`) opens a page for running Tomcat from Debug
Hub. Set it up under Settings → Tomcat → Management; the page says what is missing.

- **Server.** Start Tomcat and Stop Tomcat run your own scripts, in the script's folder, or
  without them Tomcat's own `bin/startup.bat` and `bin/shutdown.bat` (`.sh` elsewhere), the
  traditional way: with `CATALINA_HOME` set to the Tomcat folder (by default the folder above
  `webapps`), `CATALINA_BASE` to the folder above `webapps` when that has a `conf` folder, and
  `JAVA_HOME` to the Java folder if one is set. On Windows, Tomcat then opens in its own
  console window, as it does from Explorer. The page says which way each button runs and what
  is missing (on Windows, `startup.bat` needs `JAVA_HOME` or `JRE_HOME`). The last run's output
  and exit code are shown, and the output also goes on the timeline as Tomcat events. Debug Hub
  does not wait for the script: one that keeps Tomcat in the foreground shows as still running,
  and keeps running when Debug Hub closes.
- **Start commands.** To bring up the whole dev setup at once, add start commands under
  Settings → Tomcat server. Start Tomcat runs them first, in order, then Tomcat, then Chrome if
  **Also start Chrome** is on. Each command runs in the system shell (`cmd.exe` on Windows,
  `/bin/sh` elsewhere) in its folder (empty: the settings file's folder), detached, so it keeps
  running when Debug Hub closes; its output goes on the timeline under its name. A command
  marked **wait** must finish, with exit code 0, before the next step, within 5 minutes; if it
  fails or takes longer, the sequence stops and Tomcat is not started (a command that timed out
  is left running). Use it for what Tomcat needs first, e.g. `net start postgresql-x64-16`.
  Other commands are started and left running, e.g. `npm run dev` in the web project's folder;
  one still running from an earlier Start is not started again. The page shows each step's
  progress and each command's status and last lines of output; **Run** runs one command on its
  own and **Stop** ends it with everything it started (`taskkill /T` on Windows, its process
  group elsewhere). **Tomcat only** starts just Tomcat. A second Start while one is under way
  is refused.
- **Webapps.** Everything in `webapps`, as WAR and/or unpacked folder. With the Tomcat Manager
  set up (a user with the `manager-script` role in `conf/tomcat-users.xml`), each webapp shows
  whether it is running and can be started, stopped and reloaded in place. Without it, a
  webapp is either deployed or disabled.
- **Disable / Enable.** Disable moves a webapp's WAR and unpacked folder out of `webapps` into
  the disabled folder, so Tomcat undeploys it and forgets it; Enable moves it back. Nothing is
  ever overwritten. On Windows, a running Tomcat can keep files locked; the move is then undone
  and the message says to stop the webapp or the server first. With the Manager set up, a
  running webapp is stopped before it is moved.
- **Delete.** Deletes a webapp's WAR and unpacked folder for good, from `webapps` or the
  disabled folder, after a confirmation listing every path with its size. The WAR goes first
  (otherwise Tomcat would unpack it again). Links inside the webapp are removed, never followed.
  With the Manager set up, a running webapp is stopped first; files a running Tomcat still holds
  open are retried for a few seconds, then the message says exactly what was deleted and what is
  left. The Manager's `undeploy` is not used: it follows links inside the webapp folder and also
  deletes the webapp's context file in `conf/Catalina`.
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
  it. **Show in Explorer** (Finder on macOS, the folder elsewhere) opens where a WAR was built.
- **Keeping local files.** If the copy being replaced (its unpacked folder, else its WAR, else
  its disabled copy) has files named in `tomcat.preserveFiles` anywhere in it (not under
  `WEB-INF/lib` or `node_modules`), the deploy dialog offers to keep them, ticked by default,
  listing each path. They are written into the new WAR before Tomcat sees it (replacing the
  build's file or added), so the webapp starts with your config. The build itself is not
  changed. ZIP64 (over 4 GB) and encrypted WARs cannot be rewritten; deploy those without
  keeping files.

## API client

The **API** button in the top bar (or `#api`) opens a screen for calling your REST endpoints
directly, and seeing what each call did on the server.

- **Specs.** Add your OpenAPI 3.0/3.1 or Swagger 2.0 spec under Settings → API client: a URL
  (Spring's springdoc serves it at `/v3/api-docs`, springfox at `/v2/api-docs`) or a file.
  JSON is read as is; YAML through a small built-in reader that covers what specs use (block
  maps and lists, quoted and block text, `[ ]` and `{ }`) and names the line of anything else
  (anchors and aliases are not supported). **Load specs** in Settings checks each one. The
  spec's operations are listed by tag, with their parameters, request body and responses;
  `$ref`s within the spec are followed (references to other files are not). The server URL
  comes from the spec (`servers`, or Swagger 2's `schemes`/`host`/`basePath`; relative ones
  are resolved against the spec's URL) unless **Base URL** is set. Default headers are sent
  when fetching a spec only from this machine or the base URL's host.
- **Requests.** Pick an operation, or **+ New** for a request without a spec. The builder fills
  in path, query, header and cookie parameters with the spec's examples (optional ones start
  switched off; typing a value switches them on; enums become a menu), shows the default
  headers from Settings (each can be turned off for the request, or overridden), and can
  generate an example JSON body from the schema (`readOnly` properties are left out). A JSON
  object body is form-encoded when the content type is `application/x-www-form-urlencoded`.
  The URL line shows the URL as it will be sent. **Send** (`Ctrl+Enter`) sends it; **Cancel**
  stops it. The values last used for each operation are remembered in the browser.
- **How it is sent.** The hub sends the request itself, so CORS does not apply and any local
  service can be reached. Redirects are returned as they are unless **Follow redirects** is on.
  With `api.addRequestId` on, the request carries `correlation.header` with a fresh ID, so the
  Tomcat log lines and queries it causes are linked to it on the timeline. Proxy variables
  (`HTTP_PROXY`) are not used.
- **Response.** Status, time, size, headers and the body (pretty-printed and highlighted;
  binary bodies are not shown; up to 10 MB). **Show in timeline** closes the screen and selects
  the request on the timeline, with its server events.
- **On the timeline**, API requests are their own source (**API**), recorded like browser
  requests: a request and its response, headers redacted per `redact.headers`, bodies cut at
  `maxBodyBytes`.
- **Saved requests.** **Save** puts the request in a catalog, with a name, a folder and a
  description; the **Saved** list groups them by folder, and each can be sent at once (▶),
  renamed or moved, duplicated or deleted. A request built from the spec is saved with
  `{{baseUrl}}`, so it still works when the base URL changes. The catalog is
  `api-requests.json` next to the settings file, so it can be backed up or put in git;
  **Export** downloads it and **Import** merges a file into it (by id; variables by name) and
  says what changed. An unreadable file is renamed aside, not overwritten.
- **Variables.** `{{name}}` in a URL, parameter, header or body is filled in from
  **Variables** (stored in the same file); `{{baseUrl}}` is built in. A request with an
  unknown variable is not sent; the screen says which.
- **History.** The last 50 sends are listed under **History** and can be opened again. They
  are kept in the browser's local storage with the request's own headers, but not the default
  headers from Settings.
- **Recorded requests.** A browser (or API) request on the timeline offers **Replay** (send it
  again now, through the hub, and select the new one), **Edit and send** (open it in the
  builder) and **Save to catalog…**. Headers that cannot or should not be sent again are left
  out (`Host`, `Content-Length`, `Connection`, `Accept-Encoding`, `sec-ch-*`, `sec-fetch-*`,
  HTTP/2 pseudo-headers, the old request ID). A header redacted when it was recorded is sent
  from the default headers if one has that name, and otherwise becomes `{{header-name}}`,
  e.g. `{{authorization}}`, to fill in under Variables; Replay says so rather than sending
  `[redacted]`. A body cut off at `maxBodyBytes` when recorded cannot be replayed. Chrome does
  not report cookies with the request, so a cookie-based session has to be given as a
  `Cookie` header.
- **JSON viewer.** `src/ui/api.ts` exports `setJsonViewerOpener(fn)`; once given an opener, the
  response pane shows **Open in JSON viewer** for JSON bodies.

**Plain text:** default headers (`debug-hub.config.json`) and saved requests and variables
(`api-requests.json`) are stored unencrypted. Keep real credentials out of files you share.

## Sessions and privacy

Each session is one JSONL file in `sessions/`, one event per line, and is kept until you
delete it. `sessions/` is in `.gitignore`.

Credential headers are redacted, but **session files can still contain personal data**:
request and response bodies, URLs, query strings, log messages and SQL are stored as captured.
Treat them like application logs.

API client requests are recorded like browser requests: credential headers redacted, bodies
kept up to `maxBodyBytes`.

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
