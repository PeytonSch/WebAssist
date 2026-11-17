import type { Route, RouteMatcher } from '../shared/route';
import type { HubEvent, Level } from '../shared/types';

/**
 * The timeline's row model: one row per event, with a network response folded into its
 * request's row. Shared by the timeline (main.ts) and the metrics screen, and free of the DOM
 * so the metrics can be tested in node.
 */

export type Group = 'console' | 'network' | 'log' | 'query' | 'marker';

export interface Row {
  key: string;
  t: number;
  tEnd?: number;
  /** The event that created the row; for network rows this is the request. */
  ev: HubEvent;
  /** The response, folded into its request's row. */
  res?: HubEvent;
  hay?: string;
  /** Network rows: the short name of the path, worked out on first use. */
  route?: Route;
}

export const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const STATIC_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Manifest', 'Ping', 'Other']);

export const resOf = (r: Row): HubEvent | undefined => r.res ?? (r.ev.kind === 'response' ? r.ev : undefined);

export function groupOf(r: Row): Group {
  switch (r.ev.kind) {
    case 'marker': return 'marker';
    case 'console': return 'console';
    case 'request':
    case 'response': return 'network';
    case 'query':
    case 'stats': return 'query';
    default: return 'log';
  }
}
export function levelOf(r: Row): Level {
  return r.res && RANK[r.res.level] > RANK[r.ev.level] ? r.res.level : r.ev.level;
}
export const ridOf = (r: Row): string | null => r.res?.requestId ?? r.ev.requestId;
export const statusOf = (r: Row): number | null => resOf(r)?.data.status ?? r.ev.data.status ?? null;
export const durationOf = (r: Row): number | null => resOf(r)?.data.durationMs ?? r.ev.data.durationMs ?? null;
export const failedOf = (r: Row): boolean => !!resOf(r)?.data.failed;
export const typeOf = (r: Row): string => resOf(r)?.data.resourceType ?? r.ev.data.resourceType ?? '';
/** The webapp a Tomcat event came from: '' when not known, null for other sources. */
export const webappOf = (r: Row): string | null => (r.ev.source === 'tomcat' ? r.ev.data.webapp ?? '' : null);
/** Requests made from the browser or from the API screen: both have a request and a response event. */
export const isSender = (source: string) => source === 'browser' || source === 'client';
export const isStatic = (r: Row) => r.ev.source === 'browser' && groupOf(r) === 'network' && STATIC_TYPES.has(typeOf(r));

/** The short name of a network row's path ("user/id" for /user/id/12345), or null. Cached on the row. */
export function routeWith(r: Row, routes: RouteMatcher): Route | null {
  if (groupOf(r) !== 'network') return null;
  const d = r.ev.data;
  const url: string | undefined = isSender(r.ev.source) ? d.url : d.path;
  if (!url) return null;
  r.route ??= routes.route(url, d.method);
  return r.route;
}
