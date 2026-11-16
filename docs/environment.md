# Environment

**Status: not yet verified. Phase 0 is still open.**

The hub was built in a cloud container that cannot see the development machine, so none of
the facts below have been confirmed. Generate this file on the real machine while the
IntelliJ session (Vite, Tomcat, Chrome) is running:

```
npm run doctor -- --project /path/to/the/app --out docs/environment.md
```

`doctor` is read-only. It looks at running processes and files and prints what it finds.

| # | Fact to confirm | How `doctor` finds it | Answer |
|---|---|---|---|
| 1 | CDP port | `--remote-debugging-port` on the Chrome process, then probes `/json` | unknown |
| 2 | Chrome profile is dedicated | `--user-data-dir` on the Chrome process | unknown |
| 3 | Tomcat log location | `-Dcatalina.base` on the Java process, then lists `logs/` | unknown |
| 4 | Logging framework | Scans `pom.xml` / `build.gradle` under `--project` | unknown |
| 5 | Vite proxy | Scans `vite.config.*` under `--project` for `server.proxy` | unknown |
| 6 | Postgres log location and settings | Finds the data directory; the `SHOW` queries are manual | unknown |
| 7 | Platform | `os.platform()` | unknown |

## Things that may need changing on the machine

- **Chrome debugging port.** If IntelliJ starts Chrome with `--remote-debugging-pipe` or a
  random port, add `--remote-debugging-port=9222` under Settings > Tools > Web Browsers >
  Chrome > Edit > Command-line options. `doctor` reports which case applies.
- **Chrome profile.** Chrome 136 and later keep the debugging port closed unless Chrome also
  gets a `--user-data-dir` other than the everyday profile, and a Chrome already running on a
  profile ignores the flags of a new launch on it. `doctor` flags a Chrome that has the port
  but no `--user-data-dir`. The Start Chrome button in Debug Hub starts it correctly.
- **Tomcat application logs.** IntelliJ normally shows Tomcat's stdout in its own console
  and does not write `catalina.out`. The hub can only tail files, so application logging has
  to reach a file (`catalina.<date>.log`, `localhost.<date>.log`, or the app's own log file).

## Open questions from the plan (section 10)

1. Is the browser always Chrome? The hub assumes Chrome.
2. Does the app use a logging framework with MDC support?
3. Is there an existing Vite proxy to Tomcat?
4. How long do sessions last, and how large are typical response bodies?
5. Keep session files by default or delete on exit? The hub currently keeps them.

- [ ] Owner has reviewed this file.
