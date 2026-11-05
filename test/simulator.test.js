'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/colors').setEnabled(false);
const { Simulator, LESSONS } = require('../src/simulator');

function fresh() {
  const sim = new Simulator();
  sim.run('git config --global user.name "Test User"');
  sim.run('git config --global user.email test@example.com');
  return sim;
}

// Run commands; every one must succeed unless prefixed with "!" (expected failure).
function script(sim, lines) {
  let out = '';
  for (const raw of lines) {
    const expectFail = raw.startsWith('!');
    const line = expectFail ? raw.slice(1) : raw;
    out = sim.run(line);
    assert.equal(sim.lastOk, !expectFail, `"${line}" ${expectFail ? 'should fail' : 'failed'}:\n${out}`);
  }
  return out;
}

const repo = (sim) => sim.findRepo();
const read = (sim, p) => sim.vfs.readFile(sim.vfs.resolve(p));

test('every lesson can be completed using only its hints', () => {
  LESSONS.forEach((L, i) => {
    const sim = new Simulator();
    sim.run(`lesson ${i + 1}`);
    assert.ok(sim.lesson, `lesson ${i + 1} did not start`);
    for (let s = 0; s < L.steps.length; s++) {
      assert.equal(sim.lesson && sim.lesson.step, s, `lesson ${i + 1} out of sync before step ${s + 1}`);
      const out = sim.run(L.steps[s].hint);
      if (s < L.steps.length - 1) {
        assert.ok(sim.lesson && sim.lesson.step === s + 1, `lesson ${i + 1} step ${s + 1} ("${L.steps[s].hint}") did not advance:\n${out}`);
      }
    }
    assert.equal(sim.lesson, null, `lesson ${i + 1} did not finish`);
  });
});

test('skip runs the hint and advances', () => {
  const sim = new Simulator();
  sim.run('lesson 1');
  sim.run('skip');
  assert.equal(sim.lesson.step, 1);
});

test('basic add / commit / status cycle', () => {
  const sim = fresh();
  script(sim, ['mkdir p', 'cd p', 'git init', 'echo hi > a.txt']);
  assert.match(sim.run('git status'), /Untracked files:[\s\S]*a\.txt/);
  script(sim, ['git add a.txt']);
  assert.match(sim.run('git status'), /new file:\s+a\.txt/);
  const out = script(sim, ['git commit -m "first commit"']);
  assert.match(out, /\[main \(root-commit\) [0-9a-f]{7}\] first commit/);
  assert.match(sim.run('git status'), /nothing to commit, working tree clean/);
  script(sim, ['!git commit -m "nothing"']);
  assert.match(sim.run('git log --oneline'), /\(HEAD -> main\) first commit/);
});

test('commit requires identity', () => {
  const sim = new Simulator();
  script(sim, ['git init', 'touch f', 'git add f']);
  assert.match(script(sim, ['!git commit -m x']), /Please tell me who you are/);
});

test('diff shows unstaged and staged changes', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo one > f', 'git add f', 'git commit -m 1', 'echo two >> f']);
  const d = sim.run('git diff');
  assert.match(d, /^\+two$/m);
  script(sim, ['git add f']);
  assert.equal(sim.run('git diff'), '');
  assert.match(sim.run('git diff --staged'), /^\+two$/m);
});

test('branch, switch and fast-forward merge', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo a > a', 'git add .', 'git commit -m a', 'git switch -c feat', 'echo b > b', 'git add b', 'git commit -m b', 'git switch main']);
  assert.equal(read(sim, 'b'), undefined, 'b should disappear on main');
  const out = script(sim, ['git merge feat']);
  assert.match(out, /Fast-forward/);
  assert.equal(read(sim, 'b'), 'b\n');
  script(sim, ['git branch -d feat']);
});

test('switching with conflicting local changes is refused', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo a > f', 'git add f', 'git commit -m a', 'git switch -c x', 'echo x > f', 'git commit -am x', 'git switch main', 'echo dirty > f']);
  assert.match(script(sim, ['!git switch x']), /would be overwritten by checkout/);
  assert.equal(repo(sim).currentBranch, 'main');
});

test('non-overlapping edits merge cleanly', () => {
  const sim = fresh();
  script(sim, [
    'git init r', 'cd r',
    'echo -e "1\\n2\\n3\\n4\\n5\\n6" > f', 'git add f', 'git commit -m base',
    'git switch -c x', 'echo -e "ONE\\n2\\n3\\n4\\n5\\n6" > f', 'git commit -am x',
    'git switch main', 'echo -e "1\\n2\\n3\\n4\\n5\\nSIX" > f', 'git commit -am main',
    'git merge x',
  ]);
  assert.equal(read(sim, 'f'), 'ONE\n2\n3\n4\n5\nSIX\n');
  assert.equal(repo(sim).commit(repo(sim).headHash).parents.length, 2);
});

test('conflicts block commit until resolved; merge --abort restores', () => {
  const sim = fresh();
  const setup = ['git init r', 'cd r', 'echo base > f', 'git add f', 'git commit -m base', 'git switch -c x', 'echo theirs > f', 'git commit -am x', 'git switch main', 'echo ours > f', 'git commit -am ours'];
  script(sim, [...setup, '!git merge x']);
  assert.match(read(sim, 'f'), /<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> x/);
  assert.match(sim.run('git status'), /both modified:\s+f/);
  script(sim, ['!git commit -m nope', '!git switch x', 'git merge --abort']);
  assert.equal(read(sim, 'f'), 'ours\n');
  assert.equal(repo(sim).merging, null);
  script(sim, ['!git merge x', 'echo resolved > f', 'git add f', 'git commit']);
  assert.match(sim.run('git log -n 1'), /Merge branch 'x'/);
});

test('push, rejection, pull, push', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo a > a', 'git add a', 'git commit -m a', 'github create r', 'git remote add origin https://github.com/student/r.git']);
  assert.match(script(sim, ['!git push']), /has no upstream branch/);
  script(sim, ['git push -u origin main', 'github teammate r', 'echo b > b', 'git add b', 'git commit -m b']);
  assert.match(script(sim, ['!git push']), /\[rejected\][\s\S]*fetch first/);
  script(sim, ['git pull', 'git push']);
  assert.ok(read(sim, 'TEAM_NOTES.md'));
  assert.match(sim.run('git status'), /up to date with 'origin\/main'/);
});

test('push to a repository that does not exist explains how to create it', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'touch a', 'git add a', 'git commit -m a', 'git remote add origin https://github.com/student/nope.git']);
  assert.match(script(sim, ['!git push -u origin main']), /Repository not found[\s\S]*github create/);
});

test('clone copies history and sets upstream', () => {
  const sim = fresh();
  script(sim, ['git clone https://github.com/example/hello-git.git', 'cd hello-git']);
  assert.equal(sim.run('git log --oneline').split('\n').length, 3);
  assert.match(sim.run('git status'), /up to date with 'origin\/main'/);
  assert.match(sim.run('cat hello.js'), /Hello, Git!/);
});

test('reset soft / mixed / hard', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo 1 > f', 'git add f', 'git commit -m 1', 'echo 2 > f', 'git commit -am 2']);
  script(sim, ['git reset --soft HEAD~1']);
  assert.match(sim.run('git status'), /Changes to be committed:[\s\S]*modified:\s+f/);
  script(sim, ['git reset']);
  assert.match(sim.run('git status'), /Changes not staged for commit/);
  script(sim, ['git reset --hard']);
  assert.equal(read(sim, 'f'), '1\n');
  assert.match(sim.run('git status'), /working tree clean/);
});

test('stash push / pop', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo 1 > f', 'git add f', 'git commit -m 1', 'echo 2 >> f', 'git stash']);
  assert.equal(read(sim, 'f'), '1\n');
  assert.match(sim.run('git stash list'), /stash@\{0\}: WIP on main/);
  script(sim, ['git stash pop']);
  assert.equal(read(sim, 'f'), '1\n2\n');
  assert.equal(repo(sim).stashes.length, 0);
});

test('revert creates an inverse commit', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo 1 > f', 'git add f', 'git commit -m 1', 'echo 2 > g', 'git add g', 'git commit -m 2', 'git revert HEAD']);
  assert.equal(read(sim, 'g'), undefined);
  assert.match(sim.run('git log --oneline -n 1'), /Revert "2"/);
});

test('restore and restore --staged', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo 1 > f', 'git add f', 'git commit -m 1', 'echo junk >> f', 'git add f', 'git restore --staged f']);
  assert.match(sim.run('git status'), /Changes not staged/);
  script(sim, ['git restore f']);
  assert.equal(read(sim, 'f'), '1\n');
});

test('.gitignore hides files from status and add', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo "*.log" > .gitignore', 'echo x > debug.log', 'echo y > keep.txt', 'git add .']);
  assert.deepEqual(Object.keys(repo(sim).index).sort(), ['.gitignore', 'keep.txt']);
  assert.match(script(sim, ['!git add debug.log']), /ignored/);
});

test('rm and mv are tracked', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo 1 > a', 'git add a', 'git commit -m 1', 'git mv a b']);
  assert.match(sim.run('git status'), /renamed:\s+a -> b/);
  script(sim, ['git commit -m mv', 'git rm b']);
  assert.equal(read(sim, 'b'), undefined);
  assert.match(sim.run('git status'), /deleted:\s+b/);
});

test('detached HEAD via checkout of a commit', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'echo 1 > f', 'git add f', 'git commit -m 1', 'echo 2 > f', 'git commit -am 2']);
  assert.match(script(sim, ['git checkout HEAD~1']), /detached HEAD/);
  assert.equal(read(sim, 'f'), '1\n');
  script(sim, ['git switch -']);
  assert.equal(repo(sim).currentBranch, 'main');
});

test('shell: quoting, redirects, globs and && short-circuit', () => {
  const sim = fresh();
  script(sim, ['echo "a  b" > f.txt', "echo 'c' >> f.txt", 'touch g.txt h.md']);
  assert.equal(read(sim, 'f.txt'), 'a  b\nc\n');
  assert.deepEqual(sim.run('ls *.txt').split(/\s+/), ['f.txt', 'g.txt']);
  sim.run('cd nowhere && mkdir should-not-exist');
  assert.equal(sim.vfs.isDir(sim.vfs.resolve('should-not-exist')), false);
  sim.run('cd nowhere || mkdir fallback');
  assert.ok(sim.vfs.isDir(sim.vfs.resolve('fallback')));
  assert.match(sim.run('nano f.txt'), /no text editor/);
  assert.match(sim.run('gti status'), /Did you mean: git status/);
});

test('rm -rf .git un-initializes a repository', () => {
  const sim = fresh();
  script(sim, ['git init r', 'cd r', 'rm -rf .git']);
  assert.equal(sim.findRepo(), null);
});

test('unknown git command suggests the closest one', () => {
  const sim = fresh();
  assert.match(sim.run('git comit'), /most similar command is\n\tcommit/);
});
