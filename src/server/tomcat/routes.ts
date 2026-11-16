import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebappAction } from '../../shared/tomcat';
import type { TomcatService } from './service';
import { TomcatError } from './webapps';

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<string>;

const ACTIONS: WebappAction[] = ['start', 'stop', 'reload', 'disable', 'enable'];

/**
 * The Tomcat page's API, under /api/tomcat. The caller has already checked the request comes
 * from this machine's own UI. Returns false for paths that are not Tomcat routes.
 *
 *   GET  /api/tomcat                         everything the page shows
 *   GET  /api/tomcat/wars                    just the WARs, for notifications after a reload
 *   POST /api/tomcat/webapps/<name>/<action> start, stop, reload, disable, enable
 *   POST /api/tomcat/server/<start|stop>     run the start or stop script
 *   POST /api/tomcat/deploy                  { file, name, disabledCopy: "remove" | "keep" }
 *   POST /api/tomcat/dismiss                 { file }
 */
export async function tomcatRoute(
  tomcat: TomcatService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  if (path !== '/api/tomcat' && !path.startsWith('/api/tomcat/')) return false;
  const body = async () => {
    const parsed = JSON.parse((await readBody(req)) || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  };
  try {
    if (path === '/api/tomcat' && req.method === 'GET') return json(res, 200, await tomcat.state()), true;
    if (path === '/api/tomcat/wars' && req.method === 'GET') return json(res, 200, await tomcat.wars()), true;
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' }), true;

    const app = /^\/api\/tomcat\/webapps\/([^/]+)\/([a-z]+)$/.exec(path);
    if (app) {
      const action = app[2] as WebappAction;
      if (!ACTIONS.includes(action)) return json(res, 404, { error: 'Unknown action' }), true;
      return json(res, 200, { message: await tomcat.webappAction(decodeURIComponent(app[1]), action) }), true;
    }
    const server = /^\/api\/tomcat\/server\/(start|stop)$/.exec(path);
    if (server) return json(res, 200, { run: await tomcat.runScript(server[1] as 'start' | 'stop') }), true;

    if (path === '/api/tomcat/deploy') {
      const b = await body();
      const keep = b.disabledCopy === 'keep' ? 'keep' : 'remove';
      return json(res, 200, { message: await tomcat.deploy(String(b.file ?? ''), String(b.name ?? '').trim(), keep) }), true;
    }
    if (path === '/api/tomcat/dismiss') {
      tomcat.dismiss(String((await body()).file ?? ''));
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 404, { error: 'Not found' }), true;
  } catch (err) {
    if (err instanceof TomcatError) return json(res, err.status, { error: err.message }), true;
    throw err;
  }
}
