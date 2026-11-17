import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EditorKind } from './editor';
import { SourceError, type SourceService } from './service';

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<string>;

const KINDS: EditorKind[] = ['', 'vscode', 'idea', 'emacs', 'nvim', 'custom'];
/** Names checked in one resolve call; a long stack trace has a few hundred frames at most. */
const MAX_NAMES = 2_000;

/**
 * Go to source, under /api/source. The caller has already checked the request comes from this
 * machine's own UI, which matters here: open starts a program. A request names a class, never a
 * file to open; the file comes from the index (see SourceService.open).
 *
 *   GET  /api/source/status                 projects found, index state, the editor in use
 *   GET  /api/source/editor?kind=&program=  the editor program these (unsaved) settings would use
 *   POST /api/source/resolve                { names: [...], webapp? } → which are in the sources
 *   POST /api/source/open                   { className, file?, line?, column?, webapp?, pick? }
 *   POST /api/source/test                   opens the first indexed class
 *   POST /api/source/rescan                 rebuilds the index now
 */
export async function sourceRoute(
  source: SourceService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  if (!path.startsWith('/api/source/')) return false;
  const body = async () => {
    const parsed = JSON.parse((await readBody(req)) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  try {
    if (path === '/api/source/status' && req.method === 'GET') {
      return json(res, 200, { ...source.status(), editor: source.editorStatus() }), true;
    }
    if (path === '/api/source/editor' && req.method === 'GET') {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const kind = (q.get('kind') ?? '') as EditorKind;
      if (!KINDS.includes(kind)) return json(res, 400, { error: 'Unknown editor' }), true;
      return json(res, 200, source.editorStatus(kind, q.get('program') ?? '')), true;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' }), true;
    if (path === '/api/source/resolve') {
      const b = await body();
      const names = (Array.isArray(b.names) ? b.names : []).filter((n): n is string => typeof n === 'string' && n.length <= 500).slice(0, MAX_NAMES);
      return json(res, 200, source.known(names, str(b.webapp))), true;
    }
    if (path === '/api/source/open') {
      const b = await body();
      const result = await source.open({
        className: str(b.className) ?? '',
        file: str(b.file),
        line: typeof b.line === 'number' ? b.line : undefined,
        column: typeof b.column === 'number' ? b.column : undefined,
        webapp: str(b.webapp),
        pick: str(b.pick),
      });
      return json(res, 200, result), true;
    }
    if (path === '/api/source/test') return json(res, 200, await source.test()), true;
    if (path === '/api/source/rescan') {
      await source.index.build();
      return json(res, 200, source.status()), true;
    }
    return json(res, 404, { error: 'Not found' }), true;
  } catch (err) {
    if (err instanceof SourceError) return json(res, err.status, { error: err.message, ...err.extra }), true;
    throw err;
  }
}
