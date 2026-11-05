'use strict';
const c = require('./colors');

function splitLines(text) {
  if (text === undefined || text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// LCS-based line diff. Returns ops: { t: ' ' | '-' | '+', s: line, a: indexInA, b: indexInB }
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i], a: i, b: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', s: a[i], a: i, b: j });
      i++;
    } else {
      ops.push({ t: '+', s: b[j], a: i, b: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', s: a[i], a: i++, b: j });
  while (j < m) ops.push({ t: '+', s: b[j], a: i, b: j++ });
  return ops;
}

function hunks(ops, context = 3) {
  const changes = [];
  ops.forEach((o, i) => o.t !== ' ' && changes.push(i));
  if (!changes.length) return [];
  const ranges = [];
  let start = Math.max(0, changes[0] - context);
  let end = Math.min(ops.length - 1, changes[0] + context);
  for (const ci of changes.slice(1)) {
    if (ci - context <= end + 1) {
      end = Math.min(ops.length - 1, ci + context);
    } else {
      ranges.push([start, end]);
      start = ci - context;
      end = Math.min(ops.length - 1, ci + context);
    }
  }
  ranges.push([start, end]);
  return ranges.map(([s, e]) => {
    const lines = ops.slice(s, e + 1);
    const aCount = lines.filter((o) => o.t !== '+').length;
    const bCount = lines.filter((o) => o.t !== '-').length;
    return {
      aStart: aCount ? lines[0].a + 1 : lines[0].a,
      aCount,
      bStart: bCount ? lines[0].b + 1 : lines[0].b,
      bCount,
      lines,
    };
  });
}

function countChanges(oldText, newText) {
  let ins = 0;
  let del = 0;
  for (const op of diffLines(splitLines(oldText), splitLines(newText))) {
    if (op.t === '+') ins++;
    else if (op.t === '-') del++;
  }
  return { ins, del };
}

// oldText/newText undefined means the file does not exist on that side.
function unifiedDiff(path, oldText, newText) {
  const out = [c.bold(`diff --git a/${path} b/${path}`)];
  if (oldText === undefined) out.push(c.bold('new file mode 100644'));
  if (newText === undefined) out.push(c.bold('deleted file mode 100644'));
  out.push(c.bold(oldText === undefined ? '--- /dev/null' : `--- a/${path}`));
  out.push(c.bold(newText === undefined ? '+++ /dev/null' : `+++ b/${path}`));
  for (const h of hunks(diffLines(splitLines(oldText), splitLines(newText)))) {
    out.push(c.cyan(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`));
    for (const op of h.lines) {
      if (op.t === '+') out.push(c.green('+' + op.s));
      else if (op.t === '-') out.push(c.red('-' + op.s));
      else out.push(' ' + op.s);
    }
  }
  return out.join('\n');
}

// Regions of base that `other` changed: { start, end (exclusive), lines }.
function regions(base, other) {
  const regs = [];
  let cur = null;
  let bi = 0;
  for (const op of diffLines(base, other)) {
    if (op.t === ' ') {
      if (cur) regs.push(cur);
      cur = null;
      bi++;
    } else {
      if (!cur) cur = { start: bi, end: bi, lines: [] };
      if (op.t === '-') cur.end = ++bi;
      else cur.lines.push(op.s);
    }
  }
  if (cur) regs.push(cur);
  return regs;
}

function applyRegions(base, regs, start, end) {
  const out = [];
  let p = start;
  for (const r of regs) {
    out.push(...base.slice(p, r.start), ...r.lines);
    p = r.end;
  }
  out.push(...base.slice(p, end));
  return out;
}

// Line-based three-way merge. Non-overlapping edits from both sides are combined;
// overlapping edits produce conflict markers.
function merge3(baseText, oursText, theirsText, oursLabel, theirsLabel) {
  const base = splitLines(baseText);
  const tagged = [
    ...regions(base, splitLines(oursText)).map((r) => ({ ...r, side: 'o' })),
    ...regions(base, splitLines(theirsText)).map((r) => ({ ...r, side: 't' })),
  ].sort((x, y) => x.start - y.start || x.end - y.end);

  const groups = [];
  for (const r of tagged) {
    const last = groups[groups.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      last.regs.push(r);
    } else {
      groups.push({ start: r.start, end: r.end, regs: [r] });
    }
  }

  const out = [];
  let clean = true;
  let pos = 0;
  for (const g of groups) {
    out.push(...base.slice(pos, g.start));
    const o = g.regs.filter((r) => r.side === 'o');
    const t = g.regs.filter((r) => r.side === 't');
    const oursPart = applyRegions(base, o, g.start, g.end);
    const theirsPart = applyRegions(base, t, g.start, g.end);
    if (!o.length) out.push(...theirsPart);
    else if (!t.length) out.push(...oursPart);
    else if (oursPart.join('\n') === theirsPart.join('\n')) out.push(...oursPart);
    else {
      clean = false;
      out.push(`<<<<<<< ${oursLabel}`, ...oursPart, '=======', ...theirsPart, `>>>>>>> ${theirsLabel}`);
    }
    pos = g.end;
  }
  out.push(...base.slice(pos));
  return { clean, text: out.length ? out.join('\n') + '\n' : '' };
}

module.exports = { splitLines, diffLines, unifiedDiff, countChanges, merge3 };
