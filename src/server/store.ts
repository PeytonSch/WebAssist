import { closeSync, createWriteStream, mkdirSync, openSync, readdirSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { HubEvent, SessionInfo } from '../shared/types';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const pad = (n: number) => String(n).padStart(2, '0');

function newSessionId(now = new Date()): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

/** One JSONL file per session; the file on disk is the only copy the server keeps. */
export class SessionStore {
  id = '';
  count = 0;
  private stream: WriteStream | null = null;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Starts a new session file and makes it the live one. */
  start(): string {
    this.stream?.end();
    const base = newSessionId();
    let id = base;
    // Create the file exclusively, so two sessions started in the same second never share one.
    for (let n = 2; ; n++) {
      try {
        closeSync(openSync(this.pathFor(id)!, 'wx'));
        break;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        id = `${base}_${n}`;
      }
    }
    this.id = id;
    this.count = 0;
    this.stream = createWriteStream(this.pathFor(id)!, { flags: 'a' });
    return id;
  }

  append(ev: HubEvent): void {
    this.stream?.write(JSON.stringify(ev) + '\n');
    this.count++;
  }

  /** Returns the file path for a session ID, or null if the ID is not a safe file name. */
  pathFor(id: string): string | null {
    if (!SESSION_ID.test(id)) return null;
    return join(this.dir, `${id}.jsonl`);
  }

  list(): SessionInfo[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const st = statSync(join(this.dir, f));
        const id = f.slice(0, -'.jsonl'.length);
        return { id, bytes: st.size, modified: st.mtime.toISOString(), live: id === this.id };
      })
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(resolve);
      this.stream = null;
    });
  }
}
