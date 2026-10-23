#!/usr/bin/env node
// Executes an approved macOS cleanup plan. Dry-run by default; every change is reversible.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const UID = process.getuid();
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const TS = stamp();
const PLAN_PATH = opt('--plan');
const UNDO_PATH = opt('--undo');
const EXECUTE = has('--execute');
const APPROVE = (opt('--approve') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MANIFEST_DIR = path.join(HOME, 'Library/Application Support/macos-cleanup/manifests');
const BACKUP_DIR = path.join(HOME, 'Library/Application Support/macos-cleanup/backups', TS);
const TRASH_ROOT = path.join(HOME, '.Trash', `macos-cleanup-${TS}`);

const ALLOWED_ROOTS = [HOME, '/Applications', '/usr/local', '/opt'];
const HARD_PROTECTED = [
  '/System',
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/usr/libexec',
  '/private/etc',
  '/etc',
  '/var/db',
  '/Library/Apple',
  '/Library/Extensions',
];
const HOME_PROTECTED = [
  'Documents',
  'Desktop',
  'Pictures',
  'Movies',
  'Music',
  'Library/Keychains',
  '.ssh',
  '.gnupg',
];
const BREW_ENV = {
  ...process.env,
  HOMEBREW_NO_AUTO_UPDATE: '1',
  HOMEBREW_NO_ANALYTICS: '1',
  HOMEBREW_NO_ENV_HINTS: '1',
};
const BREW_ALLOWED = new Set(['autoremove', 'cleanup --prune=all']);

const CATEGORY_LABELS = {
  cache: '缓存 (Caches)',
  browser: '浏览器 (Browsers)',
  'dev-cache': '开发缓存 (Dev caches)',
  'build-artifacts': '构建产物 (Build artifacts)',
  'system-junk': '系统垃圾 (System junk)',
  'package-manager': '包管理器 (Package managers)',
  brew: '包管理器 (Package managers)', // legacy plans
  app: '应用卸载 (Apps)',
  'app-residue': '应用残留 (App residue)',
  launchd: '后台服务 (launchd)',
  'device-data': '设备与模拟器 (Devices & simulators)',
  'vm-container': '虚拟机与容器 (VMs & containers)',
  downloads: '下载与安装包 (Downloads)',
  trash: '废纸篓 (Trash)',
  snapshots: '系统快照 (Snapshots)',
  'shell-config': '终端配置 (Shell config)',
  path: '系统 PATH (System PATH)',
  symlink: '失效软链 (Dangling symlinks)',
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
const TIER_LABEL = { safe: '安全', review: '需确认', manual: '手动' };

function groupActions(list) {
  const groups = new Map();
  for (const a of list) {
    const key = CATEGORY_LABELS[a.category] ? a.category : a.category || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return [
    ...CATEGORY_ORDER.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)]),
    ...[...groups.entries()].filter(([k]) => !CATEGORY_ORDER.includes(k)),
  ];
}

function cellText(value, max = 100) {
  let s = String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

function run(cmd, args, { timeout = 30000, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, env: env || process.env });
  if (r.error) return { ok: false, stdout: '', stderr: String(r.error.message) };
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
const fmt = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
};

function guard(target) {
  const resolved = path.resolve(target);
  if (resolved === '/' || resolved === HOME) return 'refusing to touch / or the home directory itself';
  if (!ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    return `outside allowed roots (${ALLOWED_ROOTS.join(', ')})`;
  }
  for (const p of HARD_PROTECTED) if (resolved === p || resolved.startsWith(`${p}/`)) return `protected system path ${p}`;
  for (const rel of HOME_PROTECTED) {
    const p = path.join(HOME, rel);
    if (resolved === p || resolved.startsWith(`${p}/`)) return `protected user data ${p}`;
  }
  return null;
}

const manifest = {
  schema: 'macos-cleanup-manifest/v1',
  createdAt: new Date().toISOString(),
  hostname: os.hostname(),
  plan: PLAN_PATH || null,
  entries: [],
};
function record(entry) {
  manifest.entries.push(entry);
  saveManifest();
}
function saveManifest() {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(MANIFEST_DIR, `${TS}.json`), JSON.stringify(manifest, null, 2));
}

function uniqueDest(name) {
  let dest = path.join(TRASH_ROOT, name);
  let i = 2;
  while (exists(dest)) {
    dest = path.join(TRASH_ROOT, `${name} ${i}`);
    i += 1;
  }
  return dest;
}

function trash(actionId, target) {
  const problem = guard(target);
  if (problem) return { status: 'refused', detail: problem };
  if (!exists(target)) return { status: 'skipped', detail: 'does not exist' };
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    return { status: 'failed', detail: String(e.message) };
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    const p = run('/usr/bin/pgrep', ['-f', `${target}/Contents/MacOS/`]);
    if (p.ok && p.stdout.trim()) return { status: 'skipped', detail: 'app is still running' };
  }
  fs.mkdirSync(TRASH_ROOT, { recursive: true });
  const dest = uniqueDest(path.basename(target));
  try {
    fs.renameSync(target, dest);
  } catch (e) {
    return { status: 'failed', detail: `${e.code || ''} ${e.message}`.trim() };
  }
  record({ actionId, type: 'trash', original: target, trashed: dest, status: 'done' });
  return { status: 'done', detail: `-> ${dest}` };
}

function removeLines(actionId, operation) {
  const file = operation.file;
  const problem = guard(file);
  if (problem) return { status: 'refused', detail: problem };
  if (!exists(file)) return { status: 'skipped', detail: 'file does not exist' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { status: 'failed', detail: String(e.message) };
  }
  const lines = text.split(/\r?\n/);
  const targets = [];
  for (const edit of operation.edits || []) {
    const expected = String(edit.expected || '').trim();
    if (!expected) continue;
    const at = edit.line - 1;
    if (lines[at] !== undefined && lines[at].trim() === expected) {
      targets.push(at);
      continue;
    }
    const matches = lines.map((l, i) => (l.trim() === expected ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 1) {
      targets.push(matches[0]);
      continue;
    }
    return {
      status: 'skipped',
      detail: `line ${edit.line} no longer matches expected content; file changed since planning`,
    };
  }
  if (!targets.length) return { status: 'skipped', detail: 'nothing to remove' };
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = path.join(BACKUP_DIR, `${path.basename(file)}.${TS}`);
  try {
    fs.copyFileSync(file, backup);
  } catch (e) {
    return { status: 'failed', detail: `backup failed: ${e.message}` };
  }
  const remove = new Set(targets);
  const kept = lines.filter((_, i) => !remove.has(i));
  try {
    fs.writeFileSync(file, kept.join('\n'));
  } catch (e) {
    return { status: 'failed', detail: String(e.message) };
  }
  record({
    actionId,
    type: 'remove-lines',
    original: file,
    backup,
    removed: targets.map((i) => lines[i]),
    status: 'done',
  });
  return { status: 'done', detail: `${targets.length} line(s), backup ${backup}` };
}

function bootoutAgents(agents) {
  for (const a of agents || []) {
    if (!a.label || !/^[A-Za-z0-9._-]+$/.test(a.label)) continue;
    run('/bin/launchctl', ['bootout', `gui/${UID}/${a.label}`], { timeout: 15000 });
  }
}

function launchdBootout(actionId, operation) {
  if (!/^[A-Za-z0-9._-]+$/.test(operation.label || '')) {
    return { status: 'refused', detail: 'invalid label' };
  }
  if (!operation.plist || !path.resolve(operation.plist).startsWith(path.join(HOME, 'Library/LaunchAgents') + '/')) {
    return { status: 'refused', detail: 'only user-level LaunchAgents are handled' };
  }
  bootoutAgents([{ label: operation.label, plist: operation.plist }]);
  const res = trash(actionId, operation.plist);
  return res;
}

function brew(actionId, args) {
  const key = args.join(' ');
  if (!BREW_ALLOWED.has(key)) return { status: 'refused', detail: `command not allowed: ${key}` };
  const bin = exists('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew';
  if (!exists(bin)) return { status: 'failed', detail: 'brew not found' };
  const r = run(bin, args, { timeout: 30 * 60000, env: BREW_ENV });
  record({
    actionId,
    type: 'brew',
    command: `brew ${key}`,
    status: r.ok ? 'done' : 'failed',
    detail: (r.stdout + r.stderr).trim().slice(-2000),
  });
  return { status: r.ok ? 'done' : 'failed', detail: r.ok ? 'completed' : r.stderr.slice(0, 500) };
}

function executeAction(action) {
  const op = action.operation || {};
  if (action.tier === 'manual') {
    return { status: 'manual', detail: op.note || 'requires manual steps' };
  }
  switch (op.type) {
    case 'trash': {
      const results = (op.targets || []).map((t) => trash(action.id, t));
      return summarizeResults(results);
    }
    case 'uninstall': {
      bootoutAgents(op.agents);
      const results = [trash(action.id, op.app), ...(op.residues || []).map((t) => trash(action.id, t))];
      return summarizeResults(results);
    }
    case 'remove-lines':
      return removeLines(action.id, op);
    case 'launchd-bootout':
      return launchdBootout(action.id, op);
    case 'brew':
      return brew(action.id, op.args || []);
    default:
      return { status: 'refused', detail: `unknown operation ${op.type}` };
  }
}

function summarizeResults(results) {
  const done = results.filter((r) => r.status === 'done').length;
  const skipped = results.filter((r) => r.status === 'skipped' || r.status === 'refused').length;
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) return { status: 'partial', detail: `${done} done, ${skipped} skipped, ${failed.length} failed: ${failed[0].detail}` };
  if (!done) return { status: 'skipped', detail: results.map((r) => r.detail).join('; ') || 'nothing to do' };
  return { status: 'done', detail: `${done} item(s) moved to Trash, ${skipped} skipped` };
}

// ---------------------------------------------------------------- undo

function undoFrom(file) {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Cannot read manifest: ${e.message}`);
    process.exit(1);
  }
  if (m.schema !== 'macos-cleanup-manifest/v1') {
    console.error('Not a cleanup manifest.');
    process.exit(1);
  }
  let restored = 0;
  let failed = 0;
  for (const e of m.entries) {
    if (e.status !== 'done') continue;
    if (e.type === 'trash') {
      if (!exists(e.trashed)) {
        e.status = 'undo-skipped';
        e.undoDetail = 'trashed item no longer exists';
        failed += 1;
        continue;
      }
      if (exists(e.original)) {
        e.status = 'undo-skipped';
        e.undoDetail = 'original path is occupied';
        failed += 1;
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(e.original), { recursive: true });
        fs.renameSync(e.trashed, e.original);
        e.status = 'undone';
        restored += 1;
      } catch (err) {
        e.undoDetail = String(err.message);
        failed += 1;
      }
    } else if (e.type === 'remove-lines' && e.backup) {
      try {
        if (exists(e.original)) {
          fs.copyFileSync(e.original, `${e.original}.undo-${TS}`);
        }
        fs.copyFileSync(e.backup, e.original);
        e.status = 'undone';
        restored += 1;
      } catch (err) {
        e.undoDetail = String(err.message);
        failed += 1;
      }
    } else if (e.type === 'brew') {
      e.undoDetail = 'brew actions cannot be undone';
      failed += 1;
    }
  }
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  console.log(`Undo: ${restored} restored, ${failed} skipped/failed. Manifest updated: ${file}`);
}

// ---------------------------------------------------------------- main

if (UNDO_PATH) {
  undoFrom(path.resolve(UNDO_PATH));
  process.exit(0);
}

if (!PLAN_PATH) {
  console.error('Usage: apply.mjs --plan <plan.json> [--approve A001,A002] [--execute]');
  console.error('       apply.mjs --undo <manifest.json>');
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(fs.readFileSync(path.resolve(PLAN_PATH), 'utf8'));
} catch (e) {
  console.error(`Cannot read plan: ${e.message}`);
  process.exit(1);
}
if (plan.schema !== 'macos-cleanup-plan/v1') {
  console.error('Unsupported plan schema. Re-run audit.mjs to regenerate.');
  process.exit(1);
}

const allActions = plan.actions || [];
const byId = new Map(allActions.map((a) => [a.id, a]));
const unknown = APPROVE.filter((id) => !byId.has(id));
if (unknown.length) {
  console.error(`Unknown action id(s): ${unknown.join(', ')}`);
  process.exit(1);
}
const selected = APPROVE.length ? APPROVE.map((id) => byId.get(id)) : allActions;

if (!selected.length) {
  console.log('No actions selected.');
  process.exit(0);
}

if (!EXECUTE) {
  const bytes = selected.reduce((n, a) => n + (a.sizeBytes || 0), 0);
  const ordered = groupActions(selected);

  console.log('# 清理预演（dry run，未做任何修改）');
  console.log('');
  console.log(`- 选中：${selected.length} 项，可回收 ${fmt(bytes)}`);
  console.log(`- 计划：${path.resolve(PLAN_PATH)}`);
  console.log('');
  console.log('| # | 模块 | 项数 | 体积 |');
  console.log('|---|---|---:|---:|');
  ordered.forEach(([key, items], i) => {
    console.log(
      `| ${i + 1} | ${CATEGORY_LABELS[key] || key} | ${items.length} | ${fmt(items.reduce((n, a) => n + (a.sizeBytes || 0), 0))} |`,
    );
  });
  console.log(`| | **合计** | **${selected.length}** | **${fmt(bytes)}** |`);
  ordered.forEach(([key, items], i) => {
    console.log('');
    console.log(`## ${i + 1}. ${CATEGORY_LABELS[key] || key} — ${items.length} 项`);
    console.log('');
    console.log('| ID | 项目 | 大小 | 级别 | 依据 |');
    console.log('|---|---|---:|---|---|');
    for (const a of items) {
      console.log(
        `| ${a.id} | ${cellText(a.title, 60)} | ${fmt(a.sizeBytes)} | ${TIER_LABEL[a.tier] || a.tier} | ${cellText(a.evidence)} |`,
      );
    }
  });
  console.log('');
  console.log('确认无误后加 `--execute` 执行；`手动` 级别不会被执行。');
  process.exit(0);
}

if (!APPROVE.length) {
  console.error('Refusing to execute without --approve <action ids>. Review the dry run first.');
  process.exit(2);
}

const executable = selected.filter((a) => a.tier !== 'manual');
const manual = selected.filter((a) => a.tier === 'manual');
if (!executable.length) {
  console.log('All selected actions require manual steps:');
  for (const a of manual) console.log(`- ${a.id}: ${a.operation?.note || a.title}`);
  process.exit(0);
}

console.log(`正在执行 ${executable.length} 项。清单：${path.join(MANIFEST_DIR, `${TS}.json`)}`);
const results = [];
for (const a of executable) {
  const r = executeAction(a);
  results.push({ ...a, ...r });
}

const STATUS_LABEL = { done: '完成', skipped: '跳过', partial: '部分完成', failed: '失败', refused: '拒绝' };
console.log('');
console.log('# 执行结果');
console.log('');
for (const [key, items] of groupActions(results)) {
  console.log(`## ${CATEGORY_LABELS[key] || key} — ${items.length} 项`);
  console.log('');
  console.log('| ID | 项目 | 大小 | 级别 | 结果 | 详情 |');
  console.log('|---|---|---:|---|---|---|');
  for (const r of items) {
    console.log(
      `| ${r.id} | ${cellText(r.title, 50)} | ${fmt(r.sizeBytes)} | ${TIER_LABEL[r.tier] || r.tier} | ${STATUS_LABEL[r.status] || r.status} | ${cellText(r.detail, 80)} |`,
    );
  }
  console.log('');
}
if (manual.length) {
  console.log('## 需手动处理');
  console.log('');
  console.log('| ID | 项目 | 操作 |');
  console.log('|---|---|---|');
  for (const a of manual) {
    console.log(`| ${a.id} | ${cellText(a.title, 50)} | ${cellText(a.operation?.note || '', 100)} |`);
  }
  console.log('');
}

saveManifest();
const done = results.filter((r) => r.status === 'done').length;
const failed = results.filter((r) => r.status === 'failed' || r.status === 'partial').length;
console.log(`完成 ${done} 项，失败 ${failed} 项，跳过 ${results.length - done - failed} 项。`);
console.log(`回滚：node ${path.basename(process.argv[1])} --undo "${path.join(MANIFEST_DIR, `${TS}.json`)}"`);
if (failed) process.exitCode = 1;
