import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config';
import { CatalogError, type CatalogStore } from './catalog';
import { SEND_BODY_LIMIT, SendError, type ApiClient } from './client';
import { SpecError } from './spec';

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage, limit?: number) => Promise<string>;

/** What the API screen needs from the settings, besides the specs. */
export function clientInfo(cfg: Config, client: ApiClient) {
  return {
    specs: client.specs(),
    baseUrl: cfg.api.baseUrl,
    defaultHeaders: cfg.api.headers,
    addRequestId: cfg.api.addRequestId,
    requestIdHeader: cfg.correlation.header,
    timeoutMs: cfg.api.timeoutMs,
    insecureTls: cfg.api.insecureTls,
  };
}

/**
 * The API screen's routes, under /api/client. The caller has already checked that the request
 * comes from this machine's own UI, which matters most here: /send makes the hub fetch any URL,
 * so it must never be reachable from another site or another machine. Returns false for paths
 * that are not API client routes.
 *
 *   GET    /api/client                          settings the screen needs and each spec's load status
 *   GET    /api/client/specs/<name>[?reload=1]  the parsed spec, loaded on first use
 *   POST   /api/client/send                     SendInput → SendResult; closing the request cancels it
 *   GET    /api/client/catalog                  saved requests and variables
 *   POST   /api/client/catalog/requests         save a new request
 *   PUT    /api/client/catalog/requests/<id>    replace a saved request
 *   DELETE /api/client/catalog/requests/<id>
 *   PUT    /api/client/catalog/variables        replace the variables
 *   POST   /api/client/catalog/import           merge an exported catalog
 */
export async function apiClientRoute(
  cfg: () => Config,
  client: ApiClient,
  catalog: CatalogStore,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  if (path !== '/api/client' && !path.startsWith('/api/client/')) return false;
  const method = req.method ?? 'GET';
  const body = async (limit = 1024 * 1024) => JSON.parse((await readBody(req, limit)) || 'null');

  try {
    if (path === '/api/client' && method === 'GET') {
      json(res, 200, clientInfo(cfg(), client));
      return true;
    }

    const spec = /^\/api\/client\/specs\/([^/]+)$/.exec(path);
    if (spec && method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x');
      json(res, 200, await client.spec(decodeURIComponent(spec[1]), url.searchParams.has('reload')));
      return true;
    }

    if (path === '/api/client/send' && method === 'POST') {
      const input = await body(SEND_BODY_LIMIT * 2);
      // The screen's Cancel aborts its fetch, which closes this request: stop the outgoing one too.
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      json(res, 200, await client.send(input ?? {}, abort.signal));
      return true;
    }

    if (path === '/api/client/catalog' && method === 'GET') {
      json(res, 200, catalog.read());
      return true;
    }
    if (path === '/api/client/catalog/requests' && method === 'POST') {
      json(res, 200, await catalog.create(await body(SEND_BODY_LIMIT * 2)));
      return true;
    }
    const one = /^\/api\/client\/catalog\/requests\/([^/]+)$/.exec(path);
    if (one && method === 'PUT') {
      json(res, 200, await catalog.update(decodeURIComponent(one[1]), await body(SEND_BODY_LIMIT * 2)));
      return true;
    }
    if (one && method === 'DELETE') {
      json(res, 200, await catalog.remove(decodeURIComponent(one[1])));
      return true;
    }
    if (path === '/api/client/catalog/variables' && method === 'PUT') {
      json(res, 200, await catalog.setVariables(await body()));
      return true;
    }
    if (path === '/api/client/catalog/import' && method === 'POST') {
      json(res, 200, await catalog.import(await body(64 * 1024 * 1024)));
      return true;
    }
  } catch (err) {
    if (err instanceof CatalogError) json(res, 400, { error: err.message, errors: err.errors });
    else if (err instanceof SpecError || err instanceof SendError) json(res, 400, { error: err.message });
    else if (err instanceof SyntaxError) json(res, 400, { error: `Not valid JSON: ${err.message}` });
    else throw err;
    return true;
  }
  json(res, 404, { error: 'Not found' });
  return true;
}
