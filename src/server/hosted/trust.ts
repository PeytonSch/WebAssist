import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import type { HostedInfo } from './info';

/**
 * Who may use the hub when it runs inside Tomcat.
 *
 * On its own the hub listens on 127.0.0.1 and trusts requests addressed to localhost. Inside
 * Tomcat it is reachable by whoever can reach Tomcat, and it can run scripts, deploy webapps
 * and show captured request bodies. So, in this order:
 *
 *  1. Only the launcher may talk to the hub: every request carries the secret the launcher made
 *     up when it started the hub. Another program on the machine that finds the port gets 403.
 *  2. Only clients on this machine, unless the person who runs Tomcat opened it up
 *     (debughub.remote: "all", or addresses and networks).
 *  3. Only under a host name that is plainly this machine (localhost, an IP address, the
 *     machine's name) or one that was allowed (debughub.hosts). This stops DNS rebinding, where
 *     a web page's own domain is pointed at this machine to get around the next check.
 *  4. No cross-site requests: a request that says where it comes from (Origin) must come from
 *     the hub's own pages.
 *
 * The launcher passes what the browser sent in X-Debug-Hub-* headers, because Java's HTTP client
 * silently drops Origin, Host and Sec-* headers. It removes any such header the client sent.
 */

export const H = {
  secret: 'x-debug-hub-secret',
  /** The client's address as Tomcat saw it. */
  remoteAddr: 'x-debug-hub-remote-addr',
  /** The Host header the browser sent. */
  host: 'x-debug-hub-host',
  origin: 'x-debug-hub-origin',
  fetchSite: 'x-debug-hub-fetch-site',
  /** X-Forwarded-For as the request arrived at Tomcat, if a proxy in front of Tomcat added one. */
  forwardedFor: 'x-debug-hub-forwarded-for',
  /** "1" when the request carried Forwarded, X-Forwarded-For or X-Real-IP: it came through a proxy. */
  viaProxy: 'x-debug-hub-via-proxy',
} as const;

// ── Addresses ───────────────────────────────────────────

/** An IPv4 or IPv6 address as 4 or 16 bytes; IPv4-mapped IPv6 (::ffff:1.2.3.4) as the IPv4 address. */
export function parseIp(text: string): Uint8Array | null {
  let s = text.trim().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const kind = isIP(s);
  if (kind === 4) return Uint8Array.from(s.split('.').map(Number));
  if (kind !== 6) return null;
  // The last group may be dotted IPv4.
  let tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = dotted[2].split('.').map(Number);
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const groups = (part: string | undefined) => (part ? part.split(':').filter((g) => g !== '').map((g) => parseInt(g, 16)) : []);
  const left = groups(head);
  const right = [...groups(rest), ...tail];
  const fill = rest === undefined ? [] : new Array(Math.max(0, 8 - left.length - right.length)).fill(0);
  const all = [...left, ...fill, ...right];
  if (all.length !== 8) return null;
  const bytes = new Uint8Array(16);
  all.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? bytes.slice(12) : bytes;
}

export function isLoopback(addr: string): boolean {
  const ip = parseIp(addr);
  if (!ip) return false;
  if (ip.length === 4) return ip[0] === 127;
  return ip.slice(0, 15).every((b) => b === 0) && ip[15] === 1;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

interface Network {
  ip: Uint8Array;
  bits: number;
}

export interface RemotePolicy {
  all: boolean;
  networks: Network[];
  /** Entries that are neither an address nor a network, for the log. */
  invalid: string[];
}

/** "" or "off": nobody else. "all" (or "*", "true"): anyone. Otherwise addresses and networks: "192.168.1.0/24, 10.0.0.7, fd00::/8". */
export function parseRemotePolicy(text: string): RemotePolicy {
  const policy: RemotePolicy = { all: false, networks: [], invalid: [] };
  for (const item of text.split(/[\s,;]+/).filter(Boolean)) {
    const word = item.toLowerCase();
    if (word === 'all' || word === '*' || word === 'true' || word === 'on' || word === 'yes') policy.all = true;
    else if (word === 'off' || word === 'false' || word === 'no' || word === 'none' || word === 'local') continue;
    else {
      const [addr, prefix] = item.split('/');
      const ip = parseIp(addr);
      const bits = prefix === undefined ? (ip?.length ?? 0) * 8 : Number(prefix);
      if (!ip || !Number.isInteger(bits) || bits < 0 || bits > ip.length * 8 || (prefix !== undefined && !/^\d+$/.test(prefix))) policy.invalid.push(item);
      else policy.networks.push({ ip, bits });
    }
  }
  return policy;
}

function inNetwork(ip: Uint8Array, net: Network): boolean {
  if (ip.length !== net.ip.length) return false;
  for (let i = 0, left = net.bits; left > 0; i++, left -= 8) {
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((ip[i] & mask) !== (net.ip[i] & mask)) return false;
  }
  return true;
}

export function policyAllows(policy: RemotePolicy, addr: string): boolean {
  if (policy.all) return true;
  const ip = parseIp(addr);
  return !!ip && policy.networks.some((n) => inNetwork(ip, n));
}

// ── Host names ──────────────────────────────────────────

/** "host:8080" or "[::1]:8080" without the port, lower-cased, without a trailing dot. */
export function hostNameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (v6) return v6[1];
  return h.replace(/:\d+$/, '').replace(/\.$/, '');
}

export interface HostPolicy {
  any: boolean;
  /** localhost, the machine's own names and the names that were allowed. */
  names: Set<string>;
  /** Only the names that were allowed (debughub.hosts). */
  allowed: Set<string>;
  /** "*.example.com" entries, stored as ".example.com". */
  suffixes: string[];
}

export function parseHostPolicy(text: string, machineNames: string[]): HostPolicy {
  const policy: HostPolicy = { any: false, names: new Set(['localhost']), allowed: new Set(), suffixes: [] };
  for (const name of machineNames) {
    const n = name.trim().toLowerCase().replace(/\.$/, '');
    if (!n) continue;
    policy.names.add(n);
    // The short name of a fully qualified one: "devbox" for "devbox.corp.example".
    if (n.includes('.') && !isIP(n)) policy.names.add(n.slice(0, n.indexOf('.')));
  }
  for (const item of text.split(/[\s,;]+/).filter(Boolean)) {
    const n = hostNameOf(item);
    if (n === '*') policy.any = true;
    else if (n.startsWith('*.')) policy.suffixes.push(n.slice(1));
    else if (n) {
      policy.names.add(n);
      policy.allowed.add(n);
    }
  }
  return policy;
}

/** An IP address cannot be rebound, so any is fine; names must be this machine's or allowed. */
export function hostAllowed(policy: HostPolicy, hostHeader: string): boolean {
  const name = hostNameOf(hostHeader);
  if (!name) return false;
  if (policy.any || parseIp(name)) return true;
  return policy.names.has(name) || policy.suffixes.some((s) => name.endsWith(s));
}

// ── The gate ────────────────────────────────────────────

export type DenyReason = 'secret' | 'remote' | 'host' | 'origin';

export interface Client {
  /** The client's address: as Tomcat saw it, or the last hop a proxy in front of Tomcat named. */
  addr: string;
  /** On the machine the hub runs on, so "Start Chrome", "Show in Explorer" and the editor make sense. */
  local: boolean;
  /** The Host header the browser used, e.g. "localhost:8080". */
  host: string;
}

export type Verdict = { ok: true; client: Client } | { ok: false; reason: DenyReason; status: number; client: Client | null };

export interface GateOptions {
  /** Addresses of this machine's network interfaces; read from the OS when not given. */
  ownAddresses?: () => string[];
  machineNames?: string[];
  /** Where the Host headers of accepted requests are noted (shared with the Chrome collector). */
  seenHosts?: Set<string>;
}

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? '';

function ownAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address));
}

export class HostedGate {
  readonly remote: RemotePolicy;
  readonly hosts: HostPolicy;
  private secret: Buffer;
  private own: () => string[];
  /** Host headers of requests that were let in: the addresses the UI is being used under. */
  readonly seenHosts: Set<string>;

  constructor(info: Pick<HostedInfo, 'secret' | 'remote' | 'hosts'>, opts: GateOptions = {}) {
    this.seenHosts = opts.seenHosts ?? new Set<string>();
    this.secret = Buffer.from(info.secret, 'utf8');
    this.remote = parseRemotePolicy(info.remote);
    this.hosts = parseHostPolicy(info.hosts, opts.machineNames ?? [hostname()]);
    this.own = opts.ownAddresses ?? ownAddresses;
  }

  /** "local", "all" or "list": what debughub.remote amounts to, for the Settings screen. */
  get access(): 'local' | 'all' | 'list' {
    return this.remote.all ? 'all' : this.remote.networks.length ? 'list' : 'local';
  }

  private secretOk(req: IncomingMessage): boolean {
    const got = Buffer.from(one(req.headers[H.secret]), 'utf8');
    return got.length === this.secret.length && timingSafeEqual(got, this.secret);
  }

  /** The machine's own address counts as local: http://<this machine's name>:8080 arrives from its LAN address. */
  private onThisMachine(addr: string): boolean {
    if (isLoopback(addr)) return true;
    const ip = parseIp(addr);
    return !!ip && this.own().some((a) => {
      const mine = parseIp(a);
      return !!mine && sameBytes(mine, ip);
    });
  }

  client(req: IncomingMessage): Client {
    const peer = one(req.headers[H.remoteAddr]);
    const peerLocal = this.onThisMachine(peer);
    const viaProxy = one(req.headers[H.viaProxy]) === '1' || !!one(req.headers[H.forwardedFor]);
    // Behind a proxy on this machine every client arrives from 127.0.0.1; the proxy names the
    // real one as the last entry of X-Forwarded-For. Without that the client is not known.
    let addr = peer;
    if (peerLocal && viaProxy) addr = one(req.headers[H.forwardedFor]).split(',').pop()?.trim() ?? '';
    return { addr, local: peerLocal && !viaProxy, host: one(req.headers[H.host]) };
  }

  check(req: IncomingMessage, path: string): Verdict {
    if (!this.secretOk(req)) return { ok: false, reason: 'secret', status: 403, client: null };
    const client = this.client(req);
    if (!client.local && !policyAllows(this.remote, client.addr)) return { ok: false, reason: 'remote', status: 403, client };
    if (!hostAllowed(this.hosts, client.host)) return { ok: false, reason: 'host', status: 403, client };

    // Cross-site protection. Browsers send Origin with every request that can change something,
    // and Sec-Fetch-Site with every request; other clients (curl) send neither.
    const origin = one(req.headers[H.origin]);
    if (origin && !this.originOk(origin, client.host)) return { ok: false, reason: 'origin', status: 403, client };
    const site = one(req.headers[H.fetchSite]).toLowerCase();
    const isApi = path === '/api' || path.startsWith('/api/');
    if (isApi && (site === 'cross-site' || site === 'same-site')) return { ok: false, reason: 'origin', status: 403, client };

    if (this.seenHosts.size < 50) this.seenHosts.add(client.host.toLowerCase());
    return { ok: true, client };
  }

  /** The page's origin must be the address the request was sent to, or a host name that was allowed. */
  private originOk(origin: string, host: string): boolean {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false; // includes "null", the origin of sandboxed pages and files
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.host.toLowerCase() === host.trim().toLowerCase()) return true;
    // Behind a proxy that rewrites Host, the browser's origin is the proxy's public name, which
    // must then have been allowed by name. The machine's own names do not count here: another
    // page served from this machine (a dev server on another port) is still another site.
    const name = hostNameOf(u.host);
    return this.hosts.allowed.has(name) || this.hosts.suffixes.some((s) => name.endsWith(s));
  }
}

// ── What a refused client is told ───────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One sentence for JSON answers and the page's heading. */
export function denyMessage(reason: DenyReason, client: Client | null): string {
  if (reason === 'remote') {
    return `Debug Hub only answers the computer it runs on${client?.addr ? `, and you are connecting from ${client.addr}` : ''}. Whoever runs Tomcat can allow other computers with the debughub.remote setting.`;
  }
  if (reason === 'host') return `Debug Hub does not know the host name ${client ? hostNameOf(client.host) : ''}. Whoever runs Tomcat can allow it with the debughub.hosts setting.`;
  if (reason === 'origin') return 'This request came from another web site, which Debug Hub does not allow.';
  return 'Forbidden';
}

/** The page a browser sees instead of the UI. It names no paths on the server. */
export function denyPage(reason: DenyReason, client: Client | null): string {
  const title = reason === 'remote' ? 'Debug Hub is only available on the computer it runs on' : reason === 'host' ? 'Debug Hub does not know this address' : 'Not allowed';
  let body = `<p>${esc(denyMessage(reason, client))}</p>`;
  if (reason === 'remote') {
    body = `
<p>You are connecting from <code>${esc(client?.addr || 'another computer')}</code>. Debug Hub can run scripts, deploy webapps and show
captured requests on the server it runs on, so it only answers that computer unless it is told otherwise.</p>
<h2>If you only need it yourself</h2>
<p>Open it on the server, or tunnel to it: <code>ssh -L 8080:localhost:8080 you@server</code>, then open
<code>http://localhost:8080${esc('/…')}</code> on your own computer.</p>
<h2>To open it to other computers</h2>
<p>On the server, set <code>debughub.remote</code> to the addresses or networks to allow, or to <code>all</code>, and restart Tomcat.
For example in <code>bin/setenv.sh</code> of the Tomcat it runs in:</p>
<pre>CATALINA_OPTS="$CATALINA_OPTS -Ddebughub.remote=192.168.1.0/24,10.0.0.7"</pre>
<p>or <code>bin\\setenv.bat</code> on Windows:</p>
<pre>set "CATALINA_OPTS=%CATALINA_OPTS% -Ddebughub.remote=192.168.1.0/24,10.0.0.7"</pre>
<p>The environment variable <code>DEBUG_HUB_REMOTE</code> and the context parameter <code>debughub.remote</code> work too.
Anyone allowed in can do everything Debug Hub can, so also require a login: set <code>debughub.role</code> to a role from
<code>conf/tomcat-users.xml</code>. The README has the details.</p>`;
  } else if (reason === 'host') {
    body = `
<p>This page was asked for as <code>${esc(client ? hostNameOf(client.host) : '')}</code>, which is neither <code>localhost</code>, an IP address
nor the server's own name. Debug Hub refuses names it does not know, because a web site can point its own domain at
your computer to reach local tools.</p>
<p>Use the server's IP address or <code>localhost</code>, or allow the name on the server: set <code>debughub.hosts</code>
(for example <code>-Ddebughub.hosts=dev.example.com</code> in <code>CATALINA_OPTS</code>, or the environment variable
<code>DEBUG_HUB_HOSTS</code>) and restart Tomcat. <code>*.example.com</code> allows every name under a domain.</p>`;
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Debug Hub</title>
<style>
  body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2430; background: #f6f7f9; margin: 0; }
  main { max-width: 660px; margin: 9vh auto; padding: 28px 32px; background: #fff; border: 1px solid #e3e6ec; border-radius: 12px; }
  h1 { font-size: 20px; margin: 0 0 12px; } h2 { font-size: 15px; margin: 22px 0 6px; }
  code, pre { font: 13px ui-monospace, Consolas, monospace; background: #f1f3f7; border-radius: 5px; }
  code { padding: 1px 5px; } pre { padding: 10px 12px; overflow-x: auto; }
  @media (prefers-color-scheme: dark) { body { background: #0b0d12; color: #e6e8ee; } main { background: #151821; border-color: #262a36; } code, pre { background: #1e2230; } }
</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>
`;
}
