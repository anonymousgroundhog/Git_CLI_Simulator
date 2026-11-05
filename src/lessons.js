'use strict';

// Each lesson: title, summary, optional setup commands (run silently after a
// sandbox reset), and steps. A step is complete when check(sim) returns true
// after any command. `hint` must be a command that completes the step (tests
// replay every lesson using only the hints). `after` is shown on success.

const ran = (re) => (sim) => sim.lastOk && re.test(sim.lastCommand);
const ranAny = (re) => (sim) => re.test(sim.lastCommand);
const P = (sim, p) => sim.vfs.resolve(p);
const repoAt = (sim, p = '~/my-project') => sim.repos.get(P(sim, p));
const fileAt = (sim, p) => sim.vfs.readFile(P(sim, p));
const indexHash = (sim, file, repoPath) => {
  const r = repoAt(sim, repoPath);
  return r && r.index[file];
};
const headFile = (sim, file, repoPath) => {
  const r = repoAt(sim, repoPath);
  return r && r.headTree()[file];
};
const workHash = (sim, file, repoPath = '~/my-project') => {
  const content = fileAt(sim, `${repoPath}/${file}`);
  return content === undefined ? undefined : sim.store.hashBlob(content);
};
const commits = (sim, repoPath) => {
  const r = repoAt(sim, repoPath);
  return r && r.headHash ? r.ancestors(r.headHash).size : 0;
};
const headMsg = (sim) => {
  const r = repoAt(sim);
  return r && r.headHash ? r.commit(r.headHash).message : '';
};
const isClean = (sim) => {
  const r = repoAt(sim);
  if (!r) return false;
  const st = r.status();
  return !st.staged.length && !st.unstaged.length;
};

const BASE_REPO = [
  'mkdir my-project',
  'cd my-project',
  'git init',
  'echo "# My Project" > README.md',
  'git add README.md',
  'git commit -m "Add README"',
];

const LESSONS = [
  {
    title: 'Your first repository',
    summary: 'Learn to move around the terminal, create a repository, and make your first commit.',
    freshConfig: true,
    steps: [
      {
        say: 'The terminal always has a "current folder". Print it with `pwd` (print working directory).',
        hint: 'pwd',
        check: ran(/^pwd\b/),
        after: '/home/student is your home folder. The prompt shows it as ~',
      },
      {
        say: 'List what is inside the current folder with `ls`.',
        hint: 'ls',
        check: ran(/^ls\b/),
        after: 'Empty for now.',
      },
      {
        say: 'Create a folder for your project named my-project using `mkdir`.',
        hint: 'mkdir my-project',
        check: (sim) => sim.vfs.isDir(P(sim, '~/my-project')),
      },
      {
        say: 'Move into the new folder with `cd`.',
        hint: 'cd my-project',
        check: (sim) => sim.vfs.cwd === P(sim, '~/my-project'),
        after: 'Notice the prompt changed to ~/my-project.',
      },
      {
        say: 'Git stamps every commit with your name. Set it with `git config` (use your own name).',
        hint: 'git config --global user.name "Your Name"',
        check: (sim) => ran(/^git config\b.*user\.name/)(sim) && Boolean(sim.config['user.name']),
      },
      {
        say: 'Now set your email the same way (user.email).',
        hint: 'git config --global user.email "you@example.com"',
        check: (sim) => ran(/^git config\b.*user\.email/)(sim) && Boolean(sim.config['user.email']),
        after: '--global means this applies to every repository on this computer. You only do this once.',
      },
      {
        say: 'Turn this folder into a git repository with `git init`.',
        hint: 'git init',
        check: (sim) => Boolean(repoAt(sim)),
        after: 'git created a hidden .git folder (see it with `ls -a`). That folder IS the repository: it stores every snapshot. The prompt now shows the branch: (main).',
      },
      {
        say: 'Ask git what is going on with `git status`. You will use this command constantly.',
        hint: 'git status',
        check: ran(/^git status\b/),
        after: 'No commits yet, and nothing to commit.',
      },
      {
        say: 'Create a file. The simulator has no text editor, so use echo with > to write text into a file.',
        hint: 'echo "# My Project" > README.md',
        check: (sim) => sim.vfs.isFile(P(sim, '~/my-project/README.md')),
        after: 'Use `cat README.md` any time to see what is inside a file.',
      },
      {
        say: 'Run `git status` again.',
        hint: 'git status',
        check: (sim) => ran(/^git status\b/)(sim) && repoAt(sim).status().untracked.length > 0,
        after: 'README.md is "untracked": git can see it, but is not saving its history yet.',
      },
      {
        say: 'Stage the file with `git add`. Staging means "include this in the next commit".',
        hint: 'git add README.md',
        check: (sim) => Boolean(indexHash(sim, 'README.md')),
      },
      {
        say: 'Check `git status` once more.',
        hint: 'git status',
        check: ran(/^git status\b/),
        after: 'README.md is now under "Changes to be committed" — it is staged.',
      },
      {
        say: 'Save a snapshot with `git commit`. Always describe the change with -m "message".',
        hint: 'git commit -m "Add README"',
        check: (sim) => commits(sim) >= 1,
        after: 'A commit is a permanent snapshot. The 7 characters after the branch name are the start of its unique ID (hash).',
      },
      {
        say: 'Look at the history with `git log`.',
        hint: 'git log',
        check: ran(/^git log\b/),
        after: 'HEAD -> main means "you are here, on branch main".',
      },
    ],
    done: 'You created a repository, staged a file and made your first commit. The cycle is always: edit → git add → git commit.',
  },

  {
    title: 'Tracking changes',
    summary: 'See what changed with git diff, stage and unstage files, and throw away mistakes.',
    setup: BASE_REPO,
    steps: [
      {
        say: 'A repository with one commit is ready in ~/my-project. Add a line to README.md (>> appends instead of overwriting).',
        hint: 'echo "Learning git step by step." >> README.md',
        check: (sim) => workHash(sim, 'README.md') !== indexHash(sim, 'README.md'),
      },
      {
        say: 'See exactly what changed with `git diff`.',
        hint: 'git diff',
        check: ran(/^git diff(?!.*--(staged|cached))/),
        after: 'Lines starting with + were added, lines with - were removed. Plain git diff shows changes you have NOT staged yet.',
      },
      {
        say: 'Stage README.md.',
        hint: 'git add README.md',
        check: (sim) => indexHash(sim, 'README.md') !== headFile(sim, 'README.md'),
      },
      {
        say: 'Plain `git diff` would now show nothing. To see staged changes use `git diff --staged`.',
        hint: 'git diff --staged',
        check: ran(/^git diff\b.*--(staged|cached)/),
        after: '--staged compares the staging area with the last commit: exactly what the next commit will contain.',
      },
      {
        say: 'Commit the change.',
        hint: 'git commit -m "Describe the project"',
        check: (sim) => commits(sim) >= 2,
      },
      {
        say: 'Oops: create a scratch file and stage it by accident (two commands joined with &&).',
        hint: 'echo "temporary notes" > notes.txt && git add notes.txt',
        check: (sim) => Boolean(indexHash(sim, 'notes.txt')),
      },
      {
        say: 'Unstage notes.txt with `git restore --staged`.',
        hint: 'git restore --staged notes.txt',
        check: (sim) => !indexHash(sim, 'notes.txt') && sim.vfs.isFile(P(sim, '~/my-project/notes.txt')),
        after: 'The file is still on disk, just no longer staged. It is untracked again.',
      },
      {
        say: 'Now break README.md: append a line you will regret.',
        hint: 'echo "OOPS this line is a mistake" >> README.md',
        check: (sim) => /OOPS/.test(fileAt(sim, '~/my-project/README.md') || ''),
      },
      {
        say: 'Throw that edit away with `git restore README.md` (no --staged this time).',
        hint: 'git restore README.md',
        check: (sim) => !/OOPS/.test(fileAt(sim, '~/my-project/README.md') || '') && workHash(sim, 'README.md') === indexHash(sim, 'README.md'),
        after: 'Careful: restore permanently discards uncommitted edits. `cat README.md` to confirm the line is gone.',
      },
      {
        say: 'View the history in compact form with `git log --oneline`.',
        hint: 'git log --oneline',
        check: ran(/^git log\b.*--oneline/),
      },
    ],
    done: 'You can now inspect changes (diff), stage/unstage (add / restore --staged) and discard edits (restore).',
  },

  {
    title: 'Branches and merging',
    summary: 'Work on a feature in its own branch, then merge it back into main.',
    setup: BASE_REPO,
    steps: [
      {
        say: 'List branches with `git branch`.',
        hint: 'git branch',
        check: ran(/^git branch\s*$/),
        after: 'The * marks the branch you are on.',
      },
      {
        say: 'Create a new branch named feature.',
        hint: 'git branch feature',
        check: (sim) => Boolean(repoAt(sim).branches.feature),
        after: 'Creating a branch does not switch to it. Run `git branch` to check.',
      },
      {
        say: 'Switch to the feature branch with `git switch`.',
        hint: 'git switch feature',
        check: (sim) => repoAt(sim).currentBranch === 'feature',
        after: 'New commits will now go on feature. (Older tutorials use `git checkout feature` — same idea.)',
      },
      {
        say: 'Write some code on this branch: create app.js.',
        hint: 'echo "console.log(\'Hello from feature\');" > app.js',
        check: (sim) => sim.vfs.isFile(P(sim, '~/my-project/app.js')),
      },
      {
        say: 'Stage and commit app.js on the feature branch.',
        hint: 'git add app.js && git commit -m "Add app.js"',
        check: (sim) => {
          const r = repoAt(sim);
          return Boolean(r.branches.feature && r.treeOf(r.branches.feature)['app.js']);
        },
      },
      {
        say: 'Compare the branches with `git log --oneline --all`.',
        hint: 'git log --oneline --all',
        check: ran(/^git log\b.*--all/),
        after: 'feature is one commit ahead of main.',
      },
      {
        say: 'Go back to main.',
        hint: 'git switch main',
        check: (sim) => repoAt(sim).currentBranch === 'main',
      },
      {
        say: 'Run `ls`. Where did app.js go?',
        hint: 'ls',
        check: ran(/^ls\b/),
        after: 'app.js only exists on feature. Switching branches swaps the files in your folder.',
      },
      {
        say: 'Bring the feature work into main with `git merge feature`.',
        hint: 'git merge feature',
        check: (sim) => Boolean(repoAt(sim).headTree()['app.js']),
        after: '"Fast-forward": main had no new commits of its own, so git simply moved main forward to feature.',
      },
      {
        say: 'The feature branch is merged, so delete it with `git branch -d`.',
        hint: 'git branch -d feature',
        check: (sim) => !repoAt(sim).branches.feature,
      },
    ],
    done: 'Branch → commit → switch back → merge → delete. That is the everyday feature workflow.',
  },

  {
    title: 'Merge conflicts',
    summary: 'Two branches changed the same line. Learn to read and resolve a conflict.',
    setup: [
      ...BASE_REPO,
      'echo "Hello, world!" > greeting.txt',
      'git add greeting.txt',
      'git commit -m "Add greeting"',
      'git switch -c spanish',
      'echo "Hola, mundo!" > greeting.txt',
      'git commit -am "Translate greeting to Spanish"',
      'git switch main',
      'echo "Hello there, world!" > greeting.txt',
      'git commit -am "Make greeting friendlier"',
    ],
    steps: [
      {
        say: 'Branches main and spanish both changed greeting.txt. Look at the history of both with `git log --oneline --all`.',
        hint: 'git log --oneline --all',
        check: ran(/^git log\b.*--all/),
      },
      {
        say: 'You are on main. Merge the spanish branch.',
        hint: 'git merge spanish',
        check: (sim) => Boolean(repoAt(sim).merging && repoAt(sim).merging.conflicts.size),
        after: 'CONFLICT! Both branches changed the same line, so git cannot choose. It asks you to decide. (The prompt now says MERGING.)',
      },
      {
        say: 'Run `git status` to see which files are in conflict.',
        hint: 'git status',
        check: ran(/^git status\b/),
        after: 'greeting.txt is listed under "Unmerged paths".',
      },
      {
        say: 'Look inside the file with `cat greeting.txt`.',
        hint: 'cat greeting.txt',
        check: ran(/^cat\b.*greeting/),
        after: 'Between <<<<<<< HEAD and ======= is your version (main). Between ======= and >>>>>>> spanish is theirs. You must replace the whole thing with the final text and delete the markers.',
      },
      {
        say: 'Resolve the conflict: overwrite greeting.txt with the text you want to keep (no <<<<<<< markers).',
        hint: 'echo "Hello there, world! / Hola, mundo!" > greeting.txt',
        check: (sim) => {
          const t = fileAt(sim, '~/my-project/greeting.txt') || '';
          return !/^(<<<<<<<|=======|>>>>>>>)/m.test(t);
        },
      },
      {
        say: 'Tell git the conflict is resolved by staging the file.',
        hint: 'git add greeting.txt',
        check: (sim) => {
          const r = repoAt(sim);
          return Boolean(r.merging) && r.merging.conflicts.size === 0;
        },
      },
      {
        say: 'Finish the merge with a commit.',
        hint: 'git commit -m "Merge spanish greeting"',
        check: (sim) => {
          const r = repoAt(sim);
          return !r.merging && r.commit(r.headHash).parents.length === 2;
        },
        after: 'This "merge commit" has two parents: one from each branch.',
      },
      {
        say: 'See the result with `git log --oneline --graph`.',
        hint: 'git log --oneline --graph',
        check: ran(/^git log\b/),
      },
    ],
    done: 'Conflicts are normal! Read the markers, edit the file, git add, git commit. If you panic: `git merge --abort` puts everything back.',
  },

  {
    title: 'Remotes and GitHub',
    summary: 'Publish your repository, collaborate with a (simulated) teammate, and clone a project.',
    setup: BASE_REPO,
    steps: [
      {
        say: 'Create an empty repository on (simulated) GitHub. In real life you would click "New repository" on github.com.',
        hint: 'github create my-project',
        check: (sim) => Boolean(sim.serverRepo('https://github.com/student/my-project.git')),
      },
      {
        say: 'Connect your local repository to it. By convention the main remote is called origin.',
        hint: 'git remote add origin https://github.com/student/my-project.git',
        check: (sim) => Boolean(repoAt(sim).remotes.origin),
      },
      {
        say: 'Check your remotes with `git remote -v`.',
        hint: 'git remote -v',
        check: ran(/^git remote\b.*-v/),
      },
      {
        say: 'Upload your commits with `git push -u origin main`.',
        hint: 'git push -u origin main',
        check: (sim) => {
          const srv = sim.serverRepo('https://github.com/student/my-project.git');
          return Boolean(srv && srv.branches.main && srv.branches.main === repoAt(sim).branches.main);
        },
        after: '-u links your local main to origin/main, so later a plain `git push` or `git pull` knows where to go.',
      },
      {
        say: 'Run `git status`.',
        hint: 'git status',
        check: ran(/^git status\b/),
        after: '"Your branch is up to date with \'origin/main\'".',
      },
      {
        say: 'Now pretend a teammate pushed a commit to GitHub.',
        hint: 'github teammate my-project',
        check: (sim) => {
          const srv = sim.serverRepo('https://github.com/student/my-project.git');
          return Boolean(srv && srv.branches.main !== repoAt(sim).branches.main);
        },
      },
      {
        say: 'Meanwhile, you make your own commit locally.',
        hint: 'echo "My local change" > local.txt && git add local.txt && git commit -m "Add local notes"',
        check: (sim) => Boolean(headFile(sim, 'local.txt')),
      },
      {
        say: 'Try to `git push`.',
        hint: 'git push',
        check: ranAny(/^git push\b/),
        after: 'Rejected! GitHub has a commit you do not have. Git refuses to overwrite your teammate\'s work.',
      },
      {
        say: 'Get your teammate\'s work with `git pull`.',
        hint: 'git pull',
        check: (sim) => {
          const srv = sim.serverRepo('https://github.com/student/my-project.git');
          const r = repoAt(sim);
          return r.isAncestor(srv.branches.main, r.headHash);
        },
        after: 'pull = fetch (download) + merge. Run `ls` and you will see TEAM_NOTES.md from your teammate.',
      },
      {
        say: 'Now push again.',
        hint: 'git push',
        check: (sim) => {
          const srv = sim.serverRepo('https://github.com/student/my-project.git');
          return srv.branches.main === repoAt(sim).branches.main;
        },
        after: 'Golden rule: pull before you push.',
      },
      {
        say: 'Finally, clone someone else\'s project. First go back to your home folder.',
        hint: 'cd ~',
        check: (sim) => sim.vfs.cwd === sim.vfs.home,
      },
      {
        say: 'Clone https://github.com/example/hello-git.git with `git clone`.',
        hint: 'git clone https://github.com/example/hello-git.git',
        check: (sim) => Boolean(repoAt(sim, '~/hello-git')),
        after: 'clone downloads the whole history and sets up origin for you.',
      },
      {
        say: 'Go into the cloned project and look at its history.',
        hint: 'cd hello-git && git log --oneline',
        check: (sim) => ran(/^git log\b/)(sim) && sim.vfs.cwd === P(sim, '~/hello-git'),
      },
    ],
    done: 'remote add → push -u → pull → push, plus clone. You can now collaborate!',
  },

  {
    title: 'Undo and stash',
    summary: 'Put work aside with stash, fix a bad commit with reset, and safely undo with revert.',
    setup: [...BASE_REPO, 'echo "Version 2" >> README.md', 'git commit -am "Update README"'],
    steps: [
      {
        say: 'You are in the middle of some work. Append a line to README.md.',
        hint: 'echo "half-finished idea" >> README.md',
        check: (sim) => /half-finished/.test(fileAt(sim, '~/my-project/README.md') || ''),
      },
      {
        say: 'Urgent bug report! Put your unfinished work aside with `git stash`.',
        hint: 'git stash',
        check: (sim) => repoAt(sim).stashes.length === 1 && isClean(sim),
        after: 'Your changes are saved away and the folder is clean again.',
      },
      {
        say: 'See what is stashed with `git stash list`.',
        hint: 'git stash list',
        check: ran(/^git stash list\b/),
      },
      {
        say: 'Bug fixed (pretend). Bring your work back with `git stash pop`.',
        hint: 'git stash pop',
        check: (sim) => repoAt(sim).stashes.length === 0 && /half-finished/.test(fileAt(sim, '~/my-project/README.md') || ''),
      },
      {
        say: 'Commit it quickly with a lazy message. -a stages every tracked file that changed.',
        hint: 'git commit -am "WIP"',
        check: (sim) => commits(sim) === 3 && headMsg(sim) === 'WIP',
      },
      {
        say: '"WIP" is a bad message. Undo the last commit but keep the changes staged with `git reset --soft HEAD~1`.',
        hint: 'git reset --soft HEAD~1',
        check: (sim) => commits(sim) === 2 && indexHash(sim, 'README.md') !== headFile(sim, 'README.md'),
        after: 'HEAD~1 means "one commit before HEAD". The commit is gone, the changes are still staged.',
      },
      {
        say: 'Commit again with a good message.',
        hint: 'git commit -m "Add half-finished idea to README"',
        check: (sim) => commits(sim) === 3 && headMsg(sim) !== 'WIP',
        after: 'Tip: `git commit --amend -m "new message"` fixes the last message in one step.',
      },
      {
        say: 'Once commits are pushed, never rewrite them. Undo safely by creating a new "opposite" commit with `git revert HEAD`.',
        hint: 'git revert HEAD',
        check: (sim) => commits(sim) === 4 && /^Revert/.test(headMsg(sim)),
      },
      {
        say: 'Check the history with `git log --oneline`.',
        hint: 'git log --oneline',
        check: ran(/^git log\b/),
        after: 'The bad commit is still in history, but its changes are undone.',
      },
    ],
    done: 'stash = set aside, reset = move the branch back (only for unpushed work), revert = undo with a new commit (safe for shared work).',
  },
];

module.exports = { LESSONS };
