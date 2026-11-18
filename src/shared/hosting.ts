// How the hub is being run, as the UI needs to know it (GET /api/host).

export interface HostInfo {
  /** Running as a webapp inside Tomcat (see "Running inside Tomcat" in the README), not on its own port. */
  hosted: boolean;
  /**
   * The browser is on the machine the hub runs on. When it is not, things the hub does on its
   * own machine (Start Chrome, Show in Explorer, opening the editor) happen somewhere the user
   * cannot see, and the hub refuses them.
   */
  local: boolean;
  /** The webapp's context path, "" for ROOT. */
  contextPath?: string;
  /** The hub's own webapp, as Tomcat names it: "debug-hub". */
  webapp?: string;
  /** e.g. "Apache Tomcat/9.0.89". */
  server?: string;
  /** Where settings, sessions and saved requests are kept. */
  dataDir?: string;
  /** Where the hub's own output goes. */
  logFile?: string | null;
  /** Who can connect: only this machine, anyone, or a list of addresses. */
  access?: 'local' | 'all' | 'list';
  /** The Tomcat in Settings is the one the hub runs in. */
  ownTomcat?: boolean;
}
