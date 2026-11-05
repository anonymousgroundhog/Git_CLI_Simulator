'use strict';

// Tiny ANSI color helper. Colors are disabled when stdout is not a TTY,
// when NO_COLOR is set, or when setEnabled(false) is called (tests, --no-color).
let enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (open, close = 39) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

// Glyphs. The legacy Windows console (conhost) often lacks fonts for symbols
// like ✔ or ★, so fall back to ASCII there. Windows Terminal, VS Code, ConEmu
// and Git Bash (mintty) all render Unicode fine.
const env = process.env;
let unicode =
  env.GIT_SIM_ASCII !== '1' &&
  (process.platform !== 'win32' || Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI || env.MSYSTEM));

const UNICODE = { ok: '✔', check: '✓', star: '★', arrow: '▶', left: '←', bar: '━', tee: '├── ', elbow: '└── ', pipe: '│   ', boxTL: '┌', boxTR: '┐', boxBL: '└', boxBR: '┘', boxH: '─', boxV: '│' };
const ASCII = { ok: '[OK]', check: '[OK]', star: '***', arrow: '>', left: '<-', bar: '=', tee: '|-- ', elbow: '`-- ', pipe: '|   ', boxTL: '+', boxTR: '+', boxBL: '+', boxBR: '+', boxH: '-', boxV: '|' };

module.exports = {
  setEnabled(v) {
    enabled = Boolean(v);
  },
  setUnicode(v) {
    unicode = Boolean(v);
  },
  sym: (name) => (unicode ? UNICODE : ASCII)[name],
  isEnabled: () => enabled,
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
};
