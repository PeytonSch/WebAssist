import type { WarInfo } from './tomcat';

export type Source = 'browser' | 'tomcat' | 'postgres' | 'hub';
export type Kind = 'console' | 'request' | 'response' | 'log' | 'query' | 'stats' | 'marker';
export type Level = 'debug' | 'info' | 'warn' | 'error';

/** The single shape every captured event is normalized to. */
export interface HubEvent {
  id: string;
  /** ISO-8601 with millisecond precision and the hub machine's UTC offset. */
  ts: string;
  source: Source;
  kind: Kind;
  level: Level;
  requestId: string | null;
  summary: string;
  data: Record<string, any>;
}

export interface CollectorStatus {
  name: string;
  state: 'off' | 'waiting' | 'connected';
  detail: string;
}

export interface HubStatus {
  session: string;
  eventCount: number;
  collectors: CollectorStatus[];
  correlation: { header: string; timeWindowMs: number };
}

export interface SessionInfo {
  id: string;
  bytes: number;
  modified: string;
  live: boolean;
}

export type ServerMessage =
  | { type: 'events'; session: string; events: HubEvent[] }
  | { type: 'status'; status: HubStatus }
  /** A WAR in a watched folder was built or rebuilt and can be deployed. */
  | { type: 'war'; war: WarInfo };
