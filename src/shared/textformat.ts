// How a text file is stored: its encoding, byte order mark, line endings and whether it ends in
// a line break. The merge view works on plain "\n" text; these put a merged result back in the
// form the deployed file had, so a merge changes the lines that were merged and nothing else.
// Pure: no DOM, no Node.

export type Eol = '\n' | '\r\n' | '\r';

export interface TextFormat {
  /** latin1 (ISO-8859-1) is what old .properties and some XML files use. */
  encoding: 'utf-8' | 'latin1';
  /** A UTF-8 byte order mark at the start. */
  bom: boolean;
  /** The line ending most lines use. */
  eol: Eol;
  /** Some lines end differently; a merged result uses `eol` for all of them. */
  mixedEol: boolean;
  /** The file ends with a line break. */
  finalNewline: boolean;
}

export interface DecodedText {
  /** Without the byte order mark, line endings as "\n". */
  text: string;
  format: TextFormat;
}

/** Why a file cannot be shown as text. */
export interface NotText {
  problem: string;
}

export const EOL_NAME: Record<Eol, string> = { '\n': 'LF', '\r\n': 'CRLF', '\r': 'CR' };

/** The line ending most lines use (LF when there are none), and whether others occur too. */
export function detectEol(text: string): { eol: Eol; mixed: boolean } {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const eol: Eol = crlf > lf && crlf >= cr ? '\r\n' : cr > lf && cr > crlf ? '\r' : '\n';
  return { eol, mixed: [crlf, lf, cr].filter((n) => n > 0).length > 1 };
}

/** Any line ending to "\n". */
export function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/**
 * The lines of a text, without their endings. A text that ends in a line break has an empty last
 * line, as in an editor, so joining with "\n" gives the text back and the final line break can be
 * added or removed like any other line.
 */
export function splitLines(text: string): string[] {
  return normalizeEol(text).split('\n');
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

/** Reads a file's bytes as text, or says why it is not text Debug Hub can merge. */
export function decodeText(bytes: Uint8Array): DecodedText | NotText {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return { problem: 'It is UTF-16 text, which cannot be merged here.' };
  }
  let odd = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) return { problem: 'It is not a text file.' };
    // Control characters other than tab, line feed, form feed, carriage return and escape.
    if (b < 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13 && b !== 27) odd++;
  }
  if (odd > Math.max(2, bytes.length / 200)) return { problem: 'It is not a text file.' };
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let raw: string;
  let encoding: TextFormat['encoding'] = 'utf-8';
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    if (bom) return { problem: 'It is not valid UTF-8 text.' };
    // Not UTF-8: read each byte as one character, which writes back byte for byte.
    raw = decodeLatin1(bytes);
    encoding = 'latin1';
  }
  const { eol, mixed } = detectEol(raw);
  const text = normalizeEol(raw);
  return { text, format: { encoding, bom, eol, mixedEol: mixed, finalNewline: text.endsWith('\n') } };
}

/**
 * A merged text as the bytes to store: the format's line endings, byte order mark and encoding.
 * Whether it ends in a line break is taken from the text itself, since the merge view shows and
 * edits that.
 */
export function encodeText(text: string, format: Pick<TextFormat, 'encoding' | 'bom' | 'eol'>): Uint8Array | NotText {
  const lf = normalizeEol(text);
  const out = format.eol === '\n' ? lf : lf.replace(/\n/g, format.eol);
  if (format.encoding === 'latin1') {
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const c = out.charCodeAt(i);
      if (c > 0xff) {
        const line = out.slice(0, i).split(format.eol).length;
        return { problem: `The file is stored as ISO-8859-1, which has no "${String.fromCodePoint(out.codePointAt(i)!)}" (line ${line}). Write it as an escape, or use plain letters.` };
      }
      bytes[i] = c;
    }
    return bytes;
  }
  const body = new TextEncoder().encode(out);
  if (!format.bom) return body;
  const bytes = new Uint8Array(body.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(body, 3);
  return bytes;
}

/** "UTF-8 with BOM · CRLF", for the merge view's status line. */
export function describeFormat(f: TextFormat): string {
  const enc = f.encoding === 'latin1' ? 'ISO-8859-1' : f.bom ? 'UTF-8 with BOM' : 'UTF-8';
  return `${enc} · ${EOL_NAME[f.eol]}${f.mixedEol ? ' (mixed)' : ''}`;
}
