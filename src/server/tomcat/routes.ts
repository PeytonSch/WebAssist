import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppFolder, WebappAction } from '../../shared/tomcat';
import type { TomcatService } from './service';
import { TomcatError } from './webapps';

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<string>;

const ACTIONS: WebappAction[] = ['start', 'stop', 'reload', 'disable', 'enable'];

/** Which folder to delete from; anything else is refused rather than guessed. */
function folder(v: unknown): AppFolder {
  if (v === 'webapps' || v === 'disabled') return v;
  throw new TomcatError('Say which folder: webapps or disabled');
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The Tomcat page's API, under /api/tomcat. The caller has already checked the request comes
 * from this machine's own UI. Returns false for paths that are not Tomcat routes.
 *
 *   GET  /api/tomcat                         everything the page shows
 *   GET  /api/tomcat/wars                    just the WARs, for notifications after a reload
 *   POST /api/tomcat/webapps/<name>/<action> start, stop, reload, disable, enable
 *   POST /api/tomcat/server/start            { only?: true } start commands, Tomcat, Chrome; only: just Tomcat
 *   POST /api/tomcat/server/stop             run the stop script, or Tomcat's bin/shutdown
 *   POST /api/tomcat/commands/<i>/run        { command } run start command i on its own
 *   POST /api/tomcat/runs/<id>/stop          stop a start command's run and what it started
 *   POST /api/tomcat/deploy                  { file, name, disabledCopy: "remove" | "keep", keep?: [relative paths] }
 *   GET  /api/tomcat/keep?name=&file=        files a deploy could keep from the copy it replaces
 *   GET  /api/tomcat/delete?name=&from=      what Delete would remove (from: webapps | disabled)
 *   POST /api/tomcat/delete                  { name, from, items: [names confirmed] }
 *   POST /api/tomcat/reveal                  { file } a watched WAR, { name, from } a webapp, { from } a folder
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
    if (req.method === 'GET' && (path === '/api/tomcat/keep' || path === '/api/tomcat/delete')) {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const name = (q.get('name') ?? '').trim();
      if (path === '/api/tomcat/keep') return json(res, 200, await tomcat.keepPreview(name, q.get('file') ?? undefined)), true;
      return json(res, 200, { items: await tomcat.deletePlan(name, folder(q.get('from'))) }), true;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' }), true;

    const app = /^\/api\/tomcat\/webapps\/([^/]+)\/([a-z]+)$/.exec(path);
    if (app) {
      const action = app[2] as WebappAction;
      if (!ACTIONS.includes(action)) return json(res, 404, { error: 'Unknown action' }), true;
      return json(res, 200, { message: await tomcat.webappAction(decodeURIComponent(app[1]), action) }), true;
    }
    if (path === '/api/tomcat/server/start') return json(res, 200, { sequence: await tomcat.startTomcat((await body()).only === true) }), true;
    if (path === '/api/tomcat/server/stop') return json(res, 200, { run: await tomcat.runScript('stop') }), true;
    const cmd = /^\/api\/tomcat\/commands\/(\d+)\/run$/.exec(path);
    if (cmd) {
      const b = await body();
      return json(res, 200, { run: await tomcat.runCommand(Number(cmd[1]), typeof b.command === 'string' ? b.command : undefined) }), true;
    }
    const stop = /^\/api\/tomcat\/runs\/(\d+)\/stop$/.exec(path);
    if (stop) return json(res, 200, { message: await tomcat.stopCommand(Number(stop[1])) }), true;

    if (path === '/api/tomcat/deploy') {
      const b = await body();
      const disabledCopy = b.disabledCopy === 'keep' ? 'keep' : 'remove';
      return json(res, 200, { message: await tomcat.deploy(String(b.file ?? ''), String(b.name ?? '').trim(), disabledCopy, strings(b.keep)) }), true;
    }
    if (path === '/api/tomcat/delete') {
      const b = await body();
      if (!Array.isArray(b.items)) return json(res, 400, { error: 'Say which items to delete' }), true;
      return json(res, 200, { message: await tomcat.deleteWebapp(String(b.name ?? ''), folder(b.from), strings(b.items)) }), true;
    }
    if (path === '/api/tomcat/reveal') {
      const b = await body();
      if (typeof b.file === 'string') await tomcat.reveal({ file: b.file });
      else await tomcat.reveal({ from: folder(b.from), name: typeof b.name === 'string' ? b.name : undefined });
      return json(res, 200, { ok: true }), true;
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
