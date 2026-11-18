import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * src/ui/base.ts works out the page's base path when it loads, so each case loads it afresh
 * with a stand-in for the page it would be running in.
 */
type Call = { url: string; init?: RequestInit };

async function loadBase(pageUrl: string, scriptSrc: string | null) {
  const calls: Call[] = [];
  const page = new URL(pageUrl);
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ hosted: page.pathname !== '/', local: true }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('location', { origin: page.origin, host: page.host, pathname: page.pathname, protocol: page.protocol });
  vi.stubGlobal('document', { baseURI: pageUrl, querySelector: () => (scriptSrc ? { src: scriptSrc } : null) });
  vi.stubGlobal('window', { fetch: fakeFetch });
  vi.resetModules();
  const base = await import('../src/ui/base');
  // What UI code calls: the page's fetch, which base.ts may have wrapped.
  const pageFetch = (globalThis as any).window.fetch as typeof fetch;
  vi.stubGlobal('fetch', pageFetch);
  return { base, calls, pageFetch };
}

afterEach(() => vi.unstubAllGlobals());

describe('calling the hub under a context path', () => {
  it('leaves everything alone when the hub runs on its own', async () => {
    const { base, calls, pageFetch } = await loadBase('http://localhost:4000/', 'http://localhost:4000/app.js');
    expect(base.BASE).toBe('');
    expect(base.apiUrl('/api/live')).toBe('/api/live');
    await pageFetch('/api/status');
    expect(calls.map((c) => c.url)).toEqual(['/api/host', '/api/status']);
  });

  it('sends /api/ requests under the webapp’s path inside Tomcat', async () => {
    const { base, calls, pageFetch } = await loadBase('http://devbox:8080/debug-hub/', 'http://devbox:8080/debug-hub/app.js');
    expect(base.BASE).toBe('/debug-hub');
    expect(base.apiUrl('/api/live')).toBe('/debug-hub/api/live');
    expect(base.apiUrl('/ws')).toBe('/debug-hub/ws');

    const init = { method: 'POST', body: '{}' };
    await pageFetch('/api/tomcat/deploy', init);
    await pageFetch('/api/config?x=1');
    await pageFetch(new URL('http://devbox:8080/api/sessions?a=b'));
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      '/debug-hub/api/tomcat/deploy',
      '/debug-hub/api/config?x=1',
      'http://devbox:8080/debug-hub/api/sessions?a=b',
    ]);
    // The request itself is passed through untouched.
    expect(calls[1].init).toBe(init);
    // The first call was base.ts asking how the hub is run, already under the base.
    expect(calls[0].url).toBe('/debug-hub/api/host');
  });

  it('touches nothing that is not the hub’s API', async () => {
    const { calls, pageFetch } = await loadBase('http://devbox:8080/debug-hub/', 'http://devbox:8080/debug-hub/app.js');
    await pageFetch('http://localhost:8081/api/orders');
    await pageFetch('/apiary/x');
    await pageFetch('styles.css');
    await pageFetch(new URL('http://elsewhere.example/api/x'));
    expect(calls.slice(1).map((c) => c.url)).toEqual(['http://localhost:8081/api/orders', '/apiary/x', 'styles.css', 'http://elsewhere.example/api/x']);
  });

  it('finds the base from the script, also for /debug-hub/index.html and nested context paths', async () => {
    expect((await loadBase('http://h:8080/debug-hub/index.html', 'http://h:8080/debug-hub/app.js')).base.BASE).toBe('/debug-hub');
    expect((await loadBase('http://h:8080/tools/hub/', 'http://h:8080/tools/hub/app.js')).base.BASE).toBe('/tools/hub');
    // No script element to go by: the page's own folder.
    expect((await loadBase('http://h:8080/debug-hub/', null)).base.BASE).toBe('/debug-hub');
  });

  it('says how the hub is run, asking once', async () => {
    const { base, calls } = await loadBase('http://devbox:8080/debug-hub/', 'http://devbox:8080/debug-hub/app.js');
    expect(await base.hostInfo()).toEqual({ hosted: true, local: true });
    expect(await base.hostInfo()).toEqual({ hosted: true, local: true });
    expect(base.hostInfoNow().hosted).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/api/host'))).toHaveLength(1);
  });
});
