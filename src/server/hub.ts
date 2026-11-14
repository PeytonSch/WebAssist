import type { CollectorStatus, HubEvent, HubStatus } from '../shared/types';
import { ChromeCollector } from './collectors/chrome';
import { LogFileCollector } from './collectors/logfile';
import type { Config } from './config';
import { makeEvent } from './normalize';
import { SessionStore } from './store';

type Listener = {
  onEvent: (ev: HubEvent) => void;
  onStatus: () => void;
};

/** Wires collectors to the session store and to whoever is listening (the web UI). */
export class Hub {
  readonly store: SessionStore;
  private chrome: ChromeCollector | null = null;
  private logs: LogFileCollector[] = [];
  private listeners = new Set<Listener>();

  constructor(readonly cfg: Config) {
    this.store = new SessionStore(cfg.sessionsDir);
    const emit = (ev: HubEvent) => this.emit(ev);
    const onStatus = () => this.listeners.forEach((l) => l.onStatus());

    if (cfg.chrome.enabled) this.chrome = new ChromeCollector(cfg, emit, onStatus);
    if (cfg.tomcat.enabled) {
      if (cfg.tomcat.appLogs.length) {
        this.logs.push(new LogFileCollector('Tomcat logs', 'tomcat', cfg.tomcat.appLogs, cfg, emit, onStatus));
      }
      if (cfg.tomcat.accessLogs.length) {
        this.logs.push(new LogFileCollector('Tomcat access', 'access', cfg.tomcat.accessLogs, cfg, emit, onStatus));
      }
    }
    if (cfg.postgres.enabled && cfg.postgres.logs.length) {
      this.logs.push(new LogFileCollector('Postgres', 'postgres', cfg.postgres.logs, cfg, emit, onStatus));
    }
  }

  start(): void {
    this.store.start();
    this.chrome?.start();
    this.logs.forEach((l) => l.start());
  }

  async stop(): Promise<void> {
    this.chrome?.stop();
    await Promise.all(this.logs.map((l) => l.stop()));
    await this.store.close();
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
    this.listeners.forEach((l) => l.onStatus());
    return id;
  }

  status(): HubStatus {
    const off = (name: string, detail: string): CollectorStatus => ({ name, state: 'off', detail });
    const collectors: CollectorStatus[] = [];
    collectors.push(this.chrome?.status ?? off('Chrome', 'Disabled in config (chrome.enabled)'));
    const tomcat = this.logs.filter((l) => l.status.name.startsWith('Tomcat'));
    if (tomcat.length) collectors.push(...tomcat.map((l) => l.status));
    else collectors.push(off('Tomcat', 'Set tomcat.enabled and tomcat.appLogs / accessLogs in the config'));
    const pg = this.logs.find((l) => l.status.name === 'Postgres');
    collectors.push(pg?.status ?? off('Postgres', 'Set postgres.enabled and postgres.logs in the config'));
    return {
      session: this.store.id,
      eventCount: this.store.count,
      collectors,
      correlation: { header: this.cfg.correlation.header, timeWindowMs: this.cfg.correlation.timeWindowMs },
    };
  }
}
