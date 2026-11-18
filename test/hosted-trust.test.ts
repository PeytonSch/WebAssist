import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { denyPage, H, HostedGate, hostAllowed, hostNameOf, isLoopback, parseHostPolicy, parseIp, parseRemotePolicy, policyAllows } from '../src/server/hosted/trust';

const SECRET = 'a'.repeat(64);

/** A request as the launcher forwards it: the secret, and what the browser and Tomcat said. */
function req(over: Record<string, string | undefined> = {}): IncomingMessage {
  const headers: Record<string, string> = {
    [H.secret]: SECRET,
    [H.remoteAddr]: '127.0.0.1',
    [H.host]: 'localhost:8080',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return { headers } as unknown as IncomingMessage;
}

const gate = (remote = '', hosts = '') =>
  new HostedGate({ secret: SECRET, remote, hosts }, { ownAddresses: () => ['192.168.1.20', 'fe80::1'], machineNames: ['devbox.corp.example'] });

describe('addresses', () => {
  it('parses IPv4, IPv6 and IPv4-mapped IPv6', () => {
    expect([...parseIp('10.1.2.3')!]).toEqual([10, 1, 2, 3]);
    expect(parseIp('::1')!.length).toBe(16);
    expect([...parseIp('::ffff:192.168.1.9')!]).toEqual([192, 168, 1, 9]);
    expect([...parseIp('[fe80::1%eth0]')!].slice(0, 2)).toEqual([0xfe, 0x80]);
    expect(parseIp('localhost')).toBeNull();
    expect(parseIp('1.2.3')).toBeNull();
  });

  it('knows loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.8.9.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.1')).toBe(false);
    expect(isLoopback('')).toBe(false);
  });

  it('matches addresses and networks', () => {
    const p = parseRemotePolicy('192.168.1.0/24, 10.0.0.7 fd00::/8');
    expect(p.all).toBe(false);
    expect(p.invalid).toEqual([]);
    expect(policyAllows(p, '192.168.1.77')).toBe(true);
    expect(policyAllows(p, '192.168.2.77')).toBe(false);
    expect(policyAllows(p, '10.0.0.7')).toBe(true);
    expect(policyAllows(p, '10.0.0.8')).toBe(false);
    expect(policyAllows(p, 'fd12::9')).toBe(true);
    expect(policyAllows(p, 'fe80::9')).toBe(false);
    expect(policyAllows(p, '::ffff:192.168.1.5')).toBe(true);
    expect(policyAllows(parseRemotePolicy('10.0.0.0/7'), '11.255.0.1')).toBe(true);
    expect(policyAllows(parseRemotePolicy('10.0.0.0/7'), '12.0.0.1')).toBe(false);
  });

  it('is closed unless told otherwise, and reports entries it cannot read', () => {
    expect(policyAllows(parseRemotePolicy(''), '10.0.0.1')).toBe(false);
    expect(policyAllows(parseRemotePolicy('off'), '10.0.0.1')).toBe(false);
    expect(policyAllows(parseRemotePolicy('all'), '10.0.0.1')).toBe(true);
    expect(policyAllows(parseRemotePolicy('*'), 'not-an-address')).toBe(true);
    const p = parseRemotePolicy('192.168.1.0/33, office, 10.0.0.1/x, 10.0.0.2');
    expect(p.invalid).toEqual(['192.168.1.0/33', 'office', '10.0.0.1/x']);
    expect(policyAllows(p, '10.0.0.2')).toBe(true);
    expect(policyAllows(p, '192.168.1.1')).toBe(false);
  });
});

describe('host names', () => {
  it('takes the name out of a Host header', () => {
    expect(hostNameOf('LocalHost:8080')).toBe('localhost');
    expect(hostNameOf('[::1]:8080')).toBe('::1');
    expect(hostNameOf('dev.example.com.')).toBe('dev.example.com');
  });

  it('accepts localhost, IP addresses, the machine and allowed names, and nothing else', () => {
    const p = parseHostPolicy('hub.example.com, *.dev.example', ['devbox.corp.example']);
    for (const ok of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080', '192.168.1.20', 'devbox:8080', 'DEVBOX.corp.example:8080', 'hub.example.com', 'a.dev.example:8443']) {
      expect(hostAllowed(p, ok), ok).toBe(true);
    }
    for (const bad of ['evil.example:8080', 'localhost.evil.example', 'dev.example', '']) expect(hostAllowed(p, bad), bad).toBe(false);
    expect(hostAllowed(parseHostPolicy('*', []), 'anything.example')).toBe(true);
  });
});

describe('the gate', () => {
  it('lets the launcher in and nobody else', () => {
    expect(gate().check(req(), '/api/status').ok).toBe(true);
    for (const secret of [undefined, '', 'a'.repeat(63), 'b'.repeat(64)]) {
      const v = gate().check(req({ [H.secret]: secret }), '/api/status');
      expect(v).toMatchObject({ ok: false, reason: 'secret', status: 403 });
    }
  });

  it('serves only this machine by default', () => {
    const g = gate();
    expect(g.check(req({ [H.remoteAddr]: '::1' }), '/').ok).toBe(true);
    expect(g.check(req({ [H.remoteAddr]: '0:0:0:0:0:0:0:1' }), '/').ok).toBe(true);
    expect(g.check(req({ [H.remoteAddr]: '192.168.1.50', [H.host]: '192.168.1.20:8080' }), '/')).toMatchObject({ ok: false, reason: 'remote' });
    expect(g.access).toBe('local');
  });

  it('counts the machine’s own network address as this machine', () => {
    // http://devbox:8080 from the machine itself arrives from its LAN address.
    const v = gate().check(req({ [H.remoteAddr]: '192.168.1.20', [H.host]: 'devbox:8080' }), '/');
    expect(v).toMatchObject({ ok: true, client: { local: true } });
  });

  it('opens to listed addresses, or to everyone, only when asked', () => {
    const listed = gate('192.168.1.0/24');
    expect(listed.check(req({ [H.remoteAddr]: '192.168.1.50', [H.host]: '192.168.1.20:8080' }), '/')).toMatchObject({ ok: true, client: { local: false, addr: '192.168.1.50' } });
    expect(listed.check(req({ [H.remoteAddr]: '10.9.9.9', [H.host]: '192.168.1.20:8080' }), '/')).toMatchObject({ ok: false, reason: 'remote' });
    expect(listed.access).toBe('list');
    const all = gate('all');
    expect(all.check(req({ [H.remoteAddr]: '10.9.9.9', [H.host]: '192.168.1.20:8080' }), '/').ok).toBe(true);
    expect(all.access).toBe('all');
  });

  it('does not take a proxy on this machine for a local user', () => {
    // nginx in front of Tomcat: every client arrives from 127.0.0.1.
    const viaProxy = { [H.viaProxy]: '1', [H.forwardedFor]: '203.0.113.9, 198.51.100.4' };
    expect(gate().check(req(viaProxy), '/')).toMatchObject({ ok: false, reason: 'remote', client: { addr: '198.51.100.4', local: false } });
    // The last hop, which the proxy itself wrote, is what the list is checked against.
    expect(gate('198.51.100.0/24').check(req(viaProxy), '/').ok).toBe(true);
    expect(gate('203.0.113.0/24').check(req(viaProxy), '/').ok).toBe(false);
    // A proxy that names nobody: only "all" lets its clients in.
    expect(gate('10.0.0.0/8').check(req({ [H.viaProxy]: '1' }), '/').ok).toBe(false);
    expect(gate('all').check(req({ [H.viaProxy]: '1' }), '/')).toMatchObject({ ok: true, client: { local: false } });
  });

  it('refuses host names it does not know (DNS rebinding)', () => {
    // A web page's own domain, pointed at 127.0.0.1: Host and Origin agree, the name gives it away.
    const rebound = { [H.host]: 'attacker.example:8080', [H.origin]: 'http://attacker.example:8080' };
    expect(gate().check(req(rebound), '/api/status')).toMatchObject({ ok: false, reason: 'host' });
    expect(gate('all').check(req(rebound), '/api/status')).toMatchObject({ ok: false, reason: 'host' });
    expect(gate('', 'attacker.example').check(req(rebound), '/api/status').ok).toBe(true);
  });

  it('refuses cross-site requests', () => {
    const g = gate();
    expect(g.check(req({ [H.origin]: 'http://localhost:8080' }), '/api/markers').ok).toBe(true);
    expect(g.check(req({ [H.origin]: 'http://LOCALHOST:8080' }), '/api/markers').ok).toBe(true);
    for (const origin of ['http://evil.example', 'http://localhost:3000', 'https://localhost:8080.evil.example', 'null', 'file://', 'http://devbox:3000']) {
      expect(g.check(req({ [H.origin]: origin }), '/api/markers'), origin).toMatchObject({ ok: false, reason: 'origin' });
    }
    // Requests without Origin (plain GETs from a page elsewhere) still say where they come from.
    expect(g.check(req({ [H.fetchSite]: 'cross-site' }), '/api/sessions')).toMatchObject({ ok: false, reason: 'origin' });
    expect(g.check(req({ [H.fetchSite]: 'same-site' }), '/api/sessions')).toMatchObject({ ok: false, reason: 'origin' });
    expect(g.check(req({ [H.fetchSite]: 'same-origin' }), '/api/sessions').ok).toBe(true);
    expect(g.check(req({ [H.fetchSite]: 'none' }), '/api/sessions').ok).toBe(true);
    // Following a link to the page itself from another site is fine: it is only the page.
    expect(g.check(req({ [H.fetchSite]: 'cross-site' }), '/').ok).toBe(true);
  });

  it('accepts the public name of a proxy that rewrites Host, once it is allowed', () => {
    const behindTls = { [H.host]: 'localhost:8080', [H.origin]: 'https://hub.example.com' };
    expect(gate().check(req(behindTls), '/api/markers').ok).toBe(false);
    expect(gate('', 'hub.example.com').check(req(behindTls), '/api/markers').ok).toBe(true);
    expect(gate('', '*.example.com').check(req(behindTls), '/api/markers').ok).toBe(true);
  });

  it('notes the addresses the UI is used under', () => {
    const g = gate();
    g.check(req({ [H.host]: 'LocalHost:8080' }), '/');
    g.check(req({ [H.host]: 'evil.example' }), '/');
    expect([...g.seenHosts]).toEqual(['localhost:8080']);
  });
});

describe('what a refused browser is told', () => {
  it('says how to open it up, without naming anything on the server', () => {
    const page = denyPage('remote', { addr: '10.0.0.9', local: false, host: '10.0.0.1:8080' });
    expect(page).toContain('10.0.0.9');
    expect(page).toContain('debughub.remote');
    expect(page).toContain('ssh -L');
    expect(denyPage('host', { addr: '127.0.0.1', local: true, host: '<script>x</script>' })).not.toContain('<script>');
  });
});
