#!/usr/bin/env node
'use strict';
const readline = require('readline');
const colors = require('../src/colors');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Git CLI Simulator — practice git in a safe, pretend terminal.

usage: git-sim [--lesson <n>] [--no-color]

  --lesson <n>   start directly in lesson n
  --no-color     disable colors

Commands can also be piped in, e.g.:  git-sim < commands.txt`);
  process.exit(0);
}
if (args.includes('--no-color')) colors.setEnabled(false);

const { Simulator } = require('../src/simulator');

const c = colors;
const sim = new Simulator();
const interactive = Boolean(process.stdin.isTTY);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: interactive,
  completer: interactive ? (line) => sim.complete(line) : undefined,
  historySize: 500,
});

console.log(
  [
    c.bold(c.magenta('┌──────────────────────────────────────────────┐')),
    c.bold(c.magenta('│           Git CLI Simulator                  │')),
    c.bold(c.magenta('└──────────────────────────────────────────────┘')),
    'A pretend terminal for practicing git. Nothing you do here touches real files.',
    '',
    `  ${c.cyan('lessons')}    see the guided lessons     ${c.cyan('lesson 1')}   start at the beginning`,
    `  ${c.cyan('help')}       all commands               ${c.cyan('exit')}       quit`,
    '',
  ].join('\n'),
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
  if (!interactive) process.stdout.write(line + '\n');
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

rl.on('close', () => {
  console.log(`\n${c.green('Bye! Keep committing.')}`);
  process.exit(0);
});
