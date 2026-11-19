import type { IncomingMessage, ServerResponse } from 'node:http';
import { RegistryProblem, type RegistryService } from './service';

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<string>;

/**
 * The package registries' API, under /api/registry. The caller has already checked the request
 * comes from this machine's own UI. Returns false for paths that are not registry routes. No
 * answer ever contains a login: registries are named, and URLs are given without credentials.
 *
 *   GET  /api/registry             every registry with its packages, versions and problems
 *   POST /api/registry/check       { registry?: name } check now, all or one; answers when done
 *   POST /api/registry/test        { registry: <settings of one registry, saved or not> } what it finds
 *   POST /api/registry/download    { key, version? } fetch into the cache; answers { war, note } when ready to deploy
 *   POST /api/registry/cancel      { key } stop that download
 *   POST /api/registry/dismiss     { key } the latest version has been seen
 *   POST /api/registry/target      { key, deployAs } the webapp name it deploys as; empty: the settings' or the guess
 */
export async function registryRoute(
  registry: RegistryService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  if (path !== '/api/registry' && !path.startsWith('/api/registry/')) return false;
  const body = async () => {
    const parsed = JSON.parse((await readBody(req)) || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  };
  try {
    if (path === '/api/registry' && req.method === 'GET') return json(res, 200, await registry.snapshot()), true;
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' }), true;
    if (path === '/api/registry/check') {
      const b = await body();
      await registry.checkNow(typeof b.registry === 'string' ? b.registry : undefined);
      return json(res, 200, await registry.snapshot()), true;
    }
    if (path === '/api/registry/test') return json(res, 200, await registry.test((await body()).registry)), true;
    if (path === '/api/registry/download') {
      const b = await body();
      return json(res, 200, await registry.download(String(b.key ?? ''), typeof b.version === 'string' ? b.version : undefined)), true;
    }
    if (path === '/api/registry/cancel') {
      registry.cancel(String((await body()).key ?? ''));
      return json(res, 200, { ok: true }), true;
    }
    if (path === '/api/registry/target') {
      const b = await body();
      await registry.setTarget(String(b.key ?? ''), typeof b.deployAs === 'string' ? b.deployAs : '');
      return json(res, 200, await registry.snapshot()), true;
    }
    if (path === '/api/registry/dismiss') {
      registry.dismiss(String((await body()).key ?? ''));
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 404, { error: 'Not found' }), true;
  } catch (err) {
    if (err instanceof RegistryProblem) return json(res, err.status, { error: [err.message, err.hint].filter(Boolean).join(' ') }), true;
    throw err;
  }
}
