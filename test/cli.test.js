'use strict';
// Runs the real CLI as a child process with piped input, the same way on
// Windows, macOS and Linux (CRLF input included).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'git-sim.js');

function runCli(lines, eol = '\n', extraArgs = []) {
  const res = spawnSync(process.execPath, [BIN, '--no-color', ...extraArgs], {
    input: lines.join(eol) + eol,
    encoding: 'utf8',
    env: { ...process.env, MSYSTEM: '' },
    timeout: 20000,
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

const SCRIPT = [
  'git config --global user.name "CLI Test"',
  'git config --global user.email cli@example.com',
  'mkdir demo && cd demo && git init',
  'echo "hello" > a.txt',
  'git add a.txt',
  'git commit -m "first commit"',
  'git log --oneline',
  'exit',
];

for (const [name, eol] of [['LF', '\n'], ['CRLF (Windows)', '\r\n']]) {
  test(`CLI works with ${name} piped input`, () => {
    const out = runCli(SCRIPT, eol);
    assert.match(out, /Initialized empty Git repository in \/home\/student\/demo\/\.git\//);
    assert.match(out, /\[main \(root-commit\) [0-9a-f]{7}\] first commit/);
    assert.match(out, /[0-9a-f]{7} \(HEAD -> main\) first commit/);
    assert.doesNotMatch(out, /\r/, 'no stray carriage returns in output');
    assert.match(out, /Bye!/);
  });
}

test('CLI --help and --ascii', () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: git-sim/);
  const out = runCli(['lessons', 'exit'], '\n', ['--ascii']);
  assert.match(out, /\+-{10,}\+/);
});

test('CLI exits cleanly at end of input without exit', () => {
  const out = runCli(['pwd']);
  assert.match(out, /\/home\/student/);
});
