// Builds everything into dist/:
//   cli.js, ui/        the command-line hub (npm start)
//   payload/           what the desktop app downloads on update: app.cjs + preload.cjs + ui/ + payload.json
//                      (+ update.html, update-preload.cjs: the update window, see src/shell/updatewindow.ts)
//   shell/             the installed desktop shell: main.cjs, preload.cjs, splash.html, update.html + update-preload.cjs
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
await build({ ...node, entryPoints: ['src/desktop/preload.ts'], outfile: 'dist/payload/preload.cjs', format: 'cjs', external: ['electron'] });
await cp('dist/ui', 'dist/payload/ui', { recursive: true });
await writeFile('dist/payload/payload.json', JSON.stringify({ version: pkg.version, minShell: pkg.debugHub.minShell }) + '\n');

await build({ ...node, entryPoints: ['src/shell/main.ts'], outfile: 'dist/shell/main.cjs', format: 'cjs', external: ['electron'] });
await build({ ...node, entryPoints: ['src/shell/preload.ts'], outfile: 'dist/shell/preload.cjs', format: 'cjs', external: ['electron'] });
await cp('src/shell/splash.html', 'dist/shell/splash.html');

// The update window (src/shell/updatewindow.ts) is opened by the shell at start and by the
// running app, so both get a copy: its page with the script inlined, and its preload.
const view = await build({ ...common, entryPoints: ['src/shell/updateview.ts'], format: 'iife', target: 'es2022', minify: true, write: false });
const viewJs = view.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const updateHtml = (await readFile('src/shell/update.html', 'utf8')).replace('/*__UPDATE_VIEW__*/', () => viewJs);
for (const dir of ['dist/shell', 'dist/payload']) {
  await writeFile(join(dir, 'update.html'), updateHtml);
  await build({ ...node, entryPoints: ['src/shell/updatepreload.ts'], outfile: join(dir, 'update-preload.cjs'), format: 'cjs', external: ['electron'] });
}

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
