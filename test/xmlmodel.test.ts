import { describe, expect, it } from 'vitest';
import {
  canTable, cellOf, cellText, describe as describeNode, elements, faultSummary, findTable, findXmlIn, isLeaf, isXmlBody, namespacesInScope, nestedKind, nsDecls, parseXml,
  plainAttrs, prettyXml, preview, search, serialize, serializeCapped, serializeDocument, soapInfo, SOAP_11, SOAP_12, tableOf, textOf, xpathOf, type XEl, type XNode, type XText,
} from '../src/ui/xmlmodel';
import { completions, nestedFallback, QueryError, runXPath, splitXPath } from '../src/ui/xmlquery';

const SOAP11 = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" soapenv:mustUnderstand="1">
      <wsse:UsernameToken><wsse:Username>alice</wsse:Username></wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    <ord:GetOrderResponse xmlns:ord="http://example.com/orders">
      <ord:Order id="4711" status="OPEN">
        <ord:Customer>Ada &amp; Co &lt;Ltd&gt;</ord:Customer>
        <ord:Items>
          <ord:Item sku="A-1"><ord:Name>Bolt</ord:Name><ord:Price>2.50</ord:Price></ord:Item>
          <ord:Item sku="B-2"><ord:Name>Nut</ord:Name><ord:Price>12</ord:Price></ord:Item>
          <ord:Item sku="C-3"><ord:Name>Washer</ord:Name><ord:Price>0.1</ord:Price><ord:Note xsi:nil="true"/></ord:Item>
        </ord:Items>
        <ord:Notes><![CDATA[Leave <b>at</b> the door & ring]]></ord:Notes>
      </ord:Order>
    </ord:GetOrderResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

const FAULT11 = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault>
<faultcode>soap:Server</faultcode><faultstring>Order 4711 not found</faultstring><faultactor>http://example.com/orders</faultactor>
<detail><e:OrderFault xmlns:e="http://example.com/errors"><e:code>ORD-404</e:code></e:OrderFault></detail>
</soap:Fault></soap:Body></soap:Envelope>`;

const FAULT12 = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:m="http://example.com/m">
 <env:Body><env:Fault>
  <env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>m:BadArguments</env:Value><env:Subcode><env:Value>m:MissingId</env:Value></env:Subcode></env:Subcode></env:Code>
  <env:Reason><env:Text xml:lang="en">Processing error</env:Text><env:Text xml:lang="cs">Chyba zpracování</env:Text></env:Reason>
  <env:Node>http://example.com/node</env:Node><env:Role>http://example.com/role</env:Role>
  <env:Detail><m:MaxTime>P5M</m:MaxTime></env:Detail>
 </env:Fault></env:Body>
</env:Envelope>`;

const root = (xml: string): XEl => {
  const p = parseXml(xml);
  expect(p.error).toBeNull();
  return p.root!;
};
const names = (nodes: XNode[]) => nodes.map((n) => (n.t === 'el' || n.t === 'attr' ? n.name : n.t));

describe('parseXml', () => {
  it('reads elements, attributes, text and the declaration', () => {
    const p = parseXml(SOAP11);
    expect(p.error).toBeNull();
    expect(p.partial).toBe(false);
    expect(p.decl).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(p.root!.name).toBe('soapenv:Envelope');
    expect(p.root!.prefix).toBe('soapenv');
    expect(p.root!.local).toBe('Envelope');
    expect(p.elements).toBe(21);
    expect(elements(p.root!).map((e) => e.local)).toEqual(['Header', 'Body']);
  });

  it('drops the white space between elements but keeps text', () => {
    const r = root('<a>\n  <b> x </b>\n  <c/>\n</a>');
    expect(r.kids.map((k) => k.t)).toEqual(['el', 'el']);
    expect(textOf(r.kids[0])).toBe(' x ');
    expect(isLeaf(r.kids[0] as XEl)).toBe(true);
    // Text beside elements is content, white space included.
    const mixed = root('<p>Hello <b>big</b> world</p>');
    expect(mixed.kids.map((k) => k.t)).toEqual(['text', 'el', 'text']);
    expect(textOf(mixed)).toBe('Hello big world');
  });

  it('decodes the built-in entities and character references, in text and attributes', () => {
    const r = root('<a t="&quot;x&quot; &lt; &#65;&#x1F600;">&lt;b&gt; &amp;amp; &apos;q&apos; &#169;</a>');
    expect(r.attrs[0].value).toBe('"x" < A😀');
    expect(textOf(r)).toBe("<b> &amp; 'q' ©");
  });

  it('leaves unknown entities and bad character references as written', () => {
    const p = parseXml('<a>&nbsp;&bogus; &#0; &#xD800; a & b</a>');
    expect(p.error).toBeNull();
    expect(textOf(p.root!)).toBe('&nbsp;&bogus; &#0; &#xD800; a & b');
    expect(p.unknownEntities).toBe(2);
  });

  it('keeps CDATA as it is', () => {
    const r = root(SOAP11);
    const notes = runXPath(parseXml(SOAP11), '//Notes')[0] as XEl;
    expect(textOf(notes)).toBe('Leave <b>at</b> the door & ring');
    expect((notes.kids[0] as XText).cdata).toBe(true);
    expect(r.name).toBe('soapenv:Envelope');
    // Text and CDATA side by side stay separate nodes; the element's text joins them.
    const mix = root('<a>one <![CDATA[<two>]]> three</a>');
    expect(mix.kids.map((k) => (k as XText).cdata)).toEqual([false, true, false]);
    expect(textOf(mix)).toBe('one <two> three');
  });

  it('keeps comments and processing instructions, inside and around the root', () => {
    const p = parseXml('<?xml version="1.0"?>\n<!-- top -->\n<?pi some data?>\n<a><!-- in --><b/><?x?></a>\n<!-- end -->');
    expect(p.error).toBeNull();
    expect(p.before.map((n) => n.t)).toEqual(['comment', 'pi']);
    expect(p.after.map((n) => n.t)).toEqual(['comment']);
    expect(p.root!.kids.map((k) => k.t)).toEqual(['comment', 'el', 'pi']);
    expect(p.before[1]).toMatchObject({ target: 'pi', v: 'some data' });
  });

  it('skips a DOCTYPE without reading it: its entities are never expanded', () => {
    const p = parseXml('<!DOCTYPE a [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> <!ENTITY big "aaaa]>"> ]>\n<a>&xxe;&big;</a>');
    expect(p.error).toBeNull();
    expect(p.doctype).toBe(true);
    expect(textOf(p.root!)).toBe('&xxe;&big;');
    expect(p.unknownEntities).toBe(2);
  });

  it('accepts a byte order mark, single quotes and odd spacing', () => {
    const r = root("﻿<a  x = 'it\"s'\n y=\"2\" ><b\n/></a >");
    expect(r.attrs.map((a) => [a.name, a.value])).toEqual([['x', 'it"s'], ['y', '2']]);
    expect(r.kids).toHaveLength(1);
  });

  it('reports syntax errors with their position', () => {
    const cases: [string, RegExp, number, number][] = [
      ['<a><b></a>', /Closing tag <\/a> does not match <b> \(opened at line 1, column 4\)/, 1, 7],
      ['<a>\n  <b>x</c>\n</a>', /does not match <b>/, 2, 7],
      ['<a></a><b/>', /second root element <b>/, 1, 8],
      ['<a></a> trailing', /Text after the end of the root element/, 1, 9],
      ['hello <a/>', /Text before the root element/, 1, 1],
      ['<a x=1/>', /attribute x in <a> must be in quotes/, 1, 6],
      ['<a x></a>', /Attribute x in <a> has no value/, 1, 5],
      ['<a>1 < 2</a>', /Expected a tag name after "<"/, 1, 6],
      ['</a>', /without an opening tag/, 1, 1],
      ['<a><!FOO></a>', /Unexpected "<!"/, 1, 4],
    ];
    for (const [xml, message, line, col] of cases) {
      const p = parseXml(xml);
      expect(p.root, xml).toBeNull();
      expect(p.error?.message, xml).toMatch(message);
      expect([p.error?.line, p.error?.col], xml).toEqual([line, col]);
    }
  });

  it('gives the tree so far when the text is cut off, at every length', () => {
    const full = parseXml(SOAP11);
    for (let n = 1; n < SOAP11.length; n++) {
      const p = parseXml(SOAP11.slice(0, n));
      expect(p.error, `at ${n}`).toBeNull();
      // Cut inside the declaration there is no element yet; after that there is always a tree.
      if (n > SOAP11.indexOf('<soapenv:Envelope') + 1) {
        expect(p.partial, `at ${n}`).toBe(true);
        expect(p.root, `at ${n}`).not.toBeNull();
        expect(p.root!.cut, `at ${n}`).toBe(true);
        expect(p.elements).toBeLessThanOrEqual(full.elements);
      }
    }
  });

  it('marks what was cut: the open elements, and text, comments and CDATA that never ended', () => {
    const p = parseXml('<a><b>done</b><c><d>half a sen');
    expect(p.partial).toBe(true);
    const [b, c] = elements(p.root!);
    expect(b.cut).toBeUndefined();
    expect(c.cut).toBe(true);
    const d = elements(c)[0];
    expect(d.cut).toBe(true);
    expect((d.kids[0] as XText).cut).toBe(true);
    expect(parseXml('<a><![CDATA[x').root!.kids[0]).toMatchObject({ cdata: true, v: 'x', cut: true });
    expect(parseXml('<a><!-- x').root!.kids[0]).toMatchObject({ t: 'comment', cut: true });
    expect(parseXml('<a b="1" c="tw').root).toMatchObject({ cut: true, attrs: [{ name: 'b' }, { name: 'c', value: 'tw' }] });
    expect(parseXml('<a><b></').partial).toBe(true);
    expect(parseXml('').root).toBeNull();
    expect(parseXml('   ').error).toBeNull();
  });

  it('stays quick on a large document and does not recurse', () => {
    const items = Array.from({ length: 50_000 }, (_, i) => `<Item id="${i}"><Name>Item ${i}</Name><Price>${i}.5</Price></Item>`).join('');
    const deep = '<d>'.repeat(5000) + 'x' + '</d>'.repeat(5000);
    const t0 = Date.now();
    const p = parseXml(`<List>${items}</List>`);
    expect(p.elements).toBe(150_001);
    expect(parseXml(deep).elements).toBe(5000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(xpathOf(elements(p.root!)[49_999])).toBe('/List/Item[50000]');
  });
});

describe('namespaces', () => {
  it('resolves prefixes and default namespaces, nearest declaration first', () => {
    const r = root('<a xmlns="urn:one" xmlns:p="urn:p"><b/><p:c p:x="1" y="2"/><d xmlns="urn:two"><e/></d><f xmlns=""><g/></f></a>');
    const [b, c, d, f] = elements(r);
    expect(r.ns).toBe('urn:one');
    expect(b.ns).toBe('urn:one');
    expect(c.ns).toBe('urn:p');
    expect(c.attrs.map((a) => a.ns)).toEqual(['urn:p', null]);
    expect(d.ns).toBe('urn:two');
    expect(elements(d)[0].ns).toBe('urn:two');
    expect(f.ns).toBeNull();
    expect(elements(f)[0].ns).toBeNull();
  });

  it('separates declarations from the other attributes', () => {
    const r = root(SOAP11);
    expect(plainAttrs(r)).toEqual([]);
    expect(nsDecls(r).map((a) => a.local)).toEqual(['soapenv', 'xsi']);
    const sec = runXPath(parseXml(SOAP11), '//Security')[0] as XEl;
    expect(plainAttrs(sec).map((a) => [a.name, a.ns])).toEqual([['soapenv:mustUnderstand', SOAP_11]]);
    expect(namespacesInScope(sec)).toEqual([
      { prefix: 'wsse', uri: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd', own: true },
      { prefix: 'soapenv', uri: SOAP_11, own: false },
      { prefix: 'xsi', uri: 'http://www.w3.org/2001/XMLSchema-instance', own: false },
    ]);
  });

  it('remembers the first binding of each prefix', () => {
    expect([...parseXml('<a xmlns="urn:d" xmlns:p="urn:1"><b xmlns:p="urn:2"/></a>').prefixes]).toEqual([['', 'urn:d'], ['p', 'urn:1']]);
  });
});

describe('soapInfo', () => {
  it('recognises a SOAP 1.1 envelope and its operation', () => {
    const s = soapInfo(root(SOAP11))!;
    expect(s.version).toBe('1.1');
    expect(s.header!.local).toBe('Header');
    expect(s.headers.map((h) => h.name)).toEqual(['wsse:Security']);
    expect(s.body!.local).toBe('Body');
    expect(s.payload!.name).toBe('ord:GetOrderResponse');
    expect(s.payload!.ns).toBe('http://example.com/orders');
    expect(s.fault).toBeNull();
  });

  it('reads a SOAP 1.1 fault', () => {
    const s = soapInfo(root(FAULT11))!;
    expect(s.version).toBe('1.1');
    expect(s.fault).toMatchObject({ code: 'soap:Server', reason: 'Order 4711 not found', actor: 'http://example.com/orders', subcodes: [] });
    expect(s.fault!.detail!.local).toBe('detail');
    expect(faultSummary(s.fault!)).toBe('soap:Server: Order 4711 not found');
  });

  it('reads a SOAP 1.2 fault with subcodes', () => {
    const s = soapInfo(root(FAULT12))!;
    expect(s.version).toBe('1.2');
    expect(s.envelope.ns).toBe(SOAP_12);
    expect(s.fault).toMatchObject({
      code: 'env:Sender', subcodes: ['m:BadArguments', 'm:MissingId'], reason: 'Processing error', actor: 'http://example.com/role', node: 'http://example.com/node',
    });
    expect(s.fault!.detail!.name).toBe('env:Detail');
    expect(faultSummary(s.fault!)).toBe('env:Sender › m:BadArguments › m:MissingId: Processing error');
  });

  it('works with a default namespace, no header and an empty body', () => {
    const s = soapInfo(root(`<Envelope xmlns="${SOAP_12}"><Body/></Envelope>`))!;
    expect(s).toMatchObject({ version: '1.2', header: null, headers: [], payload: null, fault: null });
    // An envelope in an unknown namespace still counts when it has a Body.
    expect(soapInfo(root('<Envelope><Body><Ping/></Body></Envelope>'))).toMatchObject({ version: null, payload: { name: 'Ping' } });
  });

  it('is null for other documents, and a Fault elsewhere is not a fault', () => {
    expect(soapInfo(root('<orders><order/></orders>'))).toBeNull();
    expect(soapInfo(root('<Envelope><Letter/></Envelope>'))).toBeNull();
    expect(soapInfo(null)).toBeNull();
    const s = soapInfo(root(`<s:Envelope xmlns:s="${SOAP_11}"><s:Body><m:R xmlns:m="urn:m"><m:Fault/></m:R></s:Body></s:Envelope>`))!;
    expect(s.fault).toBeNull();
    expect(soapInfo(root(`<s:Envelope xmlns:s="${SOAP_11}"><s:Body><m:Fault xmlns:m="urn:m"/></s:Body></s:Envelope>`))!.fault).toBeNull();
  });

  it('keeps going on a fault that was cut off', () => {
    const s = soapInfo(parseXml(FAULT11.slice(0, FAULT11.indexOf('not found'))).root)!;
    expect(s.fault).toMatchObject({ code: 'soap:Server', reason: 'Order 4711', detail: null });
  });
});

describe('serialize', () => {
  it('pretty-prints, keeping elements with text on one line', () => {
    expect(serialize(root('<a x="1"><b>t</b><c/><d><e>1</e></d><p>Hi <i>there</i> you</p></a>'))).toBe(
      '<a x="1">\n  <b>t</b>\n  <c/>\n  <d>\n    <e>1</e>\n  </d>\n  <p>Hi <i>there</i> you</p>\n</a>');
  });

  it('escapes what it must and keeps CDATA', () => {
    const xml = '<a t="&lt;&quot;&amp;&#10;">&lt;b&gt; &amp; <![CDATA[<x> ]]]]><![CDATA[> y]]></a>';
    const out = serialize(root(xml));
    expect(out).toBe(xml);
    expect(textOf(root(out))).toBe('<b> & <x> ]]> y');
  });

  it('writes entities XML does not define back as they were written', () => {
    const xml = '<a t=\'&nbsp;"x"\'>a &nbsp; b &amp;nbsp; &lt;<b>&amp;copy;</b></a>';
    const r = root(xml);
    expect(textOf(r.kids[0])).toBe('a &nbsp; b &nbsp; <');
    expect(serialize(r)).toBe('<a t="&nbsp;&quot;x&quot;">a &nbsp; b &amp;nbsp; &lt;<b>&amp;copy;</b></a>');
  });

  it('round-trips: the pretty-printed document parses to the same tree', () => {
    for (const xml of [SOAP11, FAULT11, FAULT12, '<?xml version="1.0"?><!-- c --><a><?pi d?><b/></a><!-- e -->']) {
      const p = parseXml(xml);
      const pretty = serializeDocument(p);
      const again = serializeDocument(parseXml(pretty));
      expect(again).toBe(pretty);
      expect(parseXml(pretty).elements).toBe(p.elements);
    }
    expect(serializeDocument(parseXml(SOAP11)).startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope ')).toBe(true);
  });

  it('stops early when capped', () => {
    const r = serializeCapped(root(SOAP11), 2, 200);
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThan(400);
    expect(serializeCapped(root('<a/>'), 2, 200)).toEqual({ text: '<a/>', cut: false });
  });

  it('prettyXml gives null for anything that is not complete XML', () => {
    expect(prettyXml('<a><b>1</b></a>')).toBe('<a>\n  <b>1</b>\n</a>');
    expect(prettyXml('<a><b>1</b>')).toBeNull();
    expect(prettyXml('<a><b></a>')).toBeNull();
    expect(prettyXml('plain text')).toBeNull();
    expect(prettyXml('<!DOCTYPE html><html></html>')).toBeNull();
  });
});

describe('what a text is', () => {
  it('isXmlBody goes by the content type, then the text', () => {
    expect(isXmlBody('<a/>', 'text/xml')).toBe(true);
    expect(isXmlBody('<a/>', 'application/soap+xml')).toBe(true);
    expect(isXmlBody('  <?xml version="1.0"?><a/>', null)).toBe(true);
    expect(isXmlBody('<a/>', 'text/plain')).toBe(true);
    expect(isXmlBody('<a/>', undefined)).toBe(true);
    expect(isXmlBody('<!DOCTYPE html><html>', 'text/html')).toBe(false);
    expect(isXmlBody('<html lang="en">', null)).toBe(false);
    expect(isXmlBody('<!doctype html>\n<html>', null)).toBe(false);
    expect(isXmlBody('<div>', 'text/html')).toBe(false);
    expect(isXmlBody('{"a":"<b/>"}', 'application/json')).toBe(false);
    expect(isXmlBody('{"a":1}', null)).toBe(false);
    expect(isXmlBody('1 < 2', null)).toBe(false);
    expect(isXmlBody('no markup', 'application/xml')).toBe(true);
  });

  it('nestedKind finds escaped XML and JSON inside a text', () => {
    const r = root('<r><payload>&lt;order id="1"&gt;&lt;item&gt;x&lt;/item&gt;&lt;/order&gt;</payload><j>{"a":{"b":1}}</j><n>12 &lt; 13</n><h>&lt;b&gt;bold</h><e>{}</e></r>');
    const [x, j, n, hEl, e] = elements(r);
    expect(nestedKind(textOf(x))).toBe('xml');
    expect(nestedKind(textOf(j))).toBe('json');
    expect(nestedKind(textOf(n))).toBeNull();
    expect(nestedKind(textOf(hEl))).toBeNull();
    expect(nestedKind(textOf(e))).toBeNull();
    expect(nestedKind('  [{"a":1}]\n')).toBe('json');
    expect(nestedKind('[1, 2, 3]')).toBeNull();
    expect(nestedKind('<a></b>')).toBeNull();
    expect(parseXml(textOf(x)).root).toMatchObject({ name: 'order', attrs: [{ name: 'id', value: '1' }] });
  });

  it('findXmlIn finds a logged payload and ignores things that only look like tags', () => {
    const msg = `Outbound Message\nPayload: ${FAULT11} (took 12 ms)`;
    const found = findXmlIn(msg)!;
    expect(found.text).toBe(FAULT11);
    expect(msg.slice(found.start, found.end)).toBe(FAULT11);
    expect(findXmlIn('at com.acme.Foo.<init>(Foo.java:12)\n  Map<String, List<Order>> x = <none>')).toBeNull();
    expect(findXmlIn('value <b>bold</b> text')).toBeNull();
    expect(findXmlIn('see <?xml version="1.0"?><a><b/></a> end')?.text).toBe('<?xml version="1.0"?><a><b/></a>');
    expect(findXmlIn('broken <a><b></a>, then <c><d/></c>')?.text).toBe('<c><d/></c>');
    expect(findXmlIn('no xml here')).toBeNull();
  });
});

describe('xpathOf', () => {
  const p = parseXml(SOAP11);
  const one = (expr: string) => runXPath(p, expr)[0];

  it('gives a path that finds the node again', () => {
    const all = runXPath(p, '//*');
    const attrs = runXPath(p, '//@*');
    const texts = runXPath(p, '//text()');
    for (const n of [...all, ...attrs, ...texts]) {
      for (const anyNs of [false, true]) {
        const path = xpathOf(n, anyNs);
        expect(runXPath(p, path), path).toEqual([n]);
      }
    }
  });

  it('numbers only the steps that need it', () => {
    expect(xpathOf(one('//Item[2]/Price'))).toBe('/soapenv:Envelope/soapenv:Body/ord:GetOrderResponse/ord:Order/ord:Items/ord:Item[2]/ord:Price');
    expect(xpathOf(one('//Item[3]/@sku'))).toBe('/soapenv:Envelope/soapenv:Body/ord:GetOrderResponse/ord:Order/ord:Items/ord:Item[3]/@sku');
    expect(xpathOf(one('//Note/@xsi:nil'), true)).toBe(
      "/*[local-name()='Envelope']/*[local-name()='Body']/*[local-name()='GetOrderResponse']/*[local-name()='Order']/*[local-name()='Items']/*[local-name()='Item'][3]/*[local-name()='Note']/@*[local-name()='nil']");
    expect(xpathOf(root('<a><b/></a>').kids[0], true)).toBe('/a/b');
  });

  it('covers text, comments and processing instructions', () => {
    const d = parseXml('<a>x<b/>y<!-- c --><?p?><!-- d --></a>');
    expect(d.root!.kids.map((k) => xpathOf(k))).toEqual(['/a/text()[1]', '/a/b', '/a/text()[2]', '/a/comment()[1]', '/a/processing-instruction()', '/a/comment()[2]']);
    for (const k of d.root!.kids) expect(runXPath(d, xpathOf(k))).toEqual([k]);
  });
});

describe('runXPath', () => {
  const p = parseXml(SOAP11);
  const q = (expr: string) => runXPath(p, expr);

  it('walks paths from the top, with or without the leading slash', () => {
    expect(names(q('/soapenv:Envelope/soapenv:Body/ord:GetOrderResponse'))).toEqual(['ord:GetOrderResponse']);
    expect(names(q('soapenv:Envelope/soapenv:Body/*'))).toEqual(['ord:GetOrderResponse']);
    expect(names(q('/'))).toEqual(['soapenv:Envelope']);
    expect(names(q('/*/*'))).toEqual(['soapenv:Header', 'soapenv:Body']);
    expect(q('/soapenv:Body')).toEqual([]);
  });

  it('matches a name without a prefix in any namespace, and a prefix by its namespace', () => {
    expect(names(q('/Envelope/Body/GetOrderResponse/Order/Customer'))).toEqual(['ord:Customer']);
    expect(q('//ord:Item')).toHaveLength(3);
    expect(q('//ord:*')).toHaveLength(15);
    expect(q('//nope:Item')).toEqual([]);
    // The same namespace under another prefix, and as the default namespace.
    const d = parseXml('<r xmlns:a="urn:x"><a:i/><b:i xmlns:b="urn:x"/><i xmlns="urn:x"/><i/><c:i xmlns:c="urn:other"/></r>');
    expect(runXPath(d, '/r/a:i')).toHaveLength(3);
    expect(runXPath(d, '/r/i')).toHaveLength(5);
    expect(runXPath(d, '/r/c:i')).toHaveLength(1);
  });

  it('finds at any depth with //, in document order and without duplicates', () => {
    expect(names(q('//Name'))).toEqual(['ord:Name', 'ord:Name', 'ord:Name']);
    expect(q('//Items//Price').map((n) => textOf(n))).toEqual(['2.50', '12', '0.1']);
    expect(q('//Order//*')).toHaveLength(13);
    expect(q('//*')).toHaveLength(21);
    const ords = q('//*').map((n) => n.ord);
    expect(ords).toEqual([...ords].sort((a, b) => a - b));
    expect(new Set(q('//*//*')).size).toBe(q('//*//*').length);
  });

  it('selects attributes, text and parents', () => {
    expect(q('//Item/@sku').map((n) => textOf(n))).toEqual(['A-1', 'B-2', 'C-3']);
    expect(names(q('//Order/@*'))).toEqual(['id', 'status']);
    expect(names(q('//@xsi:nil'))).toEqual(['xsi:nil']);
    // Namespace declarations are not attributes.
    expect(q('/*/@*')).toEqual([]);
    expect(q('//Customer/text()').map((n) => textOf(n))).toEqual(['Ada & Co <Ltd>']);
    expect(names(q('//Price/..'))).toEqual(['ord:Item', 'ord:Item', 'ord:Item']);
    expect(names(q('//Name/../..'))).toEqual(['ord:Items']);
    expect(names(q('//Items/.'))).toEqual(['ord:Items']);
    expect(names(q('/..'))).toEqual([]);
    expect(runXPath(parseXml('<a><!-- c --><b/></a>'), '//comment()')).toHaveLength(1);
    expect(runXPath(parseXml('<a>x<b/>y</a>'), '/a/node()')).toHaveLength(3);
  });

  it('filters by position', () => {
    expect(q('//Item[1]/Name').map((n) => textOf(n))).toEqual(['Bolt']);
    expect(q('//Item[last()]/Name').map((n) => textOf(n))).toEqual(['Washer']);
    expect(q('//Item[position() > 1]/Name').map((n) => textOf(n))).toEqual(['Nut', 'Washer']);
    expect(q('//Item[position() = last()]/@sku').map((n) => textOf(n))).toEqual(['C-3']);
    expect(q('//Item[4]')).toEqual([]);
    // Per parent, as in XPath: the first Name of each Item.
    expect(q('//Name[1]')).toHaveLength(3);
    expect(q("//*[local-name()='Item'][2]/@sku").map((n) => textOf(n))).toEqual(['B-2']);
  });

  it('filters by attributes, children, text and functions', () => {
    const skus = (expr: string) => q(expr).map((n) => (n as XEl).attrs.find((a) => a.name === 'sku')?.value);
    expect(skus("//Item[@sku='B-2']")).toEqual(['B-2']);
    expect(skus('//Item[@sku="B-2" or @sku = \'C-3\']')).toEqual(['B-2', 'C-3']);
    expect(skus('//Item[Note]')).toEqual(['C-3']);
    expect(skus('//Item[not(Note)]')).toEqual(['A-1', 'B-2']);
    expect(skus('//Item[Price > 1]')).toEqual(['A-1', 'B-2']);
    expect(skus('//Item[Price >= 2.5 and Price < 12]')).toEqual(['A-1']);
    expect(skus('//Item[Price = 12]')).toEqual(['B-2']);
    expect(skus("//Item[Name = 'Nut']")).toEqual(['B-2']);
    expect(skus("//Item[Name != 'Nut']")).toEqual(['A-1', 'C-3']);
    expect(skus("//Item[contains(Name, 'o')]")).toEqual(['A-1']);
    expect(skus("//Item[starts-with(@sku, 'C')]")).toEqual(['C-3']);
    expect(skus("//Item[ends-with(Name, 'er')]")).toEqual(['C-3']);
    expect(skus("//Item[contains(lower-case(Name), 'bolt')]")).toEqual(['A-1']);
    expect(skus("//Item[string-length(Name) = 3]")).toEqual(['B-2']);
    expect(skus("//Item[(Price > 10 or Note) and not(@sku = 'B-2')]")).toEqual(['C-3']);
    expect(skus("//Item[Note/@xsi:nil = 'true']")).toEqual(['C-3']);
    expect(skus('//Item[count(*) = 3]')).toEqual(['C-3']);
    expect(names(q("//*[. = 'Nut']"))).toEqual(['ord:Name']);
    expect(names(q("//*[text() = 'alice']"))).toEqual(['wsse:Username']);
    expect(names(q("//*[name() = 'ord:Notes']"))).toEqual(['ord:Notes']);
    expect(names(q("//*[namespace-uri() = 'http://example.com/orders'][1]"))).toContain('ord:GetOrderResponse');
    expect(names(q("//Order[@status='OPEN'][@id=4711]/Items/Item[2]/Name"))).toEqual(['ord:Name']);
    expect(names(q("//*[normalize-space(.) = 'Bolt2.50']"))).toEqual(['ord:Item']);
    // Padded text still equals what it says.
    expect(runXPath(parseXml('<a><b> x </b></a>'), "//b[. = 'x']")).toHaveLength(1);
  });

  it('works on a document that was cut off', () => {
    const cut = parseXml(SOAP11.slice(0, SOAP11.indexOf('<ord:Item sku="C-3"')));
    expect(runXPath(cut, '//Item/Name').map((n) => textOf(n))).toEqual(['Bolt', 'Nut']);
  });

  it('explains what it cannot read', () => {
    const bad: [string, RegExp, number][] = [
      ['//Item[', /Expected a name/, 7],
      ['//Item[]', /empty/, 7],
      ['//Item[@sku="x]', /quote is not closed/, 12],
      ['//Item[1', /Expected "\]"/, 8],
      ['ancestor::a', /Axes such as ancestor:: are not supported/, 0],
      ['//a | //b', /Unions/, 4],
      ['//a[foo(1)]', /function foo\(\) is not supported/, 4],
      ['//a/#', /Unexpected "#"/, 4],
      ['//a]', /Unexpected "\]"/, 3],
      ["'text'", /gives a value, not nodes/, 0],
      ['count(//a)', /gives a value, not nodes/, 0],
      ['//Item[contains(.)]', /contains\(\) needs 2 arguments/, 7],
      ['/a/', /Expected a name/, 3],
    ];
    for (const [expr, message, pos] of bad) {
      let err: unknown;
      try {
        q(expr);
      } catch (e) {
        err = e;
      }
      expect(err, expr).toBeInstanceOf(QueryError);
      expect((err as QueryError).message, expr).toMatch(message);
      expect((err as QueryError).pos, expr).toBe(pos);
    }
  });

  it('nestedFallback looks for a path at any depth when it finds nothing from the top', () => {
    expect(q('Item/Price')).toEqual([]);
    expect(nestedFallback(p, 'Item/Price')).toMatchObject({ expr: '//Item/Price', hits: { length: 3 } });
    expect(nestedFallback(p, '/Item[2]')?.expr).toBe('//Item[2]');
    expect(nestedFallback(p, 'Nope')).toBeNull();
    expect(nestedFallback(p, '//Nope')).toBeNull();
    expect(nestedFallback(p, 'Item[')).toBeNull();
  });
});

describe('completions', () => {
  const p = parseXml(SOAP11);
  const labels = (expr: string) => completions(p, expr).map((s) => s.label);

  it('splits at the step being typed', () => {
    expect(splitXPath('')).toEqual({ context: '', sep: '', partial: '' });
    expect(splitXPath('/')).toEqual({ context: '', sep: '/', partial: '' });
    expect(splitXPath('//It')).toEqual({ context: '', sep: '//', partial: 'It' });
    expect(splitXPath('/a/b[@x="/"]/c')).toEqual({ context: '/a/b[@x="/"]', sep: '/', partial: 'c' });
    expect(splitXPath('/a//b')).toEqual({ context: '/a', sep: '//', partial: 'b' });
    expect(splitXPath('/a/b[c')).toBeNull();
    expect(splitXPath('/a/b[1]')).toBeNull();
  });

  it('offers the elements and attributes at that point', () => {
    expect(completions(p, '')).toEqual([{ text: 'soapenv:Envelope', label: 'soapenv:Envelope', detail: '1 element', kind: 'key' }]);
    expect(labels('/')).toEqual(['soapenv:Envelope']);
    expect(labels('/soapenv:Envelope/')).toEqual(['soapenv:Header', 'soapenv:Body']);
    // A finished path offers what can follow it.
    expect(completions(p, '/soapenv:Envelope/soapenv:Body').map((s) => s.text)).toEqual(['/soapenv:Envelope/soapenv:Body/ord:GetOrderResponse']);
    expect(completions(p, '//Order/')).toEqual([
      { text: '//Order/ord:Customer', label: 'ord:Customer', detail: '1 element · text', kind: 'key' },
      { text: '//Order/ord:Items', label: 'ord:Items', detail: '1 element', kind: 'key' },
      { text: '//Order/ord:Notes', label: 'ord:Notes', detail: '1 element · text', kind: 'key' },
      { text: '//Order/@id', label: '@id', detail: 'attribute', kind: 'key' },
      { text: '//Order/@status', label: '@status', detail: 'attribute', kind: 'key' },
    ]);
    expect(labels('//Order/@s')).toEqual(['@status']);
    expect(labels('//Items/Item/N')).toEqual(['ord:Name', 'ord:Note']);
    expect(completions(p, '//Items/Item/pri')).toEqual([{ text: '//Items/Item/ord:Price', label: 'ord:Price', detail: '3 elements · text', kind: 'key' }]);
  });

  it('offers names from anywhere in the document for // and for a bare name at the top', () => {
    // Names that start with what is typed come first, then names that contain it.
    expect(labels('//It')).toEqual(['ord:Items', 'ord:Item', 'wsse:Security']);
    expect(completions(p, 'Pri')).toEqual([{ text: '//ord:Price', label: '//ord:Price', detail: '3 elements · text', kind: 'any-depth' }]);
    expect(completions(p, '//@s').map((s) => s.text)).toEqual(['//@status', '//@sku', '//@soapenv:mustUnderstand', '//@xsi:nil']);
    expect(completions(p, '//Order//Na').map((s) => s.text)).toEqual(['//Order//ord:Name']);
    expect(labels('//Item[')).toEqual([]);
    expect(labels('//zzz')).toEqual([]);
    expect(completions(parseXml('<a'), '/')).toEqual([{ text: '/a', label: 'a', detail: '1 element · text', kind: 'key' }]);
  });
});

describe('search', () => {
  const p = parseXml(SOAP11);
  const find = (q: string) => search([p.root!], q);

  it('finds names, attributes and text, case-insensitively', () => {
    expect(names(find('username').matches.map((m) => m.node))).toEqual(['wsse:UsernameToken', 'wsse:Username']);
    expect(names(find('b-2').matches.map((m) => m.node))).toEqual(['ord:Item']);
    expect(names(find('mustunderstand').matches.map((m) => m.node))).toEqual(['wsse:Security']);
    expect(names(find('RING').matches.map((m) => m.node))).toEqual(['ord:Notes']);
    expect(names(find('ada & co').matches.map((m) => m.node))).toEqual(['ord:Customer']);
    // Namespace URIs are attribute values too.
    expect(names(find('example.com/orders').matches.map((m) => m.node))).toEqual(['ord:GetOrderResponse']);
    expect(find('zzz')).toEqual({ matches: [], total: 0 });
    expect(find('')).toEqual({ matches: [], total: 0 });
  });

  it('gives the elements above each match, and counts past the limit', () => {
    const m = find('bolt').matches[0];
    expect(names(m.ancestors)).toEqual(['soapenv:Envelope', 'soapenv:Body', 'ord:GetOrderResponse', 'ord:Order', 'ord:Items', 'ord:Item']);
    const r = search([p.root!], 'ord:', 3);
    expect(r.matches).toHaveLength(3);
    expect(r.total).toBe(15);
  });

  it('matches text beside elements and comments on their own rows', () => {
    const d = parseXml('<p>Hello <b>big</b> world<!-- hidden note --></p>');
    expect(search([d.root!], 'world').matches.map((m) => m.node.t)).toEqual(['text']);
    expect(search([d.root!], 'hidden').matches.map((m) => m.node.t)).toEqual(['comment']);
    expect(search(runXPath(p, '//Item/@sku'), 'a-1').matches).toMatchObject([{ top: 0, ancestors: [] }]);
  });
});

describe('describing and tables', () => {
  const p = parseXml(SOAP11);
  const one = (expr: string) => runXPath(p, expr)[0];

  it('describes nodes', () => {
    expect(describeNode(one('//Order'))).toBe('Element · 2 attributes · 3 child elements');
    expect(describeNode(one('//Customer'))).toBe('Element · text');
    expect(describeNode(one('//Notes'))).toBe('Element · CDATA text');
    expect(describeNode(one('//Note'))).toBe('Element · 1 attribute · empty');
    expect(describeNode(one('//@sku'))).toBe('Attribute');
    expect(describeNode(one('//Customer/text()'))).toBe('Text · 14 characters');
    expect(describeNode(p.root!.attrs[0])).toBe('Namespace declaration');
  });

  it('previews what a closed element holds', () => {
    expect(preview(one('//Order') as XEl)).toBe('Customer, Items, Notes');
    expect(preview(one('//Items') as XEl)).toBe('Item ×3');
    expect(preview(p.root!, 10)).toBe('Header, …');
  });

  it('builds a table from repeated children', () => {
    const items = one('//Items') as XEl;
    expect(canTable(items)).toBe(true);
    expect(canTable(one('//Order'))).toBe(false);
    expect(findTable(p.root!)).toBe(items);
    const t = tableOf(items)!;
    expect(t.columns).toEqual(['@sku', 'Name', 'Price', 'Note']);
    expect(t.rows).toHaveLength(3);
    expect(t.rows.map((r) => t.columns.map((c) => cellText(cellOf(r, c))))).toEqual([
      ['A-1', 'Bolt', '2.50', ''],
      ['B-2', 'Nut', '12', ''],
      ['C-3', 'Washer', '0.1', ''],
    ]);
    expect(cellOf(t.rows[0], 'Note')).toBeUndefined();
    expect(cellOf(t.rows[2], 'Note')).toMatchObject({ name: 'ord:Note' });
    expect(tableOf(one('//Order') as XEl)).toBeNull();
  });

  it('gives plain repeated values a text column and nested ones a preview', () => {
    const d = parseXml('<r><tags><tag>a</tag><tag>b</tag></tags><rows><row><who><first>A</first><last>B</last></who></row><row/></rows></r>');
    const tags = tableOf(runXPath(d, '//tags')[0] as XEl)!;
    expect(tags.columns).toEqual(['(text)']);
    expect(tags.rows.map((r) => cellText(cellOf(r, '(text)')))).toEqual(['a', 'b']);
    const rows = tableOf(runXPath(d, '//rows')[0] as XEl)!;
    expect(cellText(cellOf(rows.rows[0], 'who'))).toBe('<first, last>');
    expect(tableOf(runXPath(d, '//tags')[0] as XEl, 0)).toMatchObject({ columns: [], hiddenColumns: 1 });
  });
});
