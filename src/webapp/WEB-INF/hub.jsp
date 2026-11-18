<%--
  Debug Hub inside Tomcat: the launcher and the proxy, in one page.

  Debug Hub is a Node.js program. This page is the whole Java side of the webapp:

    jspInit      starts the hub (WEB-INF/hub/hub.cjs) as a child process when the webapp starts,
                 tells it where it is deployed, and restarts it if it stops by itself.
    the page     forwards every request under the webapp's context path to the hub, which
                 listens on a private port on 127.0.0.1 and only answers this launcher.
    jspDestroy   stops the hub when the webapp stops (undeploy, redeploy, Tomcat shutdown).

  It is a JSP, mapped to /* in web.xml and loaded on startup, rather than a compiled servlet,
  so that one WAR runs on Tomcat 9 (javax.servlet) and Tomcat 10 and 11 (jakarta.servlet):
  Tomcat compiles it against whichever API it has. For the same reason the code keeps to
  Java 6 syntax (no lambdas, no diamond, no try-with-resources): old Tomcats compile JSPs at
  that level by default.

  Settings, each read as the Java system property debughub.<name>, else the environment
  variable DEBUG_HUB_<NAME>, else the context parameter debughub.<name>:

    node     the Node.js program to run (default: node on the PATH, then the usual places)
    data     where settings and sessions are kept (default: <catalina.base>/debug-hub-data)
    remote   who may connect besides this computer: all, or addresses and networks
    hosts    extra host names Debug Hub may be reached under
    role     a Tomcat role (conf/tomcat-users.xml) every user must log in with

  No template text may be written by this page: the proxy uses the response's output stream.
--%><%@ page session="false" trimDirectiveWhitespaces="true" pageEncoding="UTF-8"
    import="java.io.*,java.net.*,java.nio.charset.Charset,java.security.SecureRandom,java.text.SimpleDateFormat,java.util.*" %><%!

  private static final Charset UTF8 = Charset.forName("UTF-8");
  /** The line the hub prints once it listens. */
  private static final String READY = "DEBUG_HUB_READY port=";
  private static final int MIN_NODE = 18;
  private static final long MAX_LOG_BYTES = 5L * 1024 * 1024;

  /** Request headers that are not passed on: per-connection ones, and credentials meant for Tomcat. */
  private static final Set<String> NOT_FORWARDED = new HashSet<String>(Arrays.asList(
      "host", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "expect",
      "cookie", "authorization", "origin", "via", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"));
  private static final Set<String> NOT_RETURNED = new HashSet<String>(Arrays.asList("connection", "keep-alive", "transfer-encoding", "date"));

  /**
   * Variables Tomcat's own scripts set. The hub starts other programs (start commands, another
   * Tomcat's startup script), which must not inherit them: CATALINA_HOME in the environment
   * would make another Tomcat's startup.bat start this one.
   */
  private static final String[] TOMCAT_ENV = {
      "CATALINA_HOME", "CATALINA_BASE", "CATALINA_TMPDIR", "CATALINA_OPTS", "CATALINA_PID", "CATALINA_OUT", "CATALINA_LOGGING_CONFIG",
      "JAVA_OPTS", "JDK_JAVA_OPTIONS", "JPDA_ADDRESS", "JPDA_TRANSPORT", "JPDA_SUSPEND", "JPDA_OPTS", "JSSE_OPTS", "LOGGING_CONFIG",
      "LOGGING_MANAGER", "JAVA_ENDORSED_DIRS", "ENDORSED_PROP", "_RUNJAVA", "_RUNJDB", "_EXECJAVA", "MAINCLASS", "ACTION", "SECURITY_POLICY_FILE" };

  private final Object lock = new Object();
  private volatile boolean stopping;
  private volatile Process hub;
  /** 0 until the hub says which port it listens on. */
  private volatile int hubPort;
  /** starting, running, restarting, no-node, old-node, failed. */
  private volatile String state = "starting";
  /** Why the hub is not running, in a sentence anyone may read. */
  private volatile String problem = "";
  /** More about it (paths, the end of the log), shown only to a browser on this computer. */
  private volatile String detail = "";
  private Thread supervisor;
  /** Requests being forwarded to the hub right now. */
  private final java.util.concurrent.atomic.AtomicInteger forwarding = new java.util.concurrent.atomic.AtomicInteger();

  private String secret;
  private String contextPath = "";
  private String webappDir;
  private String serverInfo = "";
  private File hubScript;
  private File dataDir;
  private File logFile;
  private final LinkedList<String> lastLines = new LinkedList<String>();

  // ── Settings ────────────────────────────────────────────

  private static boolean blank(String s) {
    return s == null || s.trim().length() == 0;
  }

  private String setting(String name) {
    String v = System.getProperty("debughub." + name);
    if (blank(v)) v = System.getenv("DEBUG_HUB_" + name.toUpperCase(Locale.ENGLISH));
    if (blank(v)) v = getServletConfig().getServletContext().getInitParameter("debughub." + name);
    return blank(v) ? null : v.trim();
  }

  private static boolean windows() {
    return System.getProperty("os.name", "").toLowerCase(Locale.ENGLISH).indexOf("win") >= 0;
  }

  // ── Start and stop ──────────────────────────────────────

  public void jspInit() {
    ServletContext app = getServletConfig().getServletContext();
    contextPath = app.getContextPath() == null ? "" : app.getContextPath();
    webappDir = app.getRealPath("/");
    serverInfo = app.getServerInfo() == null ? "" : app.getServerInfo();

    String base = System.getProperty("catalina.base", System.getProperty("user.dir"));
    String configured = setting("data");
    dataDir = configured != null ? new File(configured) : new File(base, "debug-hub-data");
    if (!usable(dataDir)) {
      // Tomcat's folder is read-only for the account it runs as: fall back to that account's home.
      File home = new File(System.getProperty("user.home", "."), ".debug-hub");
      if (usable(home)) dataDir = home;
    }
    File logs = new File(base, "logs");
    logFile = new File(logs.isDirectory() && logs.canWrite() ? logs : dataDir, "debug-hub.log");
    if (logFile.length() > MAX_LOG_BYTES) {
      File old = new File(logFile.getPath() + ".1");
      old.delete();
      logFile.renameTo(old);
    }

    byte[] random = new byte[32];
    new SecureRandom().nextBytes(random);
    StringBuilder hex = new StringBuilder();
    for (int i = 0; i < random.length; i++) hex.append(String.format("%02x", Integer.valueOf(random[i] & 0xff)));
    secret = hex.toString();

    try {
      if (webappDir != null) hubScript = new File(new File(webappDir, "WEB-INF"), "hub" + File.separator + "hub.cjs");
      else {
        // Tomcat runs the webapp from the WAR without unpacking it: Node needs real files.
        File runtime = new File(dataDir, "hub-runtime");
        copyTree(app, "/WEB-INF/hub/", runtime);
        hubScript = new File(runtime, "hub.cjs");
      }
    } catch (IOException e) {
      hubScript = null;
      detail = String.valueOf(e);
    }

    note("Debug Hub webapp started at " + (contextPath.length() == 0 ? "/" : contextPath) + " in " + serverInfo);
    supervisor = new Thread(new Runnable() {
      public void run() {
        supervise();
      }
    }, "debug-hub-supervisor");
    supervisor.setDaemon(true);
    supervisor.start();
  }

  public void jspDestroy() {
    stopping = true;
    synchronized (lock) {
      lock.notifyAll();
    }
    Process p = hub;
    if (p != null) {
      // Closing its stdin asks the hub to finish its session file and exit. Tomcat deletes the
      // webapp folder next, so wait until the process is really gone.
      try {
        p.getOutputStream().close();
      } catch (IOException e) {
        // already closed
      }
      if (!exited(p, 6000)) {
        p.destroy();
        if (!exited(p, 3000)) {
          try {
            Process.class.getMethod("destroyForcibly").invoke(p);
          } catch (Exception e) {
            // Java 7: destroy() is all there is
          }
          exited(p, 3000);
        }
      }
    }
    if (supervisor != null) {
      supervisor.interrupt();
      try {
        supervisor.join(3000);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
    }
    // With the hub gone, requests still being forwarded (the live streams) end by themselves;
    // give them a moment, so Tomcat does not find its request threads still in this webapp.
    for (int i = 0; i < 40 && forwarding.get() > 0; i++) {
      try {
        Thread.sleep(50);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        break;
      }
    }
    note("Debug Hub webapp stopped");
  }

  private static boolean usable(File dir) {
    return (dir.isDirectory() || dir.mkdirs()) && dir.canWrite();
  }

  private static boolean exited(Process p, long ms) {
    long end = System.currentTimeMillis() + ms;
    while (true) {
      try {
        p.exitValue();
        return true;
      } catch (IllegalThreadStateException running) {
        if (System.currentTimeMillis() >= end) return false;
      }
      try {
        Thread.sleep(50);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return false;
      }
    }
  }

  private void copyTree(ServletContext app, String path, File dir) throws IOException {
    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
    Set<?> children = app.getResourcePaths(path);
    if (children == null) return;
    for (Object o : children) {
      String child = (String) o;
      String name = child.substring(path.length());
      if (child.endsWith("/")) {
        copyTree(app, child, new File(dir, name.substring(0, name.length() - 1)));
        continue;
      }
      InputStream in = app.getResourceAsStream(child);
      if (in == null) continue;
      OutputStream out = new FileOutputStream(new File(dir, name));
      try {
        byte[] buf = new byte[16384];
        for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
      } finally {
        out.close();
        in.close();
      }
    }
  }

  private void setState(String newState, String why, String more) {
    synchronized (lock) {
      state = newState;
      problem = why;
      detail = more;
      lock.notifyAll();
    }
  }

  /** Keeps the hub running until the webapp stops. */
  private void supervise() {
    long wait = 1000;
    while (!stopping) {
      long started = System.currentTimeMillis();
      Process p = null;
      try {
        p = startHub();
      } catch (Throwable t) {
        setState("failed", "Debug Hub could not be started.", String.valueOf(t));
        note("could not start the hub: " + t);
      }
      if (p != null) {
        hub = p;
        // If the webapp was stopped just as the hub was started, jspDestroy has not seen it.
        if (stopping) p.destroy();
        readOutput(p);
        int code = -1;
        try {
          code = p.waitFor();
        } catch (InterruptedException e) {
          p.destroy();
        }
        hub = null;
        hubPort = 0;
        if (stopping) break;
        note("the hub stopped by itself (exit code " + code + "); starting it again");
        setState("restarting", "Debug Hub stopped unexpectedly and is being started again.", tail());
        // Back off when it keeps failing right away; start over once it ran for a while.
        wait = System.currentTimeMillis() - started > 60000 ? 1000 : Math.min(wait * 2, 30000);
      } else {
        // No usable Node.js: look again, in case it is installed meanwhile.
        wait = 10000;
      }
      synchronized (lock) {
        if (!stopping) {
          try {
            lock.wait(wait);
          } catch (InterruptedException e) {
            // stopping
          }
        }
      }
    }
  }

  /** Starts the hub process, or returns null (with the state saying why) when it cannot be. */
  private Process startHub() throws IOException {
    if (hubScript == null || !hubScript.isFile()) {
      setState("failed", "The Debug Hub program is missing from the webapp (WEB-INF/hub/hub.cjs).", detail);
      return null;
    }
    String node = findNode();
    if (node == null) return null;

    ProcessBuilder pb = new ProcessBuilder(node, hubScript.getAbsolutePath());
    // Not the webapp folder: on Windows a process's working folder cannot be deleted, and Tomcat deletes the webapp on undeploy.
    pb.directory(dataDir);
    pb.redirectErrorStream(true);
    Map<String, String> env = pb.environment();
    for (int i = 0; i < TOMCAT_ENV.length; i++) env.remove(TOMCAT_ENV[i]);
    String classpath = env.get("CLASSPATH");
    if (classpath != null && classpath.indexOf("bootstrap.jar") >= 0) env.remove("CLASSPATH");
    env.put("DEBUG_HUB_HOSTED", "tomcat");
    env.put("DEBUG_HUB_SECRET", secret);
    env.put("DEBUG_HUB_CONTEXT_PATH", contextPath);
    env.put("DEBUG_HUB_WEBAPP_DIR", webappDir == null ? "" : webappDir);
    env.put("DEBUG_HUB_CATALINA_BASE", System.getProperty("catalina.base", ""));
    env.put("DEBUG_HUB_CATALINA_HOME", System.getProperty("catalina.home", ""));
    env.put("DEBUG_HUB_JAVA_HOME", System.getProperty("java.home", ""));
    env.put("DEBUG_HUB_SERVER_INFO", serverInfo);
    env.put("DEBUG_HUB_DATA", dataDir.getAbsolutePath());
    env.put("DEBUG_HUB_LOG", logFile.getAbsolutePath());
    String remote = setting("remote");
    String hosts = setting("hosts");
    env.put("DEBUG_HUB_REMOTE", remote == null ? "" : remote);
    env.put("DEBUG_HUB_HOSTS", hosts == null ? "" : hosts);
    env.remove("DEBUG_HUB_NODE");

    setState("starting", "", "");
    note("starting the hub: " + node + " " + hubScript.getAbsolutePath());
    return pb.start();
  }

  /** A Node.js that is new enough, or null (with the state saying what is wrong). */
  private String findNode() {
    String configured = setting("node");
    List<String> candidates = new ArrayList<String>();
    if (configured != null) candidates.add(configured);
    else {
      candidates.add("node");
      if (windows()) {
        String[] roots = { System.getenv("ProgramFiles"), System.getenv("ProgramW6432"), System.getenv("ProgramFiles(x86)") };
        for (int i = 0; i < roots.length; i++) if (!blank(roots[i])) candidates.add(roots[i] + "\\nodejs\\node.exe");
        if (!blank(System.getenv("LOCALAPPDATA"))) candidates.add(System.getenv("LOCALAPPDATA") + "\\Programs\\nodejs\\node.exe");
      } else {
        candidates.addAll(Arrays.asList("/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node", "/snap/bin/node"));
      }
    }
    List<String> missing = new ArrayList<String>();
    String tooOld = null;
    for (String candidate : candidates) {
      String version = nodeVersion(candidate);
      if (version == null) {
        missing.add(candidate);
        continue;
      }
      int major = 0;
      try {
        major = Integer.parseInt(version.substring(1, version.indexOf('.')));
      } catch (RuntimeException e) {
        // not a version: counts as too old
      }
      if (major >= MIN_NODE) return candidate;
      if (tooOld == null) tooOld = candidate + " is Node.js " + version;
    }
    if (tooOld != null) {
      setState("old-node", "Debug Hub needs Node.js " + MIN_NODE + " or later, and the one on this server is older.", tooOld + ".");
    } else {
      setState("no-node", "Debug Hub needs Node.js (" + MIN_NODE + " or later), which was not found on this server.",
          (configured != null ? "debughub.node is set to " : "Looked for ") + missing + ".");
    }
    return null;
  }

  /** What "<node> --version" prints, e.g. v22.14.0, or null when it cannot be run. */
  private static String nodeVersion(String node) {
    boolean isPath = node.indexOf('/') >= 0 || node.indexOf('\\') >= 0;
    if (isPath && !new File(node).isFile()) return null;
    Process p = null;
    try {
      ProcessBuilder pb = new ProcessBuilder(node, "--version");
      pb.redirectErrorStream(true);
      p = pb.start();
      p.getOutputStream().close();
      BufferedReader in = new BufferedReader(new InputStreamReader(p.getInputStream(), UTF8));
      String line = in.readLine();
      in.close();
      return line != null && line.trim().matches("v\\d+\\.\\S*") ? line.trim() : null;
    } catch (IOException e) {
      return null;
    } finally {
      if (p != null) p.destroy();
    }
  }

  /** Copies what the hub prints to the log until it exits, and picks out the line that says it is ready. */
  private void readOutput(Process p) {
    BufferedReader in = new BufferedReader(new InputStreamReader(p.getInputStream(), UTF8));
    try {
      for (String line; (line = in.readLine()) != null; ) {
        if (line.startsWith(READY)) {
          try {
            hubPort = Integer.parseInt(line.substring(READY.length()).trim());
            setState("running", "", "");
          } catch (NumberFormatException e) {
            note(line);
          }
        } else note(line);
      }
    } catch (IOException e) {
      // the hub went away
    } finally {
      try {
        in.close();
      } catch (IOException e) {
        // nothing to do
      }
    }
  }

  /** One line in logs/debug-hub.log, in the layout of Tomcat's own log so tools read it the same way. */
  private synchronized void note(String line) {
    lastLines.add(line);
    while (lastLines.size() > 25) lastLines.removeFirst();
    if (logFile == null) return;
    Writer out = null;
    try {
      out = new OutputStreamWriter(new FileOutputStream(logFile, true), UTF8);
      out.write(new SimpleDateFormat("dd-MMM-yyyy HH:mm:ss.SSS", Locale.ENGLISH).format(new Date()) + " INFO [debug-hub] " + line + System.getProperty("line.separator"));
    } catch (IOException e) {
      // a log that cannot be written must not stop the hub
    } finally {
      if (out != null) {
        try {
          out.close();
        } catch (IOException e) {
          // nothing to do
        }
      }
    }
  }

  private synchronized String tail() {
    StringBuilder sb = new StringBuilder();
    for (String line : lastLines) sb.append(line).append('\n');
    return sb.toString();
  }

  // ── Answers of the launcher itself ──────────────────────

  private static String html(String s) {
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
  }

  private static String json(String s) {
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\') sb.append('\\').append(c);
      else if (c == '\n') sb.append("\\n");
      else if (c < 0x20 || c == '<' || c == '>') sb.append(String.format("\\u%04x", Integer.valueOf(c)));
      else sb.append(c);
    }
    return sb.append('"').toString();
  }

  /** A browser on this computer, which may be told paths and log lines. */
  private static boolean local(HttpServletRequest request) {
    if (request.getHeader("X-Forwarded-For") != null || request.getHeader("Forwarded") != null || request.getHeader("X-Real-IP") != null) return false;
    try {
      return InetAddress.getByName(request.getRemoteAddr()).isLoopbackAddress();
    } catch (Exception e) {
      return false;
    }
  }

  private static void send(HttpServletResponse response, int status, String contentType, String body) throws IOException {
    byte[] bytes = body.getBytes(UTF8);
    response.setStatus(status);
    response.setContentType(contentType);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setContentLength(bytes.length);
    OutputStream out = response.getOutputStream();
    out.write(bytes);
    out.flush();
  }

  private static void page(HttpServletResponse response, int status, String title, String bodyHtml, int refreshSeconds) throws IOException {
    String refresh = refreshSeconds > 0 ? "<meta http-equiv=\"refresh\" content=\"" + refreshSeconds + "\">" : "";
    send(response, status, "text/html; charset=UTF-8", "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" + refresh + "<title>Debug Hub</title><style>"
        + "body{font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2430;background:#f6f7f9;margin:0}"
        + "main{max-width:660px;margin:9vh auto;padding:28px 32px;background:#fff;border:1px solid #e3e6ec;border-radius:12px}"
        + "h1{font-size:20px;margin:0 0 12px}code,pre{font:13px ui-monospace,Consolas,monospace;background:#f1f3f7;border-radius:5px}"
        + "code{padding:1px 5px}pre{padding:10px 12px;overflow-x:auto;white-space:pre-wrap}.muted{color:#667085}"
        + "@media (prefers-color-scheme:dark){body{background:#0b0d12;color:#e6e8ee}main{background:#151821;border-color:#262a36}code,pre{background:#1e2230}.muted{color:#98a2b3}}"
        + "</style></head><body><main><h1>" + html(title) + "</h1>" + bodyHtml + "</main></body></html>\n");
  }

  /** What is said instead of the UI while the hub is not running. */
  private void unavailable(HttpServletRequest request, HttpServletResponse response, String path) throws IOException {
    String st = state;
    String why = problem;
    boolean waiting = "starting".equals(st) || "running".equals(st) || "restarting".equals(st);
    if (blank(why)) why = waiting ? "Debug Hub is starting. This takes a few seconds." : "Debug Hub is not running.";
    response.setHeader("Retry-After", "2");
    if (path.equals("/api") || path.startsWith("/api/")) {
      send(response, 503, "application/json; charset=UTF-8", "{\"error\":" + json(why) + ",\"state\":" + json(st) + "}");
      return;
    }
    StringBuilder body = new StringBuilder("<p>" + html(why) + "</p>");
    if ("no-node".equals(st) || "old-node".equals(st)) {
      body.append("<p>Debug Hub is a Node.js program that this webapp starts. Install Node.js " + MIN_NODE + " or later on the server")
          .append(" (<code>nodejs.org</code>), or say where it is with the Java system property <code>debughub.node</code>, for example")
          .append(" <code>-Ddebughub.node=/usr/local/bin/node</code> in <code>CATALINA_OPTS</code>, or the environment variable")
          .append(" <code>DEBUG_HUB_NODE</code>.</p><p class=\"muted\">It is looked for again every 10 seconds, and this page reloads by itself:")
          .append(" installed in its usual place, Node.js is found without redeploying anything.")
          .append(" A changed PATH, system property or environment variable needs a Tomcat restart.</p>");
    } else if (waiting) {
      body.append("<p class=\"muted\">This page reloads by itself.</p>");
    }
    if (local(request)) {
      if (!blank(detail)) body.append("<pre>").append(html(detail)).append("</pre>");
      body.append("<p class=\"muted\">Log: <code>").append(html(String.valueOf(logFile))).append("</code></p>");
    } else {
      body.append("<p class=\"muted\">The details are in <code>debug-hub.log</code> in Tomcat's logs folder on the server.</p>");
    }
    String title = "no-node".equals(st) ? "Node.js is needed" : "old-node".equals(st) ? "A newer Node.js is needed" : waiting ? "Debug Hub is starting" : "Debug Hub is not running";
    page(response, 503, title, body.toString(), waiting ? 2 : 10);
  }

  // ── The proxy ───────────────────────────────────────────

  private static void pass(HttpURLConnection c, String name, String value) {
    if (value != null) c.setRequestProperty(name, value);
  }

  /** Sends the request to the hub and its answer back, as it arrives. False when the hub could not be reached. */
  private boolean forward(HttpServletRequest request, HttpServletResponse response, String path, int port) throws IOException {
    String query = request.getQueryString();
    URL url = new URL("http://127.0.0.1:" + port + path + (query == null ? "" : "?" + query));
    // Never through a proxy the JVM may be configured with.
    HttpURLConnection c = (HttpURLConnection) url.openConnection(Proxy.NO_PROXY);
    try {
      boolean stream = path.equals("/api/live");
      c.setUseCaches(false);
      c.setInstanceFollowRedirects(false);
      c.setConnectTimeout(5000);
      // The live stream says something every few seconds; anything else may take a while (a deploy, a slow API call).
      c.setReadTimeout(stream ? 60000 : 600000);
      String method = request.getMethod();
      try {
        c.setRequestMethod(method);
      } catch (ProtocolException e) {
        send(response, 405, "application/json; charset=UTF-8", "{\"error\":\"Method not allowed\"}");
        return true;
      }

      for (Enumeration<?> names = request.getHeaderNames(); names.hasMoreElements(); ) {
        String name = (String) names.nextElement();
        String lower = name.toLowerCase(Locale.ENGLISH);
        // What the browser says about itself travels in the launcher's own headers below; a
        // client must not be able to supply those.
        if (NOT_FORWARDED.contains(lower) || lower.startsWith("x-debug-hub-") || lower.startsWith("sec-") || lower.startsWith("proxy-")) continue;
        for (Enumeration<?> values = request.getHeaders(name); values.hasMoreElements(); ) c.addRequestProperty(name, (String) values.nextElement());
      }
      c.setRequestProperty("Connection", "close");
      c.setRequestProperty("X-Debug-Hub-Secret", secret);
      c.setRequestProperty("X-Debug-Hub-Remote-Addr", request.getRemoteAddr());
      // Java's HTTP client drops Host, Origin and Sec-* silently, so they go under other names.
      pass(c, "X-Debug-Hub-Host", request.getHeader("Host"));
      pass(c, "X-Debug-Hub-Origin", request.getHeader("Origin"));
      pass(c, "X-Debug-Hub-Fetch-Site", request.getHeader("Sec-Fetch-Site"));
      pass(c, "X-Debug-Hub-Forwarded-For", request.getHeader("X-Forwarded-For"));
      if (request.getHeader("X-Forwarded-For") != null || request.getHeader("Forwarded") != null || request.getHeader("X-Real-IP") != null) {
        c.setRequestProperty("X-Debug-Hub-Via-Proxy", "1");
      }

      int length = request.getContentLength();
      boolean hasBody = length > 0 || request.getHeader("Transfer-Encoding") != null;
      if ("POST".equals(method) || "PUT".equals(method) || hasBody) {
        c.setDoOutput(true);
        // Streaming also stops Java from quietly sending a POST twice when a connection drops.
        if (length >= 0) c.setFixedLengthStreamingMode(length);
        else c.setChunkedStreamingMode(8192);
      }

      int status;
      try {
        if (c.getDoOutput()) {
          OutputStream up = c.getOutputStream();
          InputStream body = request.getInputStream();
          byte[] buf = new byte[16384];
          for (int n; (n = body.read(buf)) != -1; ) up.write(buf, 0, n);
          up.close();
        }
        status = c.getResponseCode();
      } catch (IOException e) {
        // Not listening (any more), or it went away before answering.
        return false;
      }

      response.setStatus(status);
      for (int i = 0; i < 200; i++) {
        String value = c.getHeaderField(i);
        String name = c.getHeaderFieldKey(i);
        if (value == null && i > 0) break;
        if (name == null || value == null || NOT_RETURNED.contains(name.toLowerCase(Locale.ENGLISH))) continue;
        response.addHeader(name, value);
      }

      InputStream in = null;
      try {
        in = status >= 400 ? c.getErrorStream() : c.getInputStream();
      } catch (IOException e) {
        in = c.getErrorStream();
      }
      OutputStream out = response.getOutputStream();
      if (in != null) {
        try {
          byte[] buf = new byte[16384];
          for (int n; (n = in.read(buf)) != -1; ) {
            out.write(buf, 0, n);
            // Nothing more waiting: send what there is now. This is what keeps the live stream
            // and a session download flowing instead of arriving in one piece at the end.
            if (stream || in.available() == 0) out.flush();
          }
        } catch (IOException e) {
          // The browser went away, or the hub did: nothing more to send either way.
        } finally {
          try {
            in.close();
          } catch (IOException e) {
            // nothing to do
          }
        }
      }
      try {
        out.flush();
      } catch (IOException e) {
        // the browser went away
      }
      return true;
    } finally {
      c.disconnect();
    }
  }
%><%
  // The page starts out as text/html; the hub's answer says what it really is.
  response.reset();

  String contextPathNow = request.getContextPath();
  String requestUri = request.getRequestURI();
  if (contextPathNow.length() > 0 && requestUri.equals(contextPathNow)) {
    // /debug-hub: the UI's files are relative to /debug-hub/.
    response.sendRedirect(contextPathNow + "/" + (request.getQueryString() == null ? "" : "?" + request.getQueryString()));
    if (true) return;
  }
  String hubPath = requestUri.startsWith(contextPathNow) ? requestUri.substring(contextPathNow.length()) : requestUri;
  int semicolon = hubPath.indexOf(';');
  if (semicolon >= 0) hubPath = hubPath.substring(0, semicolon);
  if (hubPath.length() == 0) hubPath = "/";

  // debughub.role: everyone logs in to Tomcat (BASIC, see web.xml) with a user in that role.
  String requiredRole = setting("role");
  if (requiredRole != null) {
    if (!request.authenticate(response)) {
      if (true) return;
    }
    if (!request.isUserInRole(requiredRole)) {
      page(response, 403, "Not allowed", "<p>Your Tomcat user does not have the role Debug Hub is set up to require.</p>", 0);
      if (true) return;
    }
  }

  // Requests that arrive while the hub is still starting wait for it a little.
  int port = hubPort;
  if (port == 0) {
    long end = System.currentTimeMillis() + 8000;
    synchronized (lock) {
      while (hubPort == 0 && !stopping && ("starting".equals(state) || "restarting".equals(state))) {
        long left = end - System.currentTimeMillis();
        if (left <= 0) break;
        try {
          lock.wait(left);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          break;
        }
      }
    }
    port = hubPort;
  }
  boolean answered = false;
  if (port != 0) {
    forwarding.incrementAndGet();
    try {
      answered = forward(request, response, hubPath, port);
    } finally {
      forwarding.decrementAndGet();
    }
  }
  if (!answered) {
    if (!response.isCommitted()) {
      response.reset();
      unavailable(request, response, hubPath);
    }
  }
  if (true) return;
%>