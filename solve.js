// A fast drop-in for makefun-site 1.0.0, written from scratch in this session.
//
// The build is the same pipeline the reference runs (sources in code-unit
// order, front matter, permalinks, Markdown, collections, tags, layouts,
// report), but every stage is reworked for speed instead of clarity:
//   - the Markdown body is rendered in one fused pass over its lines, with a
//     hand-rolled line classifier and an inline renderer that jumps between
//     special characters instead of walking every character through a regex;
//   - slugs are memoised per case (titles and tag names repeat a lot);
//   - words are counted by scanning code units, not by a global regex;
//   - each template is compiled once per case into a small JavaScript
//     function (via new Function) that appends to an output array, so
//     rendering is straight-line code with no node-tree walk. Loop scopes
//     reuse one frame object and one loop object per loop.
// Nothing is cached between cases: every run(input) builds its own tables.

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** HTML escape table. */
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped, in bulk. */
function escHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ENT[c]);
}

/** One character escaped, for the inline renderer. */
function escChar(c) {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  if (c === "'") return '&#39;';
  return c;
}

/** JavaScript whitespace (what /\s/ matches) as a code-unit table. */
const WS_TBL = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TBL[c] = 1;

/** The words of one line: runs of characters other than whitespace. */
function lineWords(s) {
  let n = 0;
  let inWord = false;
  for (let j = 0; j < s.length; j++) {
    if (WS_TBL[s.charCodeAt(j)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- the slug rule

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one "-", none at either end, at most 64 characters, "untitled" when nothing is left. */
function slugBase(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    let keep = '';
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = ch;
    if (keep === '') {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += keep;
  }
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqSlug(slug, taken) {
  let out = slug;
  let n = 2;
  while (taken.has(out)) {
    out = `${slug}-${n}`;
    n++;
  }
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const p = date.split('-');
  return `${Number(p[2])} ${MONTHS[Number(p[1]) - 1]} ${p[0]}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted or bare string value, or why it is refused. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmString(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

/**
 * A source's front matter over its `lines`: { data, bodyAt } (bodyAt is the
 * index of the first body line), or { error } with the first reason refused.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === '' || /^[ \t]+$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyAt: close + 1 };
}

// ---------------------------------------------------------------- Markdown

/** Whether `s` is blank (spaces and tabs only). */
function blankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `s` with spaces and tabs dropped at either end. */
function trimEnds(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/** A fence's language when `s` opens one ("" for none), else null. */
function fenceLang(s) {
  if (s.charCodeAt(0) !== 96 || s.charCodeAt(1) !== 96 || s.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = s.slice(start, i);
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `s` closes a fence. */
function fenceClose(s) {
  if (s.charCodeAt(0) !== 96 || s.charCodeAt(1) !== 96 || s.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null. */
function headingAt(s) {
  let d = 0;
  while (d < 6 && s.charCodeAt(d) === 35) d++;
  if (d === 0) return null;
  if (d === 6 && s.charCodeAt(6) === 35) return null;
  const c = s.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let a = d;
  while (a < s.length && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  if (a >= s.length) return null;
  let b = s.length;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return { depth: d, text: s.slice(a, b) };
}

/** Whether `s` is a thematic break (`---` or `***`, spaces or tabs after). */
function isHr(s) {
  const c0 = s.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(1) !== c0 || s.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A list's first line: { ordered, start, text }, or null. */
function listOpen(s) {
  const c0 = s.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && s.charCodeAt(1) === 32) return { ordered: false, start: 1, text: trimEnds(s.slice(2)) };
  let d = 0;
  while (d < 9 && s.charCodeAt(d) >= 48 && s.charCodeAt(d) <= 57) d++;
  if (d > 0 && s.charCodeAt(d) === 46 && s.charCodeAt(d + 1) === 32) {
    return { ordered: true, start: Number(s.slice(0, d)), text: trimEnds(s.slice(d + 2)) };
  }
  return null;
}

/** Another item of a list of `ordered` kind in `s`, or null. */
function listItem(s, ordered) {
  if (!ordered) {
    const c0 = s.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && s.charCodeAt(1) === 32) return trimEnds(s.slice(2));
    return null;
  }
  let d = 0;
  while (d < 9 && s.charCodeAt(d) >= 48 && s.charCodeAt(d) <= 57) d++;
  if (d > 0 && s.charCodeAt(d) === 46 && s.charCodeAt(d + 1) === 32) return trimEnds(s.slice(d + 2));
  return null;
}

/** Whether `s` continues a list item (two or more spaces, then a non-space). */
function isContinued(s) {
  let j = 0;
  while (s.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= s.length) return false;
  return !WS_TBL[s.charCodeAt(j)];
}

/** Whether `line` ends a paragraph. */
function endsPara(line) {
  return blankLine(line) || fenceLang(line) !== null || headingAt(line) !== null || isHr(line);
}

/** The characters a backslash escapes, as a code-unit table. */
const ESC_TBL = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESC_TBL[ch.charCodeAt(0)] = 1;

/** The characters the inline scanner stops at, as a code-unit table. */
const SPEC = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '[', '&', '<', '>', '"', "'"]) SPEC[ch.charCodeAt(0)] = 1;

const WS_RE = /\s/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wl = what.length;
  for (let j = from; j <= end - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESC_TBL[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESC_TBL[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s[a..b]` rendered inline into `out`; `link(target)` resolves a link's href. */
function inlineStr(s, a, b, out, link) {
  let i = a;
  while (i < b) {
    let j = i;
    while (j < b) {
      const c = s.charCodeAt(j);
      if (c < 128 && SPEC[c]) break;
      j++;
    }
    if (j > i) out.push(s.slice(i, j));
    i = j;
    if (i >= b) break;
    const ch = s[i];
    if (ch === '\\') {
      if (i + 1 < b && ESC_TBL[s.charCodeAt(i + 1)]) {
        out.push(escChar(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (ch === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < b && k > i + 1) {
        out.push('<code>', escHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (ch === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2, b);
        if (k > i + 2) {
          out.push('<strong>');
          inlineStr(s, i + 2, k, out, link);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1, b);
        if (k > i + 1) {
          out.push('<em>');
          inlineStr(s, i + 1, k, out, link);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    if (ch === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) {
        const mm = s.indexOf(')', k + 2);
        if (mm !== -1 && mm < b) m = mm;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          out.push('<a href="', escHtml(link(target)), '">');
          inlineStr(s, i + 1, k, out, link);
          out.push('</a>');
          i = m + 1;
          continue;
        }
      }
      out.push('[');
      i++;
      continue;
    }
    out.push(escChar(ch));
    i++;
  }
}

/**
 * `lines[start..]` rendered: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents, its excerpt (the first paragraph's
 * inline HTML, or "") and its word count (every body line's words, the fence
 * close line included — the count is over the raw body, as the reference does).
 */
function renderBody(lines, start, link, slugOf) {
  const parts = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  const ids = new Set();
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    words += lineWords(line);
    if (blankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const code = [];
      while (i < n && !fenceClose(lines[i])) {
        words += lineWords(lines[i]);
        code.push(lines[i++]);
      }
      if (i < n) words += lineWords(lines[i]);
      i++;
      parts.push('<pre><code' + (lang === '' ? '' : ' class="language-' + escHtml(lang) + '"') + '>');
      for (let q = 0; q < code.length; q++) {
        parts.push(escHtml(code[q]), '\n');
      }
      parts.push('</code></pre>\n');
      continue;
    }
    const hd = headingAt(line);
    if (hd !== null) {
      const id = uniqSlug(slugOf(hd.text), ids);
      const hp = [];
      inlineStr(hd.text, 0, hd.text.length, hp, link);
      const html = hp.join('');
      parts.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const q = [];
      let first = true;
      while (i < n && lines[i].charCodeAt(0) === 62) {
        if (!first) words += lineWords(lines[i]);
        first = false;
        const l = lines[i++];
        q.push(trimEnds(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = [];
      for (const l of q) if (l !== '') kept.push(l);
      if (kept.length === 0) {
        parts.push('<blockquote>\n</blockquote>\n');
      } else {
        const t = kept.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineStr(t, 0, t.length, parts, link);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const op = listOpen(line);
    if (op !== null) {
      const items = [[op.text]];
      i++;
      while (i < n) {
        const it = listItem(lines[i], op.ordered);
        if (it !== null) {
          words += lineWords(lines[i]);
          items.push([it]);
          i++;
          continue;
        }
        if (isContinued(lines[i])) {
          words += lineWords(lines[i]);
          items[items.length - 1].push(trimEnds(lines[i]));
          i++;
          continue;
        }
        break;
      }
      const tag = op.ordered ? 'ol' : 'ul';
      parts.push(op.ordered && op.start !== 1 ? `<ol start="${op.start}">` : `<${tag}>`, '\n');
      for (const it of items) {
        const t = it.join('\n');
        parts.push('<li>');
        inlineStr(t, 0, t.length, parts, link);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      continue;
    }
    const pl = [trimEnds(line)];
    i++;
    while (i < n && !endsPara(lines[i])) {
      words += lineWords(lines[i]);
      pl.push(trimEnds(lines[i]));
      i++;
    }
    const t = pl.join('\n');
    const pp = [];
    inlineStr(t, 0, t.length, pp, link);
    const html = pp.join('');
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TplErr extends Error {}

/** The path `text` names, split at its dots, or a TplErr. */
function pathParts(name, text) {
  if (!PATH_RE.test(text)) throw new TplErr(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b]` holds only spaces or tabs. */
function onlySpaces(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}/{{{ }}} values and {% %} tags (a standalone tag's line taken with it). */
function tokenizeTpl(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  const L = src.length;
  while (i < L) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === L - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TplErr(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') {
        toks.push({ t: 'x', s: text });
        text = '';
      }
      toks.push({ t: raw ? 'r' : 'v', p: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplErr(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const ls = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const le = nl === -1 ? L : nl;
    const standalone = onlySpaces(src, ls, open) && onlySpaces(src, end, le);
    if (standalone) text = text.slice(0, text.length - (open - ls));
    if (text !== '') {
      toks.push({ t: 'x', s: text });
      text = '';
    }
    toks.push({ t: 'g', s: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? L : nl + 1) : end;
  }
  if (text !== '') toks.push({ t: 'x', s: text });
  return toks;
}

/** `src` parsed into its tree of nodes (a TplErr when it does not parse). */
function parseTpl(name, src) {
  const root = { k: 'root', b: [] };
  const stack = [root];
  let body = root.b;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'x') {
      body.push({ k: 't', s: tok.s });
      continue;
    }
    if (tok.t === 'v' || tok.t === 'r') {
      body.push({ k: tok.t, p: tok.p });
      continue;
    }
    const tag = tok.s;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 'f', v: m[1], p: pathParts(name, m[2]), b: [] };
      body.push(node);
      stack.push(node);
      body = node.b;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 'i', not: m[1] !== undefined, p: pathParts(name, m[2]), a: [], e: null };
      body.push(node);
      stack.push(node);
      body = node.a;
    } else if (tag === 'else') {
      if (top.k !== 'i' || top.e !== null) throw new TplErr(`template "${name}": an else outside an if`);
      top.e = [];
      body = top.e;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.k !== (tag === 'endfor' ? 'f' : 'i')) {
        throw new TplErr(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === 'root' ? parent.b : parent.k === 'f' ? parent.b : parent.e !== null ? parent.e : parent.a;
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push({ k: 'c', n: m[1] });
    } else {
      throw new TplErr(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TplErr(`template "${name}": a ${stack[stack.length - 1].k === 'f' ? 'for' : 'if'} is not closed`);
  }
  return root.b;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at a one-name path in the scope chain. */
function get1(s, a) {
  for (; s !== null; s = s.parent) {
    if (Object.hasOwn(s.vars, a)) return s.vars[a];
  }
  return undefined;
}

/** The value at a two-name path in the scope chain. */
function get2(s, a, b) {
  for (; s !== null; s = s.parent) {
    if (Object.hasOwn(s.vars, a)) {
      const v = s.vars[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
      return v[b];
    }
  }
  return undefined;
}

/** The value at a three-name path in the scope chain. */
function get3(s, a, b, c) {
  for (; s !== null; s = s.parent) {
    if (Object.hasOwn(s.vars, a)) {
      let v = s.vars[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
      v = v[b];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
      return v[c];
    }
  }
  return undefined;
}

/** The value at a longer path in the scope chain. */
function getN(s, path) {
  for (; s !== null; s = s.parent) {
    if (Object.hasOwn(s.vars, path[0])) {
      let v = s.vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** JavaScript source for reading `path` from scope variable `sv`. */
function getCall(path, sv) {
  if (path.length === 1) return `g1(${sv},${JSON.stringify(path[0])})`;
  if (path.length === 2) return `g2(${sv},${JSON.stringify(path[0])},${JSON.stringify(path[1])})`;
  if (path.length === 3) {
    return `g3(${sv},${JSON.stringify(path[0])},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
  }
  return `gN(${sv},${JSON.stringify(path)})`;
}

/** Emit `nodes` as JavaScript into `g.parts`, reading scope variable `sv`. */
function emitNodes(g, nodes, sv) {
  for (const n of nodes) {
    if (n.k === 't') {
      g.parts.push(`O.push(${JSON.stringify(n.s)});`);
    } else if (n.k === 'v') {
      g.parts.push(`O.push(esc(txt(${getCall(n.p, sv)})));`);
    } else if (n.k === 'r') {
      g.parts.push(`O.push(txt(${getCall(n.p, sv)}));`);
    } else if (n.k === 'i') {
      g.parts.push(`if(tru(${getCall(n.p, sv)})!==${n.not ? 'true' : 'false'}){`);
      emitNodes(g, n.a, sv);
      g.parts.push('}');
      if (n.e !== null) {
        g.parts.push('else{');
        emitNodes(g, n.e, sv);
        g.parts.push('}');
      }
    } else if (n.k === 'f') {
      const id = g.uid++;
      const xs = `_x${id}`;
      const fr = `_f${id}`;
      const lp = `_l${id}`;
      const ix = `_i${id}`;
      g.parts.push(`{let ${xs}=${getCall(n.p, sv)};if(Array.isArray(${xs})){`);
      g.parts.push(`let ${fr}={vars:{},parent:${sv}};`);
      g.parts.push(`let ${lp}={index:0,first:false,last:false,length:${xs}.length};`);
      g.parts.push(`for(let ${ix}=0;${ix}<${xs}.length;${ix}++){`);
      g.parts.push(`${fr}.vars[${JSON.stringify(n.v)}]=${xs}[${ix}];`);
      g.parts.push(`${lp}.index=${ix}+1;${lp}.first=${ix}===0;${lp}.last=${ix}===${xs}.length-1;`);
      g.parts.push(`${fr}.vars.loop=${lp};`);
      emitNodes(g, n.b, fr);
      g.parts.push('}}}');
    } else if (n.k === 'c') {
      const id = g.uid++;
      g.parts.push(`{let _t${id}=T.get(${JSON.stringify(n.n)});if(_t${id}!==undefined&&D<8)_t${id}(${sv},O,D+1);}`);
    }
  }
}

/** Compile `src` into a render function (S, O, D), sharing `tplMap` for includes. */
function compileTpl(name, src, tplMap) {
  const nodes = parseTpl(name, src);
  const g = { parts: [], uid: 0 };
  emitNodes(g, nodes, 'S');
  const fn = new Function('esc', 'txt', 'tru', 'g1', 'g2', 'g3', 'gN', 'T', 'S', 'O', 'D', g.parts.join(''));
  return fn.bind(null, escHtml, textOf, truthy, get1, get2, get3, getN, tplMap);
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
};

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Slugs repeat across titles, tags and headings: memoise them per case.
  const slugCache = new Map();
  const slugOf = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugBase(t);
      slugCache.set(t, s);
    }
    return s;
  };

  // Templates, parsed and compiled in code-unit order of their name. One that
  // does not parse is reported and left out, as if it were not there.
  const tplMap = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(cmp);
  for (const name of tNames) {
    try {
      tplMap.set(name, compileTpl(name, input.templates[name], tplMap));
    } catch (err) {
      if (!(err instanceof TplErr)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths; a source that is not .md is static.
  const files = input.files.slice().sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // Front matter, in source order: a refused source is reported and dropped,
  // and so is a draft. The checks run in order, the first failure reported.
  const kept = [];
  for (const s of sources) {
    const lines = s.text.split('\n');
    const fm = parseFrontMatter(lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    const post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (post && !Object.hasOwn(data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout !== undefined ? data.layout : post ? 'post' : 'page';
    if (!tplMap.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    s.data = data;
    s.post = post;
    s.layout = layout;
    s.lines = lines;
    s.bodyAt = fm.bodyAt;
    s.newer = null;
    s.older = null;
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqSlug(s.data.slug !== undefined ? s.data.slug : slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderBody(s.lines, s.bodyAt, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    const names = s.data.tags !== undefined ? s.data.tags : [];
    for (const nm of names) {
      const sg = slugOf(nm);
      if (seen.has(sg)) continue;
      seen.add(sg);
      out.push(nm);
    }
    return out;
  };
  for (const p of posts) {
    const refs = [];
    for (const nm of ownTagNames(p)) {
      const sg = slugOf(nm);
      let t = bySlug.get(sg);
      if (t === undefined) {
        t = { name: nm, slug: sg, url: `${base}/tags/${sg}/`, posts: [] };
        bySlug.set(sg, t);
      }
      t.posts.push(p);
      refs.push(t);
    }
    p.tagRefs = refs;
  }
  for (const s of kept) {
    if (s.post) continue;
    const refs = [];
    for (const nm of ownTagNames(s)) {
      const sg = slugOf(nm);
      const t = bySlug.get(sg);
      refs.push(t !== undefined ? t : { name: nm, slug: sg, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // A post's card, as lists show it (built once per post, reused by its page).
  const cards = new Map();
  const cardOf = (s) => {
    let c = s.card;
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date !== undefined ? s.data.date : '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary !== undefined ? s.data.summary : '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = c;
    return c;
  };
  for (const p of posts) cards.set(p, cardOf(p));

  /** A page as its layout reads it. */
  const pageOf = (s) => {
    const c = cardOf(s);
    return {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer),
      older: linkOf(s.older),
      is_post: s.post,
    };
  };

  // Layouts: every page through its layout, the index pages and the tag pages.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootVars = { site, tags: allTags, recent };
  const output = {};
  const render = (name, extra) => {
    const f = tplMap.get(name);
    if (f === undefined) return null;
    const out = [];
    f({ vars: Object.assign({}, rootVars, extra), parent: null }, out, 0);
    return out.join('');
  };
  let nPages = 0;
  for (const s of kept) {
    if (!s.post) nPages++;
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
