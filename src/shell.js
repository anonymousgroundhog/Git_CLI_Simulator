'use strict';
const c = require('./colors');
const { VFS } = require('./vfs');

class ShellError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellError';
  }
}

const fail = (msg) => {
  throw new ShellError(msg);
};
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- parsing

// Split a command line on &&, || and ; (outside quotes). Each part records the
// operator that follows it.
function splitChain(line) {
  const parts = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      cur += ch;
      if (ch === '\\' && q === '"' && i + 1 < line.length) cur += line[++i];
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[++i];
    } else if (ch === '&' && line[i + 1] === '&') {
      parts.push({ text: cur, op: '&&' });
      cur = '';
      i++;
    } else if (ch === '|' && line[i + 1] === '|') {
      parts.push({ text: cur, op: '||' });
      cur = '';
      i++;
    } else if (ch === ';') {
      parts.push({ text: cur, op: ';' });
      cur = '';
    } else if (ch === '#' && (cur === '' || /\s$/.test(cur))) {
      break;
    } else cur += ch;
  }
  if (q) fail(`bash: unexpected EOF while looking for matching \`${q}'`);
  parts.push({ text: cur, op: null });
  return parts.filter((p) => p.text.trim());
}

function tokenize(text) {
  const tokens = [];
  let cur = null;
  let q = null;
  const push = () => {
    if (cur) tokens.push(cur);
    cur = null;
  };
  const start = () => {
    if (!cur) cur = { value: '', glob: false };
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === q) q = null;
      else if (q === '"' && ch === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) cur.value += text[++i];
      else cur.value += ch;
      continue;
    }
    if (/\s/.test(ch)) push();
    else if (ch === '"' || ch === "'") {
      start();
      q = ch;
    } else if (ch === '\\') {
      start();
      cur.value += text[++i] ?? '';
    } else if (ch === '>') {
      push();
      if (text[i + 1] === '>') {
        tokens.push({ op: '>>' });
        i++;
      } else tokens.push({ op: '>' });
    } else if (ch === '<') fail('bash: input redirection (<) is not supported in the simulator');
    else if (ch === '|') fail('bash: pipes (|) are not supported in the simulator');
    else {
      start();
      cur.value += ch;
      if (ch === '*' || ch === '?') cur.glob = true;
    }
  }
  if (q) fail(`bash: unexpected EOF while looking for matching \`${q}'`);
  push();
  return tokens;
}

function expandGlob(vfs, pattern) {
  const slash = pattern.lastIndexOf('/');
  const dirPart = slash >= 0 ? pattern.slice(0, slash + 1) : '';
  const base = pattern.slice(slash + 1);
  if (/[*?]/.test(dirPart)) return [pattern];
  const dirAbs = vfs.resolve(dirPart || '.');
  if (!vfs.isDir(dirAbs)) return [pattern];
  const re = new RegExp(
    '^' +
      [...base].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRe(ch))).join('') +
      '$',
  );
  const hits = vfs
    .list(dirAbs)
    .map((e) => e.name)
    .filter((n) => re.test(n) && (base.startsWith('.') || !n.startsWith('.')));
  return hits.length ? hits.map((n) => dirPart + n) : [pattern];
}

function parseCommand(vfs, text) {
  const tokens = tokenize(text);
  const argv = [];
  let redirect = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op) {
      const target = tokens[i + 1];
      if (!target || target.op) fail("bash: syntax error near unexpected token `newline'");
      redirect = { op: t.op, target: target.value };
      i++;
    } else if (t.glob) argv.push(...expandGlob(vfs, t.value));
    else argv.push(t.value);
  }
  return { argv, redirect };
}

// ---------------------------------------------------------------- builtins

function isGitDir(sim, abs) {
  return VFS.basename(abs) === '.git' && sim.repos.has(VFS.parent(abs));
}

function dropReposUnder(sim, abs) {
  for (const root of [...sim.repos.keys()]) {
    if (root === abs || root.startsWith(abs + '/')) sim.repos.delete(root);
  }
}

function fixCwd(sim) {
  let d = sim.vfs.cwd;
  while (!sim.vfs.isDir(d)) d = VFS.parent(d);
  if (d !== sim.vfs.cwd) {
    sim.vfs.cwd = d;
    return c.yellow(`(simulator: your current folder was removed; moved you to ${sim.vfs.display(d)})`);
  }
  return '';
}

function splitFlags(args) {
  const flags = new Set();
  const rest = [];
  let dd = false;
  for (const a of args) {
    if (dd || !a.startsWith('-') || a === '-') rest.push(a);
    else if (a === '--') dd = true;
    else if (a.startsWith('--')) flags.add(a);
    else for (const ch of a.slice(1)) flags.add(ch);
  }
  return { flags, rest };
}

const builtins = {
  pwd: (sim) => sim.vfs.cwd,

  whoami: () => 'student',

  cd(sim, args) {
    const t = args[0];
    if (!t || t === '~') {
      sim.vfs.cwd = sim.vfs.home;
      return '';
    }
    const abs = sim.vfs.resolve(t);
    if (isGitDir(sim, abs)) fail(`bash: cd: ${t}: the simulator keeps .git closed — git manages it for you`);
    if (!sim.vfs.isDir(abs)) fail(`bash: cd: ${t}: ${sim.vfs.isFile(abs) ? 'Not a directory' : 'No such file or directory'}`);
    sim.vfs.cwd = abs;
    return '';
  },

  ls(sim, args) {
    const { flags, rest } = splitFlags(args);
    const all = flags.has('a') || flags.has('A');
    const perLine = flags.has('l') || flags.has('1');
    const targets = rest.length ? rest : ['.'];
    const fileNames = [];
    const dirBlocks = [];
    const errors = [];
    for (const t of targets) {
      const abs = sim.vfs.resolve(t);
      if (sim.vfs.isFile(abs)) {
        fileNames.push(t);
        continue;
      }
      if (!sim.vfs.isDir(abs)) {
        errors.push(`ls: cannot access '${t}': No such file or directory`);
        continue;
      }
      let entries = sim.vfs.list(abs);
      if (sim.repos.has(abs)) entries.push({ name: '.git', dir: true });
      if (!all) entries = entries.filter((e) => !e.name.startsWith('.'));
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const names = entries.map((e) => (e.dir ? c.bold(c.blue(e.name + '/')) : e.name));
      dirBlocks.push({ t, text: names.join(perLine ? '\n' : '  ') });
    }
    const sep = perLine ? '\n' : '  ';
    const parts = [];
    if (fileNames.length) parts.push(fileNames.join(sep));
    const many = targets.length > 1;
    for (const b of dirBlocks) parts.push(many ? `${b.t}:\n${b.text}` : b.text);
    const out = parts.join(many ? '\n\n' : '\n');
    if (errors.length) fail([...errors, out].filter(Boolean).join('\n'));
    return out;
  },

  mkdir(sim, args) {
    const { flags, rest } = splitFlags(args);
    if (!rest.length) fail('mkdir: missing operand');
    for (const n of rest) {
      const abs = sim.vfs.resolve(n);
      if (sim.vfs.exists(abs)) {
        if (!flags.has('p')) fail(`mkdir: cannot create directory '${n}': File exists`);
        continue;
      }
      if (!sim.vfs.isDir(VFS.parent(abs)) && !flags.has('p')) {
        fail(`mkdir: cannot create directory '${n}': No such file or directory`);
      }
      sim.vfs.mkdirp(abs);
    }
    return '';
  },

  touch(sim, args) {
    if (!args.length) fail('touch: missing file operand');
    for (const n of args) {
      const abs = sim.vfs.resolve(n);
      if (sim.vfs.exists(abs)) continue;
      if (!sim.vfs.isDir(VFS.parent(abs))) fail(`touch: cannot touch '${n}': No such file or directory`);
      sim.vfs.writeFile(abs, '');
    }
    return '';
  },

  cat(sim, args) {
    if (!args.length) fail('cat: missing file operand (the simulator cannot read from the keyboard)');
    let out = '';
    for (const n of args) {
      const abs = sim.vfs.resolve(n);
      if (sim.vfs.isDir(abs) || isGitDir(sim, abs)) fail(`${out}cat: ${n}: Is a directory`);
      if (!sim.vfs.isFile(abs)) fail(`${out}cat: ${n}: No such file or directory`);
      out += sim.vfs.readFile(abs);
    }
    return out;
  },

  echo(sim, args) {
    let newline = true;
    let escapes = false;
    while (args.length && /^-[ne]+$/.test(args[0])) {
      if (args[0].includes('n')) newline = false;
      if (args[0].includes('e')) escapes = true;
      args = args.slice(1);
    }
    let text = args.join(' ');
    if (escapes) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    return newline ? text + '\n' : text;
  },

  rm(sim, args) {
    const { flags, rest } = splitFlags(args);
    const recursive = flags.has('r') || flags.has('R') || flags.has('--recursive');
    const force = flags.has('f') || flags.has('--force');
    if (!rest.length) fail('rm: missing operand');
    for (const t of rest) {
      const abs = sim.vfs.resolve(t);
      if (isGitDir(sim, abs)) {
        if (!recursive) fail(`rm: cannot remove '${t}': Is a directory`);
        sim.repos.delete(VFS.parent(abs));
        continue;
      }
      if (sim.vfs.isFile(abs)) sim.vfs.removeFile(abs);
      else if (sim.vfs.isDir(abs)) {
        if (!recursive) fail(`rm: cannot remove '${t}': Is a directory`);
        if (abs === '/' || abs === sim.vfs.home || sim.vfs.home.startsWith(abs + '/')) {
          fail(`rm: refusing to remove '${t}' (the simulator protects your home folder)`);
        }
        sim.vfs.removeTree(abs);
        dropReposUnder(sim, abs);
      } else if (!force) fail(`rm: cannot remove '${t}': No such file or directory`);
    }
    return fixCwd(sim);
  },

  mv(sim, args) {
    const { rest } = splitFlags(args);
    if (rest.length < 2) fail(`mv: missing destination file operand after '${rest[0] || ''}'`);
    const [src, dst] = rest;
    const sAbs = sim.vfs.resolve(src);
    if (!sim.vfs.exists(sAbs)) fail(`mv: cannot stat '${src}': No such file or directory`);
    let dAbs = sim.vfs.resolve(dst);
    if (sim.vfs.isDir(dAbs)) dAbs = VFS.join(dAbs, VFS.basename(sAbs));
    if (!sim.vfs.isDir(VFS.parent(dAbs))) fail(`mv: cannot move '${src}' to '${dst}': No such file or directory`);
    if (dAbs === sAbs) return '';
    if (sim.vfs.isDir(sAbs) && (dAbs + '/').startsWith(sAbs + '/')) {
      fail(`mv: cannot move '${src}' to a subdirectory of itself, '${dst}'`);
    }
    if (sim.vfs.isDir(dAbs)) fail(`mv: cannot overwrite directory '${dst}'`);
    if (sim.vfs.isFile(sAbs)) {
      sim.vfs.writeFile(dAbs, sim.vfs.readFile(sAbs));
      sim.vfs.removeFile(sAbs);
      return '';
    }
    sim.vfs.moveTree(sAbs, dAbs);
    for (const [root, repo] of [...sim.repos]) {
      if (root === sAbs || root.startsWith(sAbs + '/')) {
        sim.repos.delete(root);
        repo.root = dAbs + root.slice(sAbs.length);
        sim.repos.set(repo.root, repo);
      }
    }
    if (sim.vfs.cwd === sAbs || sim.vfs.cwd.startsWith(sAbs + '/')) sim.vfs.cwd = dAbs + sim.vfs.cwd.slice(sAbs.length);
    return '';
  },

  cp(sim, args) {
    const { flags, rest } = splitFlags(args);
    if (rest.length < 2) fail(`cp: missing destination file operand after '${rest[0] || ''}'`);
    const [src, dst] = rest;
    const sAbs = sim.vfs.resolve(src);
    if (!sim.vfs.exists(sAbs)) fail(`cp: cannot stat '${src}': No such file or directory`);
    let dAbs = sim.vfs.resolve(dst);
    if (sim.vfs.isDir(dAbs)) dAbs = VFS.join(dAbs, VFS.basename(sAbs));
    if (!sim.vfs.isDir(VFS.parent(dAbs))) fail(`cp: cannot create '${dst}': No such file or directory`);
    if (sim.vfs.isFile(sAbs)) {
      sim.vfs.writeFile(dAbs, sim.vfs.readFile(sAbs));
      return '';
    }
    if (!flags.has('r') && !flags.has('R')) fail(`cp: -r not specified; omitting directory '${src}'`);
    if ((dAbs + '/').startsWith(sAbs + '/')) fail(`cp: cannot copy a directory, '${src}', into itself`);
    sim.vfs.mkdirp(dAbs);
    for (const d of [...sim.vfs.dirs]) if (d.startsWith(sAbs + '/')) sim.vfs.mkdirp(dAbs + d.slice(sAbs.length));
    for (const f of sim.vfs.filesUnder(sAbs)) sim.vfs.writeFile(dAbs + f.slice(sAbs.length), sim.vfs.readFile(f));
    return '';
  },

  tree(sim, args) {
    const { flags, rest } = splitFlags(args);
    const root = sim.vfs.resolve(rest[0]);
    if (!sim.vfs.isDir(root)) fail(`tree: '${rest[0]}': No such directory`);
    const lines = [c.bold(c.blue(rest[0] || '.'))];
    let dirs = 0;
    let files = 0;
    const walk = (dir, prefix) => {
      const entries = sim.vfs.list(dir).filter((e) => flags.has('a') || !e.name.startsWith('.'));
      entries.forEach((e, i) => {
        const last = i === entries.length - 1;
        lines.push(`${prefix}${last ? c.sym('elbow') : c.sym('tee')}${e.dir ? c.bold(c.blue(e.name + '/')) : e.name}`);
        if (e.dir) {
          dirs++;
          walk(VFS.join(dir, e.name), prefix + (last ? '    ' : c.sym('pipe')));
        } else files++;
      });
    };
    walk(root, '');
    lines.push('', `${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}`);
    return lines.join('\n');
  },

  rmdir(sim, args) {
    const { rest } = splitFlags(args);
    if (!rest.length) fail('rmdir: missing operand');
    for (const t of rest) {
      const abs = sim.vfs.resolve(t);
      if (!sim.vfs.isDir(abs)) fail(`rmdir: failed to remove '${t}': ${sim.vfs.isFile(abs) ? 'Not a directory' : 'No such file or directory'}`);
      if (sim.vfs.list(abs).length || sim.repos.has(abs)) fail(`rmdir: failed to remove '${t}': Directory not empty`);
      if (abs === sim.vfs.home || abs === '/') fail(`rmdir: refusing to remove '${t}'`);
      sim.vfs.dirs.delete(abs);
    }
    return fixCwd(sim);
  },

  clear: () => '\x1b[2J\x1b[H',
};

// Windows Command Prompt / PowerShell habits -> the bash command taught here.
const WINDOWS_ALIASES = {
  dir: 'ls',
  cls: 'clear',
  type: 'cat',
  del: 'rm',
  erase: 'rm',
  copy: 'cp',
  move: 'mv',
  ren: 'mv',
  md: 'mkdir',
  rd: 'rmdir',
};

for (const editor of ['nano', 'vim', 'vi', 'emacs', 'code', 'notepad', 'gedit']) {
  builtins[editor] = () =>
    fail(
      `${editor}: there is no text editor in the simulator.\n` +
        'Write files with echo instead:\n' +
        '  echo "first line" > file.txt     # create / overwrite\n' +
        '  echo "another line" >> file.txt  # append',
    );
}

module.exports = { builtins, parseCommand, splitChain, ShellError, WINDOWS_ALIASES };
