'use strict';
const c = require('./colors');
const { VFS } = require('./vfs');
const { ObjectStore } = require('./store');
const { runGit, GIT_COMMANDS, GitError, short } = require('./git');
const { builtins, parseCommand, splitChain, ShellError, WINDOWS_ALIASES } = require('./shell');
const { github, seedServer, normalizeUrl } = require('./github');
const { LESSONS } = require('./lessons');

const SIM_COMMANDS = ['help', 'lessons', 'lesson', 'hint', 'skip', 'github', 'reset', 'exit', 'quit'];

const HELP = `${c.bold('Git CLI Simulator')} — a safe sandbox. Nothing here touches your real files.

${c.bold('Simulator commands')}
  lessons              list the guided lessons
  lesson <n>           start lesson n (resets the sandbox)
  lesson               show the current step again
  lesson stop          leave the lesson (keep playing freely)
  hint                 show the command for the current step
  skip                 let the simulator run the current step for you
  github ...           pretend GitHub: create, list, show, teammate
  reset                wipe the sandbox and start over
  exit                 quit

${c.bold('Shell commands')}
  pwd  ls [-a]  cd <dir>  mkdir [-p] <dir>  touch <file>  cat <file>
  echo "text" > file   (create/overwrite)     echo "text" >> file   (append)
  rm [-r] <path>  mv <from> <to>  cp [-r] <from> <to>  tree  clear
  Chain commands with && or ;   Wildcards like *.txt work.

${c.bold('Git')}
  git help             list supported git commands
  git help <command>   examples for one command, e.g.  git help commit`;

class Simulator {
  constructor() {
    this.lesson = null;
    this.exited = false;
    this.reset();
  }

  reset({ keepConfig = false } = {}) {
    const config = keepConfig ? this.config : {};
    this.vfs = new VFS();
    this.store = new ObjectStore();
    this.repos = new Map();
    this.server = new Map();
    this.config = config;
    this.clock = Date.now();
    this.seq = 0;
    this.teammateCount = 0;
    this.lastCommand = '';
    this.lastOk = true;
    seedServer(this);
  }

  // Strictly increasing timestamps so commits made in the same second still sort.
  now() {
    this.clock = Math.max(Date.now(), this.clock + 1000);
    return this.clock;
  }

  nextSeq() {
    return ++this.seq;
  }

  findRepo(from = this.vfs.cwd) {
    for (let p = from; ; p = VFS.parent(p)) {
      if (this.repos.has(p)) return this.repos.get(p);
      if (p === '/') return null;
    }
  }

  serverRepo(url) {
    return this.server.get(normalizeUrl(url)) || null;
  }

  prompt() {
    const repo = this.findRepo();
    let branch = '';
    if (repo) {
      const name = repo.currentBranch || `${short(repo.headHash)}...`;
      branch = ' ' + c.cyan(`(${name}${repo.merging ? '|MERGING' : ''})`);
    }
    return `${c.bold(c.green('student@git-sim'))}:${c.bold(c.blue(this.vfs.display(this.vfs.cwd)))}${branch}$ `;
  }

  // Run one line typed by the user. Returns the text to print.
  run(line) {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed === 'skip') return this.skip();
    let parts;
    try {
      parts = splitChain(trimmed);
    } catch (e) {
      this.lastOk = false;
      return c.red(e.message);
    }
    const outputs = [];
    let prevOk = true;
    let prevOp = null;
    for (const part of parts) {
      const skipIt = (prevOp === '&&' && !prevOk) || (prevOp === '||' && prevOk);
      prevOp = part.op;
      if (skipIt) continue;
      const res = this.runSegment(part.text.trim());
      if (res.output) outputs.push(res.output);
      prevOk = res.ok;
      const lessonOut = this.checkLesson();
      if (lessonOut) outputs.push(lessonOut);
      if (this.exited) break;
    }
    return outputs.join('\n');
  }

  runSegment(text) {
    this.lastCommand = text;
    let output = '';
    let ok = true;
    try {
      const { argv, redirect } = parseCommand(this.vfs, text);
      let out = argv.length ? this.dispatch(argv) : '';
      if (redirect) {
        const abs = this.vfs.resolve(redirect.target);
        if (this.vfs.isDir(abs)) throw new ShellError(`bash: ${redirect.target}: Is a directory`);
        if (!this.vfs.isDir(VFS.parent(abs))) throw new ShellError(`bash: ${redirect.target}: No such file or directory`);
        if (out && !out.endsWith('\n')) out += '\n';
        const prev = redirect.op === '>>' ? this.vfs.readFile(abs) || '' : '';
        this.vfs.writeFile(abs, prev + out.replace(/\x1b\[[0-9;]*m/g, ''));
        out = '';
      }
      output = out;
    } catch (e) {
      ok = false;
      if (e instanceof GitError || e instanceof ShellError) output = colorErrors(e.message);
      else output = c.red(`simulator error: ${e.message}`);
    }
    this.lastOk = ok;
    return { output: output.replace(/\n$/, ''), ok };
  }

  dispatch(argv) {
    const [name, ...args] = argv;
    if (name === 'git') return runGit(this, args);
    if (builtins[name]) return builtins[name](this, args);
    const alias = WINDOWS_ALIASES[name.toLowerCase()];
    if (alias) {
      const out = builtins[alias](this, args);
      if (alias === 'clear') return out;
      const note = c.gray(`(simulator: '${name}' is a Windows command. In bash — Linux, macOS, Git Bash — use '${alias}'.)`);
      return out ? `${note}\n${out}` : note;
    }
    switch (name) {
      case 'help':
      case '?':
        return HELP;
      case 'lessons':
        return this.listLessons();
      case 'lesson':
        return this.lessonCommand(args);
      case 'hint':
        return this.hint();
      case 'github':
      case 'gh':
        return github(this, args);
      case 'reset':
        this.lesson = null;
        this.reset({ keepConfig: true });
        return 'Sandbox wiped. You are back in an empty home folder (your git config was kept).';
      case 'exit':
      case 'quit':
      case 'logout':
        this.exited = true;
        return '';
      default: {
        let msg = `${name}: command not found`;
        if (/^(gti|got|gi|gitt|igt|tig)$/.test(name)) msg += `\nDid you mean: git ${args.join(' ')}`;
        else if (name.startsWith('git-')) msg += `\nDid you mean: git ${name.slice(4)} ${args.join(' ')}`;
        else msg += "\nType 'help' to see what you can do.";
        throw new ShellError(msg);
      }
    }
  }

  // ------------------------------------------------------------ lessons

  listLessons() {
    const lines = [c.bold('Guided lessons'), ''];
    LESSONS.forEach((L, i) => {
      const cur = this.lesson && this.lesson.n === i + 1 ? c.green(`  ${c.sym('left')} current`) : '';
      lines.push(`  ${c.cyan(`lesson ${i + 1}`)}  ${c.bold(L.title)}${cur}`, `            ${L.summary}`);
    });
    lines.push('', 'Starting a lesson resets the sandbox (your git name/email are kept).');
    return lines.join('\n');
  }

  lessonCommand(args) {
    const a = args[0];
    if (!a) {
      if (!this.lesson) return "You are not in a lesson. Type 'lessons' to see the list.";
      return this.stepText();
    }
    if (a === 'stop' || a === 'quit' || a === 'exit') {
      this.lesson = null;
      return 'Left the lesson. The sandbox is yours to play in.';
    }
    if (a === 'next') return this.startLesson((this.lesson ? this.lesson.n : 0) + 1);
    if (!/^\d+$/.test(a)) throw new ShellError('usage: lesson <number> | lesson stop');
    return this.startLesson(Number(a));
  }

  startLesson(n) {
    const L = LESSONS[n - 1];
    if (!L) throw new ShellError(`There is no lesson ${n}. Type 'lessons' to see the list.`);
    this.lesson = null;
    this.reset({ keepConfig: !L.freshConfig });
    if (!L.freshConfig) {
      this.config['user.name'] = this.config['user.name'] || 'Student';
      this.config['user.email'] = this.config['user.email'] || 'student@example.com';
    }
    for (const cmd of L.setup || []) {
      const r = this.runSegment(cmd);
      if (!r.ok) throw new Error(`lesson ${n} setup failed at "${cmd}": ${r.output}`);
    }
    this.lastCommand = '';
    this.lesson = { n, step: 0 };
    const bar = c.sym('bar').repeat(4);
    return [
      c.bold(c.magenta(`${bar} Lesson ${n}: ${L.title} ${bar}`)),
      L.summary,
      c.gray("(Type 'hint' if you are stuck, 'skip' to let the simulator do a step, 'lesson stop' to leave.)"),
      '',
      this.stepText(),
    ].join('\n');
  }

  stepText() {
    const L = LESSONS[this.lesson.n - 1];
    const step = L.steps[this.lesson.step];
    const say = step.say.replace(/`([^`]+)`/g, (_, code) => c.cyan(code));
    return `${c.bold(c.yellow(`${c.sym('arrow')} Step ${this.lesson.step + 1}/${L.steps.length}:`))} ${say}`;
  }

  hint() {
    if (!this.lesson) return "No lesson running. Type 'lessons' to pick one.";
    const step = LESSONS[this.lesson.n - 1].steps[this.lesson.step];
    return `Hint: type   ${c.cyan(step.hint)}`;
  }

  skip() {
    if (!this.lesson) return "No lesson running. Type 'lessons' to pick one.";
    const step = LESSONS[this.lesson.n - 1].steps[this.lesson.step];
    return `${c.gray(`(simulator runs: ${step.hint})`)}\n${this.run(step.hint)}`;
  }

  checkLesson() {
    if (!this.lesson) return '';
    const L = LESSONS[this.lesson.n - 1];
    const step = L.steps[this.lesson.step];
    let passed = false;
    try {
      passed = Boolean(step.check(this));
    } catch {
      passed = false;
    }
    if (!passed) return '';
    const after = step.after ? ' ' + step.after.replace(/`([^`]+)`/g, (_, code) => c.cyan(code)) : '';
    const out = [`\n${c.green(`${c.sym('ok')} Done!`)}${after}`];
    this.lesson.step++;
    if (this.lesson.step >= L.steps.length) {
      const n = this.lesson.n;
      this.lesson = null;
      out.push('', c.bold(c.green(`${c.sym('star')} Lesson ${n} complete: ${L.title}`)), L.done);
      if (LESSONS[n]) out.push('', `Next up: ${c.cyan(`lesson ${n + 1}`)} — ${LESSONS[n].title}. Or keep experimenting here.`);
      else out.push('', 'That was the last lesson. Great work! The sandbox is yours — try anything.');
    } else {
      out.push('', this.stepText());
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------ tab completion

  complete(line) {
    const words = line.split(/\s+/);
    const last = words[words.length - 1];
    let cands = [];
    if (words.length === 1) cands = [...Object.keys(builtins), 'git', ...SIM_COMMANDS];
    else if (words[0] === 'git' && words.length === 2) cands = GIT_COMMANDS;
    else if (words[0] === 'github' && words.length === 2) cands = ['create', 'list', 'show', 'teammate'];
    else {
      const dirPart = last.slice(0, last.lastIndexOf('/') + 1);
      const abs = this.vfs.resolve(dirPart || '.');
      if (this.vfs.isDir(abs)) cands = this.vfs.list(abs).map((e) => dirPart + e.name + (e.dir ? '/' : ''));
      const repo = this.findRepo();
      if (repo && words[0] === 'git' && ['switch', 'checkout', 'merge', 'branch', 'push', 'pull', 'log', 'diff', 'reset', 'rebase'].includes(words[1])) {
        cands.push(...Object.keys(repo.branches), ...Object.keys(repo.remoteRefs), ...Object.keys(repo.remotes));
      }
    }
    const hits = [...new Set(cands)].filter((x) => x.startsWith(last)).sort();
    return [hits, last];
  }
}

function colorErrors(msg) {
  return msg
    .split('\n')
    .map((l) => {
      if (/^(fatal|error):/.test(l)) return c.red(l);
      if (/^hint:/.test(l)) return c.yellow(l);
      return l;
    })
    .join('\n');
}

module.exports = { Simulator, LESSONS };
