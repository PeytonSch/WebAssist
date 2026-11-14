import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);

await rm('dist', { recursive: true, force: true });
await mkdir('dist/ui', { recursive: true });

await build({
  entryPoints: ['src/server/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});

await build({
  entryPoints: ['src/ui/main.ts'],
  outfile: 'dist/ui/app.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});

await cp('src/ui/index.html', 'dist/ui/index.html');
await cp('src/ui/styles.css', 'dist/ui/styles.css');
