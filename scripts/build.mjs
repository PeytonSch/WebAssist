// Builds everything into dist/:
//   cli.js, ui/        the command-line hub (npm start)
//   payload/           what the desktop app downloads on update: app.cjs + ui/ + payload.json
//   shell/             the installed desktop shell: main.cjs, preload.cjs, splash.html
// With --release it also writes release/latest.json and the packed payload for a GitHub Release.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const common = { bundle: true, logLevel: 'warning' };
const node = { ...common, platform: 'node', target: 'node18' };

await rm('dist', { recursive: true, force: true });
await mkdir('dist/ui', { recursive: true });

await build({ ...node, entryPoints: ['src/server/cli.ts'], outfile: 'dist/cli.js', format: 'esm', packages: 'external', banner: { js: '#!/usr/bin/env node' } });
await build({ ...common, entryPoints: ['src/ui/main.ts'], outfile: 'dist/ui/app.js', format: 'esm', target: 'es2022', minify: true });
await cp('src/ui/index.html', 'dist/ui/index.html');
await cp('src/ui/styles.css', 'dist/ui/styles.css');

// The payload must be self-contained (no node_modules where it is unpacked), so ws is bundled in.
// bufferutil and utf-8-validate are optional native speed-ups that ws works without.
await build({ ...node, entryPoints: ['src/desktop/app.ts'], outfile: 'dist/payload/app.cjs', format: 'cjs', external: ['electron', 'bufferutil', 'utf-8-validate'] });
await cp('dist/ui', 'dist/payload/ui', { recursive: true });
await writeFile('dist/payload/payload.json', JSON.stringify({ version: pkg.version, minShell: pkg.debugHub.minShell }) + '\n');

await build({ ...node, entryPoints: ['src/shell/main.ts'], outfile: 'dist/shell/main.cjs', format: 'cjs', external: ['electron'] });
await build({ ...node, entryPoints: ['src/shell/preload.ts'], outfile: 'dist/shell/preload.cjs', format: 'cjs', external: ['electron'] });
await cp('src/shell/splash.html', 'dist/shell/splash.html');

if (process.argv.includes('--release')) {
  // Same format as packPayload() in src/shell/updater.ts: gzip(JSON { files: { path: base64 } }).
  const files = {};
  const walk = async (rel) => {
    for (const entry of await readdir(join('dist/payload', rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else files[child] = (await readFile(join('dist/payload', child))).toString('base64');
    }
  };
  await walk('');
  const data = gzipSync(JSON.stringify({ files }), { level: 9 });
  const file = `debug-hub-payload-${pkg.version}.json.gz`;
  const repo = String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  await rm('release', { recursive: true, force: true });
  await mkdir('release');
  await writeFile(join('release', file), data);
  await writeFile('release/latest.json', JSON.stringify({
    version: pkg.version,
    minShell: pkg.debugHub.minShell,
    file,
    // Pinned to this tag, so a release published mid-download cannot cause a checksum mismatch.
    url: `${repo}/releases/download/v${pkg.version}/${file}`,
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
  }, null, 2) + '\n');
  console.log(`release/${file}  ${(data.length / 1024).toFixed(0)} kB`);
}
