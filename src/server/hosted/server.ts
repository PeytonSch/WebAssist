import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostInfo } from '../../shared/hosting';
import type { Config } from '../config';
import type { DetectOptions } from '../setup-detect';
import { hostedEditable, type HostedEditable } from './defaults';
import { selfName, type HostedInfo } from './info';
import { ownTomcat, ownUiHosts } from './self';
import { denyMessage, denyPage, HostedGate, type Client } from './trust';

type Json = (res: ServerResponse, status: number, body: unknown) => void;

/**
 * Things the hub does on the machine it runs on. From a browser on another machine they would
 * open a window nobody is looking at, so they are refused there.
 */
const MACHINE_ACTIONS: Record<string, string> = {
  '/api/chrome/launch': 'Start Chrome starts Chrome on the computer Debug Hub runs on, and you are using it from another one. Start Chrome there, or start it here with a debugging port and point Settings › Browser at this computer.',
  '/api/tomcat/reveal': 'This opens a file manager window on the computer Debug Hub runs on, and you are using it from another one.',
  '/api/source/open': 'Go to source opens the editor on the computer Debug Hub runs on, and you are using it from another one.',
  '/api/source/test': 'This opens the editor on the computer Debug Hub runs on, and you are using it from another one.',
};

/** What the HTTP server (src/server/http.ts) does differently when the hub runs inside Tomcat. */
export class HostedServer {
  readonly gate: HostedGate;

  constructor(readonly info: HostedInfo, private cfg: () => Config, gate?: HostedGate) {
    this.gate = gate ?? new HostedGate(info, { seenHosts: ownUiHosts });
  }

  /**
   * Runs before every route. Refuses what may not come in, and answers the few requests that
   * are about hosting itself. Returns true when the request has been answered.
   */
  before(req: IncomingMessage, res: ServerResponse, url: URL, json: Json): boolean {
    const path = url.pathname;
    const verdict = this.gate.check(req, path);
    if (!verdict.ok) {
      const api = path === '/api' || path.startsWith('/api/');
      if (api || verdict.reason === 'secret' || !/\btext\/html\b/.test(String(req.headers.accept ?? ''))) {
        json(res, verdict.status, { error: denyMessage(verdict.reason, verdict.client) });
      } else {
        res.writeHead(verdict.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(denyPage(verdict.reason, verdict.client));
      }
      return true;
    }
    const client = verdict.client;

    if (path === '/api/host' && req.method === 'GET') {
      json(res, 200, this.hostInfo(client));
      return true;
    }
    if (req.method === 'POST' && !client.local && MACHINE_ACTIONS[path]) {
      json(res, 403, { error: MACHINE_ACTIONS[path] });
      return true;
    }
    // Stop Tomcat stops the hub with it; the page asks first and then says so with ?self=1.
    if (req.method === 'POST' && path === '/api/tomcat/server/stop' && !url.searchParams.has('self') && ownTomcat(this.cfg(), this.info)) {
      json(res, 409, {
        error: 'Debug Hub runs inside this Tomcat, so stopping it stops Debug Hub too. You would have to start Tomcat again yourself to get this page back.',
        self: true,
      });
      return true;
    }
    return false;
  }

  hostInfo(client: Client): HostInfo {
    const i = this.info;
    return {
      hosted: true,
      local: client.local,
      contextPath: i.contextPath,
      webapp: selfName(i),
      server: i.serverInfo,
      dataDir: i.dataDir,
      logFile: i.logFile,
      access: this.gate.access,
      ownTomcat: ownTomcat(this.cfg(), i),
    };
  }

  /** GET /api/config: the settings file with detected values where it is silent. */
  editable(file: string): HostedEditable {
    return hostedEditable(file, this.info);
  }

  /** The setup guide offers the Tomcat the hub runs in first. */
  detectOptions(): DetectOptions {
    return { env: { ...process.env, CATALINA_BASE: this.info.catalinaBase, CATALINA_HOME: this.info.catalinaHome } };
  }
}
