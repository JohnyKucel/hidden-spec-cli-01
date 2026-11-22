// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON tool calls), finds the lines each edit names at the
// first of three matching tiers, and writes every change or none.
// Node 22, standard library alone. Run as:
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// SPEC.md in this repository is the whole contract.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

// One text file, split the way the spec says: its line break is CRLF when
// its first line feed follows a carriage return, LF otherwise; a trailing
// break is a property of the file, not an extra line.
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(state: FileState): string {
  if (state.lines.length === 0) return '';
  return state.lines.join(state.br) + (state.finalBreak ? state.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrailing(s);
  return stripBoth(s);
}

// Positions where O occurs in the file lines at one tier, at or after
// `from`, keeping only positions the caller accepts.
function occurrencesAt(
  fileLines: string[],
  oldLines: string[],
  tier: number,
  from: number,
  accept?: (pos: number) => boolean,
): number[] {
  const out: number[] = [];
  if (oldLines.length === 0 || oldLines.length > fileLines.length) return out;
  const want = oldLines.map((l) => tierLine(l, tier));
  for (let i = Math.max(0, from); i + oldLines.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k += 1) {
      if (tierLine(fileLines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok && (accept === undefined || accept(i))) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  positions: number[];
}

// First tier (0, then 1, then 2; only 0 under --strict) with an occurrence.
function findTier(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  from = 0,
  accept?: (pos: number) => boolean,
): TierHit | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const positions = occurrencesAt(fileLines, oldLines, tier, from, accept);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// A chunk: old lines O, new lines N. A new line that is a context line
// remembers which old line it is, so it is written as the file's own line.
interface Chunk {
  o: string[];
  n: string[];
  nCtx: (number | null)[];
}

function chunkFromBody(body: string[]): Chunk {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const entry of body) {
    if (entry === '' || entry.startsWith(' ')) {
      const line = entry === '' ? '' : entry.slice(1);
      o.push(line);
      n.push(line);
      nCtx.push(o.length - 1);
    } else if (entry.startsWith('-')) {
      o.push(entry.slice(1));
    } else if (entry.startsWith('+')) {
      n.push(entry.slice(1));
      nCtx.push(null);
    }
    // A `\` entry is not a line of either side; it only marks a missing
    // final line break, which the caller reads off the body directly.
  }
  return { o, n, nCtx };
}

// New lines with tier-2 re-indentation applied. Context lines are handled
// by the caller, which substitutes the file's own matched line.
function reindentNew(
  newLines: string[],
  oldLines: string[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  if (tier !== 2 || oldLines.length === 0) return [...newLines];
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(oldLines[0]!);
  return newLines.map((line) => {
    if (line === '' || line.trim() === '') return line;
    return line.startsWith(p) ? f + line.slice(p.length) : line;
  });
}

// Replace the matched lines at `pos` with the chunk's new lines.
function replaceChunk(state: FileState, pos: number, chunk: Chunk, tier: number): void {
  const rewritten: string[] = [];
  for (let i = 0; i < chunk.n.length; i += 1) {
    const ctx = chunk.nCtx[i]!;
    if (ctx !== null) {
      rewritten.push(state.lines[pos + ctx]!);
    } else {
      rewritten.push(reindentNew([chunk.n[i]!], chunk.o, state.lines, pos, tier)[0]!);
    }
  }
  state.lines.splice(pos, chunk.o.length, ...rewritten);
}

// The tree as the edits leave it: changed paths in `now` (null: deleted),
// the rest read from disk. Moves that succeeded are remembered so the
// output can print one `R old -> new` line for them.
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];

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

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }

  state(p: string): FileState | null {
    const text = this.get(p);
    return text === null ? null : parseFile(text);
  }
}

type Edit = (tree: Tree) => void;

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- JSON ---

function jsonEdit(v: unknown, strict: boolean): Edit | null {
  void strict;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const lfAt = before.indexOf('\n');
      const crlf = lfAt > 0 && before[lfAt - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const state = parseFile(before);
      if (line < 0 || line > state.lines.length) throw new Fail('no-match', p);
      state.lines.splice(line, 0, ...added);
      tree.set(p, serializeFile(state));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[], strict: boolean): Edit[] {
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
      const e = jsonEdit(x, strict);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l), strict);
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------------- unified ---

interface Hunk {
  a: number;
  body: string[];
  chunk: Chunk;
  // A `\` line follows the hunk's last context or `+` line.
  noEolCtxPlus: boolean;
  // A `\` line follows the hunk's last `+` line.
  noEolPlus: boolean;
}

function hunkFlags(body: string[]): { noEolCtxPlus: boolean; noEolPlus: boolean } {
  const followsBackslash = (idx: number): boolean =>
    idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  let noEolCtxPlus = false;
  let noEolPlus = false;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const e = body[i]!;
    if (e === '' || e.startsWith(' ') || e.startsWith('+')) {
      noEolCtxPlus = followsBackslash(i);
      break;
    }
  }
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.startsWith('+')) {
      noEolPlus = followsBackslash(i);
      break;
    }
  }
  return { noEolCtxPlus, noEolPlus };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_HEAD = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

function headerPath(line: string): string {
  const after = line.slice(4);
  const tab = after.indexOf('\t');
  return (tab < 0 ? after : after.slice(0, tab)).trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

interface Section {
  oldRaw: string | null;
  newRaw: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const isSectionStart = (j: number): boolean =>
    lines[j]!.startsWith('diff --git ') ||
    (lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '));
  while (i < lines.length) {
    if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (!isSectionStart(i)) {
      i += 1;
      continue;
    }
    const section: Section = { oldRaw: null, newRaw: null, create: false, remove: false, hunks: [] };
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    if (lines[i]!.startsWith('diff --git ')) {
      const m = DIFF_HEAD.exec(lines[i]!);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      diffOld = m[1]!;
      diffNew = m[2]!;
      i += 1;
    }
    // Header, up to the first hunk or the next section.
    let headerPairSeen = false;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('@@') || l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (headerPairSeen) break;
          headerPairSeen = true;
          section.oldRaw = headerPath(l);
          section.newRaw = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) section.create = true;
      else if (l.startsWith('deleted file mode')) section.remove = true;
      i += 1;
    }
    // Hunks, until the next section or the end of the patch.
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const m = HUNK_HEAD.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
        const body: string[] = [];
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
            body.push(b);
            i += 1;
          } else break;
        }
        while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
        const flags = hunkFlags(body);
        section.hunks.push({ a: Number(m[1]), body, chunk: chunkFromBody(body), ...flags });
        continue;
      }
      if (isSectionStart(i)) break;
      i += 1;
    }
    const oldRaw = section.oldRaw ?? renameFrom ?? diffOld;
    const newRaw = section.newRaw ?? renameTo ?? diffNew;
    if (section.oldRaw === '/dev/null') section.create = true;
    if (section.newRaw === '/dev/null') section.remove = true;
    const oldPath = oldRaw === null || oldRaw === '/dev/null' ? null : stripAB(oldRaw);
    const newPath = newRaw === null || newRaw === '/dev/null' ? null : stripAB(newRaw);
    edits.push(unifiedEdit(section, oldPath, newPath, strict));
  }
  return edits;
}

function applyHunks(state: FileState, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const hunk of hunks) {
    if (hunk.chunk.o.length === 0) {
      const pos = Math.min(hunk.a + d, state.lines.length);
      const touchesEnd = pos === state.lines.length;
      state.lines.splice(pos, 0, ...hunk.chunk.n);
      if (touchesEnd) state.finalBreak = !hunk.noEolCtxPlus;
      d += hunk.chunk.n.length;
      continue;
    }
    const found = findTier(state.lines, hunk.chunk.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const touchesEnd = pos + hunk.chunk.o.length === state.lines.length;
    replaceChunk(state, pos, hunk.chunk, found.tier);
    if (touchesEnd) state.finalBreak = !hunk.noEolCtxPlus;
    d += hunk.chunk.n.length - hunk.chunk.o.length;
  }
}

function unifiedEdit(section: Section, oldPath: string | null, newPath: string | null, strict: boolean): Edit {
  return (tree) => {
    if (oldPath !== null && !safePath(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safePath(newPath)) throw new Fail('unsafe', newPath);
    if (section.create) {
      if (newPath === null) throw new Fail('missing', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plusLines: string[] = [];
      for (const hunk of section.hunks) {
        for (const entry of hunk.body) {
          if (entry.startsWith('+')) plusLines.push(entry.slice(1));
        }
      }
      let finalBreak = true;
      for (let h = section.hunks.length - 1; h >= 0; h -= 1) {
        const hunk = section.hunks[h]!;
        if (hunk.body.some((e) => e.startsWith('+'))) {
          finalBreak = !hunk.noEolPlus;
          break;
        }
      }
      tree.set(newPath, serializeFile({ lines: plusLines, br: '\n', finalBreak }));
      return;
    }
    if (section.remove) {
      if (oldPath === null || tree.get(oldPath) === null) throw new Fail('missing', oldPath ?? '');
      tree.set(oldPath, null);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const state = tree.state(oldPath)!;
      applyHunks(state, section.hunks, oldPath, strict);
      tree.set(newPath, serializeFile(state));
      tree.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const path = oldPath ?? newPath;
    if (path === null || tree.get(path) === null) throw new Fail('missing', path ?? '');
    const state = tree.state(path)!;
    applyHunks(state, section.hunks, path, strict);
    tree.set(path, serializeFile(state));
  };
}

// ------------------------------------------------------ search-replace ---

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const state = tree.state(path);
    if (state === null) throw new Fail('missing', path);
    const found = findTier(state.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const rewritten = reindentNew(newLines, oldLines, state.lines, pos, found.tier);
    state.lines.splice(pos, oldLines.length, ...rewritten);
    tree.set(path, serializeFile(state));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let boundary = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= boundary; j -= 1) {
      const t = lines[j]!;
      if (blank(t) || t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    boundary = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ------------------------------------------------------------------ v4a ---

interface V4aChunk extends Chunk {
  anchor: string;
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const state = tree.state(path);
    if (state === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== '') {
        const anchorHit = findTier(state.lines, [chunk.anchor], strict, cursor);
        if (anchorHit === null) throw new Fail('no-match', path);
        cursor = anchorHit.positions[0]! + 1;
      }
      if (chunk.o.length === 0) {
        const pos = chunk.eof ? state.lines.length : cursor;
        state.lines.splice(pos, 0, ...chunk.n);
        cursor = pos + chunk.n.length;
        continue;
      }
      const accept = chunk.eof
        ? (pos: number): boolean => pos + chunk.o.length === state.lines.length
        : undefined;
      const found = findTier(state.lines, chunk.o, strict, cursor, accept);
      if (found === null || found.positions.length === 0) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      replaceChunk(state, pos, chunk, found.tier);
      cursor = pos + chunk.n.length;
    }
    const out = serializeFile(state);
    if (moveTo !== null) {
      tree.set(moveTo, out);
      tree.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.set(path, out);
    }
  };
}

const V4A_SECTION =
  /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    const sectionMatch = V4A_SECTION.exec(l);
    if (sectionMatch === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = sectionMatch[1]!;
    const path = sectionMatch[2]!.trim();
    i += 1;
    if (kind === 'Add File') {
      const fileLines: string[] = [];
      const fromBlank: boolean[] = [];
      while (i < last) {
        const x = lines[i]!;
        if (V4A_SECTION.test(x)) break;
        if (blank(x)) {
          fileLines.push('');
          fromBlank.push(true);
          i += 1;
          continue;
        }
        if (x.startsWith('+')) {
          fileLines.push(x.slice(1));
          fromBlank.push(false);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it; a `+`
      // line that names an empty line is explicit and stays.
      while (fileLines.length > 0 && fromBlank[fromBlank.length - 1]) {
        fileLines.pop();
        fromBlank.pop();
      }
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (kind === 'Delete File') {
      while (i < last) {
        const x = lines[i]!;
        if (V4A_SECTION.test(x)) break;
        if (blank(x)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    // Update File.
    const updateLine = i - 1;
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i += 1;
    }
    const chunks: V4aChunk[] = [];
    let current: { anchor: string; body: string[]; eof: boolean } | null = null;
    let eofSeen = false;
    while (i < last) {
      const x = lines[i]!;
      if (V4A_SECTION.test(x)) break;
      if (x === '*** End of File') {
        if (current === null) throw new Exit2(`error: parse ${i + 1}`);
        current.eof = true;
        eofSeen = true;
        i += 1;
        continue;
      }
      if (x.startsWith('@@')) {
        const chunk = { anchor: x.slice(2).trim(), body: [] as string[], eof: false };
        chunks.push(chunk as unknown as V4aChunk);
        current = chunk;
        eofSeen = false;
        i += 1;
        continue;
      }
      if (x === '' || x.startsWith(' ') || x.startsWith('-') || x.startsWith('+')) {
        if (eofSeen) throw new Exit2(`error: parse ${i + 1}`);
        if (current === null) {
          const chunk = { anchor: '', body: [] as string[], eof: false };
          chunks.push(chunk as unknown as V4aChunk);
          current = chunk;
        }
        current.body.push(x);
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Blank lines at the end of the section are not part of it.
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1] as unknown as { body: string[] };
      while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.trim() === '') {
        lastChunk.body.pop();
      }
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
    const built: V4aChunk[] = chunks.map((c) => {
      const raw = c as unknown as { anchor: string; body: string[]; eof: boolean };
      const chunk = chunkFromBody(raw.body);
      return { ...chunk, anchor: raw.anchor, eof: raw.eof };
    });
    edits.push(v4aUpdateEdit(path, moveTo, built, strict));
  }
  return edits;
}

// ----------------------------------------------------------------- run ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
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
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines, strict);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // Changed paths, with a successful move printed as one `R` line that
  // replaces its `D` and `A` lines and sorts by the new path.
  const consumed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
    if (consumed.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const { p, now } of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
