#!/usr/bin/env node
'use strict';
const readline = require('readline');
const colors = require('../src/colors');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Git CLI Simulator — practice git in a safe, pretend terminal.

usage: git-sim [--lesson <n>] [--no-color] [--ascii]

  --lesson <n>   start directly in lesson n
  --no-color     disable colors (or set NO_COLOR=1)
  --ascii        plain ASCII symbols, for consoles that show boxes instead
                 of symbols like ✔ (or set GIT_SIM_ASCII=1)

Commands can also be piped in, e.g.:  git-sim < commands.txt`);
  process.exit(0);
}
if (args.includes('--no-color')) colors.setEnabled(false);
if (args.includes('--ascii')) colors.setUnicode(false);

const { Simulator } = require('../src/simulator');

const c = colors;
const sim = new Simulator();
const interactive = Boolean(process.stdin.isTTY);
// Git Bash's mintty terminal on Windows talks to Node through a pipe, so stdin
// is not a TTY even though a person is typing (and mintty already echoes input).
const mintty = !interactive && process.platform === 'win32' && Boolean(process.env.MSYSTEM);
const echoInput = !interactive && !mintty;
if (mintty && !process.env.NO_COLOR && !args.includes('--no-color')) colors.setEnabled(true);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: interactive,
  completer: interactive ? (line) => sim.complete(line) : undefined,
  historySize: 500,
});

const s = c.sym;
const title = '           Git CLI Simulator                  ';
console.log(
  [
    c.bold(c.magenta(s('boxTL') + s('boxH').repeat(title.length) + s('boxTR'))),
    c.bold(c.magenta(s('boxV') + title + s('boxV'))),
    c.bold(c.magenta(s('boxBL') + s('boxH').repeat(title.length) + s('boxBR'))),
    'A pretend terminal for practicing git. Nothing you do here touches real files.',
    '',
    `  ${c.cyan('lessons')}    see the guided lessons     ${c.cyan('lesson 1')}   start at the beginning`,
    `  ${c.cyan('help')}       all commands               ${c.cyan('exit')}       quit`,
    mintty ? c.gray('(Git Bash detected: for tab completion and history, start with  winpty node bin/git-sim.js)') : null,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n'),
);

const li = args.indexOf('--lesson');
if (li >= 0) {
  try {
    console.log(sim.run(`lesson ${args[li + 1]}`));
  } catch (e) {
    console.log(e.message);
  }
}

rl.setPrompt(sim.prompt());
rl.prompt();

rl.on('line', (line) => {
  if (echoInput) process.stdout.write(line + '\n');
  const out = sim.run(line);
  if (out === '\x1b[2J\x1b[H') {
    if (interactive) console.clear();
  } else if (out) console.log(out);
  if (sim.exited) {
    rl.close();
    return;
  }
  rl.setPrompt(sim.prompt());
  rl.prompt();
});

// Ctrl+C cancels the current line, like bash. Use `exit` (or Ctrl+D / Ctrl+Z Enter) to quit.
rl.on('SIGINT', () => {
  process.stdout.write(`^C\n${c.gray("(type 'exit' to quit)")}\n`);
  rl.write(null, { ctrl: true, name: 'e' }); // jump to end of line
  rl.write(null, { ctrl: true, name: 'u' }); // delete everything before the cursor
  rl.setPrompt(sim.prompt());
  rl.prompt();
});

rl.on('close', () => {
  console.log(`\n${c.green('Bye! Keep committing.')}`);
  process.exit(0);
});
