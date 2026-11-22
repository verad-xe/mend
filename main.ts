// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
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

type Edit = (tree: Tree) => void;

/** Shared context for the parsers: strict matching and the list of successful moves. */
interface Ctx {
  strict: boolean;
  moves: Array<{ old: string; new: string }>;
}

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

/* ------------------------------------------------------------------ */
/* Section 3: a file's lines, its line break and its final line break */
/* ------------------------------------------------------------------ */

interface FileParts {
  br: string;
  lines: string[];
  ends: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function joinParts(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/* --------------------------------------------------------------- */
/* Section 5: matching lines at three tiers, and building the new   */
/* lines from a chunk's context and added lines.                    */
/* --------------------------------------------------------------- */

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const normAt = (tier: number, s: string): string => (tier === 0 ? s : tier === 1 ? trimTrail(s) : trimBoth(s));

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** All 0-based positions where O occurs in lines at the given tier. */
function occurrencesAt(o: string[], lines: string[], tier: number): number[] {
  const oo = o.map((x) => normAt(tier, x));
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normAt(tier, lines[i + j]!) !== oo[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions, or null. */
function findTier(o: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const t of tiers(strict)) {
    const pos = occurrencesAt(o, lines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, with its first such position, or null. */
function findTierFrom(o: string[], lines: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  for (const t of tiers(strict)) {
    const pos = occurrencesAt(o, lines, t).filter((p) => p >= from && (!eof || p + o.length === lines.length));
    if (pos.length > 0) return { tier: t, pos: pos[0]! };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findSingle(anchor: string, lines: string[], from: number, strict: boolean): { tier: number; idx: number } | null {
  for (const t of tiers(strict)) {
    const a = normAt(t, anchor);
    for (let i = from; i < lines.length; i += 1) {
      if (normAt(t, lines[i]!) === a) return { tier: t, idx: i };
    }
  }
  return null;
}

type Item = { kind: 'ctx'; o: number } | { kind: 'add'; text: string };

/**
 * Build the replacement lines for a chunk. Context items are written as the file's own matched lines.
 * At tier 2 every other (added) line is re-indented: the leading whitespace of O's first line is
 * replaced by that of the file's first matched line, when the added line starts with it.
 */
function buildReplacement(items: Item[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadWs(o[0]!);
    f = leadWs(fileLines[pos] ?? '');
  }
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + it.o]!);
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** One body op of a unified hunk or a V4A chunk. `bsAfter` means a `\` line followed it. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  bsAfter?: boolean;
}

/** Split a chunk's ops into its old lines O and its new-line items N. */
function chunkON(ops: Op[]): { o: string[]; items: Item[] } {
  const o: string[] = [];
  const items: Item[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      items.push({ kind: 'ctx', o: o.length });
      o.push(op.text);
    } else if (op.kind === 'del') {
      o.push(op.text);
    } else {
      items.push({ kind: 'add', text: op.text });
    }
  }
  return { o, items };
}

/**
 * Apply unified hunks in order to a file's text (section 6), tracking the running offset d
 * and the file's final line break.
 */
function applyHunks(before: string, hunks: Array<{ a: number; ops: Op[]; noEol: boolean }>, strict: boolean, path: string): string {
  const parts = fileParts(before);
  const lines = [...parts.lines];
  let ends = parts.ends;
  const br = parts.br;
  let d = 0;
  for (const h of hunks) {
    const { o, items } = chunkON(h.ops);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      const ins = buildReplacement(items, lines, at, 0, o);
      lines.splice(at, 0, ...ins);
      if (atEnd && ins.length > 0) ends = !h.noEol;
      d += items.length;
      continue;
    }
    const found = findTier(o, lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.pos[0]!;
    for (const p of found.pos) {
      const db = Math.abs(p - target);
      const bb = Math.abs(pos - target);
      if (db < bb || (db === bb && p < pos)) pos = p;
    }
    const atEnd = pos + o.length === lines.length;
    const repl = buildReplacement(items, lines, pos, found.tier, o);
    lines.splice(pos, o.length, ...repl);
    if (atEnd) ends = !h.noEol;
    d += items.length - o.length;
  }
  return joinParts(lines, br, ends);
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
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

/* --------------------------------------------------------------- */
/* Section 6: unified diffs                                        */
/* --------------------------------------------------------------- */

interface Hunk {
  a: number;
  ops: Op[];
  noEol: boolean;
}

interface USection {
  tripleOld: string | null;
  tripleNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function triplePath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const startSection = (): USection => {
    const s: USection = { tripleOld: null, tripleNew: null, renameOld: null, renameNew: null, diffOld: null, diffNew: null, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.tripleOld = triplePath(line);
        cur.tripleNew = triplePath(lines[i + 1]!);
      } else {
        const s = startSection();
        s.tripleOld = triplePath(line);
        s.tripleNew = triplePath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && !line.startsWith('@@')) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      inHeader = false;
      let j = i + 1;
      const ops: Op[] = [];
      while (j < lines.length) {
        const lj = lines[j]!;
        if (lj.startsWith('diff --git ')) break;
        if (lj.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (lj === '') {
          ops.push({ kind: 'ctx', text: '' });
          j += 1;
          continue;
        }
        const c = lj[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          ops.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: lj.slice(1) });
          j += 1;
          continue;
        }
        if (c === '\\') {
          if (ops.length > 0) ops[ops.length - 1]!.bsAfter = true;
          j += 1;
          continue;
        }
        break;
      }
      let noEol = false;
      for (let k = ops.length - 1; k >= 0; k -= 1) {
        const o = ops[k]!;
        if (o.kind === 'ctx' || o.kind === 'add') {
          noEol = o.bsAfter === true;
          break;
        }
      }
      while (ops.length > 0 && ops[ops.length - 1]!.kind === 'ctx' && ops[ops.length - 1]!.text === '') ops.pop();
      cur.hunks.push({ a, ops, noEol });
      i = j;
      continue;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    let oldP: string | null = null;
    let newP: string | null = null;
    if (s.tripleOld !== null) oldP = s.tripleOld === '/dev/null' ? null : s.tripleOld;
    else if (s.renameOld !== null) oldP = s.renameOld;
    else oldP = s.diffOld;
    if (s.tripleNew !== null) newP = s.tripleNew === '/dev/null' ? null : s.tripleNew;
    else if (s.renameNew !== null) newP = s.renameNew;
    else newP = s.diffNew;
    if (oldP === null && newP !== null) oldP = newP;
    if (newP === null && oldP !== null) newP = oldP;
    if (oldP === null || newP === null) continue;
    const oldPath = oldP;
    const newPath = newP;
    const isCreate = s.create || s.tripleOld === '/dev/null';
    const isDelete = s.del || s.tripleNew === '/dev/null';
    const hunks = s.hunks;
    if (isCreate) {
      edits.push((tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        let lastAddBs = false;
        for (const h of hunks) {
          for (const o of h.ops) {
            if (o.kind === 'add') {
              plus.push(o.text);
              lastAddBs = o.bsAfter === true;
            }
          }
        }
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (lastAddBs ? '' : '\n'));
      });
      continue;
    }
    if (isDelete) {
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      });
      continue;
    }
    if (oldPath !== newPath) {
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const text = applyHunks(before, hunks, ctx.strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, text);
        ctx.moves.push({ old: oldPath, new: newPath });
      });
      continue;
    }
    edits.push((tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, applyHunks(before, hunks, ctx.strict, oldPath));
    });
  }
  return edits;
}

/* --------------------------------------------------------------- */
/* Section 7: SEARCH/REPLACE blocks                                */
/* --------------------------------------------------------------- */

function srEdits(lines: string[], ctx: Ctx): Edit[] {
  interface Block {
    path: string;
    old: string[];
    neu: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const lj = lines[j]!;
      if (blank(lj)) continue;
      if (lj.trim().startsWith('```')) continue;
      path = lj.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let sep = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let rep = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (sep < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, sep), neu: lines.slice(sep + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.neu.length === 0 ? '' : b.neu.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const parts = fileParts(before);
    const found = findTier(b.old, parts.lines, ctx.strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.pos[0]!;
    const items: Item[] = b.neu.map((t) => ({ kind: 'add' as const, text: t }));
    const repl = buildReplacement(items, parts.lines, pos, found.tier, b.old);
    const lines2 = [...parts.lines];
    lines2.splice(pos, b.old.length, ...repl);
    tree.now.set(b.path, joinParts(lines2, parts.br, parts.ends));
  });
}

/* --------------------------------------------------------------- */
/* Section 8: V4A patches                                          */
/* --------------------------------------------------------------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sectionKind = (idx: number): 'add' | 'delete' | 'update' | null => {
    const t = lines[idx]!.trimStart();
    if (t.startsWith('*** Add File:')) return 'add';
    if (t.startsWith('*** Delete File:')) return 'delete';
    if (t.startsWith('*** Update File:')) return 'update';
    return null;
  };
  const pathAfterColon = (line: string): string => {
    const t = line.trimStart();
    const c = t.indexOf(':');
    return t.slice(c + 1).trim();
  };

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const kind = sectionKind(i);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    const path = pathAfterColon(lines[i]!);
    i += 1;
    if (kind === 'add') {
      const fileLines: string[] = [];
      while (i < last && sectionKind(i) === null) {
        const rl = lines[i]!;
        if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else if (rl.trim() === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      sections.push({ kind: 'add', path, line: secLine, moveTo: null, addLines: fileLines, chunks: [] });
      continue;
    }
    if (kind === 'delete') {
      while (i < last && sectionKind(i) === null) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      sections.push({ kind: 'delete', path, line: secLine, moveTo: null, addLines: [], chunks: [] });
      continue;
    }
    // update
    const raw: string[] = [];
    const rawIdx: number[] = [];
    while (i < last && sectionKind(i) === null) {
      raw.push(lines[i]!);
      rawIdx.push(i);
      i += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') {
      raw.pop();
      rawIdx.pop();
    }
    let moveTo: string | null = null;
    let startIdx = 0;
    let p = 0;
    while (p < raw.length && raw[p]!.trim() === '') p += 1;
    if (p < raw.length && raw[p]!.trimStart().startsWith('*** Move to:')) {
      moveTo = pathAfterColon(raw[p]!);
      startIdx = p + 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let started = false;
    for (let k = startIdx; k < raw.length; k += 1) {
      const rl = raw[k]!;
      const ln = rawIdx[k]! + 1;
      if (rl.trim() === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${ln}`);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
        continue;
      }
      if (rl.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        const anchor = rl.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
        started = true;
        continue;
      }
      if (rl === '') {
        if (cur === null) {
          if (started) continue;
          cur = { anchor: null, eof: false, ops: [] };
          started = true;
        }
        cur.ops.push({ kind: 'ctx', text: '' });
        continue;
      }
      const c = rl[0]!;
      if (c === ' ' || c === '-' || c === '+') {
        if (cur === null) {
          cur = { anchor: null, eof: false, ops: [] };
          started = true;
        }
        cur.ops.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: rl.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${ln}`);
    }
    if (cur !== null) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
    sections.push({ kind: 'update', path, line: secLine, moveTo, addLines: [], chunks });
  }

  return sections.map((sec) => (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = fileParts(before);
    const lines2 = [...parts.lines];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const f = findSingle(ch.anchor, lines2, cursor, ctx.strict);
        if (f === null) throw new Fail('no-match', sec.path);
        cursor = f.idx + 1;
      }
      const { o, items } = chunkON(ch.ops);
      if (o.length === 0) {
        const at = ch.eof ? lines2.length : cursor;
        const ins = buildReplacement(items, lines2, at, 0, o);
        lines2.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findTierFrom(o, lines2, cursor, ctx.strict, ch.eof);
        if (found === null) throw new Fail('no-match', sec.path);
        const repl = buildReplacement(items, lines2, found.pos, found.tier, o);
        lines2.splice(found.pos, o.length, ...repl);
        cursor = found.pos + repl.length;
      }
    }
    const text = joinParts(lines2, parts.br, parts.ends);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      ctx.moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.now.set(sec.path, text);
    }
  });
}

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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, ctx)
          : kind === 'search-replace'
            ? srEdits(lines, ctx)
            : v4aEdits(lines, ctx);
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
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a successful move prints `R <old> -> <new>` in place of that pair's D and A
  // lines and sorts by <new>; every other row sorts by its path. All sorting is UTF-8 byte order.
  const rows: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const mv of ctx.moves) {
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.new);
    const nowOld = tree.get(mv.old);
    const nowNew = tree.get(mv.new);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      consumed.add(mv.old);
      consumed.add(mv.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
