import { describe, expect, it } from 'vitest';
import { checkSyntax, compareKeys, countKeys, fileKind, readKeys, syntaxRegression, type FileKind } from '../src/shared/configkeys';
import { decodeText, describeFormat, detectEol, encodeText, splitLines, type DecodedText } from '../src/shared/textformat';

/** { path: value } of a file's settings. */
function keys(text: string, kind: FileKind): Record<string, string> | null {
  const entries = readKeys(text, kind);
  return entries && Object.fromEntries(entries.map((e) => [e.path, e.value]));
}

function delta(first: string, second: string, kind: FileKind) {
  const d = compareKeys(readKeys(first, kind)!, readKeys(second, kind)!, kind);
  return {
    added: d.added.map((c) => (c.count > 1 ? `${c.path} (${c.count})` : c.path)),
    removed: d.removed.map((c) => (c.count > 1 ? `${c.path} (${c.count})` : c.path)),
    changed: d.changed.map((c) => `${c.path}: ${c.from} -> ${c.to}`),
  };
}

describe('fileKind', () => {
  it('goes by the file name', () => {
    expect(['config.yaml', 'a/b/app.YML', 'x.json', 'app.properties', 'log4j2.xml', 'js/config.js', '.env', 'tool.ini', 'notes.txt', 'Makefile'].map(fileKind)).toEqual([
      'yaml', 'yaml', 'json', 'properties', 'xml', 'js', 'ini', 'ini', 'text', 'text',
    ]);
  });
});

describe('YAML settings', () => {
  const yaml = [
    '# Shop settings',
    'server:',
    '  port: 9090   # local',
    '  host: "0.0.0.0"',
    'db:',
    '  url: jdbc:postgresql://localhost/shop',
    '  pool:',
    '    max: 10',
    'features:',
    '  - search',
    '  - export',
    'servers:',
    '  - name: a',
    '    port: 1',
    '  - name: b',
    '    opts: { tls: true, ciphers: [x, y] }',
    'empty:',
    'motd: |',
    '  Hello',
    '  there: friend',
    'last: done',
  ].join('\n');

  it('reads nested keys, lists, flow values, block text and empty values', () => {
    expect(keys(yaml, 'yaml')).toEqual({
      'server.port': '9090',
      'server.host': '"0.0.0.0"',
      'db.url': 'jdbc:postgresql://localhost/shop',
      'db.pool.max': '10',
      features: '[search, export]',
      'servers[0].name': 'a',
      'servers[0].port': '1',
      'servers[1].name': 'b',
      'servers[1].opts.tls': 'true',
      'servers[1].opts.ciphers': '[x, y]',
      empty: '',
      motd: 'Hello\nthere: friend',
      last: 'done',
    });
    const lines = Object.fromEntries(readKeys(yaml, 'yaml')!.map((e) => [e.path, e.line]));
    expect(lines['server.port']).toBe(2);
    expect(lines['db.pool.max']).toBe(7);
    expect(lines.last).toBe(20);
  });

  it('reads what a strict parser would refuse: anchors, tags, several documents, lists at the key’s indent', () => {
    const text = 'base: &base\n  a: 1\nuse: *base\ntyped: !!str 12\nhosts:\n- x\n- y\nnext: 1\n---\nspring:\n  profiles: prod\n';
    expect(keys(text, 'yaml')).toEqual({ 'base.a': '1', use: '*base', typed: '12', hosts: '[x, y]', next: '1', 'document 2.spring.profiles': 'prod' });
  });

  it('says what a new build adds, drops and sets differently', () => {
    const build = [
      'server:',
      '  port: 8080',
      '  host: "0.0.0.0"',
      '  timeout: 30',
      'db:',
      '  url: jdbc:postgresql://db/shop',
      'mail:',
      '  smtp:',
      '    host: smtp.shop',
      '    port: 25',
      'features:',
      '  - search',
      '  - export',
      '  - reports',
      'last: done',
    ].join('\n');
    const d = delta(yaml, build, 'yaml');
    expect(d.added).toEqual(['server.timeout', 'mail (2)']);
    expect(d.removed).toEqual(['db.pool.max', 'servers (5)', 'empty', 'motd']);
    expect(d.changed).toEqual([
      'server.port: 9090 -> 8080',
      'db.url: jdbc:postgresql://localhost/shop -> jdbc:postgresql://db/shop',
      'features: [search, export] -> [search, export, reports]',
    ]);
    const full = compareKeys(readKeys(yaml, 'yaml')!, readKeys(build, 'yaml')!, 'yaml');
    expect(countKeys(full.added)).toBe(3);
    expect(full.added[0]).toMatchObject({ path: 'server.timeout', value: '30', line: 3 });
    expect(full.added[1]).toMatchObject({ path: 'mail', count: 2, line: 8 });
    expect(full.added[1].value).toBeUndefined();
    // Quoting is not a change of value.
    expect(delta('a: "x"\nb: 1', "a: 'x'\nb: 1", 'yaml')).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('JSON settings', () => {
  it('reads objects and arrays, also with comments and trailing commas', () => {
    const text = '{\n  // local\n  "api": { "url": "http://x", "retries": 3 },\n  "tags": ["a", "b"],\n  "list": [{ "id": 1 }, { "id": 2 }],\n  "none": {},\n}';
    expect(keys(text, 'json')).toEqual({ 'api.url': '"http://x"', 'api.retries': '3', tags: '["a", "b"]', 'list[0].id': '1', 'list[1].id': '2', none: '{}' });
    expect(readKeys(text, 'json')!.find((e) => e.path === 'api.retries')!.line).toBe(2);
    expect(readKeys('not json', 'json')).toBeNull();
    expect(readKeys('{"a": 1} trailing', 'json')).toBeNull();
  });

  it('compares by key', () => {
    expect(delta('{"a": 1, "b": {"c": true}}', '{"a": 2, "b": {"c": true, "d": null}, "e": {"f": 1, "g": 2}}', 'json')).toEqual({
      added: ['b.d', 'e (2)'],
      removed: [],
      changed: ['a: 1 -> 2'],
    });
  });
});

describe('.properties and INI settings', () => {
  it('reads keys with =, : and spaces, escapes and continued lines', () => {
    const text = '# comment\n! also\nmail.smtp.host = smtp.shop\nmail.smtp.port:25\nname Shop\npath=C:\\\\data\nlong = one, \\\n       two\nwith\\ space = x\nempty=\n';
    expect(keys(text, 'properties')).toEqual({
      'mail.smtp.host': 'smtp.shop',
      'mail.smtp.port': '25',
      name: 'Shop',
      path: 'C:\\\\data',
      long: 'one, two',
      'with space': 'x',
      empty: '',
    });
    expect(delta('a.b=1\nc=2\n', 'a.b=1\na.d=5\nx.y=1\nx.z=2\n', 'properties')).toEqual({ added: ['a.d', 'x (2)'], removed: ['c'], changed: [] });
  });

  it('reads sections of INI, TOML and .env files', () => {
    expect(keys('; note\ntop = 1\n[db]\nurl = "x"\n[db.pool]\nmax = 5\n[[server]]\nname = a\n[[server]]\nname = b\n', 'ini')).toEqual({
      top: '1',
      'db.url': '"x"',
      'db.pool.max': '5',
      'server[0].name': 'a',
      'server[1].name': 'b',
    });
    expect(keys('export API_URL=http://x\nDEBUG=1\n', 'ini')).toEqual({ API_URL: 'http://x', DEBUG: '1' });
  });
});

describe('XML settings', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- local logging -->',
    '<Configuration status="WARN">',
    '  <Properties>',
    '    <Property name="logDir">/var/log/shop</Property>',
    '  </Properties>',
    '  <Appenders>',
    '    <Console name="Console" target="SYSTEM_OUT">',
    '      <PatternLayout pattern="%d %-5p %c - %m%n"/>',
    '    </Console>',
    '  </Appenders>',
    '  <Loggers>',
    '    <Logger name="com.shop" level="debug"/>',
    '    <Root level="info">',
    '      <AppenderRef ref="Console"/>',
    '    </Root>',
    '  </Loggers>',
    '</Configuration>',
  ].join('\n');

  it('reads elements and attributes by path, naming elements by their name attribute', () => {
    expect(keys(xml, 'xml')).toEqual({
      '@status': 'WARN',
      'Properties/Property[logDir]': '/var/log/shop',
      'Appenders/Console[Console]@target': 'SYSTEM_OUT',
      'Appenders/Console[Console]/PatternLayout@pattern': '%d %-5p %c - %m%n',
      'Loggers/Logger[com.shop]@level': 'debug',
      'Loggers/Root@level': 'info',
      'Loggers/Root/AppenderRef[Console]': '',
    });
    expect(readKeys(xml, 'xml')!.find((e) => e.path === 'Loggers/Logger[com.shop]@level')!.line).toBe(12);
  });

  it('says which loggers and appenders a new build adds', () => {
    const build = xml
      .replace('status="WARN"', 'status="INFO" monitorInterval="30"')
      .replace('    </Console>\n', '    </Console>\n    <RollingFile name="File" fileName="${logDir}/shop.log">\n      <PatternLayout pattern="%d %m%n"/>\n    </RollingFile>\n')
      .replace('    <Logger name="com.shop" level="debug"/>\n', '    <Logger name="com.shop" level="info"/>\n    <Logger name="com.shop.search" level="warn"/>\n')
      .replace('    <Property name="logDir">/var/log/shop</Property>\n', '');
    expect(delta(xml, build, 'xml')).toEqual({
      added: ['@monitorInterval', 'Appenders/RollingFile[File] (2)', 'Loggers/Logger[com.shop.search]@level'],
      removed: ['Properties/Property[logDir]'],
      changed: ['@status: WARN -> INFO', 'Loggers/Logger[com.shop]@level: debug -> info'],
    });
  });

  it('numbers elements of the same tag that have no name', () => {
    expect(keys('<a><b x="1"/><b x="2"/><c>t &amp; u</c></a>', 'xml')).toEqual({ 'b[1]@x': '1', 'b[2]@x': '2', c: 't & u' });
  });
});

describe('JavaScript settings (best effort)', () => {
  it('reads an object assigned to a global, with nested keys and expressions as values', () => {
    const js = [
      '// Local settings',
      'window.CONFIG = {',
      "  apiUrl: 'http://localhost:8080/api',",
      '  features: { newSearch: true, beta: false },',
      '  timeout: 30 * 1000,',
      "  hosts: ['a', 'b'],",
      '  onError: function (e) { console.log(e, { x: 1 }); },',
      '  re: /[,}]+/g,',
      '};',
      'var retries = 3',
      "window.APP_NAME = 'Shop';",
    ].join('\n');
    expect(keys(js, 'js')).toEqual({
      'CONFIG.apiUrl': "'http://localhost:8080/api'",
      'CONFIG.features.newSearch': 'true',
      'CONFIG.features.beta': 'false',
      'CONFIG.timeout': '30 * 1000',
      'CONFIG.hosts': "['a', 'b']",
      'CONFIG.onError': 'function (e) { console.log(e, { x: 1 }); }',
      'CONFIG.re': '/[,}]+/g',
      retries: '3',
      APP_NAME: "'Shop'",
    });
    expect(readKeys(js, 'js')!.find((e) => e.path === 'CONFIG.timeout')!.line).toBe(4);
  });

  it('reads module exports, export default, wrapped scripts and objects handed to a call', () => {
    expect(keys('module.exports = { a: 1, b: { c: 2 } };', 'js')).toEqual({ a: '1', 'b.c': '2' });
    expect(keys('export default {\n  a: 1,\n  "b-c": [1, 2],\n}\n', 'js')).toEqual({ a: '1', 'b-c': '[1, 2]' });
    expect(keys('(function () {\n  var cfg = { debug: true };\n  window.cfg = cfg;\n})();', 'js')).toEqual({ 'cfg.debug': 'true', cfg: 'cfg' });
    expect(keys("angular.module('app').constant('ENV', { api: '/v1', flags: { x: 1 } });", 'js')).toEqual({ 'ENV.api': "'/v1'", 'ENV.flags.x': '1' });
    expect(keys('Object.assign(window.CONFIG, { extra: 1 });', 'js')).toEqual({ 'CONFIG.extra': '1' });
    expect(keys('for (let i = 0; i < 3; i++) { run(i); }', 'js')).toBeNull();
  });

  it('compares two versions', () => {
    const mine = "window.CONFIG = {\n  apiUrl: 'http://localhost/api',\n  legacyMode: true,\n};\n";
    const build = "window.CONFIG = {\n  apiUrl: '/api',\n  features: { newSearch: false },\n  pageSize: 25,\n};\n";
    expect(delta(mine, build, 'js')).toEqual({
      added: ['CONFIG.features.newSearch', 'CONFIG.pageSize'],
      removed: ['CONFIG.legacyMode'],
      changed: ["CONFIG.apiUrl: 'http://localhost/api' -> '/api'"],
    });
  });
});

describe('readKeys', () => {
  it('has nothing to say about plain text and empty files', () => {
    expect(readKeys('some notes\nmore', 'text')).toBeNull();
    expect(readKeys('', 'yaml')).toBeNull();
    expect(readKeys('# only a comment\n', 'properties')).toBeNull();
    expect(readKeys('no elements here', 'xml')).toBeNull();
  });
});

describe('checkSyntax', () => {
  it('accepts well-formed files', () => {
    expect(checkSyntax('a: 1\nb:\n  - x\n', 'yaml')).toBeNull();
    expect(checkSyntax('{"a": [1, 2]}', 'json')).toBeNull();
    expect(checkSyntax('<a x="1"><!-- c --><b/>text &amp; more<![CDATA[ <raw> & ]]></a>\n', 'xml')).toBeNull();
    expect(checkSyntax('a=1\nb=2\n', 'properties')).toBeNull();
    expect(checkSyntax("window.C = { a: [1, 2], re: /[)]/, s: 'it\\'s' };", 'js')).toBeNull();
    expect(checkSyntax('anything { goes', 'text')).toBeNull();
  });

  it('finds what a hand merge typically breaks', () => {
    expect(checkSyntax('a:\n  b: 1\n c: 2\n', 'yaml')).toMatchObject({ line: 2 });
    expect(checkSyntax('a: 1\nb: 2\na: 3\n', 'yaml')).toEqual({ message: '"a" is set twice (lines 1 and 3).', line: 2 });
    expect(checkSyntax('s:\n  port: 1\n  x: 2\n  port: 3\n', 'yaml')?.message).toBe('"s.port" is set twice (lines 2 and 4).');
    expect(checkSyntax('{\n  "a": 1\n  "b": 2\n}', 'json')).toMatchObject({ line: 2 });
    expect(checkSyntax('{"a": 1, "b": {"c": 1, "c": 2}}', 'json')?.message).toBe('"b.c" is set twice (lines 1 and 1).');
    expect(checkSyntax('a=1\nb=2\na=3\n', 'properties')?.message).toBe('"a" is set twice (lines 1 and 3).');
    expect(checkSyntax('window.C = {\n  a: [1, 2,\n};', 'js')).toMatchObject({ line: 2 });
    expect(checkSyntax("x = 'open\ny = 2", 'js')).toMatchObject({ line: 0 });
  });

  it('finds XML that is not well formed', () => {
    const problem = (text: string) => checkSyntax(text, 'xml')?.message;
    expect(problem('<a>\n  <b>\n</a>')).toBe('</a> closes <b>, which was opened on line 2.');
    expect(checkSyntax('<a>\n  <b>\n</a>', 'xml')?.line).toBe(2);
    expect(problem('<a>\n<b/>')).toBe('<a>, opened on line 1, is never closed.');
    expect(problem('<a x=1/>')).toBe('In <a>, an attribute needs a value in quotes.');
    expect(problem('<a x="1" x="2"/>')).toBe('<a> has the attribute x twice.');
    expect(problem('<a>fish & chips</a>')).toBe('An & must be written as &amp;.');
    expect(problem('<a><!-- never closed </a>')).toBe('A comment is never closed.');
    expect(problem('<a/><b/>')).toBe('There is more than one root element.');
    expect(problem('<a>1 < 2</a>')).toBe('A < that does not start a tag must be written as &lt;.');
  });

  it('only reports what the merge broke', () => {
    const commented = '{\n  // comment\n  "a": 1\n}';
    // JSON with comments never parsed: not the merge's doing.
    expect(syntaxRegression(`${commented}\n`, 'json', [commented])).toBeNull();
    expect(syntaxRegression('{"a": 1,}', 'json', ['{"a": 1}', '{"a": 2}'])).not.toBeNull();
    expect(syntaxRegression('{"a": 3}', 'json', ['{"a": 1}', '{"a": 2}'])).toBeNull();
    // Unchanged from one of the versions: nothing to report even if it does not parse.
    expect(syntaxRegression('{"a": 1,}', 'json', ['{"a": 1,}', '{"a": 2}'])).toBeNull();
    expect(syntaxRegression('a: &x 1\nb: *x\nc: [\n', 'yaml', ['a: &x 1\nb: *x\n'])).toBeNull();
  });
});

describe('text format', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const ok = (d: ReturnType<typeof decodeText>) => d as DecodedText;

  it('finds line endings, the byte order mark and the final line break', () => {
    expect(ok(decodeText(bytes('a\nb\n'))).format).toEqual({ encoding: 'utf-8', bom: false, eol: '\n', mixedEol: false, finalNewline: true });
    const crlf = ok(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('a: ü\r\nb\r\nc')])));
    expect(crlf.text).toBe('a: ü\nb\nc');
    expect(crlf.format).toEqual({ encoding: 'utf-8', bom: true, eol: '\r\n', mixedEol: false, finalNewline: false });
    expect(describeFormat(crlf.format)).toBe('UTF-8 with BOM · CRLF');
    expect(detectEol('a\r\nb\nc\r\nd\r\n')).toEqual({ eol: '\r\n', mixed: true });
    expect(detectEol('a\rb\r')).toEqual({ eol: '\r', mixed: false });
    expect(detectEol('one line')).toEqual({ eol: '\n', mixed: false });
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b', '']);
    expect(splitLines('')).toEqual(['']);
  });

  it('writes a merged text back as the file was stored', () => {
    const original = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('a: 1\r\nb: ü\r\n')]);
    const d = ok(decodeText(original));
    expect(encodeText(d.text, d.format)).toEqual(original);
    expect(encodeText('a: 1\nnew: 2\nb: ü', d.format)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('a: 1\r\nnew: 2\r\nb: ü')]));
    // Line endings pasted in from elsewhere do not leak into the file.
    expect(encodeText('a\r\nb\rc\n', { encoding: 'utf-8', bom: false, eol: '\n' })).toEqual(bytes('a\nb\nc\n'));
  });

  it('reads and writes ISO-8859-1 byte for byte, and refuses characters it does not have', () => {
    const latin = new Uint8Array([0x67, 0x72, 0xfc, 0xdf, 0x3d, 0xe4, 0x0a]); // grüß=ä\n
    const d = ok(decodeText(latin));
    expect(d.text).toBe('grüß=ä\n');
    expect(d.format.encoding).toBe('latin1');
    expect(encodeText(d.text, d.format)).toEqual(latin);
    expect(describeFormat(d.format)).toBe('ISO-8859-1 · LF');
    expect(encodeText('a=1\nb=€\n', d.format)).toMatchObject({ problem: expect.stringMatching(/ISO-8859-1.*"€" \(line 2\)/) });
  });

  it('refuses binary and UTF-16 files', () => {
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]))).toEqual({ problem: 'It is not a text file.' });
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toMatchObject({ problem: expect.stringContaining('UTF-16') });
    expect(decodeText(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({ problem: 'It is not a text file.' });
    expect(ok(decodeText(new Uint8Array())).text).toBe('');
  });
});
