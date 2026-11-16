import type { CollectorStatus, HubEvent } from '../../shared/types';
import type { Config } from '../config';
import { compilePatterns, makeEvent, type EventInput } from '../normalize';
import { parseAccessLine } from '../parsers/access';
import { isPostgresEntryStart, parsePostgresEntry } from '../parsers/postgres';
import { isTomcatEntryStart, parseTomcatEntry, type ParseContext } from '../parsers/tomcat';
import { Tailer } from './tail';

const MAX_ENTRY_LINES = 2000;

interface Pending {
  lines: string[];
  timer: NodeJS.Timeout | null;
  firstSeenMs: number;
}

/**
 * Groups raw lines into entries. A line that does not start a new entry (a stack frame,
 * "Caused by:", a tab-indented SQL continuation) is appended to the entry before it.
 */
export class EntryGrouper {
  private pending = new Map<string, Pending>();

  constructor(
    /** `pending` is the entry collected so far, for formats where that decides it. */
    private isStart: (line: string, pending?: readonly string[]) => boolean,
    private flushMs: number,
    private onEntry: (file: string, lines: string[], firstSeenMs: number) => void,
  ) {}

  push(file: string, line: string): void {
    let p = this.pending.get(file);
    if (p && (this.isStart(line, p.lines) || p.lines.length >= MAX_ENTRY_LINES)) {
      this.flush(file);
      p = undefined;
    }
    if (!p) {
      if (line.trim() === '') return;
      p = { lines: [], timer: null, firstSeenMs: Date.now() };
      this.pending.set(file, p);
    }
    p.lines.push(line);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.flush(file), this.flushMs);
  }

  flush(file: string): void {
    const p = this.pending.get(file);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(file);
    while (p.lines.length > 1 && p.lines[p.lines.length - 1].trim() === '') p.lines.pop();
    this.onEntry(file, p.lines, p.firstSeenMs);
  }

  flushAll(): void {
    for (const file of [...this.pending.keys()]) this.flush(file);
  }
}

type Format = 'tomcat' | 'access' | 'postgres';

/** Tails one family of log files and emits normalized events. */
export class LogFileCollector {
  private tailer: Tailer;
  private grouper: EntryGrouper | null = null;
  private ridPatterns: RegExp[];
  status: CollectorStatus;

  constructor(
    private name: string,
    private format: Format,
    patterns: string[],
    private cfg: Config,
    private emit: (ev: HubEvent) => void,
    private onStatus: () => void,
  ) {
    this.ridPatterns = compilePatterns(cfg.correlation.logPatterns);
    this.status = { name, state: 'waiting', detail: 'No matching log files yet' };

    if (format !== 'access') {
      const isStart = format === 'tomcat' ? isTomcatEntryStart : isPostgresEntryStart;
      const parse = format === 'tomcat' ? parseTomcatEntry : parsePostgresEntry;
      this.grouper = new EntryGrouper(isStart, cfg.tail.flushMs, (file, lines, firstSeenMs) =>
        this.out(parse(lines, this.ctx(file, firstSeenMs))),
      );
    }

    this.tailer = new Tailer(patterns, {
      fromStart: cfg.tail.fromStart,
      pollMs: cfg.tail.pollMs,
      onLine: (file, line) => this.onLine(file, line),
      onFilesChanged: (files) => {
        this.status = files.length
          ? { name, state: 'connected', detail: `Tailing ${files.length} file${files.length === 1 ? '' : 's'}\n${files.join('\n')}` }
          : { name, state: 'waiting', detail: `No files match:\n${patterns.join('\n')}` };
        this.onStatus();
      },
    });
  }

  private ctx(file: string, nowMs = Date.now()): ParseContext {
    return { file, ridPatterns: this.ridPatterns, nowMs };
  }

  private out(input: EventInput | null): void {
    if (input) this.emit(makeEvent(input));
  }

  private onLine(file: string, line: string): void {
    if (this.grouper) {
      this.grouper.push(file, line);
      return;
    }
    if (line.trim() === '') return;
    this.out(parseAccessLine(line, { ...this.ctx(file), durationUnit: this.cfg.tomcat.accessDurationUnit }));
  }

  start(): void {
    this.tailer.start();
  }

  async stop(): Promise<void> {
    await this.tailer.stop();
    this.grouper?.flushAll();
  }
}
