// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON text-editor tool calls), finds the lines each edit names at the
// first of three matching tiers (exact, trailing-whitespace tolerant,
// whitespace-and-indent tolerant), and changes every file or none. The whole
// contract is SPEC.md. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: exactly one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: reported as `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at `\n`, one trailing `\r`
 * removed from each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 * `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of UTF-8 paths, for sorting the exit-0 lines. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines plus its own line break and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit: apply it to the tree, or throw a Fail. A failed edit changes
 * nothing (the caller rolls the tree back to its snapshot). */
type Edit = (tree: Tree) => void;

/** A move that succeeded, for the exit-0 `R old -> new` line. */
interface Move {
  old: string;
  new: string;
}

// ---- line matching (SPEC.md section 5) ----

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in `lines` at this tier, at or
 * after `from`. Occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0]! : '';
}

/** Tier-2 re-indentation: a non-empty, not-whitespace-only line of N that
 * starts with P (the leading whitespace of O's first line) has that P
 * replaced by F (the leading whitespace of the file's first matched line). */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a hunk or chunk: context, old, new, or a `\` line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** Split a hunk/chunk body into its old lines O and its new-line plan N:
 * each N entry is a context line (written as the file's own matched line, at
 * O index `oIndex`) or a `+` line (written from the patch). */
function splitBody(body: BodyLine[]): {
  oLines: string[];
  nSpec: Array<{ kind: 'ctx' | 'new'; text: string; oIndex: number }>;
} {
  const oLines: string[] = [];
  const nSpec: Array<{ kind: 'ctx' | 'new'; text: string; oIndex: number }> = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      oLines.push(b.text);
      nSpec.push({ kind: 'ctx', text: b.text, oIndex: oIdx });
      oIdx += 1;
    } else if (b.kind === 'old') {
      oLines.push(b.text);
      oIdx += 1;
    } else if (b.kind === 'new') {
      nSpec.push({ kind: 'new', text: b.text, oIndex: -1 });
    }
  }
  return { oLines, nSpec };
}

/** Whether a `\` line follows the body's last context or `+` line: the new
 * file then ends without a line break when the hunk runs to the end. */
function backslashAfterLastWritten(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const b = body[i]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      return i + 1 < body.length && body[i + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Build the replacement lines for a match at `pos` under `tier`: context
 * lines come from the file, `+` lines from the patch (re-indented at tier 2). */
function buildReplacement(
  nSpec: Array<{ kind: 'ctx' | 'new'; text: string; oIndex: number }>,
  fileLines: string[],
  pos: number,
  oLines: string[],
  tier: number,
): string[] {
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(oLines[0]!);
  return nSpec.map((n) => {
    if (n.kind === 'ctx') return fileLines[pos + n.oIndex]!;
    return tier === 2 ? reindent(n.text, p, f) : n.text;
  });
}

/** The tiers to try, in order. */
function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

// ---- detecting the format (SPEC.md section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object, or null when it is not one (a parse fault). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const br: '\r\n' | '\n' = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface Hunk {
  /** The old start line A of `@@ -A[,B] +C[,D] @@`. */
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null; // null: `/dev/null`, no file
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  pairSeen: boolean;
  hunks: Hunk[];
}

/** A `--- <path>` / `+++ <path>` path: text after the four characters, up to
 * the first tab, surrounding spaces removed; `/dev/null` means no file, and
 * a leading `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const startSection = (oldP: string | null, newP: string | null): void => {
    if (cur !== null) sections.push(cur);
    cur = { oldPath: oldP, newPath: newP, newFile: false, deletedFile: false, pairSeen: false, hunks: [] };
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pairSeen = true;
      } else {
        startSection(oldP, newP);
        cur!.pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      let j = i + 1;
      const raw: string[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
          raw.push(l);
          j += 1;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const body: BodyLine[] = raw.map((l) => {
        if (l === '') return { kind: 'ctx', text: '' };
        const c = l[0]!;
        if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
        if (c === '-') return { kind: 'old', text: l.slice(1) };
        if (c === '+') return { kind: 'new', text: l.slice(1) };
        return { kind: 'bs', text: l.slice(1) };
      });
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (!cur.pairSeen) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.pairSeen) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i += 1;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

/** Apply a section's hunks in order to a file's lines. `d` is the sum over
 * the hunks applied so far of (N's length minus O's length). */
function applyHunks(file: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  const lines = [...file.lines];
  let finalBreak = file.final;
  let d = 0;
  for (const h of hunks) {
    const { oLines, nSpec } = splitBody(h.body);
    const noEol = backslashAfterLastWritten(h.body);
    if (oLines.length > 0) {
      let tier = -1;
      let occ: number[] = [];
      for (const t of tiers(strict)) {
        occ = occurrences(lines, oLines, t);
        if (occ.length > 0) {
          tier = t;
          break;
        }
      }
      if (tier < 0) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const replacement = buildReplacement(nSpec, lines, best, oLines, tier);
      const touchesEnd = best + oLines.length === lines.length;
      lines.splice(best, oLines.length, ...replacement);
      if (touchesEnd) finalBreak = !noEol;
      d += replacement.length - oLines.length;
    } else {
      const insertPos = Math.min(Math.max(h.a + d, 0), lines.length);
      const replacement = nSpec.map((n) => n.text);
      const atEnd = insertPos === lines.length;
      lines.splice(insertPos, 0, ...replacement);
      if (atEnd) finalBreak = !noEol;
      d += replacement.length;
    }
  }
  return { lines, br: file.br, final: finalBreak };
}

function unifiedEdit(s: Section, strict: boolean, moves: Move[]): Edit {
  const isCreate = s.oldPath === null || s.newFile;
  const isDelete = s.newPath === null || s.deletedFile;
  if (isCreate && s.newPath !== null) {
    const newPath = s.newPath;
    return (tree) => {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let finalBreak = true;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = s.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi -= 1) {
          if (body[bi]!.kind === 'new') {
            finalBreak = !(bi + 1 < body.length && body[bi + 1]!.kind === 'bs');
            break outer;
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete && s.oldPath !== null) {
    const oldPath = s.oldPath;
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (s.oldPath !== null && s.newPath !== null && s.oldPath !== s.newPath) {
    const oldPath = s.oldPath;
    const newPath = s.newPath;
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const after = applyHunks(parseFile(before), s.hunks, strict, oldPath);
      tree.now.set(newPath, serializeFile(after));
      tree.now.set(oldPath, null);
      moves.push({ old: oldPath, new: newPath });
    };
  }
  if (s.oldPath !== null && s.newPath !== null) {
    const p = s.oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const after = applyHunks(parseFile(before), s.hunks, strict, p);
      tree.now.set(p, serializeFile(after));
    };
  }
  // Both paths `/dev/null`: nothing to create, delete or move.
  return () => undefined;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    let s = -1;
    for (let k = i; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k > prevReplace; k -= 1) {
      const l = lines[k]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let e = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        e = k;
        break;
      }
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let k = e + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        r = k;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, e), newLines: lines.slice(e + 1, r) });
    prevReplace = r;
    prevPath = path;
    i = r + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const file = parseFile(before);
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiers(strict)) {
      occ = occurrences(file.lines, b.oldLines, t);
      if (occ.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', b.path);
    if (occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = occ[0]!;
    const f = leadingWs(file.lines[pos]!);
    const p = leadingWs(b.oldLines[0]!);
    const replacement = b.newLines.map((l) => (tier === 2 ? reindent(l, p, f) : l));
    const lines = [...file.lines];
    lines.splice(pos, b.oldLines.length, ...replacement);
    tree.now.set(b.path, serializeFile({ lines, br: file.br, final: file.final }));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  /** null: no anchor. */
  anchor: string | null;
  body: Array<{ kind: 'ctx' | 'old' | 'new'; text: string }>;
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines?: string[];
  moveTo?: string | null;
  chunks?: V4aChunk[];
}

function parseV4aSectionContent(
  kind: 'add' | 'delete' | 'update',
  raw: string[],
  rawStart: number,
  lineNo: number,
): { addLines?: string[]; moveTo?: string | null; chunks?: V4aChunk[] } {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
    return { addLines: fileLines };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${rawStart + 1}`);
    return {};
  }
  let moveTo: string | null = null;
  let rest = raw;
  let restStart = rawStart;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    rest = raw.slice(1);
    restStart = rawStart + 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const pushChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (let k = 0; k < rest.length; k += 1) {
    const l = rest[k]!;
    const ln = restStart + k + 1;
    if (l.startsWith('@@')) {
      pushChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      pushChunk();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length === 0) cur = { anchor: null, body: [], eof: false };
        else throw new Exit2(`error: parse ${ln}`);
      }
      if (l === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
      else cur.body.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  pushChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  return { moveTo, chunks };
}

function parseV4a(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (lines[k]!.trim() !== '') {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const rawStart = i + 1;
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j += 1;
    }
    const raw = lines.slice(rawStart, j);
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
    const content = parseV4aSectionContent(kind, raw, rawStart, i + 1);
    sections.push({ kind, path, lineNo: i + 1, ...content });
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict, moves));
}

function v4aEdit(s: V4aSection, strict: boolean, moves: Move[]): Edit {
  if (s.kind === 'add') {
    const p = s.path;
    const addLines = s.addLines!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    const p = s.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = s.path;
  const moveTo = s.moveTo ?? null;
  const chunks = s.chunks!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = parseFile(before);
    const lines = [...file.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiers(strict)) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (lineEq(lines[k]!, ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const oLines: string[] = [];
      const nSpec: Array<{ kind: 'ctx' | 'new'; text: string; oIndex: number }> = [];
      let oIdx = 0;
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          oLines.push(b.text);
          nSpec.push({ kind: 'ctx', text: b.text, oIndex: oIdx });
          oIdx += 1;
        } else if (b.kind === 'old') {
          oLines.push(b.text);
          oIdx += 1;
        } else {
          nSpec.push({ kind: 'new', text: b.text, oIndex: -1 });
        }
      }
      if (oLines.length > 0) {
        let tier = -1;
        let pos = -1;
        for (const t of tiers(strict)) {
          const occ = occurrences(lines, oLines, t, cursor);
          const cand = ch.eof ? occ.filter((ix) => ix + oLines.length === lines.length) : occ;
          if (cand.length > 0) {
            tier = t;
            pos = cand[0]!;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', p);
        const replacement = buildReplacement(nSpec, lines, pos, oLines, tier);
        lines.splice(pos, oLines.length, ...replacement);
        cursor = pos + replacement.length;
      } else {
        const insertPos = ch.eof ? lines.length : cursor;
        const replacement = nSpec.map((n) => n.text);
        lines.splice(insertPos, 0, ...replacement);
        cursor = insertPos + replacement.length;
      }
    }
    const out = serializeFile({ lines, br: file.br, final: file.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(p, null);
      moves.push({ old: p, new: moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

// ---- invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // What changed, against the tree as it was before the patch.
  const added = new Set<string>();
  const deleted = new Set<string>();
  const modified = new Set<string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
    else modified.add(p);
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const m of moves) {
    if (deleted.has(m.old) && added.has(m.new)) {
      deleted.delete(m.old);
      added.delete(m.new);
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const p of added) rows.push({ key: p, line: `A ${p}` });
  for (const p of deleted) rows.push({ key: p, line: `D ${p}` });
  for (const p of modified) rows.push({ key: p, line: `M ${p}` });
  rows.sort((a, b) => byteCompare(a.key, b.key));
  const out = rows.map((r) => r.line);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
