'use strict';
const c = require('./colors');
const { ShellError } = require('./shell');

const USER = 'student';

function normalizeUrl(url) {
  let u = String(url).trim().replace(/\/+$/, '');
  const ssh = /^git@([^:]+):(.+)$/.exec(u);
  if (ssh) u = `https://${ssh[1]}/${ssh[2]}`;
  return u.replace(/\.git$/, '').toLowerCase();
}

function findByName(sim, name) {
  if (!name) return null;
  const want = name.toLowerCase().replace(/\.git$/, '');
  for (const srv of sim.server.values()) {
    if (srv.name.toLowerCase() === want || srv.name.toLowerCase().endsWith('/' + want)) return srv;
  }
  return null;
}

// Fill the simulated GitHub with a small public project students can clone.
function seedServer(sim) {
  const history = [
    [{ 'README.md': '# Hello Git\n\nA tiny example project for practicing git clone.\n' }, 'Initial commit'],
    [
      {
        'README.md': '# Hello Git\n\nA tiny example project for practicing git clone.\n',
        'hello.js': "console.log('Hello, Git!');\n",
      },
      'Add hello.js',
    ],
    [
      {
        'README.md': '# Hello Git\n\nA tiny example project for practicing git clone.\n\nRun it with: node hello.js\n',
        'hello.js': "console.log('Hello, Git!');\n",
        '.gitignore': 'node_modules/\n',
      },
      'Document how to run the project',
    ],
  ];
  let parent = null;
  history.forEach(([files, message], i) => {
    const tree = {};
    for (const p of Object.keys(files).sort()) tree[p] = sim.store.blob(files[p]);
    parent = sim.store.put({
      type: 'commit',
      tree,
      parents: parent ? [parent] : [],
      message,
      author: 'Octo Example',
      email: 'octo@example.com',
      date: sim.clock - (history.length - i) * 86400000,
      seq: sim.nextSeq(),
    });
  });
  const url = 'https://github.com/example/hello-git.git';
  sim.server.set(normalizeUrl(url), { name: 'example/hello-git', url, branches: { main: parent }, head: 'main' });
}

const HELP = [
  'github - a pretend GitHub that lives inside the simulator',
  '',
  '  github create <name>             create an empty repository on GitHub',
  '  github list                      list repositories on GitHub',
  '  github show <name>               show branches and files of a repository',
  '  github teammate <name> [branch]  pretend a teammate pushed a new commit',
].join('\n');

function github(sim, args) {
  const [sub, name, branchArg] = args;
  switch (sub) {
    case 'create': {
      if (!name) throw new ShellError('usage: github create <repo-name>');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ShellError('github: repository names may only contain letters, numbers, ".", "_" and "-"');
      const url = `https://github.com/${USER}/${name}.git`;
      if (sim.serverRepo(url)) throw new ShellError(`github: repository ${USER}/${name} already exists`);
      sim.server.set(normalizeUrl(url), { name: `${USER}/${name}`, url, branches: {}, head: null });
      return [
        `${c.green('✓')} Created empty repository ${c.bold(`${USER}/${name}`)} on GitHub (simulated).`,
        '',
        `  URL: ${c.cyan(url)}`,
        '',
        'Connect your local repository to it with:',
        `  ${c.cyan(`git remote add origin ${url}`)}`,
        `  ${c.cyan('git push -u origin main')}`,
      ].join('\n');
    }
    case 'list':
    case 'ls':
      return [...sim.server.values()]
        .map((s) => `${c.bold(s.name.padEnd(28))} ${s.url}  ${c.gray(Object.keys(s.branches).length ? Object.keys(s.branches).join(', ') : '(empty)')}`)
        .join('\n');
    case 'show':
    case 'view': {
      const srv = findByName(sim, name);
      if (!srv) throw new ShellError(`github: no repository named '${name || ''}'. Try: github list`);
      const lines = [c.bold(srv.name), srv.url, ''];
      const branches = Object.keys(srv.branches);
      if (!branches.length) return [...lines, 'This repository is empty. Push some commits to it!'].join('\n');
      lines.push('Branches:');
      for (const b of branches) {
        const cm = sim.store.commit(srv.branches[b]);
        lines.push(`  ${c.green(b.padEnd(12))} ${c.yellow(srv.branches[b].slice(0, 7))} ${cm.message.split('\n')[0]} ${c.gray(`(${cm.author})`)}`);
      }
      const head = srv.head && srv.branches[srv.head] ? srv.head : branches[0];
      lines.push('', `Files on ${head}:`);
      for (const p of Object.keys(sim.store.commit(srv.branches[head]).tree)) lines.push(`  ${p}`);
      return lines.join('\n');
    }
    case 'teammate': {
      const srv = findByName(sim, name);
      if (!srv) throw new ShellError(`github: no repository named '${name || ''}'. Try: github list`);
      const branch = branchArg || srv.head || 'main';
      const tip = srv.branches[branch];
      if (!tip) throw new ShellError(`github: ${srv.name} has no branch '${branch}' yet — push to it first`);
      const n = ++sim.teammateCount;
      const tree = { ...sim.store.commit(tip).tree };
      const file = 'TEAM_NOTES.md';
      const old = tree[file] ? sim.store.content(tree[file]) : '# Team notes\n\n';
      tree[file] = sim.store.blob(`${old}- Note #${n} from your teammate Sam\n`);
      const sorted = Object.fromEntries(Object.keys(tree).sort().map((k) => [k, tree[k]]));
      const h = sim.store.put({
        type: 'commit',
        tree: sorted,
        parents: [tip],
        message: `Add team note #${n}`,
        author: 'Sam Teammate',
        email: 'sam@example.com',
        date: sim.now(),
        seq: sim.nextSeq(),
      });
      srv.branches[branch] = h;
      return (
        `${c.magenta('Sam (your teammate)')} pushed commit ${c.yellow(h.slice(0, 7))} "Add team note #${n}" to ${srv.name} (${branch}).\n` +
        "GitHub now has a commit that your computer doesn't have yet."
      );
    }
    default:
      return HELP;
  }
}

module.exports = { github, seedServer, normalizeUrl };
