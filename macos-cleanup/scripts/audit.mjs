#!/usr/bin/env node
// Read-only macOS cleanup planner. Produces a risk-tiered plan; deletes nothing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const optAll = (n) => {
  const out = [];
  argv.forEach((a, i) => {
    if (a === n && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
};

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const OUT = path.resolve(opt('--out', `macos-cleanup-plan-${stamp()}.json`));
const PRINT_LIMIT = Number(opt('--print-limit', 15));
const LIVE_SHELL = !has('--skip-live-shell');
const REQUESTED_APPS = optAll('--app');
const DAY = 86400000;

if (process.platform !== 'darwin') {
  console.error('This planner only supports macOS.');
  process.exit(2);
}

const findings = [];
const actions = [];
const add = (f) => findings.push(f);
const act = (a) => actions.push(a);

// Path-based cleanup candidates, sized in one batch and turned into actions later.
const candidates = [];
const claimedPaths = new Set();
const isInsideClaimed = (p) => {
  for (const c of claimedPaths) if (p === c || p.startsWith(`${c}/`)) return true;
  return false;
};
function candidate(spec) {
  const list = (spec.paths || (spec.path ? [spec.path] : [])).filter(
    (p) => exists(p) && !isInsideClaimed(p),
  );
  if (!list.length) return;
  list.forEach((p) => claimedPaths.add(p));
  candidates.push({ ...spec, paths: list, path: list[0] });
}

function flushCandidates() {
  const sizes = duSizes(candidates.flatMap((c) => c.paths));
  const inventory = [];
  for (const c of candidates) {
    const sizeBytes = c.paths.reduce((n, p) => n + (sizes.get(p) || 0), 0);
    inventory.push({ category: c.category, title: c.title, path: c.path, paths: c.paths, sizeBytes, tier: c.tier });
    if (sizeBytes < (c.minBytes || 0)) continue;
    if (c.operation === 'manual') {
      act({
        tier: c.tier || 'manual',
        category: c.category,
        title: c.title,
        evidence: `${c.paths.join(', ')}${sizeBytes ? ` (${fmtBytes(sizeBytes)})` : ''}`,
        why: c.why,
        reversal: c.reversal || 'No automatic change is made.',
        sizeBytes,
        operation: { type: 'manual', note: c.note },
      });
    } else {
      act({
        tier: c.tier,
        category: c.category,
        title: c.title,
        evidence: `${c.paths.join(', ')} (${fmtBytes(sizeBytes)})`,
        why: c.why,
        reversal: c.reversal || 'Moved to Trash; undo restores it.',
        sizeBytes,
        operation: { type: 'trash', targets: c.paths },
      });
    }
  }
  return inventory;
}
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
const expand = (s) => {
  let v = String(s || '').trim().replace(/^["']|["']$/g, '');
  v = v.replace(/^~(?=\/|$)/, HOME).replace(/\$\{HOME\}/g, HOME).replace(/\$HOME\b/g, HOME);
  return v;
};
const isDynamic = (s) => /\$\(|`|\$\{?PATH\}?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(s);

function run(cmd, args, { timeout = 15000, env } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: env || process.env,
  });
  if (r.error) return { ok: false, stdout: '', stderr: String(r.error.message) };
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function duSizes(paths) {
  const map = new Map();
  const CHUNK = 80;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const r = run('/usr/bin/du', ['-sk', ...chunk], { timeout: 180000 });
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(\d+)\t(.+)$/);
      if (m) map.set(m[2], Number(m[1]) * 1024);
    }
  }
  return map;
}

const SYSTEM_PATH_PREFIXES = ['/var/run/com.apple.security.cryptexd', '/System/Cryptexes'];
const SYSTEM_DEFAULT_DIRS = new Set([
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
]);
const isSystemPath = (dir) => SYSTEM_PATH_PREFIXES.some((p) => dir.startsWith(p));

const MODULES = {
  cache: { zh: '缓存', en: 'Caches' },
  browser: { zh: '浏览器', en: 'Browsers' },
  'dev-cache': { zh: '开发缓存', en: 'Dev caches' },
  'build-artifacts': { zh: '构建产物', en: 'Build artifacts' },
  'system-junk': { zh: '系统垃圾', en: 'System junk' },
  'package-manager': { zh: '包管理器', en: 'Package managers' },
  app: { zh: '应用卸载', en: 'Apps' },
  'app-residue': { zh: '应用残留', en: 'App residue' },
  launchd: { zh: '后台服务', en: 'launchd' },
  'device-data': { zh: '设备与模拟器', en: 'Devices & simulators' },
  'vm-container': { zh: '虚拟机与容器', en: 'VMs & containers' },
  downloads: { zh: '下载与安装包', en: 'Downloads' },
  trash: { zh: '废纸篓', en: 'Trash' },
  snapshots: { zh: '系统快照', en: 'Snapshots' },
  'shell-config': { zh: '终端配置', en: 'Shell config' },
  path: { zh: '系统 PATH', en: 'System PATH' },
  symlink: { zh: '失效软链', en: 'Dangling symlinks' },
};
const MODULE_KEYS = Object.keys(MODULES);
const ID_PREFIX = {
  cache: 'CACHE',
  browser: 'BROWSER',
  'dev-cache': 'DEV',
  'build-artifacts': 'BUILD',
  'system-junk': 'SYS',
  'package-manager': 'PKG',
  app: 'APP',
  'app-residue': 'RESIDUE',
  launchd: 'LAUNCHD',
  'device-data': 'DEVICE',
  'vm-container': 'VM',
  downloads: 'DL',
  trash: 'TRASH',
  snapshots: 'SNAP',
  'shell-config': 'SHELL',
  path: 'PATH',
  symlink: 'LINK',
};

// ---------------------------------------------------------------- live shell

function readLivePath() {
  if (!LIVE_SHELL) return { value: process.env.PATH || '', source: 'process PATH (--skip-live-shell)' };
  const r = run('/bin/zsh', ['-lic', "printf '__AUD__%s__END__' \"$PATH\""], { timeout: 15000 });
  const m = r.stdout.match(/__AUD__([\s\S]*?)__END__/);
  if (r.ok && m && m[1].trim()) return { value: m[1].trim(), source: 'zsh -lic' };
  return { value: process.env.PATH || '', source: 'fallback: process PATH', degraded: true };
}

function readPathSources() {
  const out = new Map();
  const addDir = (dir, src) => {
    if (!out.has(dir)) out.set(dir, []);
    out.get(dir).push(src);
  };
  if (exists('/etc/paths')) {
    for (const line of fs.readFileSync('/etc/paths', 'utf8').split('\n')) {
      const v = line.trim();
      if (v && !v.startsWith('#')) addDir(v, '/etc/paths');
    }
  }
  const dir = '/etc/paths.d';
  if (exists(dir)) {
    for (const f of fs.readdirSync(dir)) {
      try {
        for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
          const v = line.trim();
          if (v && !v.startsWith('#')) addDir(v, `/etc/paths.d/${f}`);
        }
      } catch {
        /* unreadable fragment */
      }
    }
  }
  return out;
}

let rcDeclaredPaths = new Set();

function auditLivePath(live) {
  const dirs = live.value.split(':').filter(Boolean);
  const seen = new Map();
  const declared = readPathSources();
  const untracedDirs = [];
  let dupes = 0;
  let missing = 0;
  let systemDirs = 0;

  dirs.forEach((dir, i) => {
    if (seen.has(dir)) {
      dupes += 1;
      add({
        severity: 'low',
        layer: 'path',
        title: 'PATH 中存在重复条目',
        evidence: `${dir} appears at positions ${seen.get(dir)} and ${i}`,
        recommendation: 'Remove the redundant export in the rc file that adds it twice.',
      });
      return;
    }
    seen.set(dir, i);

    if (!dir.startsWith('/')) {
      add({
        severity: 'medium',
        layer: 'path',
        title: 'PATH 中包含相对路径',
        evidence: `PATH position ${i} is "${dir}"`,
        recommendation: 'Replace with an absolute path; relative entries depend on cwd.',
      });
      return;
    }

    if (isSystemPath(dir)) {
      systemDirs += 1;
      return;
    }

    if (!exists(dir)) {
      if (!rcDeclaredPaths.has(dir)) {
        missing += 1;
        const sources = declared.get(dir);
        if (sources) {
          act({
            tier: 'manual',
            category: 'path',
            title: '移除失效的系统 PATH 条目',
            evidence: `${dir} 不存在；声明于 ${sources.join(', ')}`,
            why: 'The directory was deleted but the path fragment still injects it into every shell.',
            reversal: 'Recreate the line in the same file if the tool is reinstalled.',
            sizeBytes: 0,
            operation: {
              type: 'manual',
              note: `从 ${sources.join(', ')} 中删除包含 "${dir}" 的行（需要 sudo）。`,
            },
          });
        } else {
          add({
            severity: 'info',
            layer: 'path',
            title: '来源不明的失效 PATH 目录',
            evidence: `${dir} does not exist and is not declared in rc files or /etc/paths*`,
            path: dir,
            recommendation: 'Injected at runtime (launchctl, IDE, or a tool launcher); ignore unless it keeps reappearing.',
          });
        }
      }
      return;
    }

    if (!declared.has(dir) && !rcDeclaredPaths.has(dir) && !SYSTEM_DEFAULT_DIRS.has(dir)) {
      untracedDirs.push(dir);
    }
  });

  if (untracedDirs.length) {
    add({
      severity: 'info',
      layer: 'path',
      title: '来源不明的 PATH 目录',
      evidence: untracedDirs.join(', '),
      recommendation: 'Not declared in rc files or /etc/paths*; likely injected by an app or tool launcher.',
    });
  }

  if (os.arch() === 'arm64') {
    const local = dirs.indexOf('/usr/local/bin');
    const brew = dirs.indexOf('/opt/homebrew/bin');
    if (local >= 0 && brew >= 0 && local < brew) {
      add({
        severity: 'medium',
        layer: 'path',
        title: '/usr/local/bin 在 Apple Silicon 上遮蔽 Homebrew',
        evidence: `/usr/local/bin at ${local}, /opt/homebrew/bin at ${brew}`,
        recommendation: 'Legacy Intel installs can shadow native tools; check what lives in /usr/local/bin.',
      });
    }
  }

  return { dirs: dirs.length, duplicates: dupes, missing, untraced: untracedDirs.length, systemInjected: systemDirs };
}

// ---------------------------------------------------------------- rc files

const RC_FILES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.bash_profile',
  '.bashrc',
  '.profile',
  '.config/fish/config.fish',
];

const VERSION_MANAGERS = [
  ['nvm', /nvm\.sh|NVM_DIR/],
  ['asdf', /asdf\.sh|\/\.asdf/],
  ['mise', /mise\s+(activate|init)|mise\.sh/],
  ['pyenv', /pyenv\s+init|pyenv\.sh/],
  ['rbenv', /rbenv\s+init|rbenv\.sh/],
  ['volta', /VOLTA_HOME|volta\.sh/],
  ['sdkman', /sdkman-init\.sh/],
  ['conda', /conda\s+initialize/],
  ['fnm', /fnm\s+env/],
];

function pathsFromLine(line) {
  const out = [];
  const re = /(?:^|[\s;])(?:export\s+)?PATH=(?:"([^"]*)"|'([^']*)'|([^\s;#]+))/g;
  let m;
  while ((m = re.exec(line))) {
    const v = m[1] ?? m[2] ?? m[3] ?? '';
    for (const part of v.split(':')) if (part && part !== '$PATH' && part !== '${PATH}') out.push(part);
  }
  const arr = line.match(/^\s*(?:typeset\s+-[aA]?\s+)?path\+?=\(([^)]*)\)/);
  if (arr) {
    for (const part of arr[1].split(/\s+/)) {
      const v = part.replace(/^["']|["']$/g, '');
      if (v && v !== '$PATH') out.push(v);
    }
  }
  return out;
}

function auditRcFiles() {
  const fileEdits = new Map(); // file -> [{line, expected}]
  const aliasTargets = new Map();
  const managers = new Map();
  const brewShellenv = [];
  let scanned = 0;
  let deadEntries = 0;

  const declare = (dir) => rcDeclaredPaths.add(dir);

  for (const rel of RC_FILES) {
    const file = path.join(HOME, rel);
    if (!exists(file)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const lines = text.split(/\r?\n/);
    const seenLines = new Map();
    const edits = [];

    lines.forEach((raw, idx) => {
      const lineNo = idx + 1;
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;

      if (line.length >= 10) {
        const n = (seenLines.get(line) || 0) + 1;
        seenLines.set(line, n);
        if (n === 2) {
          add({
            severity: 'low',
            layer: 'shell-config',
            title: 'rc 文件存在重复行',
            evidence: `${file}:${lineNo} repeats "${line.slice(0, 120)}"`,
            path: file,
            recommendation: 'Keep one copy; repeated exports and sources slow shell startup.',
          });
        }
      }

      for (const [name, re] of VERSION_MANAGERS) {
        if (re.test(line)) {
          if (!managers.has(name)) managers.set(name, []);
          if (!managers.get(name).includes(file)) managers.get(name).push(file);
        }
      }

      if (/brew\s+shellenv/.test(line)) brewShellenv.push({ file, lineNo });

      const src = line.match(/^\s*(?:source|\.)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
      if (src) {
        const target = expand(src[1] || src[2] || src[3] || '');
        if (target.startsWith('/') && !isDynamic(target) && !exists(target)) {
          edits.push({ line: lineNo, expected: line });
        }
      }

      const alias = line.match(/^\s*alias\s+([A-Za-z0-9_.+-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/);
      if (alias) {
        const body = (alias[2] ?? alias[3] ?? alias[4] ?? '').trim();
        let cmd = body.split(/\s+/)[0];
        if (['sudo', 'command', 'env', 'noglob'].includes(cmd)) cmd = body.split(/\s+/)[1] || '';
        if (/^[A-Za-z0-9_.+-]+$/.test(cmd)) aliasTargets.set(alias[1], { cmd, file, lineNo, line });
      }

      const literals = [];
      for (const entry of pathsFromLine(line)) {
        const v = expand(entry);
        if (!v || isDynamic(v) || !v.startsWith('/')) continue;
        declare(v);
        literals.push(v);
      }
      if (literals.length) {
        const dead = literals.filter((v) => !exists(v));
        deadEntries += dead.length;
        if (dead.length === literals.length) {
          edits.push({ line: lineNo, expected: line });
        } else if (dead.length) {
          add({
            severity: 'medium',
            layer: 'shell-config',
            title: 'rc 行同时包含有效与失效的 PATH',
            evidence: `${file}:${lineNo} -> dead: ${dead.join(', ')}`,
            path: file,
            recommendation: 'Edit by hand: the same line also adds directories that still exist.',
          });
        }
      }
    });

    if (edits.length) {
      if (!fileEdits.has(file)) fileEdits.set(file, []);
      fileEdits.get(file).push(...edits);
    }
  }

  for (const [file, edits] of fileEdits) {
    const uniq = [...new Map(edits.map((e) => [`${e.line}:${e.expected}`, e])).values()];
    act({
      tier: 'safe',
      category: 'shell-config',
      title: `清理 ${path.basename(file)} 中 ${uniq.length} 条失效配置`,
      evidence: uniq.map((e) => `${file}:${e.line} ${e.expected.slice(0, 100)}`).join(' | '),
      why: 'Each line adds a missing directory or sources a file that no longer exists.',
      reversal: 'The file is backed up before editing; undo restores the backup.',
      sizeBytes: 0,
      operation: { type: 'remove-lines', file, edits: uniq },
    });
  }

  const missingAliases = checkAliases(aliasTargets);
  for (const name of missingAliases) {
    const info = aliasTargets.get(name);
    add({
      severity: 'medium',
      layer: 'shell-config',
      title: '别名指向不存在的命令',
      evidence: `${info.file}:${info.lineNo} alias ${name} -> ${info.cmd}`,
      path: info.file,
      recommendation: 'Remove the alias or reinstall the missing command.',
    });
    act({
      tier: 'review',
      category: 'shell-config',
      title: `删除指向缺失命令的别名 "${name}"`,
      evidence: `${info.file}:${info.lineNo} alias ${name} -> ${info.cmd}`,
      why: `The target command "${info.cmd}" is not on PATH.`,
      reversal: 'The rc file is backed up; undo restores it.',
      sizeBytes: 0,
      operation: { type: 'remove-lines', file: info.file, edits: [{ line: info.lineNo, expected: info.line }] },
    });
  }

  if (managers.size > 1) {
    add({
      severity: 'medium',
      layer: 'shell-config',
      title: '同时启用了多个版本管理器',
      evidence: [...managers.entries()].map(([n, f]) => `${n} (${f.join(', ')})`).join('; '),
      recommendation: 'Keep one manager (mise/asdf are supersets); remove the others from rc.',
    });
  }

  if (brewShellenv.length > 1) {
    add({
      severity: 'low',
      layer: 'shell-config',
      title: 'brew shellenv 被重复执行',
      evidence: brewShellenv.map((b) => `${b.file}:${b.lineNo}`).join(', '),
      recommendation: 'Keep a single eval "$(brew shellenv)" line.',
    });
  }

  return { scanned, aliasCount: aliasTargets.size, missingAliases: missingAliases.length, deadEntries };
}

function checkAliases(aliasTargets) {
  const names = [...aliasTargets.keys()];
  if (!names.length || !LIVE_SHELL) return [];
  const script = names
    .map((n) => `command -v '${n}' >/dev/null 2>&1 || print -r -- 'MISSING:${n}'`)
    .join('\n');
  const r = run('/bin/zsh', ['-lic', script], { timeout: 20000 });
  if (!r.ok) return [];
  return [...r.stdout.matchAll(/MISSING:([A-Za-z0-9_.+-]+)/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------- launchd

function auditLaunchd() {
  const dirs = [path.join(HOME, 'Library/LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons'];
  let total = 0;
  let orphans = 0;

  for (const dir of dirs) {
    if (!exists(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter((n) => n.endsWith('.plist'));
    } catch {
      continue;
    }
    for (const name of entries) {
      total += 1;
      const plist = path.join(dir, name);
      const r = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { timeout: 5000 });
      if (!r.ok) continue;
      let j;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        continue;
      }
      const program =
        j.Program || j.BundleProgram || (Array.isArray(j.ProgramArguments) ? j.ProgramArguments[0] : null);
      if (typeof program !== 'string' || !program.startsWith('/')) continue;
      if (exists(program)) continue;

      orphans += 1;
      const userLevel = dir.startsWith(HOME);
      add({
        severity: 'high',
        layer: 'launchd',
        title: '后台服务指向不存在的可执行文件',
        evidence: `${plist} label=${j.Label || '?'} program=${program}`,
        path: plist,
        recommendation: userLevel
          ? 'Leftover from a removed tool; boot it out and remove the plist.'
          : 'System-wide leftover; removal requires sudo and manual review.',
      });
      if (userLevel && j.Label) {
        act({
          tier: 'review',
          category: 'launchd',
          title: `卸载并移除后台服务 ${j.Label}`,
          evidence: `label=${j.Label} program=${program} (missing)`,
          why: 'The job cannot start because its executable is gone.',
          reversal: 'The plist is moved to Trash; reinstall the owning tool to recreate it.',
          sizeBytes: 0,
          operation: { type: 'launchd-bootout', label: j.Label, plist },
        });
      }
    }
  }
  return { files: total, orphans };
}

// ---------------------------------------------------------------- apps

function bundleId(appPath) {
  const info = path.join(appPath, 'Contents', 'Info.plist');
  if (!exists(info)) return null;
  const r = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info], { timeout: 4000 });
  const id = r.ok ? r.stdout.trim() : '';
  return id && !/\s/.test(id) ? id : null;
}

function listApps(dir) {
  if (!exists(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name.endsWith('.app'))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function findBrew() {
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) if (exists(p)) return p;
  const r = run('/usr/bin/which', ['brew'], { timeout: 3000 });
  return r.ok ? r.stdout.trim() : null;
}

const BREW_ENV = {
  ...process.env,
  HOMEBREW_NO_AUTO_UPDATE: '1',
  HOMEBREW_NO_ANALYTICS: '1',
  HOMEBREW_NO_ENV_HINTS: '1',
};

function brewCaskAppMap(brew, casks) {
  if (!brew || !casks.length) return new Map();
  const r = run(brew, ['info', '--cask', '--json=v2', ...casks], { timeout: 45000, env: BREW_ENV });
  if (!r.ok) return new Map();
  const map = new Map();
  try {
    const j = JSON.parse(r.stdout);
    for (const c of j.casks || []) {
      for (const artifact of c.artifacts || []) {
        const apps = artifact && artifact.app;
        if (!Array.isArray(apps)) continue;
        for (const a of apps) {
          const target = typeof a === 'string' ? a : a && a.target;
          if (target) map.set(path.basename(target), c.token);
        }
      }
    }
  } catch {
    /* fall back to name heuristic */
  }
  return map;
}

function lastUsed(p) {
  const r = run('/usr/bin/mdls', ['-name', 'kMDItemLastUsedDate', '-raw', p], { timeout: 5000 });
  const v = r.stdout.trim();
  if (!v || v === '(null)') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function residuesFor(app) {
  const out = [];
  const addPath = (p) => {
    if (p && exists(p) && !out.includes(p)) out.push(p);
  };
  const addMatching = (dir, predicate) => {
    if (!exists(dir)) return;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (predicate(name)) addPath(path.join(dir, name));
      }
    } catch {
      /* unreadable directory */
    }
  };
  const name = app.name.replace(/\.app$/i, '');
  const id = app.bundleId;
  if (id) {
    addPath(path.join(HOME, 'Library/Application Support', id));
    addPath(path.join(HOME, 'Library/Preferences', `${id}.plist`));
    addPath(path.join(HOME, 'Library/Caches', id));
    addPath(path.join(HOME, 'Library/Containers', id));
    addPath(path.join(HOME, 'Library/Saved Application State', `${id}.savedState`));
    addPath(path.join(HOME, 'Library/WebKit', id));
    addPath(path.join(HOME, 'Library/HTTPStorages', id));
    addPath(path.join(HOME, 'Library/Application Scripts', id));
    addPath(path.join(HOME, 'Library/Logs', name));
    addMatching(path.join(HOME, 'Library/Preferences/ByHost'), (n) => n.startsWith(`${id}.`) && n.endsWith('.plist'));
    addMatching(path.join(HOME, 'Library/Group Containers'), (n) => n === id || n.endsWith(`.${id}`));
  }
  addPath(path.join(HOME, 'Library/Application Support', name));
  addPath(path.join(HOME, 'Library/Caches', name));

  const agents = [];
  const agentsDir = path.join(HOME, 'Library/LaunchAgents');
  if (id && exists(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir).filter((n) => n.endsWith('.plist'))) {
      const p = path.join(agentsDir, f);
      try {
        const text = fs.readFileSync(p, 'utf8');
        if (!text.includes(id)) continue;
        const m = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
        agents.push({ plist: p, label: m ? m[1] : null });
        if (!out.includes(p)) out.push(p);
      } catch {
        /* unreadable plist */
      }
    }
  }
  return { residues: out, agents };
}

function auditApps() {
  const brew = findBrew();
  let casks = [];
  let leaves = [];
  if (brew) {
    const c = run(brew, ['list', '--cask'], { timeout: 20000, env: BREW_ENV });
    if (c.ok) casks = c.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const l = run(brew, ['leaves'], { timeout: 25000, env: BREW_ENV });
    if (l.ok) leaves = l.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const caskMap = brewCaskAppMap(brew, casks);
  const caskFallback = new Map(casks.map((t) => [t.toLowerCase(), t]));

  const apps = [];
  const unknownApps = [];
  const noUsage = [];
  const appPaths = [];
  for (const dir of ['/Applications', path.join(HOME, 'Applications')]) {
    for (const appPath of listApps(dir)) appPaths.push({ appPath, dir });
  }
  const sizes = duSizes(appPaths.map((a) => a.appPath));

  for (const { appPath, dir } of appPaths) {
    const name = path.basename(appPath);
    const id = bundleId(appPath);
    const mas = exists(path.join(appPath, 'Contents', '_MASReceipt', 'receipt'));
    let source = 'unknown';
    let confidence = 'low';
    if (id?.startsWith('com.apple.')) {
      source = 'apple-system';
      confidence = 'high';
    } else if (caskMap.has(name)) {
      source = `homebrew-cask:${caskMap.get(name)}`;
      confidence = 'high';
    } else if (mas) {
      source = 'app-store';
      confidence = 'high';
    } else if (caskFallback.has(name.replace(/\.app$/i, '').toLowerCase())) {
      source = `homebrew-cask:~${caskFallback.get(name.replace(/\.app$/i, '').toLowerCase())}`;
      confidence = 'medium';
    }
    const sizeBytes = sizes.get(appPath) || 0;
    const used = lastUsed(appPath);
    const app = { name, path: appPath, bundleId: id, source, sourceConfidence: confidence, sizeBytes, lastUsed: used ? new Date(used).toISOString() : null };
    apps.push(app);

    if (id?.startsWith('com.apple.') || source === 'apple-system') continue;

    const nameNoExt = name.replace(/\.app$/i, '').toLowerCase();
    const requested = REQUESTED_APPS.some((r) => {
      const q = r.toLowerCase().replace(/\.app$/i, '');
      return q === nameNoExt || q === (id || '').toLowerCase();
    });
    const mtime = fs.statSync(appPath).mtimeMs;
    const sizeGate = sizeBytes >= 100 * 1024 * 1024;
    const unusedCandidate = Boolean(used) && Date.now() - used > 365 * DAY && sizeGate;
    const noUsageRecord = !used && Date.now() - mtime > 365 * DAY && sizeGate;
    const isComponent = /(helper|url handler|updater|uninstaller|installer|agent)/i.test(name);

    if (requested || (!isComponent && (dir !== '/Applications' || unusedCandidate))) {
      const { residues, agents } = residuesFor(app);
      const residueBytes = [...duSizes(residues).values()].reduce((n, v) => n + v, 0);
      const reasons = [];
      if (requested) reasons.push('用户指定');
      if (dir !== '/Applications') reasons.push('安装在 /Applications 之外');
      if (unusedCandidate) reasons.push(`最后使用 ${app.lastUsed}`);
      act({
        tier: 'review',
        category: 'app',
        title: `卸载 ${name}`,
        evidence: `${appPath} (${source === 'unknown' ? '来源未知' : source}, ${fmtBytes(sizeBytes)}${reasons.length ? `, ${reasons.join('; ')}` : ''})`,
        why: reasons.join('; ') || 'explicitly selected',
        reversal: 'App and residue are moved to Trash in one folder; undo moves them back.',
        sizeBytes: sizeBytes + residueBytes,
        operation: {
          type: 'uninstall',
          app: appPath,
          bundleId: id,
          residues,
          agents,
        },
      });
    } else {
      if (noUsageRecord) noUsage.push(`${name} (${fmtBytes(sizeBytes)})`);
      if (source === 'unknown') unknownApps.push(name);
    }
  }

  if (noUsage.length) {
    add({
      severity: 'info',
      layer: 'apps',
      title: `${noUsage.length} 个应用无使用记录但安装时间较早`,
      evidence: noUsage.join(', '),
      recommendation:
        'Spotlight often has no last-used date, so these are NOT proven unused. Confirm manually; to remove one, re-run with --app "<name>".',
    });
  }

  if (unknownApps.length) {
    add({
      severity: 'info',
      layer: 'apps',
      title: `${unknownApps.length} 个应用来源未知`,
      evidence: unknownApps.join(', '),
      recommendation: 'Likely pkg or manual installs. Confirm ownership before planning removal; none are auto-selected.',
    });
  }

  return { apps, casks, leaves, brew, caskConfidence: caskMap.size ? 'high' : 'heuristic' };
}

// ---------------------------------------------------------------- residue

const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9_-]+){2,}$/;
// Sub-components of an installed app, not standalone leftovers.
const COMPONENT_RE = /(helper|updater|crashpad|renderer|daemon|service|services|monitor|launcher|proxy|extension)/i;

function belongsToInstalled(name, installedIds) {
  const n = name.toLowerCase();
  for (const id of installedIds) {
    if (n === id || n.startsWith(`${id}.`) || id.startsWith(`${n}.`)) return true;
  }
  return false;
}

function auditOrphanResidue(installedIds, installedNames) {
  const dirs = [
    ['Library/Application Support', 'data', ''],
    ['Library/Caches', 'cache', ''],
    ['Library/Containers', 'container', ''],
    ['Library/Group Containers', 'group-container', ''],
    ['Library/Saved Application State', 'state', '.savedState'],
    ['Library/WebKit', 'webkit', ''],
    ['Library/HTTPStorages', 'http', ''],
  ];
  const now = Date.now();
  const candidates = [];

  for (const [rel, kind, suffix] of dirs) {
    const dir = path.join(HOME, rel);
    if (!exists(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const raw of entries) {
      let name = suffix ? raw.replace(new RegExp(`${suffix.replace('.', '\\.')}$`), '') : raw;
      if (name.endsWith('.binarycookies')) name = name.slice(0, -'.binarycookies'.length);
      // Group containers are prefixed with the developer team id: <TEAMID>.<bundle-id>
      if (kind === 'group-container') name = name.replace(/^[A-Z0-9]{10}\./, '');
      if (!BUNDLE_RE.test(name)) continue;
      if (/^(groups?\.)?com\.apple\./i.test(name)) continue;
      if (COMPONENT_RE.test(name)) continue;
      if (belongsToInstalled(name, installedIds)) continue;
      if (installedNames.has(normalizeName(name))) continue;
      const p = path.join(dir, raw);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (now - st.mtimeMs < 30 * DAY) continue;
      candidates.push({ path: p, kind, name, mtime: st.mtimeMs });
    }
  }

  const sizes = duSizes(candidates.map((c) => c.path));
  const ranked = candidates
    .map((c) => ({ ...c, sizeBytes: sizes.get(c.path) || 0 }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  const limit = 15;
  const minBytes = 5 * 1024 * 1024;
  const eligible = ranked.filter((c) => c.sizeBytes >= minBytes).slice(0, limit);

  for (const c of eligible) {
    act({
      tier: 'review',
      category: 'app-residue',
      title: `清理孤立残留 ${c.name}（${c.kind}）`,
      evidence: `${c.path} (${fmtBytes(c.sizeBytes)}，最近改动 ${new Date(c.mtime).toISOString().slice(0, 10)})`,
      why: 'No installed app matches this bundle id, it is not a known sub-component, and nothing touched it in 30+ days.',
      reversal: 'Moved to Trash; undo restores the original location.',
      sizeBytes: c.sizeBytes,
      operation: { type: 'trash', targets: [c.path] },
    });
  }
  if (ranked.length > eligible.length) {
    add({
      severity: 'info',
      layer: 'apps',
      title: `${ranked.length - eligible.length} 个孤立残留低于计划阈值`,
      evidence: ranked
        .slice(eligible.length, eligible.length + 10)
        .map((c) => `${c.name} (${fmtBytes(c.sizeBytes)})`)
        .join(', '),
      recommendation: `Only items above ${fmtBytes(minBytes)} are planned, capped at ${limit}. Review the rest manually if needed.`,
    });
  }
  return { candidates: ranked.length, planned: eligible.length };
}

function normalizeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------- bin dirs

function auditBinDirs(liveDirs) {
  const dirs = [
    ['/usr/local/bin', 'legacy Intel-style location'],
    [path.join(HOME, '.local/bin'), 'per-user manual install'],
    [path.join(HOME, 'bin'), 'per-user manual install'],
  ];
  const out = [];
  const brokenLinks = [];

  for (const [dir, label] of dirs) {
    if (!exists(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir).slice(0, 2000);
    } catch {
      continue;
    }
    let executables = 0;
    let broken = 0;
    for (const name of entries) {
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = '';
        try {
          target = fs.readlinkSync(p);
        } catch {
          continue;
        }
        const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
        if (!exists(resolved)) {
          broken += 1;
          brokenLinks.push({ link: p, target: resolved });
        }
        continue;
      }
      if (st.isFile() && (st.mode & 0o111) !== 0) executables += 1;
    }
    out.push({ dir, label, executables, broken });
    if (!liveDirs.includes(dir)) {
      add({
        severity: 'info',
        layer: 'install-source',
        title: 'bin 目录不在 PATH 中',
        evidence: `${dir} holds ${executables} executable(s) but is absent from the live PATH`,
        path: dir,
        recommendation: 'Either add it to PATH deliberately or remove the stale installs.',
      });
    }
  }

  const groups = new Map();
  for (const { link, target } of brokenLinks) {
    const appHit = target.indexOf('.app/');
    const owner = appHit > 0 ? target.slice(0, appHit + 4) : path.dirname(target);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(link);
  }
  for (const [owner, links] of groups) {
    add({
      severity: 'medium',
      layer: 'install-source',
      title: '已卸载应用留下的断链',
      evidence: `${links.length} link(s) -> missing ${owner}: ${links.slice(0, 5).join(', ')}${links.length > 5 ? ', ...' : ''}`,
      path: links[0],
      recommendation: `Delete the dangling links; the target under ${owner} is gone.`,
    });
    act({
      tier: 'safe',
      category: 'symlink',
      title: `清理 ${links.length} 条失效软链`,
      evidence: links.join(', '),
      why: `All targets under ${owner} no longer exist.`,
      reversal: 'Links are moved to Trash and can be restored.',
      sizeBytes: 0,
      operation: { type: 'trash', targets: links },
    });
  }

  return out;
}

// ---------------------------------------------------------------- brew + caches

function auditBrew(brew, leaves, casks, apps) {
  const installed = [];
  if (!brew) {
    return { autoremove: [], cacheBytes: 0, installed, formulae: leaves.length, casks: casks.length };
  }

  const prefix = path.dirname(path.dirname(brew));
  const cellar = path.join(prefix, 'Cellar');
  const caskroom = path.join(prefix, 'Caskroom');

  const fv = run(brew, ['list', '--formula', '--versions'], { timeout: 20000, env: BREW_ENV });
  const fVersions = new Map();
  if (fv.ok) {
    for (const line of fv.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts[0]) fVersions.set(parts[0], parts.slice(1).join(' '));
    }
  }
  const fPaths = leaves.map((n) => path.join(cellar, n));
  const fSizes = duSizes(fPaths);
  leaves.forEach((n, i) =>
    installed.push({
      manager: 'Homebrew',
      name: n,
      version: fVersions.get(n) || '',
      sizeBytes: fSizes.get(fPaths[i]) || 0,
      kind: 'formula',
      path: fPaths[i],
    }),
  );

  const cv = run(brew, ['list', '--cask', '--versions'], { timeout: 20000, env: BREW_ENV });
  const cVersions = new Map();
  if (cv.ok) {
    for (const line of cv.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts[0]) cVersions.set(parts[0], parts.slice(1).join(' '));
    }
  }
  const appByToken = new Map();
  for (const a of apps) {
    const m = /^homebrew-cask:(.+)$/.exec(a.source || '');
    if (m) appByToken.set(m[1], a);
  }
  const cPaths = casks.map((t) => path.join(caskroom, t));
  const cSizes = duSizes(cPaths);
  casks.forEach((t, i) => {
    const app = appByToken.get(t);
    installed.push({
      manager: 'Homebrew Cask',
      name: t,
      version: cVersions.get(t) || '',
      sizeBytes: (cSizes.get(cPaths[i]) || 0) + (app?.sizeBytes || 0),
      kind: 'cask',
      path: app?.path || cPaths[i],
      appSize: app?.sizeBytes || 0,
    });
  });

  const bases = new Map();
  for (const n of leaves) {
    const b = n.split('@')[0];
    if (!bases.has(b)) bases.set(b, []);
    bases.get(b).push(n);
  }
  for (const [b, list] of bases) {
    if (list.length > 1) {
      add({
        severity: 'info',
        layer: 'install-source',
        title: `Homebrew 同时安装了 ${b} 的多个版本`,
        evidence: list.join(', '),
        recommendation: '确认旧版本是否仍被依赖，再决定是否移除。',
      });
    }
  }
  const dry = run(brew, ['autoremove', '-n'], { timeout: 60000, env: BREW_ENV });
  const autoremove = dry.ok
    ? dry.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /^[A-Za-z0-9@._+-]+$/.test(s))
    : [];

  if (autoremove.length) {
    act({
      tier: 'review',
      category: 'package-manager',
      title: `清理 ${autoremove.length} 个无用的 Homebrew 依赖`,
      evidence: autoremove.join(', '),
      why: 'Installed only as dependencies of formulae that are no longer installed.',
      reversal: 'Reinstall with brew install; downloads will be cached again.',
      sizeBytes: 0,
      operation: { type: 'brew', args: ['autoremove'] },
    });
  }

  const cacheDir = path.join(HOME, 'Library/Caches/Homebrew');
  claimedPaths.add(cacheDir);
  const cacheBytes = exists(cacheDir) ? Number(run('/usr/bin/du', ['-sk', cacheDir]).stdout.split('\t')[0]) * 1024 || 0 : 0;
  if (cacheBytes > 100 * 1024 * 1024) {
    act({
      tier: 'safe',
      category: 'package-manager',
      title: '清理 Homebrew 缓存与旧版本',
      evidence: `${cacheDir} (${fmtBytes(cacheBytes)})`,
      why: 'Downloads and superseded versions are not needed by installed formulae.',
      reversal: 'brew re-downloads binaries when needed; installed formulae stay.',
      sizeBytes: cacheBytes,
      operation: { type: 'brew', args: ['cleanup', '--prune=all'] },
    });
  }
  return { autoremove, cacheBytes, installed, formulae: leaves.length, casks: casks.length };
}

const MB = 1024 * 1024;

function collectCachesAndDev() {
  const specs = [
    ['dev-cache', '清理 npm 缓存', '.npm/_cacache', 'safe', 100 * MB],
    ['dev-cache', '清理 pip 缓存', 'Library/Caches/pip', 'safe', 100 * MB],
    ['dev-cache', '清理 pip 缓存 (XDG)', '.cache/pip', 'safe', 100 * MB],
    ['dev-cache', '清理 uv 缓存', '.cache/uv', 'safe', 100 * MB],
    ['dev-cache', '清理 Poetry 缓存', 'Library/Caches/pypoetry', 'safe', 100 * MB],
    ['dev-cache', '清理 CocoaPods 缓存', 'Library/Caches/CocoaPods', 'safe', 100 * MB],
    ['dev-cache', '清理 Cargo 下载缓存', '.cargo/registry/cache', 'safe', 100 * MB],
    ['dev-cache', '清理 Go 构建缓存', 'Library/Caches/go-build', 'safe', 100 * MB],
    ['dev-cache', '清理 Go 模块缓存', 'go/pkg/mod/cache/download', 'safe', 100 * MB],
    ['dev-cache', '清理 Yarn 缓存', 'Library/Caches/Yarn', 'safe', 100 * MB],
    ['dev-cache', '清理 sccache', 'Library/Caches/Mozilla.sccache', 'safe', 100 * MB],
    ['dev-cache', '清理 pnpm store', 'Library/pnpm/store', 'review', 200 * MB],
    ['dev-cache', '清理 Gradle 缓存', '.gradle/caches', 'review', 200 * MB],
    ['dev-cache', '清理 Maven 仓库', '.m2/repository', 'review', 200 * MB],
    ['dev-cache', '清理 Dart/Flutter 包缓存', '.pub-cache', 'review', 200 * MB],
    ['dev-cache', '清理 Playwright 浏览器', 'Library/Caches/ms-playwright', 'review', 200 * MB],
    ['dev-cache', '清理 HuggingFace 模型缓存', '.cache/huggingface', 'review', 500 * MB],
    ['dev-cache', '清理 VS Code 缓存', 'Library/Caches/com.microsoft.VSCode', 'safe', 100 * MB],
    ['dev-cache', '清理 JetBrains 缓存', 'Library/Caches/JetBrains', 'safe', 100 * MB],
    ['dev-cache', '清理 Xcode DerivedData', 'Library/Developer/Xcode/DerivedData', 'review', 200 * MB],
    ['dev-cache', '清理模拟器缓存', 'Library/Developer/CoreSimulator/Caches', 'safe', 100 * MB],
  ];
  for (const [category, title, rel, tier, minBytes] of specs) {
    candidate({
      category,
      title,
      path: path.join(HOME, rel),
      tier,
      minBytes,
      why: tier === 'safe' ? '缓存会在下次使用时自动重建。' : '可在下次构建或下载时重建，首次会变慢。',
    });
  }

  const dir = path.join(HOME, 'Library/Caches');
  if (!exists(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const e of entries.slice(0, 60)) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('com.apple.')) continue;
    const p = path.join(dir, e.name);
    if (claimedPaths.has(p)) continue;
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < 30 * DAY) continue;
    candidate({
      category: 'cache',
      title: `应用缓存：${e.name}`,
      path: p,
      tier: 'review',
      minBytes: 500 * MB,
      why: '30 天未改动且超过 500 MB 的应用缓存，可重建。',
    });
  }
}

function collectBrowsers() {
  const browsers = [
    ['Chrome', [path.join(HOME, 'Library/Caches/Google/Chrome'), path.join(HOME, 'Library/Caches/com.google.Chrome')]],
    [
      'Safari',
      [
        path.join(HOME, 'Library/Caches/com.apple.Safari'),
        path.join(HOME, 'Library/Containers/com.apple.Safari/Data/Library/Caches'),
      ],
    ],
    ['Firefox', [path.join(HOME, 'Library/Caches/Firefox')]],
    [
      'Edge',
      [path.join(HOME, 'Library/Caches/Microsoft Edge'), path.join(HOME, 'Library/Caches/com.microsoft.edgemac')],
    ],
    ['Brave', [path.join(HOME, 'Library/Caches/BraveSoftware')]],
    ['Arc', [path.join(HOME, 'Library/Caches/company.thebrowser.Browser')]],
  ];
  const profiles = [
    ['Chrome', path.join(HOME, 'Library/Application Support/Google/Chrome')],
    ['Edge', path.join(HOME, 'Library/Application Support/Microsoft Edge')],
    ['Brave', path.join(HOME, 'Library/Application Support/BraveSoftware/Brave-Browser')],
    ['Arc', path.join(HOME, 'Library/Application Support/Arc/User Data')],
  ];
  const subdirs = ['Cache', 'Code Cache', 'GPUCache', 'Service Worker/CacheStorage'];

  for (const [name, root] of profiles) {
    if (!exists(root)) continue;
    let profs = [];
    try {
      profs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    const entry = browsers.find((b) => b[0] === name);
    for (const prof of profs) {
      for (const sub of subdirs) {
        const p = path.join(root, prof, sub);
        if (exists(p)) entry[1].push(p);
      }
    }
  }
  const ffProfiles = path.join(HOME, 'Library/Application Support/Firefox/Profiles');
  if (exists(ffProfiles)) {
    try {
      for (const prof of fs.readdirSync(ffProfiles)) {
        const p = path.join(ffProfiles, prof, 'cache2');
        if (exists(p)) browsers.find((b) => b[0] === 'Firefox')[1].push(p);
      }
    } catch {
      /* unreadable */
    }
  }

  for (const [name, paths] of browsers) {
    const list = [...new Set(paths)];
    if (!list.some(exists)) continue;
    candidate({
      category: 'browser',
      title: `清理 ${name} 浏览器缓存`,
      paths: list,
      tier: 'review',
      minBytes: 50 * MB,
      why: '只清缓存，不动历史记录、书签和登录状态。',
      reversal: '缓存自动重建，不影响登录。',
    });
  }
}

function collectSystemJunk() {
  const junk = [
    ['~/Library/Logs/DiagnosticReports', '清理崩溃报告', 'Library/Logs/DiagnosticReports', 'safe', 10 * MB],
    ['~/Library/Application Support/CrashReporter', '清理 CrashReporter 数据', 'Library/Application Support/CrashReporter', 'review', 10 * MB],
    ['~/Library/iTunes/iPhone Software Updates', '清理旧 iOS 固件', 'Library/iTunes/iPhone Software Updates', 'review', 100 * MB],
    ['Mail Downloads', '清理邮件附件下载', 'Library/Containers/com.apple.mail/Data/Library/Mail Downloads', 'review', 100 * MB],
    ['Messages Attachments', '清理信息附件', 'Library/Messages/Attachments', 'review', 200 * MB],
  ];
  for (const [, title, rel, tier, minBytes] of junk) {
    candidate({
      category: 'system-junk',
      title,
      path: path.join(HOME, rel),
      tier,
      minBytes,
      why: '日志、崩溃报告与附件缓存可以安全移除。',
    });
  }

  candidate({
    category: 'system-junk',
    title: '系统级缓存 /Library/Caches',
    path: '/Library/Caches',
    tier: 'manual',
    minBytes: 100 * MB,
    operation: 'manual',
    note: '系统级缓存需要 sudo；用图形化存储管理或自行确认后清理，本工具不执行。',
    why: '系统级缓存长期累积，可能占用数 GB。',
  });
  candidate({
    category: 'system-junk',
    title: '休眠镜像 /private/var/vm/sleepimage',
    path: '/private/var/vm/sleepimage',
    tier: 'manual',
    minBytes: 500 * MB,
    operation: 'manual',
    note: '需要 sudo；关闭休眠镜像前先确认 FileVault 与休眠设置。',
    why: '休眠镜像大小约等于内存容量。',
  });
  candidate({
    category: 'system-junk',
    title: '系统崩溃日志 /Library/Logs/DiagnosticReports',
    path: '/Library/Logs/DiagnosticReports',
    tier: 'manual',
    minBytes: 100 * MB,
    operation: 'manual',
    note: '需要 sudo；仅删除旧报告，保留最近一周。',
    why: '系统级崩溃报告会持续累积。',
  });
}

function collectBuildArtifacts() {
  const skip = ['Library', '.Trash', 'Movies', '.cargo', '.rustup', 'go', '.npm', '.gradle', '.m2'].map((p) =>
    path.join(HOME, p),
  );
  const args = [HOME, '-maxdepth', '4', '('];
  skip.forEach((p, i) => {
    if (i) args.push('-o');
    args.push('-path', p);
  });
  args.push(
    ')',
    '-prune',
    '-o',
    '-type',
    'd',
    '(',
    '-name',
    'node_modules',
    '-o',
    '-name',
    '.venv',
    '-o',
    '-name',
    'target',
    '-o',
    '-name',
    '.zig-cache',
    ')',
    '-prune',
    '-print',
  );
  const r = run('/usr/bin/find', args, { timeout: 90000 });
  if (!r.ok) return;
  const markers = {
    node_modules: ['package.json'],
    '.venv': ['pyproject.toml', 'requirements.txt', 'Pipfile'],
    target: ['Cargo.toml'],
    '.zig-cache': ['build.zig'],
  };
  const now = Date.now();
  const found = [];
  for (const p of r.stdout.split('\n').filter(Boolean)) {
    const base = path.basename(p);
    const parent = path.dirname(p);
    if (!(markers[base] || []).some((m) => exists(path.join(parent, m)))) continue;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < 30 * DAY) continue;
    found.push({ p, base, parent });
  }
  for (const f of found.slice(0, 40)) {
    candidate({
      category: 'build-artifacts',
      title: `构建产物：${path.basename(f.parent)}/${f.base}`,
      path: f.p,
      tier: 'review',
      minBytes: 200 * MB,
      why: '项目构建/依赖目录，可由包管理器或构建命令重新生成。',
    });
  }
}

function collectDeviceData() {
  candidate({
    category: 'device-data',
    title: 'iOS 设备备份',
    path: path.join(HOME, 'Library/Application Support/MobileSync/Backup'),
    tier: 'manual',
    minBytes: 100 * MB,
    operation: 'manual',
    note: '备份含个人数据；请在 Finder 的设备管理中删除，本工具不代删。',
    why: '旧 iPhone/iPad 备份经常占用数十 GB。',
  });
  for (const [title, rel, minBytes] of [
    ['Xcode iOS DeviceSupport', 'Library/Developer/Xcode/iOS DeviceSupport', 500 * MB],
    ['CoreSimulator 设备数据', 'Library/Developer/CoreSimulator/Devices', 1024 * MB],
    ['CoreSimulator 运行时', 'Library/Developer/CoreSimulator/Profiles/Runtimes', 1024 * MB],
    ['Xcode Archives', 'Library/Developer/Xcode/Archives', 500 * MB],
    ['Android 模拟器 (AVD)', '.android/avd', 1024 * MB],
    ['Android 系统镜像', 'Library/Android/sdk/system-images', 1024 * MB],
  ]) {
    candidate({
      category: 'device-data',
      title,
      path: path.join(HOME, rel),
      tier: 'review',
      minBytes,
      why: '设备支持文件、模拟器与归档可按需重新生成或重新下载。',
      reversal: '移至废纸篓；撤销可恢复，重新连接设备会重建部分数据。',
    });
  }
}

function collectVmAndContainers() {
  for (const [title, rel] of [
    ['虚拟机：Parallels', 'Parallels'],
    ['虚拟机：UTM', 'Library/Containers/com.utmapp.UTM/Data/Documents'],
    ['虚拟机：VMware Fusion', 'Library/Application Support/VMware Fusion/Virtual Machines'],
    ['虚拟机：VirtualBox', 'VirtualBox VMs'],
  ]) {
    candidate({
      category: 'vm-container',
      title,
      path: path.join(HOME, rel),
      tier: 'review',
      minBytes: 1024 * MB,
      why: '虚拟机会占用大量空间；删除前确认其中没有需要保留的系统。',
    });
  }

  const docker = run('/usr/bin/env', ['docker', 'system', 'df'], { timeout: 8000 });
  if (docker.ok && docker.stdout.trim()) {
    act({
      tier: 'manual',
      category: 'vm-container',
      title: 'Docker 磁盘占用',
      evidence: docker.stdout.trim().split('\n').slice(0, 6).join(' | '),
      why: '停止的容器、悬空镜像和构建缓存可以由 Docker 自己回收。',
      reversal: '删除的镜像和容器无法恢复；需要时重新拉取/构建。',
      sizeBytes: 0,
      operation: {
        type: 'manual',
        note: '先运行 docker system df 确认；需要时执行 docker system prune（会删除停止的容器和悬空镜像）。',
      },
    });
  }
}

function collectDownloads() {
  const dir = path.join(HOME, 'Downloads');
  if (!exists(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  const installers = [];
  const large = [];
  for (const e of entries) {
    if (!e.isFile() && !e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    const age = now - st.mtimeMs;
    const ext = path.extname(e.name).toLowerCase();
    if (['.dmg', '.pkg', '.mpkg', '.iso'].includes(ext) && age > 30 * DAY) {
      installers.push({ p, name: e.name, sizeBytes: st.size, mtime: st.mtimeMs });
    } else if (age > 90 * DAY && st.size >= 1024 * MB) {
      large.push({ p, name: e.name, sizeBytes: st.size });
    }
  }
  installers
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 10)
    .forEach((i) =>
      candidate({
        category: 'downloads',
        title: `旧安装包：${i.name}`,
        path: i.p,
        tier: 'review',
        minBytes: 100 * MB,
        why: '30 天以上的安装包，安装完成后通常不再需要。',
      }),
    );
  if (large.length) {
    add({
      severity: 'info',
      layer: 'install-source',
      title: `${large.length} 个下载目录大文件（90 天以上）`,
      evidence: large
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
        .slice(0, 10)
        .map((f) => `${f.name} (${fmtBytes(f.sizeBytes)})`)
        .join(', '),
      recommendation: '个人文件不做自动清理；确认后可自行删除。',
    });
  }
}

function collectTrashAndSnapshots() {
  candidate({
    category: 'trash',
    title: '废纸篓',
    path: path.join(HOME, '.Trash'),
    tier: 'manual',
    minBytes: 100 * MB,
    operation: 'manual',
    note: '清空废纸篓会同时销毁本工具的撤销记录；确认恢复期已过再清空。',
    why: '废纸篓占用空间，但清空后无法撤销。',
  });

  const snaps = run('/usr/bin/tmutil', ['listlocalsnapshots', '/'], { timeout: 15000 });
  if (snaps.ok) {
    const dates = snaps.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.includes('com.apple.TimeMachine'));
    if (dates.length) {
      act({
        tier: 'manual',
        category: 'snapshots',
        title: `本地 Time Machine 快照 ${dates.length} 个`,
        evidence: dates.slice(0, 3).join(', '),
        why: 'APFS 本地快照会占用“可清除”空间，通常会自动过期。',
        reversal: '删除后无法恢复；确认不需要回滚后再操作。',
        sizeBytes: 0,
        operation: {
          type: 'manual',
          note: 'sudo tmutil deletelocalsnapshots <日期>，或等待系统自动清理。',
        },
      });
    }
  }
}

function readShellHistory() {
  let text = '';
  for (const rel of ['.zsh_history', '.bash_history']) {
    const p = path.join(HOME, rel);
    try {
      const st = fs.statSync(p);
      const len = Math.min(st.size, 5 * 1024 * 1024);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      fs.closeSync(fd);
      text += buf.toString('utf8').toLowerCase();
    } catch {
      /* no history */
    }
  }
  return text;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function usedInHistory(name, text) {
  const base = String(name).split('/').pop().split('@')[0].toLowerCase();
  if (!text || base.length < 3) return null;
  return new RegExp(`(^|[^a-z0-9_-])${escapeRe(base)}([^a-z0-9_-]|$)`, 'm').test(text);
}

function auditPackageManagers() {
  const out = { npm: [], pipx: [], cargo: [], gemCount: 0 };

  const npm = run('/usr/bin/env', ['npm', 'ls', '-g', '--depth=0', '--json'], { timeout: 20000 });
  if (npm.ok) {
    try {
      const deps = JSON.parse(npm.stdout).dependencies || {};
      const rootR = run('/usr/bin/env', ['npm', 'root', '-g'], { timeout: 10000 });
      const root = rootR.ok ? rootR.stdout.trim() : '';
      const entries = Object.entries(deps).map(([name, meta]) => ({
        manager: 'npm',
        name,
        version: meta?.version || '',
        path: root ? path.join(root, name) : '',
        kind: 'cli',
      }));
      const sizes = duSizes(entries.map((e) => e.path).filter(Boolean));
      out.npm = entries.map((e) => ({ ...e, sizeBytes: sizes.get(e.path) || 0 }));
    } catch {
      /* unparsable npm output */
    }
  }

  const pipx = run('/usr/bin/env', ['pipx', 'list', '--json'], { timeout: 15000 });
  if (pipx.ok) {
    try {
      const j = JSON.parse(pipx.stdout);
      for (const [name, v] of Object.entries(j.venvs || {})) {
        out.pipx.push({
          manager: 'pipx',
          name,
          version: v?.metadata?.main_package?.package_version || '',
          sizeBytes: 0,
          path: path.join(HOME, '.local/pipx/venvs', name),
          kind: 'cli',
        });
      }
    } catch {
      /* fall back to --short */
    }
  }
  if (!out.pipx.length) {
    const short = run('/usr/bin/env', ['pipx', 'list', '--short'], { timeout: 15000 });
    if (short.ok) {
      out.pipx = short.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({
          manager: 'pipx',
          name,
          version: '',
          sizeBytes: 0,
          path: path.join(HOME, '.local/pipx/venvs', name),
          kind: 'cli',
        }));
    }
  }
  const pipxSizes = duSizes(out.pipx.map((e) => e.path));
  out.pipx.forEach((e) => {
    e.sizeBytes = pipxSizes.get(e.path) || 0;
  });

  const gem = run('/usr/bin/env', ['gem', 'list', '--no-versions'], { timeout: 20000 });
  if (gem.ok) out.gemCount = gem.stdout.split('\n').map((s) => s.trim()).filter(Boolean).length;

  const cargo = run('/usr/bin/env', ['cargo', 'install', '--list'], { timeout: 15000 });
  if (cargo.ok) {
    for (const line of cargo.stdout.split('\n')) {
      const m = line.trim().match(/^([A-Za-z0-9_-]+)\s+v([^\s:]+):/);
      if (m) {
        out.cargo.push({
          manager: 'cargo',
          name: m[1],
          version: m[2],
          sizeBytes: 0,
          path: path.join(HOME, '.cargo/bin', m[1]),
          kind: 'cli',
        });
      }
    }
    const cargoSizes = duSizes(out.cargo.map((e) => e.path));
    out.cargo.forEach((e) => {
      e.sizeBytes = cargoSizes.get(e.path) || 0;
    });
  }

  const total = out.npm.length + out.pipx.length + out.cargo.length;
  if (total || out.gemCount) {
    add({
      severity: 'info',
      layer: 'install-source',
      title: '全局安装的包管理器工具',
      evidence: `npm ${out.npm.length}, pipx ${out.pipx.length}, cargo ${out.cargo.length}, gem ${out.gemCount}`,
      recommendation: '无法可靠判断是否使用中；清单见“正常软件占用”，确认后再用对应包管理器卸载。',
    });
  }
  return out;
}

// ---------------------------------------------------------------- misc

function auditReceipts() {
  const r = run('/usr/sbin/pkgutil', ['--pkgs'], { timeout: 20000 });
  if (!r.ok) return { count: 0, ids: [] };
  const ids = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return { count: ids.length, ids: ids.slice(0, 500) };
}

function auditLoginShell() {
  const user = os.userInfo().username;
  const r = run('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'UserShell'], { timeout: 5000 });
  const declared = r.ok ? (r.stdout.match(/UserShell:\s*(\S+)/) || [])[1] : null;
  const current = process.env.SHELL || null;
  if (declared && current && declared !== current) {
    add({
      severity: 'info',
      layer: 'system',
      title: '登录 shell 与 $SHELL 不一致',
      evidence: `directory service: ${declared}, current env: ${current}`,
      recommendation: 'Change with chsh if the difference was not intentional.',
    });
  }
  return { declared, current };
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------- main

const started = Date.now();
const livePath = readLivePath();

const rcStats = auditRcFiles();
const pathStats = auditLivePath(livePath);

const appStats = auditApps();
const installedIds = new Set(appStats.apps.map((a) => (a.bundleId || '').toLowerCase()).filter(Boolean));
const installedNames = new Set(appStats.apps.map((a) => normalizeName(a.name.replace(/\.app$/i, ''))));
const residueStats = auditOrphanResidue(installedIds, installedNames);

const launchStats = auditLaunchd();
const binStats = auditBinDirs(livePath.value.split(':').filter(Boolean));
const brewStats = auditBrew(appStats.brew, appStats.leaves, appStats.casks, appStats.apps);
collectCachesAndDev();
collectBrowsers();
collectSystemJunk();
collectBuildArtifacts();
collectDeviceData();
collectVmAndContainers();
collectDownloads();
collectTrashAndSnapshots();
const packageManagers = auditPackageManagers();
const cleanupInventory = flushCandidates();
const receipts = auditReceipts();
const loginShell = auditLoginShell();

const swVers = run('/usr/bin/sw_vers', ['-productVersion'], { timeout: 3000 });
const order = { high: 0, medium: 1, low: 2, info: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || String(a.layer).localeCompare(String(b.layer)));
findings.forEach((f, i) => {
  f.id = `F${String(i + 1).padStart(3, '0')}`;
});

const historyText = readShellHistory();
const softwarePackages = [...brewStats.installed, ...packageManagers.npm, ...packageManagers.pipx, ...packageManagers.cargo]
  .map((p) => {
    let ageDays = null;
    try {
      ageDays = Math.floor((Date.now() - fs.statSync(p.path).mtimeMs) / DAY);
    } catch {
      /* path missing */
    }
    const used = usedInHistory(p.name, historyText);
    return { ...p, ageDays, usedInHistory: used, suspicious: used === false && (ageDays ?? 0) > 90 };
  })
  .sort((a, b) => b.sizeBytes - a.sizeBytes);
const software = {
  apps: [...appStats.apps].sort((a, b) => b.sizeBytes - a.sizeBytes),
  packages: softwarePackages,
};

const tierOrder = { safe: 0, review: 1, manual: 2 };
const moduleRank = (c) => {
  const i = MODULE_KEYS.indexOf(c);
  return i === -1 ? 999 : i;
};
actions.sort(
  (a, b) => moduleRank(a.category) - moduleRank(b.category) || tierOrder[a.tier] - tierOrder[b.tier] || b.sizeBytes - a.sizeBytes,
);
const counters = new Map();
for (const a of actions) {
  const prefix = ID_PREFIX[a.category] || 'ACT';
  const n = (counters.get(prefix) || 0) + 1;
  counters.set(prefix, n);
  a.id = `${prefix}-${String(n).padStart(2, '0')}`;
}

const summarize = (arr) => ({
  total: arr.length,
  high: arr.filter((x) => x.severity === 'high').length,
  medium: arr.filter((x) => x.severity === 'medium').length,
  low: arr.filter((x) => x.severity === 'low').length,
  info: arr.filter((x) => x.severity === 'info').length,
});

const planBytes = actions.reduce((n, a) => n + (a.sizeBytes || 0), 0);
const softwareBytes =
  software.apps.reduce((n, a) => n + (a.sizeBytes || 0), 0) +
  software.packages.reduce((n, p) => n + (p.sizeBytes || 0), 0);
const report = {
  schema: 'macos-cleanup-plan/v1',
  tool: 'macos-cleanup',
  mode: 'read-only-plan',
  meta: {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    hostname: os.hostname(),
    macOS: swVers.ok ? swVers.stdout.trim() : 'unknown',
    arch: os.arch(),
    home: HOME,
    pathSource: livePath.source,
    pathDegraded: Boolean(livePath.degraded),
  },
  summary: {
    findings: summarize(findings),
    actions: {
      total: actions.length,
      safe: actions.filter((a) => a.tier === 'safe').length,
      review: actions.filter((a) => a.tier === 'review').length,
      manual: actions.filter((a) => a.tier === 'manual').length,
      reclaimableBytes: planBytes,
    },
    software: {
      apps: software.apps.length,
      packages: software.packages.length,
      bytes: softwareBytes,
    },
  },
  inventory: {
    path: { dirs: livePath.value.split(':').filter(Boolean), ...pathStats },
    rc: rcStats,
    apps: appStats.apps,
    brew: { prefix: appStats.brew, formulae: appStats.leaves, casks: appStats.casks, ...brewStats },
    launchd: launchStats,
    binDirs: binStats,
    residue: residueStats,
    cleanupTargets: cleanupInventory,
    packageManagers,
    software,
    receipts: { count: receipts.count, ids: receipts.ids },
    loginShell,
  },
  actions,
  findings,
  nextStep:
    'Present actions grouped by tier, ask the user to approve specific IDs, then run apply.mjs --plan <file> --approve <ids> --execute. Nothing has been changed.',
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

// stdout: modular, agent- and human-readable report
const TIER_LABEL = { safe: '安全', review: '需确认', manual: '手动' };
const SEVERITY_LABEL = { high: '高', medium: '中', low: '低', info: '提示' };
const LAYER_LABEL = {
  path: '系统 PATH',
  'shell-config': '终端配置',
  launchd: '后台服务',
  apps: '应用',
  'install-source': '安装来源',
  system: '系统设置',
};

function cell(value, max = 110) {
  let v = String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  if (v.length > max) v = `${v.slice(0, max - 1)}…`;
  return v;
}

function groupByModule(list) {
  const groups = new Map();
  for (const item of list) {
    const key = MODULES[item.category] ? item.category : item.category || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const ordered = [];
  for (const key of MODULE_KEYS) if (groups.has(key)) ordered.push([key, groups.get(key)]);
  for (const [key, items] of groups) if (!MODULE_KEYS.includes(key)) ordered.push([key, items]);
  return ordered;
}

function moduleTitle(key) {
  const m = MODULES[key];
  if (!m) return key;
  return m.zh === m.en ? m.zh : `${m.zh} (${m.en})`;
}

function printReport() {
  const out = [];
  const totalBytes = actions.reduce((n, a) => n + (a.sizeBytes || 0), 0);
  out.push('# macOS 清理计划（只读）');
  out.push('');
  out.push(`- 主机：${report.meta.hostname}`);
  out.push(`- 系统：macOS ${report.meta.macOS} (${report.meta.arch})`);
  out.push(`- 生成时间：${report.meta.generatedAt}`);
  out.push(`- PATH 来源：${report.meta.pathSource}${report.meta.pathDegraded ? '（降级）' : ''}`);
  out.push('');

  const groups = groupByModule(actions);
  out.push('## 总览');
  out.push('');
  out.push(`- 可清理（垃圾 / 可重建 / 安装残留）：**${actions.length}** 项，**${fmtBytes(totalBytes)}**`);
  out.push(
    `- 正常软件占用：应用 **${software.apps.length}** 个、包管理器 **${software.packages.length}** 个，合计 **${fmtBytes(softwareBytes)}**（仅统计，不建议直接删除）`,
  );
  out.push('');
  out.push('| # | 模块 | 可清理项 | 体积 |');
  out.push('|---|---|---:|---:|');
  groups.forEach(([key, items], i) => {
    const bytes = items.reduce((n, a) => n + (a.sizeBytes || 0), 0);
    out.push(`| ${i + 1} | ${moduleTitle(key)} | ${items.length} | ${fmtBytes(bytes)} |`);
  });
  out.push(`| | **可清理合计** | **${actions.length}** | **${fmtBytes(totalBytes)}** |`);
  out.push('');

  out.push('## 可清理项（按模块）');
  out.push('');
  groups.forEach(([key, items], i) => {
    const bytes = items.reduce((n, a) => n + (a.sizeBytes || 0), 0);
    out.push(`### ${i + 1}. ${moduleTitle(key)} — ${items.length} 项，${fmtBytes(bytes)}`);
    out.push('');
    out.push('| ID | 项目 | 大小 | 级别 | 依据 |');
    out.push('|---|---|---:|---|---|');
    for (const a of items.slice(0, PRINT_LIMIT)) {
      out.push(
        `| ${a.id} | ${cell(a.title, 60)} | ${fmtBytes(a.sizeBytes)} | ${TIER_LABEL[a.tier] || a.tier} | ${cell(a.evidence)} |`,
      );
    }
    if (items.length > PRINT_LIMIT) {
      out.push(`| | _另有 ${items.length - PRINT_LIMIT} 项，见 JSON_ | | | |`);
    }
    out.push('');
  });

  const sourceLabel = (s) => {
    if (!s || s === 'unknown') return '来源未知';
    if (s === 'apple-system') return '系统应用';
    if (s === 'app-store') return 'App Store';
    if (s.startsWith('homebrew-cask:')) return 'Homebrew Cask';
    return s;
  };
  out.push('## 正常软件占用（仅统计，不建议直接删除）');
  out.push('');
  out.push(`### 应用（${software.apps.length} 个，展示体积前 15）`);
  out.push('');
  out.push('| 应用 | 大小 | 来源 | 最后使用 |');
  out.push('|---|---:|---|---|');
  for (const a of software.apps.slice(0, 15)) {
    out.push(
      `| ${cell(a.name, 40)} | ${fmtBytes(a.sizeBytes)} | ${sourceLabel(a.source)} | ${a.lastUsed ? a.lastUsed.slice(0, 10) : '无记录'} |`,
    );
  }
  out.push('');
  out.push(`### 包管理器安装的软件（${software.packages.length} 个）`);
  out.push('');
  const suspiciousCount = software.packages.filter((p) => p.suspicious).length;
  out.push(
    `> “调用记录”来自 shell 历史，仅作参考；库类依赖可能被其他程序调用，不等于无用。${suspiciousCount ? `其中 ${suspiciousCount} 个超过 90 天未见调用。` : ''}`,
  );
  out.push('');
  out.push('| 管理器 | 软件 | 版本 | 大小 | 调用记录 |');
  out.push('|---|---|---|---:|---|');
  for (const p of software.packages.slice(0, 25)) {
    const used = p.usedInHistory === true ? '有' : p.usedInHistory === false ? '未见' : '—';
    out.push(
      `| ${p.manager} | ${cell(p.name, 40)} | ${cell(p.version || '—', 20)} | ${fmtBytes(p.sizeBytes)} | ${used} |`,
    );
  }
  if (software.packages.length > 25) {
    out.push(`| | _另有 ${software.packages.length - 25} 个，见 JSON_ | | | |`);
  }
  out.push('');
  const suspiciousNames = software.packages.filter((p) => p.suspicious).map((p) => p.name);
  if (suspiciousNames.length) {
    out.push(
      `- 超过 90 天未见调用（近似判断，仅供参考）：${suspiciousNames.slice(0, 20).join(', ')}${suspiciousNames.length > 20 ? ` 等 ${suspiciousNames.length} 个` : ''}`,
    );
    out.push('');
  }

  if (findings.length) {
    out.push('## 诊断信息（仅供判断，不是删除项）');
    out.push('');
    out.push('| 级别 | 模块 | 诊断 | 依据 |');
    out.push('|---|---|---|---|');
    for (const f of findings) {
      out.push(
        `| ${SEVERITY_LABEL[f.severity] || f.severity} | ${LAYER_LABEL[f.layer] || f.layer} | ${cell(f.title, 50)} | ${cell(f.evidence)} |`,
      );
    }
    out.push('');
  }

  out.push('## 下一步');
  out.push('');
  out.push(`- 计划文件：\`${OUT}\``);
  out.push('- 以上没有任何改动。');
  out.push('- 选定要执行的 ID 后先 dry-run：`apply.mjs --plan <plan> --approve CACHE-01,PKG-01`');
  out.push('- 确认无误再加 `--execute`；`手动` 级别的条目需要你自己用 sudo 或图形界面处理。');
  console.log(out.join('\n'));
}

printReport();
