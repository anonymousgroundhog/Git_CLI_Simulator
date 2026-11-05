'use strict';

// Tiny ANSI color helper. Colors are disabled when stdout is not a TTY,
// when NO_COLOR is set, or when setEnabled(false) is called (tests, --no-color).
let enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (open, close = 39) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

module.exports = {
  setEnabled(v) {
    enabled = Boolean(v);
  },
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
