'use strict';
const c = require('./colors');
const { VFS } = require('./vfs');
const { Repo, GitError } = require('./repo');
const { unifiedDiff, countChanges, merge3 } = require('./diff');

// ---------------------------------------------------------------- helpers

const short = (h) => (h ? h.slice(0, 7) : '0000000');
const fail = (msg) => {
  throw new GitError(msg);
};
const fatal = (msg) => fail(`fatal: ${msg}`);
const union = (...objs) => [...new Set(objs.flatMap((o) => Object.keys(o)))].sort();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const under = (p, prefix) => prefix === '' || p === prefix || p.startsWith(prefix + '/');
const mapContent = (store, tree) => Object.fromEntries(Object.entries(tree).map(([p, h]) => [p, store.content(h)]));

function needRepo(sim) {
  const repo = sim.findRepo();
  if (!repo) fatal('not a git repository (or any of the parent directories): .git');
  return repo;
}

function toRel(sim, repo, spec) {
  const abs = sim.vfs.resolve(spec);
  if (!repo.contains(abs)) fatal(`${spec}: '${spec}' is outside repository at '${repo.root}'`);
  return repo.rel(abs);
}

function resolveOrFatal(repo, rev) {
  const h = repo.resolve(rev);
  if (!h) {
    if ((rev === 'HEAD' || rev === '@') && !repo.headHash) {
      fatal(`your current branch '${repo.currentBranch}' does not have any commits yet`);
    }
    fatal(
      `ambiguous argument '${rev}': unknown revision or path not in the working tree.\n` +
        "Use '--' to separate paths from revisions, like this:\n" +
        "'git <command> [<revision>...] -- [<file>...]'",
    );
  }
  return h;
}

function formatDate(ms) {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const ao = Math.abs(off);
  const tz = `${off >= 0 ? '+' : '-'}${pad(Math.floor(ao / 60))}${pad(ao % 60)}`;
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()} ${tz}`;
}

function requireIdentity(sim) {
  const name = sim.config['user.name'];
  const email = sim.config['user.email'];
  if (!name || !email) {
    fail(
      'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n' +
        '  git config --global user.email "you@example.com"\n' +
        '  git config --global user.name "Your Name"\n\n' +
        "to set your account's default identity.\n\nfatal: unable to auto-detect email address",
    );
  }
  return { name, email };
}

function diffStat(store, a, b) {
  let files = 0;
  let ins = 0;
  let del = 0;
  const modes = [];
  for (const p of union(a, b)) {
    if (a[p] === b[p]) continue;
    files++;
    const r = countChanges(store.content(a[p]) ?? '', store.content(b[p]) ?? '');
    ins += r.ins;
    del += r.del;
    if (a[p] === undefined) modes.push(` create mode 100644 ${p}`);
    else if (b[p] === undefined) modes.push(` delete mode 100644 ${p}`);
  }
  let line = ` ${plural(files, 'file')} changed`;
  if (ins) line += `, ${plural(ins, 'insertion')}(+)`;
  if (del) line += `, ${plural(del, 'deletion')}(-)`;
  return [line, ...modes].join('\n');
}

function makeCommit(sim, repo, message, parents, tree) {
  const who = requireIdentity(sim);
  const sorted = {};
  for (const k of Object.keys(tree).sort()) sorted[k] = tree[k];
  const hash = sim.store.put({
    type: 'commit',
    tree: sorted,
    parents,
    message,
    author: who.name,
    email: who.email,
    date: sim.now(),
    seq: sim.nextSeq(),
  });
  const prevTree = parents.length ? repo.treeOf(parents[0]) : {};
  repo.setHead(hash);
  const label = repo.currentBranch || 'detached HEAD';
  const root = parents.length === 0 ? ' (root-commit)' : '';
  return {
    hash,
    output: `[${label}${root} ${short(hash)}] ${message.split('\n')[0]}\n${diffStat(sim.store, prevTree, sorted)}`,
  };
}

function decorate(repo, hash) {
  const labels = [];
  if (repo.head.type === 'detached' && repo.head.hash === hash) labels.push(c.bold(c.cyan('HEAD')));
  const cur = repo.currentBranch;
  if (cur && repo.branches[cur] === hash) labels.push(`${c.bold(c.cyan('HEAD ->'))} ${c.bold(c.green(cur))}`);
  for (const b of Object.keys(repo.branches).sort()) {
    if (b !== cur && repo.branches[b] === hash) labels.push(c.bold(c.green(b)));
  }
  for (const r of Object.keys(repo.remoteRefs).sort()) {
    if (repo.remoteRefs[r] === hash) labels.push(c.bold(c.red(r)));
  }
  return labels.length ? `${c.yellow('(')}${labels.join(c.yellow(', '))}${c.yellow(')')}` : '';
}

function formatCommitLong(repo, hash) {
  const cm = repo.commit(hash);
  const deco = decorate(repo, hash);
  const lines = [c.yellow(`commit ${hash}`) + (deco ? ' ' + deco : '')];
  if (cm.parents.length > 1) lines.push(`Merge: ${cm.parents.map(short).join(' ')}`);
  lines.push(`Author: ${cm.author} <${cm.email}>`, `Date:   ${formatDate(cm.date)}`, '');
  lines.push(...cm.message.split('\n').map((l) => (l ? '    ' + l : '')));
  return lines.join('\n');
}

function treeDiff(store, a, b, prefixes = []) {
  const A = mapContent(store, a);
  const B = mapContent(store, b);
  return contentDiff(A, B, prefixes);
}

function contentDiff(A, B, prefixes = []) {
  return union(A, B)
    .filter((p) => A[p] !== B[p] && (!prefixes.length || prefixes.some((pr) => under(p, pr))))
    .map((p) => unifiedDiff(p, A[p], B[p]))
    .join('\n');
}

function trackingInfo(repo) {
  const b = repo.currentBranch;
  const up = b && repo.upstream[b];
  const local = b && repo.branches[b];
  if (!up || !local) return null;
  const ref = `${up.remote}/${up.branch}`;
  const remote = repo.remoteRefs[ref];
  if (!remote) {
    return `Your branch is based on '${ref}', but the upstream is gone.\n  (use "git branch --unset-upstream" to fixup)`;
  }
  const la = repo.ancestors(local);
  const ra = repo.ancestors(remote);
  const ahead = [...la].filter((h) => !ra.has(h)).length;
  const behind = [...ra].filter((h) => !la.has(h)).length;
  if (!ahead && !behind) return `Your branch is up to date with '${ref}'.`;
  if (ahead && !behind) {
    return `Your branch is ahead of '${ref}' by ${plural(ahead, 'commit')}.\n  (use "git push" to publish your local commits)`;
  }
  if (behind && !ahead) {
    return `Your branch is behind '${ref}' by ${plural(behind, 'commit')}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)`;
  }
  return (
    `Your branch and '${ref}' have diverged,\nand have ${ahead} and ${behind} different commits each, respectively.\n` +
    '  (use "git pull" if you want to integrate the remote branch with yours)'
  );
}

function dirtyPaths(repo) {
  const st = repo.status();
  return [...new Set([...st.staged, ...st.unstaged].map((x) => x[1]))];
}

// Update index + working tree from the current HEAD tree to the target commit's tree,
// keeping (and refusing to clobber) local changes, like `git switch`.
function switchTree(sim, repo, targetHash, verb = 'checkout') {
  if (repo.merging && repo.merging.conflicts.size) {
    fail(
      `error: you need to resolve your current index first\n${[...repo.merging.conflicts]
        .map((p) => `${p}: needs merge`)
        .join('\n')}`,
    );
  }
  const store = sim.store;
  const cur = repo.headTree();
  const tgt = repo.treeOf(targetHash);
  const work = repo.working();
  const idx = repo.index;
  const dirty = [];
  const untracked = [];
  for (const p of union(cur, tgt)) {
    if (cur[p] === tgt[p]) continue;
    const w = p in work ? store.hashBlob(work[p]) : undefined;
    if (!(p in cur) && !(p in idx) && p in work) {
      if (w !== tgt[p]) untracked.push(p);
      continue;
    }
    const clean = idx[p] === cur[p] && w === cur[p];
    const already = idx[p] === tgt[p] && w === tgt[p];
    if (!clean && !already) dirty.push(p);
  }
  const action = verb === 'merge' ? 'merge' : 'switch branches';
  if (dirty.length) {
    fail(
      `error: Your local changes to the following files would be overwritten by ${verb}:\n` +
        dirty.map((p) => `\t${p}`).join('\n') +
        `\nPlease commit your changes or stash them before you ${action}.\nAborting`,
    );
  }
  if (untracked.length) {
    fail(
      `error: The following untracked working tree files would be overwritten by ${verb}:\n` +
        untracked.map((p) => `\t${p}`).join('\n') +
        `\nPlease move or remove them before you ${action}.\nAborting`,
    );
  }
  for (const p of union(cur, tgt)) {
    if (cur[p] === tgt[p]) continue;
    if (p in tgt) {
      repo.writeWorking(p, store.content(tgt[p]));
      idx[p] = tgt[p];
    } else {
      if (p in work) repo.deleteWorking(p);
      delete idx[p];
    }
  }
}

function carriedChanges(repo) {
  const st = repo.status();
  const code = { 'new file': 'A', modified: 'M', deleted: 'D' };
  const lines = new Map();
  for (const [t, p] of [...st.staged, ...st.unstaged]) if (!lines.has(p)) lines.set(p, `${code[t]}\t${p}`);
  return [...lines.values()];
}

function afterSwitch(repo, firstLine) {
  const out = [...carriedChanges(repo), firstLine];
  const info = trackingInfo(repo);
  if (info) out.push(info);
  return out.join('\n');
}

function validateBranchName(n) {
  if (
    !/^[A-Za-z0-9._/-]+$/.test(n) ||
    n.startsWith('-') ||
    n.startsWith('/') ||
    n.endsWith('/') ||
    n.endsWith('.') ||
    n.endsWith('.lock') ||
    n.includes('..') ||
    n.includes('//') ||
    n === 'HEAD'
  ) {
    fatal(`'${n}' is not a valid branch name`);
  }
}

function rememberHead(repo) {
  repo.previousHead = { ...repo.head };
}

function switchBranch(sim, repo, name, verb) {
  if (repo.currentBranch === name) return afterSwitch(repo, `Already on '${name}'`);
  switchTree(sim, repo, repo.branches[name], verb);
  rememberHead(repo);
  repo.head = { type: 'branch', name };
  return afterSwitch(repo, `Switched to branch '${name}'`);
}

function createAndSwitch(sim, repo, name, start, force, verb) {
  validateBranchName(name);
  if (repo.branches[name] && !force) fatal(`a branch named '${name}' already exists`);
  const h = start ? resolveOrFatal(repo, start) : repo.headHash;
  if (h) switchTree(sim, repo, h, verb);
  rememberHead(repo);
  if (h) repo.branches[name] = h;
  repo.head = { type: 'branch', name };
  const out = [];
  if (start && repo.remoteRefs[start]) {
    const [remote, ...rest] = start.split('/');
    repo.upstream[name] = { remote, branch: rest.join('/') };
    out.push(`branch '${name}' set up to track '${start}'.`);
  }
  out.push(`Switched to a new branch '${name}'`);
  return [...carriedChanges(repo), ...out].join('\n');
}

function detach(sim, repo, h, label) {
  switchTree(sim, repo, h, 'checkout');
  rememberHead(repo);
  repo.head = { type: 'detached', hash: h };
  return (
    `Note: switching to '${label}'.\n\n` +
    "You are in 'detached HEAD' state. You can look around, make experimental\n" +
    'changes and commit them, and you can discard any commits you make in this\n' +
    'state without impacting any branches by switching back to a branch.\n\n' +
    'If you want to create a new branch to retain commits you create, you may\n' +
    'do so (now or later) by using -c with the switch command. Example:\n\n' +
    '  git switch -c <new-branch-name>\n\n' +
    'Or undo this operation with:\n\n  git switch -\n\n' +
    `HEAD is now at ${short(h)} ${repo.subject(h)}`
  );
}

function switchToPrevious(sim, repo, verb) {
  const prev = repo.previousHead;
  if (!prev) fatal('invalid reference: @{-1}');
  if (prev.type === 'branch') return switchBranch(sim, repo, prev.name, verb);
  return detach(sim, repo, prev.hash, short(prev.hash));
}

function guessRemote(repo, name) {
  const hits = Object.keys(repo.remoteRefs).filter((r) => r.split('/').slice(1).join('/') === name);
  return hits.length === 1 ? hits[0] : null;
}

function restorePaths(sim, repo, specs, src, updateIndex) {
  if (!specs.length) fatal('you must specify path(s) to restore');
  let n = 0;
  for (const spec of specs) {
    const prefix = toRel(sim, repo, spec);
    const hits = Object.keys(src).filter((p) => under(p, prefix));
    if (!hits.length) fail(`error: pathspec '${spec}' did not match any file(s) known to git`);
    for (const p of hits) {
      repo.writeWorking(p, sim.store.content(src[p]));
      if (updateIndex) repo.index[p] = src[p];
      n++;
    }
  }
  return n;
}

function threeWay(sim, baseT, oursT, theirsT, theirsLabel) {
  const store = sim.store;
  const tree = {};
  const conflicts = [];
  const notes = [];
  for (const p of union(baseT, oursT, theirsT)) {
    const b = baseT[p];
    const o = oursT[p];
    const t = theirsT[p];
    let r;
    if (o === t) r = o;
    else if (b === o) r = t;
    else if (b === t) r = o;
    else if (o !== undefined && t !== undefined) {
      notes.push(`Auto-merging ${p}`);
      const m = merge3(b !== undefined ? store.content(b) : '', store.content(o), store.content(t), 'HEAD', theirsLabel);
      if (m.clean) r = store.blob(m.text);
      else {
        const kind = b === undefined ? 'add/add' : 'content';
        notes.push(`CONFLICT (${kind}): Merge conflict in ${p}`);
        conflicts.push({ path: p, content: m.text });
        r = o;
      }
    } else {
      const deletedIn = o === undefined ? 'HEAD' : theirsLabel;
      const keptIn = o === undefined ? theirsLabel : 'HEAD';
      notes.push(
        `CONFLICT (modify/delete): ${p} deleted in ${deletedIn} and modified in ${keptIn}.  Version ${keptIn} of ${p} left in tree.`,
      );
      conflicts.push({ path: p, content: store.content(o === undefined ? t : o) });
      r = o;
    }
    if (r !== undefined) tree[p] = r;
  }
  return { tree, conflicts, notes };
}

function applyMerge(sim, repo, result) {
  const ours = repo.headTree();
  const work = repo.working();
  for (const p of union(ours, result.tree)) {
    if (ours[p] === result.tree[p]) continue;
    if (p in result.tree) {
      repo.writeWorking(p, sim.store.content(result.tree[p]));
      repo.index[p] = result.tree[p];
    } else {
      if (p in work) repo.deleteWorking(p);
      delete repo.index[p];
    }
  }
  for (const cf of result.conflicts) repo.writeWorking(cf.path, cf.content);
}

function doMerge(sim, repo, rev, { noFF = false, message = null } = {}) {
  const theirs = repo.resolve(rev);
  if (!theirs) fail(`merge: ${rev} - not something we can merge`);
  if (repo.merging) {
    fatal('You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.');
  }
  const ours = repo.headHash;
  if (!ours) {
    switchTree(sim, repo, theirs, 'merge');
    repo.setHead(theirs);
    return `Fast-forward`;
  }
  if (repo.isAncestor(theirs, ours)) return 'Already up to date.';
  const dirty = dirtyPaths(repo);
  if (dirty.length) {
    fail(
      'error: Your local changes to the following files would be overwritten by merge:\n' +
        dirty.map((p) => `\t${p}`).join('\n') +
        '\nPlease commit your changes or stash them before you merge.\nAborting',
    );
  }
  if (!noFF && repo.isAncestor(ours, theirs)) {
    switchTree(sim, repo, theirs, 'merge');
    repo.setHead(theirs);
    return `Updating ${short(ours)}..${short(theirs)}\nFast-forward\n${diffStat(sim.store, repo.treeOf(ours), repo.treeOf(theirs))}`;
  }
  const base = repo.mergeBase(ours, theirs);
  if (!base) fatal('refusing to merge unrelated histories');
  const res = threeWay(sim, repo.treeOf(base), repo.treeOf(ours), repo.treeOf(theirs), rev);
  let msg = message;
  if (!msg) {
    msg = repo.remoteRefs[rev] ? `Merge remote-tracking branch '${rev}'` : `Merge branch '${rev}'`;
    const cur = repo.currentBranch;
    if (cur && cur !== 'main' && cur !== 'master') msg += ` into ${cur}`;
  }
  if (!res.conflicts.length) requireIdentity(sim);
  applyMerge(sim, repo, res);
  if (res.conflicts.length) {
    repo.merging = { hash: theirs, conflicts: new Set(res.conflicts.map((x) => x.path)), message: msg };
    fail([...res.notes, 'Automatic merge failed; fix conflicts and then commit the result.'].join('\n'));
  }
  makeCommit(sim, repo, msg, [ours, theirs], { ...repo.index });
  return [...res.notes, "Merge made by the 'ort' strategy.", diffStat(sim.store, repo.treeOf(ours), repo.headTree())].join(
    '\n',
  );
}

function statusLong(repo) {
  const st = repo.status();
  const lines = [];
  if (repo.currentBranch) lines.push(`On branch ${repo.currentBranch}`);
  else lines.push(c.red(`HEAD detached at ${short(repo.headHash)}`));
  const info = trackingInfo(repo);
  if (info) lines.push(info);
  if (!repo.headHash) lines.push('', 'No commits yet');
  if (repo.merging) {
    if (st.unmerged.length) {
      lines.push(
        'You have unmerged paths.',
        '  (fix conflicts and run "git commit")',
        '  (use "git merge --abort" to abort the merge)',
      );
    } else {
      lines.push('All conflicts fixed but you are still merging.', '  (use "git commit" to conclude merge)');
    }
  }
  const label = (t) => `${t}:`.padEnd(12);
  if (st.staged.length) {
    // Pair up deleted + new file with identical content as a rename.
    const staged = [];
    const deleted = st.staged.filter(([t]) => t === 'deleted');
    const used = new Set();
    for (const [t, p] of st.staged) {
      if (t === 'new file') {
        const twin = deleted.find(([, d]) => !used.has(d) && repo.headTree()[d] === repo.index[p]);
        if (twin) {
          used.add(twin[1]);
          staged.push(`renamed:    ${twin[1]} -> ${p}`);
          continue;
        }
      }
      staged.push([t, p]);
    }
    lines.push('', 'Changes to be committed:');
    lines.push(
      repo.headHash
        ? '  (use "git restore --staged <file>..." to unstage)'
        : '  (use "git rm --cached <file>..." to unstage)',
    );
    for (const s of staged) {
      if (Array.isArray(s)) {
        if (s[0] === 'deleted' && used.has(s[1])) continue;
        lines.push(c.green(`\t${label(s[0])}${s[1]}`));
      } else lines.push(c.green(`\t${s}`));
    }
  }
  if (st.unmerged.length) {
    lines.push('', 'Unmerged paths:', '  (use "git add <file>..." to mark resolution)');
    for (const p of st.unmerged) lines.push(c.red(`\tboth modified:   ${p}`));
  }
  if (st.unstaged.length) {
    lines.push(
      '',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
    );
    for (const [t, p] of st.unstaged) lines.push(c.red(`\t${label(t)}${p}`));
  }
  if (st.untracked.length) {
    lines.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const p of st.untracked) lines.push(c.red(`\t${p}`));
  }
  if (!st.staged.length && !st.unmerged.length) {
    lines.push('');
    if (st.unstaged.length) lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
    else if (st.untracked.length) {
      lines.push('nothing added to commit but untracked files present (use "git add" to track)');
    } else if (!repo.headHash) lines.push('nothing to commit (create/copy files and use "git add" to track)');
    else if (!repo.merging) lines.push('nothing to commit, working tree clean');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- commands

const commands = {};

commands.init = (sim, args) => {
  let branch = sim.config['init.defaultbranch'] || 'main';
  let dir;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-b' || a === '--initial-branch') branch = args[++i];
    else if (a.startsWith('--initial-branch=')) branch = a.slice(17);
    else if (a === '-q' || a === '--quiet') continue;
    else if (a.startsWith('-')) fail(`error: unknown option '${a.replace(/^-+/, '')}'`);
    else dir = a;
  }
  if (!branch) fail("error: option `initial-branch' requires a value");
  validateBranchName(branch);
  const abs = sim.vfs.resolve(dir);
  if (sim.vfs.isFile(abs)) fatal(`cannot mkdir ${dir}: File exists`);
  sim.vfs.mkdirp(abs);
  if (sim.repos.has(abs)) return `Reinitialized existing Git repository in ${abs}/.git/`;
  const outer = sim.findRepo(abs);
  sim.repos.set(abs, new Repo(sim, abs, branch));
  let out = `Initialized empty Git repository in ${abs}/.git/`;
  if (outer) {
    out += c.yellow(
      `\nhint (simulator): this folder is inside another repository (${sim.vfs.display(outer.root)}).\n` +
        'hint (simulator): repositories inside repositories are usually a mistake.',
    );
  }
  return out;
};

commands.status = (sim, args) => {
  const repo = needRepo(sim);
  if (!(args.includes('-s') || args.includes('--short'))) return statusLong(repo);
  const st = repo.status();
  const code = { 'new file': 'A', modified: 'M', deleted: 'D' };
  const map = new Map();
  for (const [t, p] of st.staged) map.set(p, [code[t], ' ']);
  for (const [t, p] of st.unstaged) {
    const e = map.get(p) || [' ', ' '];
    e[1] = code[t];
    map.set(p, e);
  }
  const lines = st.unmerged.map((p) => c.red('UU') + ' ' + p);
  for (const p of [...map.keys()].sort()) {
    const [x, y] = map.get(p);
    lines.push(`${c.green(x)}${c.red(y)} ${p}`);
  }
  for (const p of st.untracked) lines.push(c.red('??') + ' ' + p);
  return lines.join('\n');
};

commands.add = (sim, args) => {
  const repo = needRepo(sim);
  const flags = args.filter((a) => a.startsWith('-'));
  const specs = args.filter((a) => !a.startsWith('-'));
  for (const f of flags) {
    if (!['-A', '--all', '-f', '--force', '-u', '--update', '--', '-v', '--verbose'].includes(f)) {
      fail(`error: unknown option '${f.replace(/^-+/, '')}'`);
    }
  }
  const all = flags.includes('-A') || flags.includes('--all');
  const force = flags.includes('-f') || flags.includes('--force');
  const updateOnly = flags.includes('-u') || flags.includes('--update');
  if (!specs.length && !all && !updateOnly) {
    return "Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?";
  }
  const work = repo.working();
  const targets = specs.length ? specs.map((s) => ({ spec: s, prefix: toRel(sim, repo, s) })) : [{ spec: '.', prefix: '' }];
  const toStage = new Set();
  const ignored = [];
  for (const { spec, prefix } of targets) {
    const cands = union(work, repo.index).filter((p) => under(p, prefix));
    if (!cands.length) fatal(`pathspec '${spec}' did not match any files`);
    for (const p of cands) {
      const tracked = p in repo.index;
      if (!tracked && updateOnly) continue;
      if (!tracked && repo.isIgnored(p) && !force) {
        if (p === prefix) ignored.push(p);
        continue;
      }
      toStage.add(p);
    }
  }
  if (ignored.length) {
    fail(
      `The following paths are ignored by one of your .gitignore files:\n${ignored.join('\n')}\n` +
        'hint: Use -f if you really want to add them.',
    );
  }
  for (const p of toStage) {
    if (p in work) repo.index[p] = sim.store.blob(work[p]);
    else delete repo.index[p];
    if (repo.merging) repo.merging.conflicts.delete(p);
  }
  return '';
};

commands.commit = (sim, args) => {
  const repo = needRepo(sim);
  const messages = [];
  let all = false;
  let amend = false;
  let allowEmpty = false;
  const need = (v) => {
    if (v === undefined) fail("error: switch `m' requires a value");
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--amend') amend = true;
    else if (a === '--all') all = true;
    else if (a === '--allow-empty') allowEmpty = true;
    else if (a === '--no-edit') continue;
    else if (a === '--message') messages.push(need(args[++i]));
    else if (a.startsWith('--message=')) messages.push(a.slice(10));
    else if (/^-[a-zA-Z]+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'a') all = true;
        else if (ch === 'm') {
          const rest = a.slice(j + 1);
          messages.push(rest || need(args[++i]));
          break;
        } else fail(`error: unknown switch \`${ch}'`);
      }
    } else if (a.startsWith('-m')) messages.push(a.slice(2));
    else if (a.startsWith('-')) fail(`error: unknown option \`${a.replace(/^-+/, '')}'`);
    else {
      fail(
        `error: pathspec '${a}' did not match any file(s) known to git` +
          c.yellow(
            '\nhint (simulator): if this was part of your message, wrap the whole message in quotes:\n' +
              'hint (simulator):   git commit -m "Fix the login bug"',
          ),
      );
    }
  }
  requireIdentity(sim);
  if (repo.merging && repo.merging.conflicts.size) {
    fail(
      'error: Committing is not possible because you have unmerged files.\n' +
        "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
        'hint: as appropriate to mark resolution and make a commit.\n' +
        'fatal: Exiting because of an unresolved conflict.',
    );
  }
  if (all) {
    const work = repo.working();
    for (const p of Object.keys(repo.index)) {
      if (p in work) repo.index[p] = sim.store.blob(work[p]);
      else delete repo.index[p];
    }
  }
  const head = repo.headHash;
  if (amend && !head) fatal('You have nothing to amend.');
  if (amend && repo.merging) fatal('You are in the middle of a merge -- cannot amend.');
  let parents = head ? [head] : [];
  if (amend) parents = repo.commit(head).parents;
  if (repo.merging) parents = [head, repo.merging.hash];
  let message = messages.join('\n\n');
  if (!messages.length) {
    if (repo.merging) message = repo.merging.message;
    else if (amend) message = repo.commit(head).message;
    else {
      fail(
        'error: the simulator has no text editor, so a message is required.\n' +
          'hint (simulator): use   git commit -m "Describe what you changed"',
      );
    }
  }
  if (!message.trim()) fail('Aborting commit due to empty commit message.');
  const tree = { ...repo.index };
  const same = (x, y) => union(x, y).every((p) => x[p] === y[p]);
  if (!repo.merging && !amend && !allowEmpty && same(tree, repo.headTree())) fail(statusLong(repo));
  repo.merging = null;
  return makeCommit(sim, repo, message, parents, tree).output;
};

commands.log = (sim, args) => {
  const repo = needRepo(sim);
  let oneline = false;
  let all = false;
  let graph = false;
  let max = Infinity;
  const starts = [];
  let exclude = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--oneline' || a === '--pretty=oneline' || a === '--format=oneline') oneline = true;
    else if (a === '--all') all = true;
    else if (a === '--graph') graph = true;
    else if (a === '--decorate' || a === '--no-decorate') continue;
    else if (a === '-n') max = Number(args[++i]);
    else if (/^-\d+$/.test(a)) max = Number(a.slice(1));
    else if (a.startsWith('--max-count=')) max = Number(a.slice(12));
    else if (a.startsWith('-')) fatal(`unrecognized argument: ${a}`);
    else if (a.includes('..')) {
      const [x, y] = a.split('..');
      exclude = repo.ancestors(resolveOrFatal(repo, x || 'HEAD'));
      starts.push(resolveOrFatal(repo, y || 'HEAD'));
    } else starts.push(resolveOrFatal(repo, a));
  }
  if (Number.isNaN(max)) fatal("'-n' requires a number");
  if (all) {
    starts.push(...Object.values(repo.branches), ...Object.values(repo.remoteRefs));
    if (repo.headHash) starts.push(repo.headHash);
  }
  if (!starts.length) {
    if (!repo.headHash) fatal(`your current branch '${repo.currentBranch}' does not have any commits yet`);
    starts.push(repo.headHash);
  }
  const set = new Set();
  for (const s of starts) for (const h of repo.ancestors(s)) if (!exclude.has(h)) set.add(h);
  const list = [...set].sort((a, b) => repo.commit(b).seq - repo.commit(a).seq).slice(0, max);
  const body = (h) => {
    const deco = decorate(repo, h);
    if (oneline) return [`${c.yellow(short(h))}${deco ? ' ' + deco : ''} ${repo.subject(h)}`];
    return formatCommitLong(repo, h).split('\n');
  };
  if (!graph) return list.map((h) => body(h).join('\n')).join(oneline ? '\n' : '\n\n');
  return renderGraph(repo, list, body, !oneline).join('\n');
};

// Simplified version of git's --graph: one column per line of development,
// with \ where a merge brings in a second parent and / where lines join.
function renderGraph(repo, list, body, spaced) {
  const shown = new Set(list);
  const cols = [];
  const out = [];
  const pipes = (n) => Array(n).fill('|').join(' ');
  list.forEach((h, idx) => {
    let col = cols.indexOf(h);
    if (col < 0) {
      cols.push(h);
      col = cols.length - 1;
    }
    const lines = body(h);
    out.push(`${cols.map((_, i) => (i === col ? c.bold('*') : '|')).join(' ')} ${lines[0]}`);
    const parents = repo.commit(h).parents.filter((p) => shown.has(p));
    const rest = [];
    if (!parents.length) {
      cols.splice(col, 1);
      if (col < cols.length) rest.push(pipes(col) + (col ? ' ' : '') + Array(cols.length - col).fill('/').join(' '));
    } else {
      cols[col] = parents[0];
      for (const p of parents.slice(1)) {
        if (cols.includes(p)) continue;
        cols.splice(col + 1, 0, p);
        const right = cols.length - col - 2;
        rest.push(pipes(col + 1) + '\\' + (right > 0 ? ' ' + Array(right).fill('\\').join(' ') : ''));
      }
      for (;;) {
        const dup = cols.findIndex((x, i) => cols.indexOf(x) !== i);
        if (dup < 0) break;
        const orig = cols.indexOf(cols[dup]);
        cols.splice(dup, 1);
        // e.g. orig 0, dup 1 -> "|/"   orig 0, dup 2 -> "|_|/"
        let row = '';
        for (let i = 0; i < dup; i++) row += '|' + (i >= orig && i < dup - 1 ? '_' : i < dup - 1 ? ' ' : '');
        row += '/';
        if (dup < cols.length) row += ' ' + Array(cols.length - dup).fill('/').join(' ');
        rest.push(row);
      }
    }
    const pad = pipes(Math.max(cols.length, 1));
    for (const l of lines.slice(1)) out.push(`${pad} ${l}`.trimEnd());
    out.push(...rest);
    if (spaced && idx < list.length - 1 && !rest.length) out.push(pad);
  });
  return out;
}

commands.diff = (sim, args) => {
  const repo = needRepo(sim);
  let staged = false;
  let stat = false;
  let nameOnly = false;
  let afterDD = false;
  const revs = [];
  const paths = [];
  for (const a of args) {
    if (afterDD) paths.push(a);
    else if (a === '--') afterDD = true;
    else if (a === '--staged' || a === '--cached') staged = true;
    else if (a === '--stat') stat = true;
    else if (a === '--name-only') nameOnly = true;
    else if (a.startsWith('-')) fail(`error: invalid option: ${a}`);
    else if (a.includes('..')) {
      const [x, y] = a.split(/\.\.\.?/);
      revs.push(x || 'HEAD', y || 'HEAD');
    } else if (repo.resolve(a)) revs.push(a);
    else paths.push(a);
  }
  const prefixes = paths.map((p) => toRel(sim, repo, p));
  const store = sim.store;
  const tracked = (keys) => {
    const work = repo.working();
    const out = {};
    for (const p of keys) if (p in work) out[p] = work[p];
    return out;
  };
  let A;
  let B;
  if (revs.length >= 2) {
    A = mapContent(store, repo.treeOf(resolveOrFatal(repo, revs[0])));
    B = mapContent(store, repo.treeOf(resolveOrFatal(repo, revs[1])));
  } else if (staged) {
    A = mapContent(store, revs.length ? repo.treeOf(resolveOrFatal(repo, revs[0])) : repo.headTree());
    B = mapContent(store, repo.index);
  } else if (revs.length === 1) {
    const t = repo.treeOf(resolveOrFatal(repo, revs[0]));
    A = mapContent(store, t);
    B = tracked(union(t, repo.index));
  } else {
    A = mapContent(store, repo.index);
    B = tracked(Object.keys(repo.index));
  }
  const changed = union(A, B).filter((p) => A[p] !== B[p] && (!prefixes.length || prefixes.some((pr) => under(p, pr))));
  if (nameOnly) return changed.join('\n');
  if (stat) {
    if (!changed.length) return '';
    let ins = 0;
    let del = 0;
    const width = Math.max(...changed.map((p) => p.length));
    const rows = changed.map((p) => {
      const r = countChanges(A[p] ?? '', B[p] ?? '');
      ins += r.ins;
      del += r.del;
      return ` ${p.padEnd(width)} | ${String(r.ins + r.del).padStart(2)} ${c.green('+'.repeat(r.ins))}${c.red('-'.repeat(r.del))}`;
    });
    let sum = ` ${plural(changed.length, 'file')} changed`;
    if (ins) sum += `, ${plural(ins, 'insertion')}(+)`;
    if (del) sum += `, ${plural(del, 'deletion')}(-)`;
    return [...rows, sum].join('\n');
  }
  return changed.map((p) => unifiedDiff(p, A[p], B[p])).join('\n');
};

commands.branch = (sim, args) => {
  const repo = needRepo(sim);
  const flags = new Set();
  const names = [];
  let upstreamTo = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-u') upstreamTo = args[++i];
    else if (a.startsWith('--set-upstream-to=')) upstreamTo = a.slice(18);
    else if (a.startsWith('--')) flags.add(a);
    else if (a.startsWith('-')) for (const ch of a.slice(1)) flags.add('-' + ch);
    else names.push(a);
  }
  const has = (...fs) => fs.some((f) => flags.has(f));

  if (has('--show-current')) return repo.currentBranch || '';

  if (upstreamTo) {
    const b = names[0] || repo.currentBranch;
    if (!repo.remoteRefs[upstreamTo]) fatal(`the requested upstream branch '${upstreamTo}' does not exist`);
    const [remote, ...rest] = upstreamTo.split('/');
    repo.upstream[b] = { remote, branch: rest.join('/') };
    return `branch '${b}' set up to track '${upstreamTo}'.`;
  }

  if (has('--unset-upstream')) {
    const b = names[0] || repo.currentBranch;
    if (!repo.upstream[b]) fatal(`branch '${b}' has no upstream information`);
    delete repo.upstream[b];
    return '';
  }

  if (has('-d', '-D', '--delete')) {
    if (!names.length) fatal('branch name required');
    const force = has('-D', '-f', '--force');
    const out = [];
    for (const n of names) {
      if (n === repo.currentBranch) fail(`error: cannot delete branch '${n}' used by worktree at '${repo.root}'`);
      const h = repo.branches[n];
      if (!h) fail(`error: branch '${n}' not found`);
      if (!force) {
        const up = repo.upstream[n];
        const upHash = up && repo.remoteRefs[`${up.remote}/${up.branch}`];
        if (!repo.isAncestor(h, repo.headHash) && !(upHash && repo.isAncestor(h, upHash))) {
          fail(
            `error: the branch '${n}' is not fully merged.\n` +
              `hint: If you are sure you want to delete it, run 'git branch -D ${n}'`,
          );
        }
      }
      delete repo.branches[n];
      delete repo.upstream[n];
      out.push(`Deleted branch ${n} (was ${short(h)}).`);
    }
    return out.join('\n');
  }

  if (has('-m', '-M', '--move')) {
    const [from, to] = names.length === 1 ? [repo.currentBranch, names[0]] : names;
    if (!from || !to) fatal('branch name required');
    validateBranchName(to);
    if (repo.branches[to] && !has('-M')) fatal(`a branch named '${to}' already exists`);
    if (from !== repo.currentBranch && !repo.branches[from]) fatal(`no branch named '${from}'`);
    if (repo.branches[from]) {
      repo.branches[to] = repo.branches[from];
      delete repo.branches[from];
    }
    if (repo.upstream[from]) {
      repo.upstream[to] = repo.upstream[from];
      delete repo.upstream[from];
    }
    if (from === repo.currentBranch) repo.head.name = to;
    return '';
  }

  if (names.length && !has('-a', '-r', '-v', '--list')) {
    const [n, start] = names;
    validateBranchName(n);
    if (repo.branches[n] && !has('-f')) fatal(`a branch named '${n}' already exists`);
    const h = start ? repo.resolve(start) : repo.headHash;
    if (!h) fatal(`not a valid object name: '${start || repo.currentBranch}'`);
    repo.branches[n] = h;
    if (start && repo.remoteRefs[start]) {
      const [remote, ...rest] = start.split('/');
      repo.upstream[n] = { remote, branch: rest.join('/') };
      return `branch '${n}' set up to track '${start}'.`;
    }
    return '';
  }

  const verbose = has('-v', '-vv');
  const rows = [];
  if (!has('-r')) {
    if (repo.head.type === 'detached') rows.push({ mark: '* ', name: `(HEAD detached at ${short(repo.head.hash)})`, h: repo.head.hash, color: c.green });
    for (const b of Object.keys(repo.branches).sort()) {
      const cur = b === repo.currentBranch;
      rows.push({ mark: cur ? '* ' : '  ', name: b, h: repo.branches[b], color: cur ? c.green : (s) => s });
    }
  }
  if (has('-a', '-r')) {
    for (const r of Object.keys(repo.remoteRefs).sort()) {
      rows.push({ mark: '  ', name: has('-a') ? `remotes/${r}` : r, h: repo.remoteRefs[r], color: c.red });
    }
  }
  const width = Math.max(0, ...rows.map((r) => r.name.length));
  return rows
    .map((r) => {
      if (!verbose) return r.mark + r.color(r.name);
      return `${r.mark}${r.color(r.name.padEnd(width))} ${c.yellow(short(r.h))} ${repo.subject(r.h)}`;
    })
    .join('\n');
};

commands.checkout = (sim, args) => {
  const repo = needRepo(sim);
  const dd = args.indexOf('--');
  if (dd >= 0) {
    const before = args.slice(0, dd);
    const paths = args.slice(dd + 1);
    const src = before[0] ? repo.treeOf(resolveOrFatal(repo, before[0])) : repo.index;
    const n = restorePaths(sim, repo, paths, src, Boolean(before[0]));
    return `Updated ${plural(n, 'path')} from ${before[0] ? 'the tree' : 'the index'}`;
  }
  if (args[0] === '-b' || args[0] === '-B') {
    if (!args[1]) fail(`error: switch \`${args[0][1]}' requires a value`);
    return createAndSwitch(sim, repo, args[1], args[2], args[0] === '-B', 'checkout');
  }
  const t = args[0];
  if (!t) return '';
  if (t.startsWith('-') && t !== '-') fail(`error: unknown switch \`${t.replace(/^-+/, '')}'`);
  if (t === '-') return switchToPrevious(sim, repo, 'checkout');
  if (args.length >= 2 && repo.resolve(t)) {
    const n = restorePaths(sim, repo, args.slice(1), repo.treeOf(repo.resolve(t)), true);
    return `Updated ${plural(n, 'path')} from the tree`;
  }
  if (repo.branches[t] || t === repo.currentBranch) return switchBranch(sim, repo, t, 'checkout');
  const guess = guessRemote(repo, t);
  if (guess) return createAndSwitch(sim, repo, t, guess, false, 'checkout');
  const h = repo.resolve(t);
  if (h) return detach(sim, repo, h, t);
  const abs = sim.vfs.resolve(t);
  if (repo.contains(abs) && Object.keys(repo.index).some((p) => under(p, repo.rel(abs)))) {
    const n = restorePaths(sim, repo, [t], repo.index, false);
    return `Updated ${plural(n, 'path')} from the index`;
  }
  fail(`error: pathspec '${t}' did not match any file(s) known to git`);
};

commands.switch = (sim, args) => {
  const repo = needRepo(sim);
  const a = args[0];
  if (!a) fatal('missing branch or commit argument');
  if (a === '-c' || a === '-C' || a === '--create') {
    if (!args[1]) fail(`error: switch \`c' requires a value`);
    return createAndSwitch(sim, repo, args[1], args[2], a === '-C', 'checkout');
  }
  if (a === '--detach' || a === '-d') return detach(sim, repo, resolveOrFatal(repo, args[1] || 'HEAD'), args[1] || 'HEAD');
  if (a === '-') return switchToPrevious(sim, repo, 'checkout');
  if (a.startsWith('-')) fail(`error: unknown switch \`${a.replace(/^-+/, '')}'`);
  if (repo.branches[a] || a === repo.currentBranch) return switchBranch(sim, repo, a, 'checkout');
  const guess = guessRemote(repo, a);
  if (guess) return createAndSwitch(sim, repo, a, guess, false, 'checkout');
  if (repo.resolve(a)) {
    fatal(`a branch is expected, got commit '${a}'\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
  }
  fatal(`invalid reference: ${a}` + c.yellow(`\nhint (simulator): to create a new branch use   git switch -c ${a}`));
};

commands.restore = (sim, args) => {
  const repo = needRepo(sim);
  let staged = false;
  let worktree = false;
  let source = null;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--staged' || a === '-S') staged = true;
    else if (a === '--worktree' || a === '-W') worktree = true;
    else if (a === '-SW' || a === '-WS') staged = worktree = true;
    else if (a === '--source' || a === '-s') source = args[++i];
    else if (a.startsWith('--source=')) source = a.slice(9);
    else if (a === '--') continue;
    else if (a.startsWith('-')) fail(`error: unknown option \`${a.replace(/^-+/, '')}'`);
    else paths.push(a);
  }
  if (!paths.length) fatal('you must specify path(s) to restore');
  if (!staged) worktree = true;
  const srcTree = source ? repo.treeOf(resolveOrFatal(repo, source)) : null;
  if (staged) {
    const t = srcTree || repo.headTree();
    for (const spec of paths) {
      const prefix = toRel(sim, repo, spec);
      const hits = union(repo.index, t).filter((p) => under(p, prefix));
      if (!hits.length) fail(`error: pathspec '${spec}' did not match any file(s) known to git`);
      for (const p of hits) {
        if (p in t) repo.index[p] = t[p];
        else delete repo.index[p];
      }
    }
  }
  if (worktree) {
    const src = srcTree || (staged ? repo.headTree() : repo.index);
    restorePaths(sim, repo, paths, src, false);
  }
  return '';
};

commands.rm = (sim, args) => {
  const repo = needRepo(sim);
  let cached = false;
  let recursive = false;
  let force = false;
  const specs = [];
  for (const a of args) {
    if (a === '--cached') cached = true;
    else if (a === '--force') force = true;
    else if (a === '--' || a === '-q' || a === '--quiet') continue;
    else if (/^-[rf]+$/.test(a)) {
      if (a.includes('r')) recursive = true;
      if (a.includes('f')) force = true;
    } else if (a.startsWith('-')) fail(`error: unknown switch \`${a.replace(/^-+/, '')}'`);
    else specs.push(a);
  }
  if (!specs.length) fail('usage: git rm [<options>] [--] <file>...');
  const work = repo.working();
  const head = repo.headTree();
  const todo = [];
  for (const spec of specs) {
    const prefix = toRel(sim, repo, spec);
    const hits = Object.keys(repo.index).filter((p) => under(p, prefix));
    if (!hits.length) fatal(`pathspec '${spec}' did not match any files`);
    if (!recursive && hits.some((p) => p !== prefix)) fatal(`not removing '${spec}' recursively without -r`);
    todo.push(...hits);
  }
  if (!force) {
    const bad = todo.filter((p) => {
      const w = p in work ? sim.store.hashBlob(work[p]) : undefined;
      const stagedDiff = repo.index[p] !== head[p];
      const workDiff = w !== undefined && w !== repo.index[p];
      return cached ? stagedDiff && workDiff : stagedDiff || workDiff;
    });
    if (bad.length) {
      fail(
        `error: the following file${bad.length > 1 ? 's have' : ' has'} changes that are not committed:\n` +
          bad.map((p) => `    ${p}`).join('\n') +
          '\n(use --cached to keep the file, or -f to force removal)',
      );
    }
  }
  for (const p of todo) {
    delete repo.index[p];
    if (!cached && p in work) repo.deleteWorking(p);
    if (repo.merging) repo.merging.conflicts.delete(p);
  }
  return todo.map((p) => `rm '${p}'`).join('\n');
};

commands.mv = (sim, args) => {
  const repo = needRepo(sim);
  const [src, dst] = args.filter((a) => !a.startsWith('-'));
  if (!dst) fail('usage: git mv [<options>] <source>... <destination>');
  const sp = toRel(sim, repo, src);
  let dAbs = sim.vfs.resolve(dst);
  if (sim.vfs.isDir(dAbs)) dAbs = VFS.join(dAbs, VFS.basename(sim.vfs.resolve(src)));
  if (!repo.contains(dAbs)) fatal(`'${dst}' is outside repository`);
  const dp = repo.rel(dAbs);
  const hits = Object.keys(repo.index).filter((p) => under(p, sp));
  if (!hits.length) fatal(`not under version control, source=${src}, destination=${dst}`);
  if (sim.vfs.exists(dAbs)) fatal(`destination exists, source=${src}, destination=${dst}`);
  const work = repo.working();
  for (const p of hits) {
    const np = dp + p.slice(sp.length);
    const content = p in work ? work[p] : sim.store.content(repo.index[p]);
    repo.writeWorking(np, content);
    if (p in work) repo.deleteWorking(p);
    repo.index[np] = repo.index[p];
    delete repo.index[p];
  }
  return '';
};

function unstagedSummary(repo) {
  const st = repo.status();
  if (!st.unstaged.length) return '';
  const code = { modified: 'M', deleted: 'D' };
  return ['Unstaged changes after reset:', ...st.unstaged.map(([t, p]) => `${code[t]}\t${p}`)].join('\n');
}

commands.reset = (sim, args) => {
  const repo = needRepo(sim);
  let mode = null;
  let dd = false;
  const rest = [];
  const paths = [];
  for (const a of args) {
    if (dd) paths.push(a);
    else if (a === '--') dd = true;
    else if (['--soft', '--mixed', '--hard'].includes(a)) mode = a.slice(2);
    else if (a.startsWith('-')) fail(`error: unknown option \`${a.replace(/^-+/, '')}'`);
    else rest.push(a);
  }
  let rev = 'HEAD';
  if (rest.length && (repo.resolve(rest[0]) || rest[0] === 'HEAD')) rev = rest.shift();
  paths.unshift(...rest);

  if (paths.length) {
    if (mode && mode !== 'mixed') fatal(`Cannot do ${mode} reset with paths.`);
    const t = rev === 'HEAD' && !repo.headHash ? {} : repo.treeOf(resolveOrFatal(repo, rev));
    for (const spec of paths) {
      const prefix = toRel(sim, repo, spec);
      const hits = union(repo.index, t).filter((p) => under(p, prefix));
      if (!hits.length) {
        fatal(
          `ambiguous argument '${spec}': unknown revision or path not in the working tree.\n` +
            "Use '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'",
        );
      }
      for (const p of hits) {
        if (p in t) repo.index[p] = t[p];
        else delete repo.index[p];
      }
    }
    return unstagedSummary(repo);
  }

  mode = mode || 'mixed';
  const target = rev === 'HEAD' && !repo.headHash ? null : resolveOrFatal(repo, rev);
  const newTree = repo.treeOf(target);
  if (mode === 'hard') {
    const work = repo.working();
    const conflicted = repo.merging ? Object.fromEntries([...repo.merging.conflicts].map((p) => [p, 1])) : {};
    for (const p of union(repo.index, repo.headTree(), newTree, conflicted)) {
      if (p in newTree) repo.writeWorking(p, sim.store.content(newTree[p]));
      else if (p in work) repo.deleteWorking(p);
    }
  }
  if (mode !== 'soft') {
    repo.index = { ...newTree };
    repo.merging = null;
  }
  if (target) repo.setHead(target);
  if (mode === 'hard') return target ? `HEAD is now at ${short(target)} ${repo.subject(target)}` : '';
  if (mode === 'mixed') return unstagedSummary(repo);
  return '';
};

commands.merge = (sim, args) => {
  const repo = needRepo(sim);
  if (args.includes('--abort')) {
    if (!repo.merging) fatal('There is no merge to abort (MERGE_HEAD missing).');
    const head = repo.headTree();
    const work = repo.working();
    const conflicted = Object.fromEntries([...repo.merging.conflicts].map((p) => [p, 1]));
    for (const p of union(repo.index, head, conflicted)) {
      if (p in head) repo.writeWorking(p, sim.store.content(head[p]));
      else if (p in work) repo.deleteWorking(p);
    }
    repo.index = { ...head };
    repo.merging = null;
    return '';
  }
  if (args.includes('--continue')) {
    if (!repo.merging) fatal('There is no merge in progress (MERGE_HEAD missing).');
    return commands.commit(sim, []);
  }
  let noFF = false;
  let message = null;
  const revs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-ff') noFF = true;
    else if (a === '--ff' || a === '--no-edit') continue;
    else if (a === '-m') message = args[++i];
    else if (a.startsWith('-')) fail(`error: unknown option \`${a.replace(/^-+/, '')}'`);
    else revs.push(a);
  }
  if (!revs.length) {
    const up = repo.currentBranch && repo.upstream[repo.currentBranch];
    if (!up) fatal('No remote for the current branch.');
    revs.push(`${up.remote}/${up.branch}`);
  }
  return doMerge(sim, repo, revs[0], { noFF, message });
};

commands.revert = (sim, args) => {
  const repo = needRepo(sim);
  const revs = args.filter((a) => !a.startsWith('-'));
  if (!revs.length) fail('usage: git revert <commit>...');
  const out = [];
  for (const rev of revs) {
    const h = resolveOrFatal(repo, rev);
    const cm = repo.commit(h);
    if (cm.parents.length > 1) fail(`error: commit ${h} is a merge but no -m option was given.\nfatal: revert failed`);
    if (dirtyPaths(repo).length) {
      fail('error: your local changes would be overwritten by revert.\nhint: commit your changes or stash them to proceed.\nfatal: revert failed');
    }
    const parentTree = repo.treeOf(cm.parents[0]);
    const res = threeWay(sim, cm.tree, repo.headTree(), parentTree, `parent of ${short(h)}`);
    if (res.conflicts.length) {
      fail(
        `error: could not revert ${short(h)}... ${repo.subject(h)}\n` +
          c.yellow('hint (simulator): this revert would cause a merge conflict, which the simulator does not support for revert.'),
      );
    }
    requireIdentity(sim);
    applyMerge(sim, repo, res);
    const msg = `Revert "${repo.subject(h)}"\n\nThis reverts commit ${h}.`;
    out.push(makeCommit(sim, repo, msg, [repo.headHash], { ...repo.index }).output);
  }
  return out.join('\n');
};

commands.show = (sim, args) => {
  const repo = needRepo(sim);
  const rev = args.find((a) => !a.startsWith('-')) || 'HEAD';
  if (rev.includes(':')) {
    const [r, p] = rev.split(':');
    const t = repo.treeOf(resolveOrFatal(repo, r || 'HEAD'));
    if (!(p in t)) fatal(`path '${p}' does not exist in '${r || 'HEAD'}'`);
    return sim.store.content(t[p]).replace(/\n$/, '');
  }
  const h = resolveOrFatal(repo, rev);
  const cm = repo.commit(h);
  const header = formatCommitLong(repo, h);
  if (cm.parents.length > 1) return header;
  const d = treeDiff(sim.store, repo.treeOf(cm.parents[0]), cm.tree);
  return d ? `${header}\n\n${d}` : header;
};

commands.stash = (sim, args) => {
  const repo = needRepo(sim);
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'push';
  const rest = args[0] && !args[0].startsWith('-') ? args.slice(1) : args;
  const pick = () => {
    const ref = rest.find((a) => !a.startsWith('-'));
    let n = 0;
    if (ref) {
      const m = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(ref);
      if (!m) fail(`error: ${ref} is not a valid reference`);
      n = Number(m[1] ?? m[2]);
    }
    if (!repo.stashes[n]) fail(n === 0 ? 'No stash entries found.' : `error: stash@{${n}} is not a valid reference`);
    return n;
  };
  switch (sub) {
    case 'push':
    case 'save': {
      if (!repo.headHash) fatal('You do not have the initial commit yet');
      if (!dirtyPaths(repo).length) return 'No local changes to save';
      let msg = null;
      const mi = rest.indexOf('-m');
      if (mi >= 0) msg = rest[mi + 1];
      else if (sub === 'save' && rest.length) msg = rest.join(' ');
      const head = repo.headTree();
      const work = repo.working();
      const files = {};
      for (const p of union(repo.index, head)) files[p] = p in work ? work[p] : null;
      const where = repo.currentBranch || '(no branch)';
      const message = msg ? `On ${where}: ${msg}` : `WIP on ${where}: ${short(repo.headHash)} ${repo.subject(repo.headHash)}`;
      repo.stashes.unshift({ base: repo.headHash, index: { ...repo.index }, files, message });
      for (const p of union(repo.index, head)) {
        if (p in head) repo.writeWorking(p, sim.store.content(head[p]));
        else if (p in work) repo.deleteWorking(p);
      }
      repo.index = { ...head };
      return `Saved working directory and index state ${message}`;
    }
    case 'list':
      return repo.stashes.map((s, i) => `${c.yellow(`stash@{${i}}`)}: ${s.message}`).join('\n');
    case 'show': {
      const s = repo.stashes[pick()];
      const base = mapContent(sim.store, repo.treeOf(s.base));
      const after = {};
      for (const [p, v] of Object.entries(s.files)) if (v !== null) after[p] = v;
      return contentDiff(base, after);
    }
    case 'pop':
    case 'apply': {
      const n = pick();
      const s = repo.stashes[n];
      const head = repo.headTree();
      const work = repo.working();
      const blocked = Object.keys(s.files).filter((p) => {
        const w = p in work ? sim.store.hashBlob(work[p]) : undefined;
        return w !== head[p] || repo.index[p] !== head[p];
      });
      if (blocked.length) {
        fail(
          'error: Your local changes to the following files would be overwritten by merge:\n' +
            blocked.map((p) => `\t${p}`).join('\n') +
            '\nPlease commit your changes or stash them before you merge.\nAborting',
        );
      }
      const baseTree = repo.treeOf(s.base);
      for (const [p, v] of Object.entries(s.files)) {
        if (v === null) {
          if (p in work) repo.deleteWorking(p);
          if (p in baseTree) delete repo.index[p];
        } else repo.writeWorking(p, v);
      }
      for (const [p, h] of Object.entries(s.index)) if (!(p in baseTree)) repo.index[p] = h;
      let out = statusLong(repo);
      if (sub === 'pop') {
        repo.stashes.splice(n, 1);
        out += `\nDropped refs/stash@{${n}}`;
      }
      return out;
    }
    case 'drop': {
      const n = pick();
      repo.stashes.splice(n, 1);
      return `Dropped refs/stash@{${n}}`;
    }
    case 'clear':
      repo.stashes = [];
      return '';
    default:
      fail(`error: unknown subcommand: ${sub}\nusage: git stash [push [-m <message>] | list | show | pop | apply | drop | clear]`);
  }
  return '';
};

commands.config = (sim, args) => {
  const rest = args.filter((a) => !['--global', '--local', '--system'].includes(a));
  if (rest[0] === '--list' || rest[0] === '-l') {
    return Object.entries(sim.config)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  }
  if (rest[0] === '--unset') {
    delete sim.config[(rest[1] || '').toLowerCase()];
    return '';
  }
  const key = rest[0];
  if (!key) fail('usage: git config [--global] <name> [<value>]\n       git config --list');
  if (!/^[a-zA-Z][\w-]*\.[\w.-]+$/.test(key)) fail(`error: key does not contain a section: ${key}`);
  const k = key.toLowerCase();
  if (rest.length === 1) {
    if (k in sim.config) return sim.config[k];
    fail('');
  }
  sim.config[k] = rest.slice(1).join(' ');
  return '';
};

commands.remote = (sim, args) => {
  const repo = needRepo(sim);
  const sub = args[0];
  if (!sub) return Object.keys(repo.remotes).join('\n');
  if (sub === '-v' || sub === '--verbose') {
    return Object.entries(repo.remotes)
      .map(([n, u]) => `${n}\t${u} (fetch)\n${n}\t${u} (push)`)
      .join('\n');
  }
  if (sub === 'add') {
    const [name, url] = args.slice(1);
    if (!name || !url) fail('usage: git remote add <name> <url>');
    if (repo.remotes[name]) fail(`error: remote ${name} already exists.`);
    repo.remotes[name] = url;
    return '';
  }
  if (sub === 'remove' || sub === 'rm') {
    const name = args[1];
    if (!repo.remotes[name]) fail(`error: No such remote: '${name}'`);
    delete repo.remotes[name];
    for (const r of Object.keys(repo.remoteRefs)) if (r.startsWith(name + '/')) delete repo.remoteRefs[r];
    for (const b of Object.keys(repo.upstream)) if (repo.upstream[b].remote === name) delete repo.upstream[b];
    return '';
  }
  if (sub === 'get-url') {
    if (!repo.remotes[args[1]]) fail(`error: No such remote '${args[1]}'`);
    return repo.remotes[args[1]];
  }
  if (sub === 'set-url') {
    const [name, url] = args.slice(1);
    if (!repo.remotes[name]) fail(`error: No such remote '${name}'`);
    repo.remotes[name] = url;
    return '';
  }
  if (sub === 'rename') {
    const [from, to] = args.slice(1);
    if (!repo.remotes[from]) fail(`error: No such remote: '${from}'`);
    repo.remotes[to] = repo.remotes[from];
    delete repo.remotes[from];
    for (const r of Object.keys(repo.remoteRefs)) {
      if (r.startsWith(from + '/')) {
        repo.remoteRefs[to + r.slice(from.length)] = repo.remoteRefs[r];
        delete repo.remoteRefs[r];
      }
    }
    for (const up of Object.values(repo.upstream)) if (up.remote === from) up.remote = to;
    return '';
  }
  fail(`error: unknown subcommand: ${sub}`);
};

function remoteServer(sim, repo, name) {
  const url = repo.remotes[name];
  if (!url) {
    fatal(
      `'${name}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\n` +
        'Please make sure you have the correct access rights\nand the repository exists.',
    );
  }
  const srv = sim.serverRepo(url);
  if (!srv) {
    fail(
      `remote: Repository not found.\nfatal: repository '${url}' not found` +
        c.yellow(
          '\nhint (simulator): create the repository on (simulated) GitHub first:  github create <name>\n' +
            'hint (simulator): and check the URL with:  git remote -v',
        ),
    );
  }
  return { url, srv };
}

commands.push = (sim, args) => {
  const repo = needRepo(sim);
  let setUp = false;
  let force = false;
  const pos = [];
  for (const a of args) {
    if (a === '-u' || a === '--set-upstream') setUp = true;
    else if (a === '-f' || a === '--force') force = true;
    else if (a.startsWith('-')) fail(`error: unknown option \`${a.replace(/^-+/, '')}'`);
    else pos.push(a);
  }
  const cur = repo.currentBranch;
  let [remoteName, spec] = pos;
  if (!remoteName) {
    if (!cur) fatal('You are not currently on a branch.');
    const up = repo.upstream[cur];
    if (up) {
      remoteName = up.remote;
      spec = `${cur}:${up.branch}`;
    } else if (!Object.keys(repo.remotes).length) {
      fatal(
        'No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n' +
          '    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>',
      );
    } else {
      fatal(
        `The current branch ${cur} has no upstream branch.\n` +
          'To push the current branch and set the remote as upstream, use\n\n' +
          `    git push --set-upstream origin ${cur}\n`,
      );
    }
  }
  const { url, srv } = remoteServer(sim, repo, remoteName);
  if (!spec) {
    if (!cur) fatal('You are not currently on a branch.');
    spec = cur;
  }
  const [src, dstRaw] = spec.split(':');
  const dst = dstRaw || src;
  const srcHash = repo.resolve(src);
  if (!srcHash) fail(`error: src refspec ${src} does not match any\nerror: failed to push some refs to '${url}'`);
  const old = srv.branches[dst];
  const lines = [`To ${url}`];
  const setUpstream = () => {
    if (setUp && repo.branches[src]) {
      repo.upstream[src] = { remote: remoteName, branch: dst };
      lines.push(`branch '${src}' set up to track '${remoteName}/${dst}'.`);
    }
  };
  if (old === srcHash) {
    repo.remoteRefs[`${remoteName}/${dst}`] = srcHash;
    setUpstream();
    return lines.length > 1 ? `Everything up-to-date\n${lines.slice(1).join('\n')}` : 'Everything up-to-date';
  }
  if (old && !repo.isAncestor(old, srcHash) && !force) {
    const known = [...Object.values(repo.branches), ...Object.values(repo.remoteRefs)].some((h) => repo.isAncestor(old, h));
    const reason = known ? 'non-fast-forward' : 'fetch first';
    const hint = known
      ? 'hint: Updates were rejected because the tip of your current branch is behind\n' +
        'hint: its remote counterpart. If you want to integrate the remote changes,\n' +
        "hint: use 'git pull' before pushing again."
      : 'hint: Updates were rejected because the remote contains work that you do not\n' +
        'hint: have locally. This is usually caused by another repository pushing to\n' +
        'hint: the same ref. If you want to integrate the remote changes, use\n' +
        "hint: 'git pull' before pushing again.";
    fail(`${lines[0]}\n ${c.red('! [rejected]')}        ${src} -> ${dst} (${reason})\nerror: failed to push some refs to '${url}'\n${hint}`);
  }
  srv.branches[dst] = srcHash;
  if (!srv.head) srv.head = dst;
  repo.remoteRefs[`${remoteName}/${dst}`] = srcHash;
  if (!old) lines.push(` * [new branch]      ${src} -> ${dst}`);
  else if (repo.isAncestor(old, srcHash)) lines.push(`   ${short(old)}..${short(srcHash)}  ${src} -> ${dst}`);
  else lines.push(` + ${short(old)}...${short(srcHash)} ${src} -> ${dst} (forced update)`);
  setUpstream();
  return lines.join('\n');
};

commands.fetch = (sim, args) => {
  const repo = needRepo(sim);
  const pos = args.filter((a) => !a.startsWith('-'));
  const cur = repo.currentBranch;
  const name = pos[0] || (cur && repo.upstream[cur] && repo.upstream[cur].remote) || 'origin';
  const { url, srv } = remoteServer(sim, repo, name);
  const lines = [];
  for (const [b, h] of Object.entries(srv.branches)) {
    const key = `${name}/${b}`;
    const old = repo.remoteRefs[key];
    if (old === h) continue;
    repo.remoteRefs[key] = h;
    if (!old) lines.push(` * [new branch]      ${b.padEnd(10)} -> ${key}`);
    else if (repo.isAncestor(old, h)) lines.push(`   ${short(old)}..${short(h)}  ${b.padEnd(10)} -> ${key}`);
    else lines.push(` + ${short(old)}...${short(h)} ${b.padEnd(10)} -> ${key}  (forced update)`);
  }
  for (const key of Object.keys(repo.remoteRefs)) {
    if (key.startsWith(name + '/') && !(key.slice(name.length + 1) in srv.branches) && args.includes('--prune')) {
      delete repo.remoteRefs[key];
      lines.push(` - [deleted]         (none)     -> ${key}`);
    }
  }
  return lines.length ? [`From ${url}`, ...lines].join('\n') : '';
};

commands.pull = (sim, args) => {
  const repo = needRepo(sim);
  const pos = args.filter((a) => !a.startsWith('-'));
  const cur = repo.currentBranch;
  if (!cur) fatal('You are not currently on a branch.');
  let [remoteName, branch] = pos;
  if (!remoteName) {
    const up = repo.upstream[cur];
    if (!up) {
      fail(
        'There is no tracking information for the current branch.\n' +
          'Please specify which branch you want to merge with.\n\n    git pull <remote> <branch>\n\n' +
          'If you wish to set tracking information for this branch you can do so with:\n\n' +
          `    git branch --set-upstream-to=origin/<branch> ${cur}\n`,
      );
    }
    remoteName = up.remote;
    branch = up.branch;
  }
  branch = branch || cur;
  const fetched = commands.fetch(sim, [remoteName]);
  const ref = `${remoteName}/${branch}`;
  if (!repo.remoteRefs[ref]) fatal(`couldn't find remote ref ${branch}`);
  const { url } = remoteServer(sim, repo, remoteName);
  try {
    const merged = doMerge(sim, repo, ref, { message: `Merge branch '${branch}' of ${url}` });
    return [fetched, merged].filter(Boolean).join('\n');
  } catch (e) {
    if (e instanceof GitError && fetched) e.message = `${fetched}\n${e.message}`;
    throw e;
  }
};

commands.clone = (sim, args) => {
  const pos = args.filter((a) => !a.startsWith('-'));
  const [url, dir] = pos;
  if (!url) fatal('You must specify a repository to clone.');
  const srv = sim.serverRepo(url);
  if (!srv) fail(`remote: Repository not found.\nfatal: repository '${url}' not found`);
  const name = dir || url.replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');
  const abs = sim.vfs.resolve(name);
  if (sim.vfs.isFile(abs) || (sim.vfs.isDir(abs) && sim.vfs.list(abs).length)) {
    fatal(`destination path '${name}' already exists and is not an empty directory.`);
  }
  sim.vfs.mkdirp(abs);
  const def = srv.head && srv.branches[srv.head] ? srv.head : Object.keys(srv.branches)[0];
  const repo = new Repo(sim, abs, def || 'main');
  sim.repos.set(abs, repo);
  repo.remotes.origin = url;
  for (const [b, h] of Object.entries(srv.branches)) repo.remoteRefs[`origin/${b}`] = h;
  const out = [`Cloning into '${name}'...`];
  if (!def) {
    out.push('warning: You appear to have cloned an empty repository.');
    return out.join('\n');
  }
  repo.branches[def] = srv.branches[def];
  repo.upstream[def] = { remote: 'origin', branch: def };
  const tree = repo.treeOf(srv.branches[def]);
  for (const [p, h] of Object.entries(tree)) {
    repo.writeWorking(p, sim.store.content(h));
    repo.index[p] = h;
  }
  out.push(`remote: Enumerating objects: done.`, `Receiving objects: 100%, done.`);
  return out.join('\n');
};

const HELP_GROUPS = [
  ['start a working area', [['init', 'Create an empty Git repository'], ['clone', 'Copy a remote repository into a new folder']]],
  [
    'work on the current change',
    [
      ['add', 'Add file contents to the staging area'],
      ['mv', 'Move or rename a tracked file'],
      ['restore', 'Discard changes / unstage files'],
      ['rm', 'Remove files from the working tree and the index'],
    ],
  ],
  [
    'examine the history and state',
    [
      ['status', 'Show the working tree status'],
      ['diff', 'Show changes between working tree, staging area and commits'],
      ['log', 'Show commit history'],
      ['show', 'Show a commit (or a file at a commit)'],
    ],
  ],
  [
    'grow, mark and tweak your common history',
    [
      ['branch', 'List, create, rename or delete branches'],
      ['switch', 'Switch branches'],
      ['checkout', 'Switch branches or restore files (older command)'],
      ['merge', 'Join two branches together'],
      ['commit', 'Record changes to the repository'],
      ['reset', 'Move the current branch / unstage files'],
      ['revert', 'Undo a commit by adding a new commit'],
      ['stash', 'Put changes aside temporarily'],
    ],
  ],
  [
    'collaborate',
    [
      ['remote', 'Manage connections to remote repositories'],
      ['fetch', 'Download commits from a remote'],
      ['pull', 'Fetch and merge in one step'],
      ['push', 'Upload your commits to a remote'],
    ],
  ],
  ['setup', [['config', 'Get and set options such as user.name']]],
];

const USAGE = {
  init: ['git init', 'git init my-folder', 'git init -b main'],
  clone: ['git clone https://github.com/example/hello-git.git', 'git clone <url> my-folder'],
  add: ['git add README.md', 'git add .            # everything in this folder', 'git add -A           # everything in the repo'],
  mv: ['git mv old.txt new.txt'],
  restore: ['git restore file.txt          # throw away unstaged edits', 'git restore --staged file.txt # unstage'],
  rm: ['git rm file.txt', 'git rm --cached file.txt   # stop tracking but keep the file', 'git rm -r folder'],
  status: ['git status', 'git status -s'],
  diff: ['git diff               # unstaged changes', 'git diff --staged      # staged changes', 'git diff main feature', 'git diff --stat'],
  log: ['git log', 'git log --oneline', 'git log --oneline --all --graph', 'git log -n 3'],
  show: ['git show', 'git show HEAD~1', 'git show main:README.md'],
  branch: ['git branch', 'git branch feature', 'git branch -d feature', 'git branch -m new-name', 'git branch -a', 'git branch -v'],
  switch: ['git switch feature', 'git switch -c new-branch', 'git switch -'],
  checkout: ['git checkout feature', 'git checkout -b new-branch', 'git checkout -- file.txt', 'git checkout <commit>'],
  merge: ['git merge feature', 'git merge --no-ff feature', 'git merge --abort'],
  commit: ['git commit -m "Message"', 'git commit -am "Message"   # stage tracked changes + commit', 'git commit --amend -m "Better message"'],
  reset: ['git reset file.txt          # unstage', 'git reset --soft HEAD~1     # undo commit, keep changes staged', 'git reset --hard HEAD       # DANGER: discard all changes'],
  revert: ['git revert HEAD', 'git revert <commit>'],
  stash: ['git stash', 'git stash -m "message"', 'git stash list', 'git stash pop', 'git stash drop'],
  remote: ['git remote -v', 'git remote add origin <url>', 'git remote remove origin'],
  fetch: ['git fetch', 'git fetch origin'],
  pull: ['git pull', 'git pull origin main'],
  push: ['git push', 'git push -u origin main', 'git push origin feature'],
  config: ['git config --global user.name "Your Name"', 'git config --global user.email "you@example.com"', 'git config --list'],
};

function gitHelp(sim, args) {
  const cmd = args.find((a) => !a.startsWith('-'));
  if (cmd) {
    if (!USAGE[cmd]) fail(`No help for '${cmd}'. Run 'git help' to see supported commands.`);
    const desc = HELP_GROUPS.flatMap((g) => g[1]).find(([n]) => n === cmd)[1];
    return [`git ${cmd} - ${desc}`, '', 'Examples:', ...USAGE[cmd].map((u) => `    ${c.cyan(u)}`)].join('\n');
  }
  const lines = ['usage: git <command> [<args>]', '', 'These are the git commands available in this simulator:', ''];
  for (const [group, cmds] of HELP_GROUPS) {
    lines.push(group);
    for (const [n, d] of cmds) lines.push(`   ${n.padEnd(11)}${d}`);
    lines.push('');
  }
  lines.push("'git help <command>' shows examples for one command.");
  return lines.join('\n');
}

commands.help = gitHelp;

const GIT_COMMANDS = Object.keys(commands).sort();

function runGit(sim, args) {
  const [sub, ...rest] = args;
  if (!sub) return gitHelp(sim, []);
  if (sub === '--version' || sub === 'version') return 'git version 2.43.0 (simulated)';
  if (sub === '--help' || sub === '-h') return gitHelp(sim, rest);
  if (rest.includes('-h') || rest.includes('--help')) return gitHelp(sim, [sub]);
  const fn = commands[sub];
  if (!fn) {
    const near = GIT_COMMANDS.filter((n) => editDistance(n, sub) <= 2);
    let msg = `git: '${sub}' is not a git command. See 'git --help'.`;
    if (near.length) msg += `\n\nThe most similar command${near.length > 1 ? 's are' : ' is'}\n${near.map((n) => `\t${n}`).join('\n')}`;
    fail(msg);
  }
  return fn(sim, rest);
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

module.exports = { runGit, GIT_COMMANDS, GitError, short, formatDate };
