'use strict';

// In-memory file system. Paths are absolute POSIX-style strings.
// Files map path -> string content; dirs is a set of directory paths.
class VFS {
  constructor(home = '/home/student') {
    this.home = home;
    this.files = new Map();
    this.dirs = new Set(['/']);
    this.mkdirp(home);
    this.cwd = home;
  }

  static parent(abs) {
    if (abs === '/') return '/';
    const i = abs.lastIndexOf('/');
    return i <= 0 ? '/' : abs.slice(0, i);
  }

  static basename(abs) {
    return abs.slice(abs.lastIndexOf('/') + 1);
  }

  static join(dir, name) {
    return dir === '/' ? `/${name}` : `${dir}/${name}`;
  }

  resolve(p) {
    if (p === undefined || p === '') return this.cwd;
    if (p === '~' || p.startsWith('~/')) p = this.home + p.slice(1);
    const abs = p.startsWith('/') ? p : `${this.cwd}/${p}`;
    const parts = [];
    for (const seg of abs.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  isDir(abs) {
    return this.dirs.has(abs);
  }

  isFile(abs) {
    return this.files.has(abs);
  }

  exists(abs) {
    return this.isDir(abs) || this.isFile(abs);
  }

  mkdirp(abs) {
    let cur = '';
    for (const part of abs.split('/').filter(Boolean)) {
      cur += '/' + part;
      if (this.files.has(cur)) throw new Error(`${cur}: Not a directory`);
      this.dirs.add(cur);
    }
  }

  writeFile(abs, content) {
    if (this.isDir(abs)) throw new Error(`${this.display(abs)}: Is a directory`);
    this.mkdirp(VFS.parent(abs));
    this.files.set(abs, content);
  }

  readFile(abs) {
    return this.files.get(abs);
  }

  removeFile(abs) {
    this.files.delete(abs);
  }

  removeTree(abs) {
    const prefix = abs + '/';
    for (const f of [...this.files.keys()]) if (f === abs || f.startsWith(prefix)) this.files.delete(f);
    for (const d of [...this.dirs]) if (d === abs || d.startsWith(prefix)) this.dirs.delete(d);
  }

  // Rename a file or directory tree from src to dst.
  moveTree(src, dst) {
    const remap = (p) => (p === src ? dst : dst + p.slice(src.length));
    const prefix = src + '/';
    for (const f of [...this.files.keys()]) {
      if (f === src || f.startsWith(prefix)) {
        const content = this.files.get(f);
        this.files.delete(f);
        this.files.set(remap(f), content);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === src || d.startsWith(prefix)) {
        this.dirs.delete(d);
        this.dirs.add(remap(d));
      }
    }
    this.mkdirp(VFS.parent(dst));
  }

  list(abs) {
    const out = [];
    for (const d of this.dirs) if (d !== abs && d !== '/' && VFS.parent(d) === abs) out.push({ name: VFS.basename(d), dir: true });
    for (const f of this.files.keys()) if (VFS.parent(f) === abs) out.push({ name: VFS.basename(f), dir: false });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  filesUnder(abs) {
    const prefix = abs === '/' ? '/' : abs + '/';
    return [...this.files.keys()].filter((f) => f.startsWith(prefix)).sort();
  }

  display(abs) {
    if (abs === this.home) return '~';
    if (abs.startsWith(this.home + '/')) return '~' + abs.slice(this.home.length);
    return abs;
  }
}

module.exports = { VFS };
