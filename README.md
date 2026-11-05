# Git CLI Simulator

A safe, pretend terminal where students practice the **git command line**. It runs in Node.js with no dependencies, and everything happens in memory: the files, the repositories, and even a stand-in for GitHub. Nothing a student types can touch real files or real repositories.

It has two modes:

- **Guided lessons** walk students through each workflow one step at a time and check their work as they go.
- **Free play** is a sandbox where students can try anything and see the same output and error messages real git would give them.

```
student@git-sim:~/my-project (main)$ git merge spanish
Auto-merging greeting.txt
CONFLICT (content): Merge conflict in greeting.txt
Automatic merge failed; fix conflicts and then commit the result.

✔ Done! CONFLICT! Both branches changed the same line, so git cannot choose. It asks you to decide.

▶ Step 3/8: Run git status to see which files are in conflict.
student@git-sim:~/my-project (main|MERGING)$
```

## Running it

The simulator runs on **Windows, macOS and Linux**. It needs Node.js 18 or later (from https://nodejs.org) and nothing else: no npm packages and no real git installation. The commands are identical in every terminal:

```bash
git clone https://github.com/anonymousgroundhog/Git_CLI_Simulator.git
cd Git_CLI_Simulator
npm start                        # or: node bin/git-sim.js
node bin/git-sim.js --lesson 3   # jump straight into a lesson
npm test                         # run the test suite
```

If a computer doesn't have git, students can download the ZIP from GitHub instead (**Code → Download ZIP**), unzip it, and run `npm start` inside the folder.

To install it as a `git-sim` command, run `npm install -g .` from the project folder. On Windows, npm creates a `git-sim.cmd` launcher automatically.

### Terminal notes

| Platform | Terminal | Notes |
|----------|----------|-------|
| Windows | Windows Terminal, PowerShell, Command Prompt, VS Code | Full support: colors, Tab completion, ↑/↓ history. |
| Windows | Older consoles that show boxes instead of ✔ or ★ | Start with `node bin/git-sim.js --ascii`, or set `GIT_SIM_ASCII=1`. |
| Windows | Git Bash (mintty) | Works. For Tab completion and history, start with `winpty node bin/git-sim.js`. |
| macOS | Terminal, iTerm2, VS Code | Full support. |
| Linux | Any terminal | Full support. |

Whatever the student's own computer uses, the pretend terminal always behaves like **bash**, the shell used on Linux, macOS and in Git Bash. This keeps the lessons the same for everyone. Habits from the Windows command prompt still work, and the simulator explains the bash equivalent:

| Windows command | Bash command |
|-----------------|--------------|
| `dir` | `ls` |
| `type` | `cat` |
| `del` | `rm` |
| `copy` | `cp` |
| `move`, `ren` | `mv` |
| `md` | `mkdir` |
| `rd` | `rmdir` |
| `cls` | `clear` |

Paths inside the simulator use `/`, as in bash. Ctrl+C clears the current line, and `exit` quits.

### Scripts and demos

You can pipe commands in, which is handy for demos or for checking an assignment. Both Windows (CRLF) and Unix (LF) line endings work:

```bash
node bin/git-sim.js --no-color < commands.txt
```

| Option | What it does |
|--------|--------------|
| `--lesson <n>` | Start directly in lesson n |
| `--no-color` | Turn off colors (or set `NO_COLOR=1`) |
| `--ascii` | Use plain ASCII instead of symbols (or set `GIT_SIM_ASCII=1`) |
| `--help` | Show usage |

GitHub Actions runs the test suite on Windows, macOS and Linux with Node 18, 20, 22 and 24. This includes tests that start the real program and pipe commands into it.

## Lessons

Type `lessons` to see the list and `lesson <n>` to start one. Starting a lesson resets the sandbox, but keeps the student's git name and email.

| # | Lesson | Covers |
|---|--------|--------|
| 1 | Your first repository | `pwd`, `ls`, `mkdir`, `cd`, `git config`, `git init`, `git status`, `git add`, `git commit`, `git log` |
| 2 | Tracking changes | `git diff`, `git diff --staged`, `git restore --staged`, `git restore`, `git log --oneline` |
| 3 | Branches and merging | `git branch`, `git switch`, fast-forward `git merge`, `git branch -d` |
| 4 | Merge conflicts | Reading conflict markers, resolving them, finishing the merge commit |
| 5 | Remotes and GitHub | `git remote add`, `git push -u`, a rejected push, `git pull`, `git clone` |
| 6 | Undo and stash | `git stash` / `pop`, `git commit -am`, `git reset --soft HEAD~1`, `git revert` |

These commands help during a lesson:

- `hint` shows the command for the current step.
- `skip` has the simulator run the step for you.
- `lesson` repeats the current instruction.
- `lesson stop` leaves the lesson and keeps the sandbox as it is.

## What's supported

**Shell commands:** `pwd`, `ls [-a] [-l]`, `cd`, `mkdir [-p]`, `rmdir`, `touch`, `cat`, `echo` (with `>` and `>>`, plus `-e` and `-n`), `rm [-r] [-f]`, `mv`, `cp [-r]`, `tree`, `clear`, and `help`. You can chain commands with `&&`, `||` and `;`. Wildcards such as `*.txt` work, and Tab completes commands, files and branch names.

There is no text editor. Students write files with `echo "text" > file` to create or overwrite a file, and `echo "text" >> file` to add a line to the end. If a student types `nano`, `vim` or `code`, the simulator explains how to use `echo` instead.

**git commands:** `init`, `clone`, `config`, `status [-s]`, `add [-A|-u|-f]`, `commit [-m] [-a] [--amend]`, `log [--oneline] [--graph] [--all] [-n]`, `diff [--staged] [--stat] [rev] [rev]`, `show [rev | rev:path]`, `branch [-d|-D|-m|-a|-r|-v|-u]`, `switch [-c] [-]`, `checkout [-b] [rev] [-- path]`, `restore [--staged] [--source]`, `rm [--cached] [-r]`, `mv`, `reset [--soft|--mixed|--hard] [rev] [path]`, `merge [--no-ff] [--abort]`, `revert`, `stash [push|list|show|pop|apply|drop|clear]`, `remote [-v|add|remove|rename|get-url|set-url]`, `fetch`, `pull`, `push [-u] [-f]` and `help`.

The simulator also supports:

- revisions such as `HEAD~2`, `HEAD^`, branch names, `origin/main` and short hashes
- `.gitignore`
- detached HEAD
- tracking branches with ahead/behind counts in `git status`
- line-level three-way merges, so edits to different parts of a file merge cleanly
- conflict markers

**Simulated GitHub (`github`):**

```
github create <name>             create an empty repo at https://github.com/student/<name>.git
github list                      list repos on the pretend GitHub
github show <name>               show a repo's branches and files
github teammate <name> [branch]  pretend a teammate pushed a commit (to practice pull/rejected pushes)
```

There is also a ready-made public project that students can clone: `https://github.com/example/hello-git.git`.

**Teaching hints:** The simulator adds hints for common beginner mistakes. They are marked `hint (simulator):` so students can tell them apart from real git output. Examples:

- running `git commit -m Fix bug` without quotes
- creating a repository inside another repository
- pushing to a GitHub repository that hasn't been created yet
- typing `gti` instead of `git`

## Differences from real git

The simulator teaches the everyday workflow. It does not try to copy every detail of git:

- **No editor.** Commands that would open an editor need `-m`. The one exception is `git commit` while finishing a merge, which uses the default merge message.
- **`.git` is virtual.** `ls -a` shows it, and `rm -rf .git` un-initializes the repository, but students can't `cd` into it.
- **No `rebase`, `cherry-pick`, tags, submodules or hooks.**
- **`revert` can't handle conflicts.** If reverting a commit would cause a conflict, the simulator explains and stops instead.
- **`git log --graph`** draws a simplified version of git's graph.
- **`git status`** shows paths relative to the top of the repository, not to the current folder.
- **Pushing and pulling never needs a login.** The pretend GitHub creates repositories under the user `student`.

## Project layout

```
bin/git-sim.js      interactive terminal (readline, tab completion, piping)
src/simulator.js    command dispatcher, prompt, lesson engine
src/shell.js        shell parsing (quotes, &&, redirects, globs) and shell commands
src/git.js          git commands
src/repo.js         repository model: refs, index, status, revision parsing
src/store.js        content-addressed object store (SHA-1)
src/diff.js         line diff, unified diff output, three-way merge
src/vfs.js          in-memory file system
src/github.js       simulated GitHub server
src/lessons.js      lesson content and step checks
test/               node:test suite (engine, lessons, and the real CLI via child process)
```

### Adding a lesson

Lessons are plain data in `src/lessons.js`. Each step has these fields:

- `say`: the instruction shown to the student.
- `hint`: a command that completes the step.
- `check(sim)`: returns true once the step is done.
- `after` (optional): an explanation shown when the step succeeds.

The test suite replays every lesson using only its hints. If a hint stops matching its check, `npm test` fails.
