import type { ServerMessage } from '../shared/types';
import { apiUrl, BASE } from './base';

/**
 * The live connection to the hub: status, new events and WAR notices as they happen. A
 * WebSocket (/ws) when the hub is reached directly; Server-Sent Events (/api/live) when a
 * WebSocket cannot connect, which is always so inside Tomcat, where a plain HTTP proxy sits in
 * between. Whichever is in use, it reconnects by itself about a second after it drops.
 */

export interface LiveHandlers {
  /** Connected, or connected again: anything recorded meanwhile should be fetched. */
  onOpen: () => void;
  onMessage: (msg: ServerMessage) => void;
  onClose: () => void;
}

const RETRY_MS = 1000;
/** WebSocket attempts that never opened before Server-Sent Events are tried instead. */
const WS_TRIES = 2;

export function connectLive(handlers: LiveHandlers): void {
  // Under a context path the page is served by Tomcat: no point in trying a WebSocket first.
  let transport: 'ws' | 'sse' = BASE ? 'sse' : 'ws';
  let failures = 0;

  const dispatch = (data: unknown) => {
    try {
      handlers.onMessage(JSON.parse(String(data)) as ServerMessage);
    } catch {
      /* not a message: ignore */
    }
  };

  const retry = (opened: boolean) => {
    handlers.onClose();
    if (opened) failures = 0;
    else if (++failures >= WS_TRIES) {
      // This way does not get through at all: try the other one.
      transport = transport === 'ws' ? 'sse' : 'ws';
      failures = 0;
    }
    setTimeout(open, RETRY_MS);
  };

  const openSocket = () => {
    let opened = false;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${apiUrl('/ws')}`);
    ws.onopen = () => {
      opened = true;
      handlers.onOpen();
    };
    ws.onmessage = (e) => dispatch(e.data);
    ws.onclose = () => retry(opened);
  };

  const openStream = () => {
    let opened = false;
    let done = false;
    const es = new EventSource(apiUrl('/api/live'));
    es.onopen = () => {
      opened = true;
      handlers.onOpen();
    };
    es.onmessage = (e) => dispatch(e.data);
    es.onerror = () => {
      if (done) return;
      done = true;
      // EventSource would reconnect on its own, but not after an HTTP error (the hub restarting
      // behind Tomcat answers 503). Closing and reopening covers both.
      es.close();
      retry(opened);
    };
  };

  const open = () => (transport === 'ws' ? openSocket() : openStream());
  open();
}
