// Builds dist/debug-hub.war: Debug Hub as a webapp for Tomcat (see "Running inside Tomcat" in
// the README). Run through `npm run build:war`, which runs scripts/build.mjs first: the WAR
// carries the same UI as every other build, from dist/ui.
//
//   WEB-INF/web.xml, WEB-INF/hub.jsp   the Java side: starts the hub and forwards requests to it (src/webapp)
//   WEB-INF/hub/hub.cjs                the hub, self-contained (src/server/hosted/main.ts, ws bundled in)
//   WEB-INF/hub/ui/                    the UI, served by the hub
//
// Nothing is compiled for Java: Tomcat compiles the JSP itself, against javax or jakarta
// servlets, whichever it has. The archive is written here, so only Node is needed to build.
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const stage = 'dist/war';
const out = 'dist/debug-hub.war';

if (!(await stat('dist/ui/app.js').catch(() => null))) {
  console.error('dist/ui is missing. Run "npm run build:war", which builds it first.');
  process.exit(1);
}

await rm(stage, { recursive: true, force: true });
await rm(out, { force: true });
await mkdir(join(stage, 'WEB-INF/hub'), { recursive: true });
await mkdir(join(stage, 'META-INF'), { recursive: true });

await cp('src/webapp/WEB-INF/web.xml', join(stage, 'WEB-INF/web.xml'));
await cp('src/webapp/WEB-INF/hub.jsp', join(stage, 'WEB-INF/hub.jsp'));
// Like the desktop payload: no node_modules where Tomcat unpacks it, so ws is bundled in.
// bufferutil and utf-8-validate are optional native speed-ups that ws works without.
await build({
  bundle: true,
  logLevel: 'warning',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  entryPoints: ['src/server/hosted/main.ts'],
  outfile: join(stage, 'WEB-INF/hub/hub.cjs'),
  external: ['bufferutil', 'utf-8-validate'],
  define: { 'process.env.DEBUG_HUB_VERSION': JSON.stringify(pkg.version) },
});
await cp('dist/ui', join(stage, 'WEB-INF/hub/ui'), { recursive: true });
await writeFile(
  join(stage, 'META-INF/MANIFEST.MF'),
  `Manifest-Version: 1.0\r\nImplementation-Title: Debug Hub\r\nImplementation-Version: ${pkg.version}\r\nCreated-By: debug-hub scripts/build-war.mjs\r\n\r\n`,
);

// ── The archive ─────────────────────────────────────────
// A plain zip: deflated entries, folder entries before their files (as jar does), no ZIP64.
// The reading and rewriting counterpart, for WARs being deployed, is src/server/tomcat/zip.ts.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function walk(dir, rel = '') {
  const names = (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  const entries = [];
  for (const e of names) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) entries.push({ name: `${child}/`, data: null }, ...(await walk(dir, child)));
    else entries.push({ name: child, data: await readFile(join(dir, child)) });
  }
  return entries;
}

// The manifest comes first, as in a jar.
const entries = (await walk(stage)).sort((a, b) => Number(b.name.startsWith('META-INF/')) - Number(a.name.startsWith('META-INF/')));
const now = new Date();
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);

const parts = [];
const central = [];
let offset = 0;
for (const e of entries) {
  const name = Buffer.from(e.name, 'utf8');
  const data = e.data ?? Buffer.alloc(0);
  const deflated = data.length ? deflateRawSync(data, { level: 9 }) : data;
  const store = deflated.length >= data.length;
  const body = store ? data : deflated;
  const crc = crc32(data);
  const head = (sig, extraFields) => {
    const b = Buffer.alloc(sig === 0x04034b50 ? 30 : 46);
    let p = b.writeUInt32LE(sig, 0);
    if (extraFields) p = b.writeUInt16LE(20, p); // version made by
    p = b.writeUInt16LE(20, p); // version needed
    p = b.writeUInt16LE(0x0800, p); // names are UTF-8
    p = b.writeUInt16LE(store ? 0 : 8, p);
    p = b.writeUInt16LE(dosTime, p);
    p = b.writeUInt16LE(dosDate, p);
    p = b.writeUInt32LE(crc, p);
    p = b.writeUInt32LE(body.length, p);
    p = b.writeUInt32LE(data.length, p);
    p = b.writeUInt16LE(name.length, p);
    p = b.writeUInt16LE(0, p); // extra field length
    if (extraFields) {
      p = b.writeUInt16LE(0, p); // comment length
      p = b.writeUInt16LE(0, p); // disk number
      p = b.writeUInt16LE(0, p); // internal attributes
      p = b.writeUInt32LE(e.data ? 0 : 0x10, p); // external attributes: folder
      b.writeUInt32LE(offset, p);
    }
    return b;
  };
  central.push(head(0x02014b50, true), name);
  const local = head(0x04034b50, false);
  parts.push(local, name, body);
  offset += local.length + name.length + body.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const war = Buffer.concat([...parts, ...central, end]);
await writeFile(out, war);
await rm(stage, { recursive: true, force: true });
console.log(`${out}  ${(war.length / 1024).toFixed(0)} kB  (${entries.filter((e) => e.data).length} files)`);
