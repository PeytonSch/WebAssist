import { dirname, join } from 'node:path';
import type { WarInfo } from '../shared/tomcat';
import type { CollectorStatus, HubEvent, HubStatus } from '../shared/types';
import { ChromeCollector } from './collectors/chrome';
import { LogFileCollector } from './collectors/logfile';
import { folderSource } from './collectors/logsdir';
import type { TailSource } from './collectors/tail';
import type { Config } from './config';
import { makeEvent } from './normalize';
import { SessionStore } from './store';
import { Webapps } from './webapps';
import { TomcatService } from './tomcat/service';

type Listener = {
  onEvent: (ev: HubEvent) => void;
  onStatus: () => void;
  /** A new WAR is ready to deploy (Tomcat page). */
  onWar?: (war: WarInfo) => void;
};

/** Wires collectors to the session store and to whoever is listening (the web UI). */
export class Hub {
  store: SessionStore;
  private chrome: ChromeCollector | null = null;
  private logs: LogFileCollector[] = [];
  private webapps: Webapps | null = null;
  private listeners = new Set<Listener>();
  private started = false;
  /** Webapps, Tomcat's start/stop scripts and the WAR watcher, for the Tomcat page. */
  tomcat: TomcatService;

  constructor(public cfg: Config) {
    this.store = new SessionStore(cfg.sessionsDir);
    this.build();
    this.tomcat = new TomcatService(cfg, {
      emit: (ev) => this.emit(ev),
      onWar: (war) => this.listeners.forEach((l) => l.onWar?.(war)),
    });
  }

  private build(): void {
    const cfg = this.cfg;
    const emit = (ev: HubEvent) => this.emit(ev);
    const onStatus = () => this.notifyStatus();
    this.chrome = cfg.chrome.enabled ? new ChromeCollector(cfg, emit, onStatus) : null;
    this.logs = [];
    this.webapps = null;
    if (cfg.tomcat.enabled) {
      const t = cfg.tomcat;
      this.webapps = new Webapps(webappDirs(cfg));
      // The logs folder adds to the files listed by hand; each collector takes its kind of file.
      const app: (string | TailSource)[] = [...t.appLogs];
      const access: (string | TailSource)[] = [...t.accessLogs];
      if (t.logsDir) {
        app.push(folderSource(t.logsDir, 'app', t.appLogs, t.accessLogs));
        access.push(folderSource(t.logsDir, 'access', t.appLogs, t.accessLogs));
      }
      if (app.length) {
        this.logs.push(new LogFileCollector('Tomcat logs', 'tomcat', app, cfg, emit, onStatus, this.webapps));
      }
      if (access.length) {
        this.logs.push(new LogFileCollector('Tomcat access', 'access', access, cfg, emit, onStatus, this.webapps));
      }
    }
    if (cfg.postgres.enabled && cfg.postgres.logs.length) {
      this.logs.push(new LogFileCollector('Postgres', 'postgres', cfg.postgres.logs, cfg, emit, onStatus));
    }
  }

  private async stopCollectors(): Promise<void> {
    this.chrome?.stop();
    this.webapps?.stop();
    await Promise.all(this.logs.map((l) => l.stop()));
  }

  private notifyStatus(): void {
    this.listeners.forEach((l) => l.onStatus());
  }

  start(): void {
    this.started = true;
    this.store.start();
    this.chrome?.start();
    this.webapps?.start();
    this.logs.forEach((l) => l.start());
    this.tomcat.start();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.tomcat.stop();
    await this.stopCollectors();
    await this.store.close();
  }

  /**
   * Applies new settings without a restart: the collectors are rebuilt, and recording carries on
   * in the same session file unless the sessions folder changed. The port cannot change while
   * the server is listening, so the running one is kept.
   */
  async reconfigure(next: Config): Promise<void> {
    // Created first: a folder that cannot be made throws here, before anything has changed.
    const store = next.sessionsDir !== this.cfg.sessionsDir ? new SessionStore(next.sessionsDir) : null;
    await this.stopCollectors();
    const port = this.cfg.port;
    if (store) {
      await this.store.close();
      this.store = store;
      if (this.started) store.start();
    }
    this.cfg = { ...next, port };
    this.build();
    this.tomcat.reconfigure(this.cfg);
    if (this.started) {
      this.chrome?.start();
      this.webapps?.start();
      this.logs.forEach((l) => l.start());
    }
    this.notifyStatus();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(ev: HubEvent): void {
    this.store.append(ev);
    this.listeners.forEach((l) => l.onEvent(ev));
  }

  addMarker(label: string): HubEvent {
    const ev = makeEvent({
      tsMs: Date.now(),
      source: 'hub',
      kind: 'marker',
      level: 'info',
      summary: label.trim().slice(0, 200) || 'Marker',
    });
    this.emit(ev);
    return ev;
  }

  /** Closes the current session file and starts recording into a fresh one. */
  newSession(): string {
    const id = this.store.start();
    this.notifyStatus();
    return id;
  }

  status(): HubStatus {
    const off = (name: string, detail: string): CollectorStatus => ({ name, state: 'off', detail });
    const collectors: CollectorStatus[] = [];
    collectors.push(this.chrome?.status ?? off('Chrome', 'Turned off in Settings'));
    const tomcat = this.logs.filter((l) => l.status.name.startsWith('Tomcat'));
    if (tomcat.length) collectors.push(...tomcat.map((l) => l.status));
    else collectors.push(off('Tomcat', 'Turn on Tomcat and add log files in Settings'));
    const pg = this.logs.find((l) => l.status.name === 'Postgres');
    collectors.push(pg?.status ?? off('Postgres', 'Turn on Postgres and add log files in Settings'));
    return {
      session: this.store.id,
      eventCount: this.store.count,
      collectors,
      correlation: { header: this.cfg.correlation.header, timeWindowMs: this.cfg.correlation.timeWindowMs },
    };
  }
}

/**
 * Folders whose contents name the webapps: webapps and disabled webapps. Without a webapps
 * folder set, CATALINA_BASE/webapps next to the logs folder is tried, as that is where it
 * normally is.
 */
function webappDirs(cfg: Config): string[] {
  const t = cfg.tomcat;
  const webapps = t.webappsDir || (t.logsDir ? join(dirname(t.logsDir), 'webapps') : '');
  return [webapps, t.disabledDir].filter(Boolean);
}
