import { promises as fs } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';

/**
 * Reading a project's source tree: where its source sets are, and which classes each source file
 * defines. Kept free of the index's bookkeeping so each part can be tested on its own.
 */

/** Folders never searched for modules or sources: build output, dependencies, IDE and VCS state. */
export const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'out', 'bin', 'dist', '.git', '.idea', '.gradle', '.mvn', '.svn', '.vscode']);
export const LANGS = ['java', 'kotlin', 'groovy', 'scala'];
export const SOURCE_EXT = /\.(java|kt|groovy|scala)$/i;
/** Module folders below a project root; multi-module builds rarely nest deeper than three. */
export const MAX_MODULE_DEPTH = 6;
/** Folders looked at while finding source sets, so a root pointed at a huge folder stays quick. */
export const MAX_MODULE_DIRS = 5_000;
/** Bytes read from a Kotlin, Groovy or Scala file to find its package and classes. */
const MAX_PARSE_BYTES = 512 * 1024;

export interface SourceDir {
  /** The language folder: <module>/src/main/java. */
  dir: string;
  /** The module's folder relative to the project root, with / separators; "" for the root itself. */
  module: string;
}

/** Lets a long walk give other work (HTTP requests, log tailing) a turn between folders. */
export const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/**
 * Every src/<set>/<language> folder under `root`, at any module depth: src/main/java,
 * web/src/test/kotlin, … `src` folders themselves are not searched further for modules.
 */
export async function findSourceDirs(root: string): Promise<SourceDir[]> {
  const out: SourceDir[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < MAX_MODULE_DIRS) {
    const { dir, depth } = queue.shift()!;
    seen++;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'src') {
        const module = relative(root, dir).split(sep).join('/');
        for (const set of await fs.readdir(join(dir, 'src'), { withFileTypes: true }).catch(() => [])) {
          if (!set.isDirectory() || set.name.startsWith('.')) continue;
          for (const lang of LANGS) {
            const st = await fs.stat(join(dir, 'src', set.name, lang)).catch(() => null);
            if (st?.isDirectory()) out.push({ dir: join(dir, 'src', set.name, lang), module });
          }
        }
        continue;
      }
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || depth >= MAX_MODULE_DEPTH) continue;
      queue.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
    await yieldNow();
  }
  // A folder that is itself a language folder (C:/dev/lib/src/main/java given as a source folder).
  if (!out.length && LANGS.includes(basename(root))) out.push({ dir: root, module: '' });
  return out;
}

/** com.example.orders.OrderService for <dir>/com/example/orders/OrderService.java. */
export function javaClassName(sourceDir: string, file: string): string {
  return relative(sourceDir, file).split(sep).join('.').replace(/\.java$/i, '');
}

// Declarations that start a line: Kotlin, Groovy and Scala put top-level types at column 0, and a
// nested type (indented) is found through its outer class anyway.
const MODIFIERS = '(?:(?:public|private|internal|protected|abstract|final|open|sealed|data|enum|annotation|inline|value|inner|case|static|strictfp|expect|actual|fun|implicit|lazy)\\s+)*';
const DECL = new RegExp(`^${MODIFIERS}(?:class|interface|object|trait|enum|record|@interface)\\s+\`?([A-Za-z_$][\\w$]*)`, 'gm');
const PACKAGE = /^[ \t]*package[ \t]+([\w.`]+)/m;
const JVM_NAME = /^@file:JvmName\(\s*"([\w$]+)"\s*\)/m;

/**
 * The package and the top-level class names a Kotlin, Groovy or Scala file defines. Unlike Java,
 * the file may hold several classes and its name need not match any of them; Kotlin compiles
 * top-level functions into a FooKt class (or the @file:JvmName). A Groovy script without a class
 * is a class named after the file.
 */
export function parseDeclarations(text: string, file: string): { pkg: string; classes: string[] } {
  const ext = extname(file).toLowerCase();
  const base = basename(file, extname(file));
  const pkg = (PACKAGE.exec(text)?.[1] ?? '').replace(/`/g, '').replace(/;$/, '');
  const classes = new Set<string>();
  for (const m of text.matchAll(DECL)) classes.add(m[1]);
  if (ext === '.kt') classes.add(JVM_NAME.exec(text)?.[1] ?? `${base}Kt`);
  if (ext === '.groovy' && !classes.size) classes.add(base);
  return { pkg, classes: [...classes] };
}

/** The `package` line of a Java file, read from its first few kilobytes. */
export async function readJavaPackage(file: string): Promise<string | null> {
  const head = await readHead(file, 16 * 1024);
  if (head === null) return null;
  // Comments before the package line (license headers) must not be mistaken for it.
  const code = head.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return /^\s*package\s+([\w.]+)\s*;/m.exec(code)?.[1] ?? '';
}

export async function readHead(file: string, bytes = MAX_PARSE_BYTES): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** The fully qualified classes a source file defines. Java: from the path alone, no reading. */
export async function classesOf(sourceDir: string, file: string): Promise<string[]> {
  if (/\.java$/i.test(file)) return [javaClassName(sourceDir, file)];
  const text = await readHead(file);
  if (text === null) return [];
  const { pkg, classes } = parseDeclarations(text, file);
  return classes.map((c) => (pkg ? `${pkg}.${c}` : c));
}

/** The 1-based line where `simpleName` is declared, for opening a file at its class. */
export function declarationLine(text: string, simpleName: string): number | null {
  const re = new RegExp(`^.*\\b(?:class|interface|object|trait|enum|record|@interface)\\s+\`?${simpleName.replace(/\$/g, '\\$')}\\b`, 'm');
  const m = re.exec(text);
  return m ? text.slice(0, m.index).split('\n').length : null;
}
