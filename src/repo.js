'use strict';
const { VFS } = require('./vfs');

class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitError';
  }
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// One git repository. The working tree lives in the simulator's VFS under `root`;
// everything that would be inside .git (refs, index, config) is kept here.
class Repo {
  constructor(sim, root, initialBranch = 'main') {
    this.sim = sim;
    this.root = root;
    this.branches = {}; // name -> commit hash
    this.head = { type: 'branch', name: initialBranch }; // or { type: 'detached', hash }
    this.index = {}; // staging area: path -> blob hash
    this.remotes = {}; // name -> url
    this.remoteRefs = {}; // 'origin/main' -> commit hash
    this.upstream = {}; // local branch -> { remote, branch }
    this.merging = null; // { hash, conflicts: Set, message, label }
    this.stashes = [];
    this.previousHead = null;
  }

  get vfs() {
    return this.sim.vfs;
  }

  get store() {
    return this.sim.store;
  }

  get headHash() {
    return this.head.type === 'branch' ? this.branches[this.head.name] || null : this.head.hash;
  }

  get currentBranch() {
    return this.head.type === 'branch' ? this.head.name : null;
  }

  setHead(hash) {
    if (this.head.type === 'branch') this.branches[this.head.name] = hash;
    else this.head.hash = hash;
  }

  commit(hash) {
    return hash ? this.store.commit(hash) : null;
  }

  treeOf(hash) {
    const cm = this.commit(hash);
    return cm ? cm.tree : {};
  }

  headTree() {
    return this.treeOf(this.headHash);
  }

  subject(hash) {
    return this.commit(hash).message.split('\n')[0];
  }

  abs(rel) {
    if (!rel) return this.root;
    return this.root === '/' ? `/${rel}` : `${this.root}/${rel}`;
  }

  rel(abs) {
    if (abs === this.root) return '';
    return abs.slice(this.root === '/' ? 1 : this.root.length + 1);
  }

  contains(abs) {
    return abs === this.root || abs.startsWith(this.root === '/' ? '/' : this.root + '/');
  }

  // All files in the working tree (path relative to root -> content),
  // skipping any other repositories nested inside this one.
  working() {
    const nested = [...this.sim.repos.keys()].filter((r) => r !== this.root && this.contains(r));
    const out = {};
    for (const f of this.vfs.filesUnder(this.root)) {
      if (nested.some((n) => f.startsWith(n + '/'))) continue;
      out[this.rel(f)] = this.vfs.readFile(f);
    }
    return out;
  }

  writeWorking(rel, content) {
    this.vfs.writeFile(this.abs(rel), content);
  }

  deleteWorking(rel) {
    const abs = this.abs(rel);
    this.vfs.removeFile(abs);
    // Like git, remove directories that became empty (but never the cwd).
    let dir = VFS.parent(abs);
    const cwd = this.vfs.cwd;
    while (
      dir !== this.root &&
      this.contains(dir) &&
      this.vfs.isDir(dir) &&
      this.vfs.list(dir).length === 0 &&
      !(cwd === dir || cwd.startsWith(dir + '/'))
    ) {
      this.vfs.dirs.delete(dir);
      dir = VFS.parent(dir);
    }
  }

  ignorePatterns() {
    const txt = this.vfs.readFile(this.abs('.gitignore'));
    if (!txt) return [];
    return txt
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  }

  isIgnored(rel) {
    const parts = rel.split('/');
    return this.ignorePatterns().some((pat) => {
      const dirOnly = pat.endsWith('/');
      const p = pat.replace(/^\//, '').replace(/\/$/, '');
      const re = new RegExp('^' + p.split('*').map(escapeRe).join('[^/]*') + '$');
      if (p.includes('/')) return re.test(rel) || rel.startsWith(p + '/');
      if (dirOnly) return parts.slice(0, -1).some((seg) => re.test(seg));
      return parts.some((seg) => re.test(seg));
    });
  }

  ancestors(hash) {
    const seen = new Set();
    const stack = hash ? [hash] : [];
    while (stack.length) {
      const h = stack.pop();
      if (seen.has(h)) continue;
      seen.add(h);
      stack.push(...this.store.commit(h).parents);
    }
    return seen;
  }

  isAncestor(a, b) {
    return Boolean(a && b) && this.ancestors(b).has(a);
  }

  mergeBase(a, b) {
    const A = this.ancestors(a);
    let best = null;
    for (const h of this.ancestors(b)) {
      if (A.has(h) && (!best || this.store.commit(h).seq > this.store.commit(best).seq)) best = h;
    }
    return best;
  }

  // Resolve HEAD, branch names, origin/main, hash prefixes, and ~N / ^N suffixes.
  resolve(rev) {
    if (!rev) return null;
    const m = /^(.*?)((?:[~^]\d*)*)$/.exec(rev);
    const base = m[1];
    let h = null;
    if (base === 'HEAD' || base === '@') h = this.headHash;
    else if (this.branches[base]) h = this.branches[base];
    else if (this.remoteRefs[base]) h = this.remoteRefs[base];
    else if (base.startsWith('remotes/') && this.remoteRefs[base.slice(8)]) h = this.remoteRefs[base.slice(8)];
    else if (/^[0-9a-f]{4,40}$/.test(base)) {
      const hits = this.store.commitsByPrefix(base);
      if (hits.length === 1) h = hits[0];
    }
    if (!h) return null;
    for (const tok of m[2].match(/[~^]\d*/g) || []) {
      const n = tok.length > 1 ? Number(tok.slice(1)) : 1;
      if (tok[0] === '~') {
        for (let i = 0; i < n; i++) {
          const cm = this.store.commit(h);
          if (!cm.parents.length) return null;
          h = cm.parents[0];
        }
      } else if (n > 0) {
        const cm = this.store.commit(h);
        if (!cm.parents[n - 1]) return null;
        h = cm.parents[n - 1];
      }
    }
    return h;
  }

  // Three-way comparison of HEAD, index and working tree.
  status() {
    const head = this.headTree();
    const idx = this.index;
    const work = this.working();
    const conflicts = this.merging ? this.merging.conflicts : new Set();
    const keys = (...objs) => [...new Set(objs.flatMap((o) => Object.keys(o)))].sort();

    const staged = [];
    for (const p of keys(head, idx)) {
      if (conflicts.has(p)) continue;
      if (!(p in head)) staged.push(['new file', p]);
      else if (!(p in idx)) staged.push(['deleted', p]);
      else if (head[p] !== idx[p]) staged.push(['modified', p]);
    }

    const unstaged = [];
    for (const p of Object.keys(idx).sort()) {
      if (conflicts.has(p)) continue;
      if (!(p in work)) unstaged.push(['deleted', p]);
      else if (this.store.hashBlob(work[p]) !== idx[p]) unstaged.push(['modified', p]);
    }

    const untracked = [];
    for (const p of Object.keys(work).sort()) {
      if (p in idx || conflicts.has(p) || this.isIgnored(p)) continue;
      const top = p.split('/')[0];
      const shown = p.includes('/') && !Object.keys(idx).some((q) => q.startsWith(top + '/')) ? top + '/' : p;
      if (!untracked.includes(shown)) untracked.push(shown);
    }

    return { staged, unstaged, untracked, unmerged: [...conflicts].sort() };
  }
}

module.exports = { Repo, GitError };
