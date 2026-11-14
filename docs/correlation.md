# Request-ID correlation

## Which level is active

| Level | What it needs | Status |
|---|---|---|
| 1. Timing fallback | Nothing | **Active.** The UI labels these matches "Matched by time". |
| 2. Header injection | Vite proxy hook, access log pattern, logging filter | Hub side built and tested against the fixture app. **App side not applied yet.** |
| 3. Database | `application_name`, `log_line_prefix`, SQL comments | Hub reads `rid=` SQL comments. **App side not applied yet.** |

When events share an ID the UI labels the match "Same request ID". IDs always win over timing:
an event that carries an ID is never claimed by a time-window match.

The snippets below were written for this plan and have not been run against the real app.

## Level 2: header injection

### 1. Vite proxy

`integrations/vite-request-id.mjs` wraps a proxy entry. It sets `X-Request-Id` on the request
to Tomcat and echoes it on the response, which is where the browser reads it.

```js
import { withRequestId } from '/path/to/WebAssist/integrations/vite-request-id.mjs';

export default defineConfig({
  server: { proxy: { '/api': withRequestId({ target: 'http://localhost:8080', changeOrigin: true }) } },
});
```

### 2. Tomcat access log (`$CATALINA_BASE/conf/server.xml`)

```xml
<Valve className="org.apache.catalina.valves.AccessLogValve" directory="logs"
       prefix="localhost_access_log" suffix=".txt"
       pattern="%h %l %u [%{yyyy-MM-dd'T'HH:mm:ss.SSSXXX}t] &quot;%r&quot; %s %b %D &quot;%{X-Request-Id}i&quot;" />
```

The bracketed timestamp gives millisecond precision; the default `%t` also works but only to
the second. `%D` is milliseconds up to Tomcat 9 and microseconds from Tomcat 10: set
`tomcat.accessDurationUnit` to `"us"` for Tomcat 10 or later. IntelliJ copies `server.xml`
into its own `CATALINA_BASE`, so edit the one `doctor` reports.

### 3. Application log

A servlet filter puts the header into the logging context. Use `javax.servlet` instead of
`jakarta.servlet` on Tomcat 9 or earlier.

```java
public class RequestIdFilter implements jakarta.servlet.Filter {
    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        String rid = ((HttpServletRequest) req).getHeader("X-Request-Id");
        if (rid != null) org.slf4j.MDC.put("rid", rid);   // Log4j2 without SLF4J: ThreadContext.put
        try {
            chain.doFilter(req, res);
        } finally {
            org.slf4j.MDC.remove("rid");
        }
    }
}
```

Then print it in the log pattern as `[rid=%X{rid}]` (Logback and Log4j2 use the same syntax).
JUL has no MDC; with JUL, rely on the access log line plus timing for the application log.

The hub finds IDs in log lines with `correlation.logPatterns`. The default matches
`rid=…`, `requestId=…`, `request_id: …` and `X-Request-Id: …`.

## Level 3: database

- JDBC URL: add `?ApplicationName=myapp`.
- `postgresql.conf`: `log_line_prefix = '%m [%p] %a '`, `log_min_duration_statement = 250`.
- For plans: `shared_preload_libraries = 'auto_explain'`, `auto_explain.log_min_duration = 250`,
  `auto_explain.log_analyze = on`.
- To tie a slow query to its request, prefix SQL with a comment in the data layer:
  `/* rid=<id> */ SELECT …`. The hub reads it from both statement and plan entries.
