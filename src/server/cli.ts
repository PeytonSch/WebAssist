import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { runDoctor } from './doctor';
import { Hub } from './hub';
import { BIND_HOST, startServer } from './http';

const HELP = `debug-hub — browser, Tomcat and Postgres activity in one timeline

Usage:
  debug-hub [start] [options]     Record a session and serve the UI
  debug-hub doctor [options]      Inspect this machine and print docs/environment.md

Options:
  --config <file>     Config file (default: ./debug-hub.config.json)
  --port <n>          UI port (default 4000)
  --cdp-port <n>      Chrome remote debugging port (default 9222)

Doctor options:
  --project <dir>     App repository to scan for the logging framework and Vite proxy
  --out <file>        Write the report to a file instead of stdout
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = 'true';
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = argv[++i] ?? '';
    } else positional.push(a);
  }
  return { flags, positional };
}

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? 'start';
  if (flags.help || !['start', 'doctor'].includes(command)) {
    process.stdout.write(HELP);
    process.exit(flags.help ? 0 : 1);
  }

  const { config, file } = loadConfig(flags.config);
  if (flags.port) config.port = Number(flags.port);
  if (flags['cdp-port']) config.chrome.port = Number(flags['cdp-port']);

  if (command === 'doctor') {
    const report = await runDoctor(config, flags.project ? resolve(flags.project) : null);
    if (flags.out) {
      const out = resolve(flags.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, report);
      console.log(`Wrote ${out}`);
    } else {
      process.stdout.write(report);
    }
    return;
  }

  const hub = new Hub(config);
  hub.start();
  const uiDir = fileURLToPath(new URL('./ui/', import.meta.url));
  try {
    await startServer(hub, uiDir);
  } catch (err: any) {
    console.error(
      err?.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use. Pass --port or set "port" in the config.`
        : `Could not start the server: ${err?.message ?? err}`,
    );
    process.exit(1);
  }

  console.log(`\n  Debug Hub   http://localhost:${config.port}   (bound to ${BIND_HOST} only)`);
  console.log(`  Config      ${file ?? 'defaults (no debug-hub.config.json found)'}`);
  console.log(`  Session     ${hub.store.pathFor(hub.store.id)}`);
  for (const c of hub.status().collectors) {
    console.log(`  ${c.name.padEnd(11)} ${c.state === 'off' ? 'off' : c.detail.split('\n')[0]}`);
  }
  console.log('');

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await hub.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
