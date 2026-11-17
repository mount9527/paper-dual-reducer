// dsh-paper-dual · 宿主半边（v0.8.0）
// 职责：跑 paper-dual-reduce 引擎（python）、读 JSON 产物、把结果整理成面板要的形状。
// 只用 Node 内置模块：profile 里的 @deepseek-ai/* 包在插件目录解析不到（实测），
// 所以宿主这一侧不依赖任何第三方库。
//
// v0.2 变更：删除 GitHub 同步（/sync 与相关状态）；新增改写闭环
//   /rewrite（生成任务）→ 模型写 edits.jsonl → /apply（预检+回填+复检）→ /compare（三栏对照）
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '/dsh-paper-dual';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const VERSION = PKG.version || '0.0.0';

// Cordis 要求显式声明要用的服务，否则 apply 里取 ctx.webServer 会报
// "cannot get property webServer without inject"。
export const name = 'dsh-paper-dual';
export const inject = ['webServer', 'tools'];

// ---------------------------------------------------------------- 状态与工具

function stateDir() {
  // 回归测试与多套本地环境各自隔离状态，不碰真实 profile 数据。
  return process.env.PAPER_DUAL_STATE_DIR || join(homedir(), '.dsh', 'paper-dual');
}
function stateFile() { return join(stateDir(), 'state.json'); }

function loadState() {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function saveState(patch) {
  const next = { ...loadState(), ...patch };
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch { /* 状态落盘失败不影响本次操作 */ }
  return next;
}

function isEngineDir(dir) {
  return Boolean(dir) && existsSync(join(dir, 'run.py'));
}

function engineDir() {
  const configured = loadState().engineDir;
  if (typeof configured === 'string' && configured.trim()) return resolve(configured.trim());

  const candidates = [
    process.env.PAPER_DUAL_ENGINE,
    join(HERE, '..', 'paper-dual-reduce'),
    join(process.cwd(), 'paper-dual-reduce'),
    join(homedir(), 'paper-dual-reduce'),
    join(homedir(), '.dsh', 'skills', 'paper-dual-reduce'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && isEngineDir(candidate)) {
      return resolve(candidate.trim());
    }
  }
  return process.env.PAPER_DUAL_ENGINE
    ? resolve(process.env.PAPER_DUAL_ENGINE)
    : join(homedir(), 'paper-dual-reduce');
}

// 用哪个 python：venv / conda / 系统解释器可能都不一样，而插件只认一个。
// 优先级：设置里的 pythonPath > 环境变量 PAPER_DUAL_PYTHON > PATH 上的 python。
function pythonBin() {
  const s = loadState();
  const raw = s.pythonPath || process.env.PAPER_DUAL_PYTHON || 'python';
  return String(raw).trim().replace(/^["']+|["']+$/g, '');
}

let pyExeCache;

async function pythonExecutable() {
  if (pyExeCache !== undefined) return pyExeCache;
  const r = await runCmd(pythonBin(), ['-c', 'import sys;print(sys.executable)'], engineDir(), 30000);
  pyExeCache = r.code === 0 ? (r.out.trim().split(/\r?\n/).pop() || '') : '';
  return pyExeCache;
}

function normalizeDocPath(raw) {
  if (typeof raw !== 'string') return '';
  let p = raw.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (/^file:/i.test(p)) {
    try { p = fileURLToPath(p); } catch { /* 保留原串，让后续存在性检查给出明确错误 */ }
  }
  return p ? resolve(p) : '';
}

function documentKey(docPath) {
  return createHash('sha256')
    .update(String(docPath).toLowerCase())
    .digest('hex')
    .slice(0, 10);
}

function docKeyOf(docPath) {
  return documentKey(docPath);
}

function fileSha256(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return ''; }
}

function previouslyStoredSha(run) {
  return run?.sourceSha || run?.docSha || '';
}

function runDocChanged(run) {
  const storedSha = previouslyStoredSha(run);
  if (!storedSha) return false;
  const source = run?.docPath && existsSync(run.docPath) ? run.docPath : '';
  if (source) return fileSha256(source) !== storedSha;
  return Boolean(run?.engineInput && existsSync(run.engineInput)
    && fileSha256(run.engineInput) !== storedSha);
}

// 当前文档的运行记录按 docKey 分开；lastRun 只是最近一篇的快捷别名。
function runs() {
  const s = loadState();
  return (s.runs && typeof s.runs === 'object') ? s.runs : {};
}

function runOf(docPath) {
  const key = docKeyOf(docPath);
  const run = runs()[key];
  return run ? { key, ...run } : null;
}

const RUNS_KEEP = 12;

function saveRun(key, patch) {
  if (!key) return null;
  const all = runs();
  const prev = all[key] ?? {};
  const now = new Date().toISOString();
  // at 是诊断时刻，updatedAt 是最后一次动作；面板与排序各用各的。
  all[key] = {
    ...prev,
    ...patch,
    at: patch.at || prev.at || now,
    updatedAt: now,
  };
  const keys = Object.keys(all);
  if (keys.length > RUNS_KEEP) {
    keys.sort((a, b) => String(all[b].updatedAt || all[b].at)
      .localeCompare(String(all[a].updatedAt || all[a].at)));
    for (const old of keys.slice(RUNS_KEEP)) delete all[old];
  }
  saveState({ runs: all, lastRun: { key, ...all[key] } });
  return all[key];
}

function currentRun() {
  const state = loadState();
  const run = state.lastRun;
  if (!run?.docPath) return null;
  const key = run.key || docKeyOf(run.docPath);
  return { ...run, key };
}

// ---------------------------------------------------------------- 改稿版本链
// 每个新版本都有独立引擎目录，绝不覆盖上一版：
//   versions/v1/base.docx + doc.json + tasks + edits + rewritten + version.docx
// original 是诊断时保存的只读快照，v1/v2/... 才能作为下一轮输入。
const ORIGINAL_VERSION = 'original';
const VERSION_ID_RE = /^original$|^v(?:[1-9]\d{0,2})$/;
const MAX_REVISIONS = 5;

function versionLabel(index) {
  if (!index) return '原文';
  if (index === 1) return '改稿';
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const suffix = index < 10 ? digits[index] : String(index);
  return `${suffix}改`;
}

function versionsRoot(run) {
  return join(run.outdir, 'versions');
}

function versionDir(run, id) {
  if (id === ORIGINAL_VERSION) return run.outdir;
  if (!VERSION_ID_RE.test(String(id)) || id === ORIGINAL_VERSION) {
    throw new Error(`非法版本号：${id}`);
  }
  return join(versionsRoot(run), id);
}

function versionMetaPath(run, id) {
  return join(versionDir(run, id), 'meta.json');
}

function readVersionMeta(run, id) {
  if (id === ORIGINAL_VERSION) return null;
  const meta = readJson(versionMetaPath(run, id));
  return meta && meta.id === id ? meta : null;
}

function writeVersionMeta(run, meta) {
  const dir = versionDir(run, meta.id);
  mkdirSync(dir, { recursive: true });
  meta.updatedAt = new Date().toISOString();
  writeFileSync(versionMetaPath(run, meta.id), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function originalVersion(run) {
  return {
    id: ORIGINAL_VERSION,
    index: 0,
    label: '原文',
    status: 'original',
    baseId: null,
    workdir: run.outdir,
    docx: run.engineInput || join(run.outdir, 'source.docx'),
    downloadable: true,
  };
}

function versionFromMeta(run, meta) {
  const dir = versionDir(run, meta.id);
  return {
    ...meta,
    workdir: dir,
    docx: meta.output || join(dir, 'version.docx'),
    baseDocx: meta.baseDocx || join(dir, 'base.docx'),
    downloadable: existsSync(meta.output || join(dir, 'version.docx')),
  };
}

// 0.6 只有根目录的一版 rewritten.docx。首次打开新版本自动迁移成 v1，
// 不删除任何旧文件，也不改变用户已经验收的内容。
function migrateLegacyVersion(run) {
  const root = versionsRoot(run);
  if (existsSync(root)) {
    try {
      if (readdirSync(root, { withFileTypes: true }).some((x) => x.isDirectory())) return;
    } catch { /* 扫描失败时继续尝试迁移 */ }
  }
  const accepted = join(run.outdir, 'accepted.docx');
  const rewritten = join(run.outdir, 'rewritten.docx');
  const source = existsSync(accepted) ? accepted : rewritten;
  if (!existsSync(source)) return;
  const id = 'v1';
  const dir = versionDir(run, id);
  mkdirSync(dir, { recursive: true });
  const output = join(dir, 'version.docx');
  copyFileSync(source, output);
  for (const [from, to] of [
    ['rewritten.result.json', 'version.result.json'],
    ['rewritten.verdict.json', 'version.verdict.json'],
    ['edits.jsonl', 'edits.jsonl'],
    ['tasks.json', 'tasks.json'],
    ['prompts.jsonl', 'prompts.jsonl'],
  ]) {
    const src = join(run.outdir, from);
    if (existsSync(src)) copyFileSync(src, join(dir, to));
  }
  const verdict = readJson(join(dir, 'version.verdict.json'));
  const result = readJson(join(dir, 'version.result.json'));
  const meta = {
    id,
    index: 1,
    label: versionLabel(1),
    baseId: ORIGINAL_VERSION,
    baseLabel: '原文',
    status: verdict?.passed ? 'applied' : 'rejected',
    visible: true,
    passed: Boolean(verdict?.passed),
    baseDocx: run.engineInput || join(run.outdir, 'source.docx'),
    output,
    createdAt: run.updatedAt || run.at || new Date().toISOString(),
    migrated: true,
    apply: result?.counts ?? run.lastApply?.apply ?? null,
  };
  writeVersionMeta(run, meta);
  const state = {
    lastTasks: run.lastTasks ?? null,
    lastApply: run.lastApply ?? null,
    lastReduce: run.lastReduce ?? null,
    lastReduceCheck: run.lastReduceCheck ?? null,
  };
  if (Object.values(state).some(Boolean)) {
    writeFileSync(join(dir, 'plugin-state.json'), JSON.stringify(state, null, 2), 'utf8');
  }
  if (!run.activeVersionId) saveRun(run.key, { activeVersionId: id });
}

function listVersions(run) {
  if (!run?.outdir) return [];
  migrateLegacyVersion(run);
  const items = [originalVersion(run)];
  const root = versionsRoot(run);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((x) => x.isDirectory() && VERSION_ID_RE.test(x.name) && x.name !== ORIGINAL_VERSION)
      .map((x) => x.name);
  } catch { /* 还没有版本目录 */ }
  entries.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const id of entries) {
    const meta = readVersionMeta(run, id);
    if (!meta || meta.visible === false) continue;
    items.push(versionFromMeta(run, meta));
  }
  return items;
}

function versionById(run, id) {
  const wanted = id === 'rewritten'
    ? (run.activeVersionId || 'v1')
    : (id || run.activeVersionId || ORIGINAL_VERSION);
  if (wanted === ORIGINAL_VERSION) return originalVersion(run);
  const meta = readVersionMeta(run, wanted);
  return meta ? versionFromMeta(run, meta) : null;
}

function activeVersion(run) {
  return versionById(run, run?.activeVersionId || ORIGINAL_VERSION);
}

function versionStatePath(version) {
  return join(version.workdir, 'plugin-state.json');
}

function readVersionState(run, version) {
  const stored = readJson(versionStatePath(version)) ?? {};
  if (version.id !== ORIGINAL_VERSION) return stored;
  return {
    lastTasks: run.lastTasks ?? stored.lastTasks ?? null,
    lastApply: run.lastApply ?? stored.lastApply ?? null,
    lastReduce: run.lastReduce ?? stored.lastReduce ?? null,
    lastReduceCheck: run.lastReduceCheck ?? stored.lastReduceCheck ?? null,
  };
}

function saveVersionState(run, version, patch) {
  const next = { ...readVersionState(run, version), ...patch };
  mkdirSync(version.workdir, { recursive: true });
  writeFileSync(versionStatePath(version), JSON.stringify(next, null, 2), 'utf8');
  // original 继续镜像到 run，保持旧版本与工具兼容。
  if (version.id === ORIGINAL_VERSION && run.key) saveRun(run.key, patch);
  return next;
}

function nextVersionIndex(run) {
  let max = 0;
  try {
    for (const entry of readdirSync(versionsRoot(run), { withFileTypes: true })) {
      const match = /^v(\d+)$/.exec(entry.name);
      if (entry.isDirectory() && match) max = Math.max(max, Number(match[1]));
    }
  } catch { /* 还没有版本 */ }
  return max + 1;
}

function createRevisionWorkspace(run, baseId) {
  const base = versionById(run, baseId || run.activeVersionId || ORIGINAL_VERSION);
  if (!base) return { ok: false, error: `找不到作为基础稿的版本：${baseId}` };
  if (!base.docx || !existsSync(base.docx)) {
    return { ok: false, error: `${base.label}还没有生成 docx，不能作为下一轮基础` };
  }
  const index = nextVersionIndex(run);
  if (index > MAX_REVISIONS) {
    return { ok: false, limitReached: true, error: `最多支持五改（${MAX_REVISIONS} 个改稿版本）` };
  }
  const id = `v${index}`;
  const dir = versionDir(run, id);
  mkdirSync(dir, { recursive: true });
  const baseDocx = join(dir, 'base.docx');
  copyFileSync(base.docx, baseDocx);
  const meta = {
    id,
    index,
    label: versionLabel(index),
    baseId: base.id,
    baseLabel: base.label,
    status: 'preparing',
    visible: false,
    passed: null,
    baseDocx,
    output: join(dir, 'version.docx'),
    createdAt: new Date().toISOString(),
  };
  writeVersionMeta(run, meta);
  return { ok: true, id, index, dir, base, baseDocx, meta };
}

function reuseRevisionWorkspace(run, id) {
  if (!VERSION_ID_RE.test(String(id)) || id === ORIGINAL_VERSION) {
    return { ok: false, error: `不能复用的版本号：${id}` };
  }
  const meta = readVersionMeta(run, id);
  if (!meta) return { ok: false, error: `版本不存在：${id}` };
  if (!['planned', 'preparing'].includes(meta.status)) {
    return { ok: false, error: `只有待回填版本能快速重建任务；${meta.label}当前是 ${meta.status}` };
  }
  const base = versionById(run, meta.baseId);
  if (!base?.downloadable || !existsSync(base.docx)) {
    return { ok: false, error: `找不到${meta.label}的基础稿` };
  }
  const dir = versionDir(run, id);
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, `reoptimize-${Date.now()}`);
  const archived = [];
  for (const name of ['tasks.json', 'prompts.jsonl', 'edits.jsonl', 'lint.json', 'report.md']) {
    const source = join(dir, name);
    if (!existsSync(source)) continue;
    mkdirSync(stale, { recursive: true });
    renameSync(source, join(stale, name));
    archived.push(name);
  }
  const baseDocx = join(dir, 'base.docx');
  copyFileSync(base.docx, baseDocx);
  const nextMeta = writeVersionMeta(run, {
    ...meta,
    status: 'preparing',
    visible: true,
    passed: null,
    baseDocx,
    optimizedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    id,
    index: meta.index,
    dir,
    base,
    baseDocx,
    meta: nextMeta,
    reused: true,
    archived: archived.length ? stale : null,
  };
}

function markVersionVisible(run, id, patch = {}) {
  const meta = { ...(readVersionMeta(run, id) ?? {}), ...patch, visible: true };
  return writeVersionMeta(run, meta);
}

function selectVersion(run, id) {
  if (!VERSION_ID_RE.test(String(id))) return { ok: false, error: `非法版本号：${id}` };
  if (id !== ORIGINAL_VERSION && !readVersionMeta(run, id)) {
    return { ok: false, error: `版本不存在：${id}` };
  }
  const next = saveRun(run.key, { activeVersionId: id });
  return { ok: true, activeVersionId: id, run: next };
}

function workdir() {
  const dir = engineDir();
  return existsSync(join(dir, 'run.py')) ? dir : HERE;
}

// ---------------------------------------------------------------- .doc → .docx
// 引擎只读 OOXML。老式 .doc 在宿主侧用 Word COM 转换，失败再用 LibreOffice；
// 转换件按内容哈希缓存，原文件始终只读。
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function headBytes(p, n = 8) {
  try {
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(n);
      const read = readSync(fd, buf, 0, n, 0);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
}

function convertedDir() {
  return join(stateDir(), 'converted');
}

function psLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function wordConvertScript(src, out) {
  // PowerShell 5.1 需要 BOM；脚本正文保持 ASCII，路径由单引号字面量转义。
  return [
    '$ErrorActionPreference = "Stop"',
    `$src = ${psLiteral(src)}`,
    `$out = ${psLiteral(out)}`,
    '$app = $null',
    'try {',
    '  $app = New-Object -ComObject Word.Application',
    '  $app.Visible = $false',
    '  try { $app.DisplayAlerts = 0 } catch { }',
    '  $doc = $app.Documents.Open($src, $false, $true, $false)',
    '  try { $doc.SaveAs2($out, 16) } finally { try { $doc.Close(0) } catch { } }',
    '  Write-Output "OK"',
    '} catch {',
    '  Write-Output ("ERR " + $_.Exception.GetType().Name)',
    '  exit 1',
    '} finally {',
    '  if ($app) {',
    '    try { $app.Quit(0) } catch { }',
    '    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }',
    '  }',
    '}',
  ].join('\r\n');
}

async function convertWithWord(src, out) {
  const dir = join(stateDir(), 'bin');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'doc2docx.ps1');
  try {
    writeFileSync(script, `\uFEFF${wordConvertScript(src, out)}\r\n`, 'utf8');
  } catch (e) {
    return { ok: false, error: `写转换脚本失败：${e?.message ?? e}` };
  }
  const r = await runCmd('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], dir, 180000);
  if (r.code === 0 && existsSync(out)) return { ok: true, method: 'word' };
  const tail = clip(`${r.out} ${r.err}`.replace(/OK/g, '').trim(), 200);
  return { ok: false, error: `Word 转换失败（${tail || `退出码 ${r.code}`}）` };
}

async function convertWithSoffice(src, out) {
  const tmp = join(stateDir(), 'tmp', `conv-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const r = await runCmd('soffice', [
    '--headless', '--norestore', '--convert-to', 'docx', '--outdir', tmp, src,
  ], tmp, 180000);
  const produced = existsSync(tmp)
    ? readdirSync(tmp).find((f) => /\.docx$/i.test(f))
    : null;
  if (r.code === 0 && produced) {
    try {
      renameSync(join(tmp, produced), out);
      rmSync(tmp, { recursive: true, force: true });
      return { ok: true, method: 'libreoffice' };
    } catch (e) {
      return { ok: false, error: `移动转换结果失败：${e?.message ?? e}` };
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  return { ok: false, error: '本机没有 LibreOffice（soffice），也没装 Word' };
}

async function ensureDocx(rawPath) {
  const src = normalizeDocPath(rawPath);
  if (!src) return { ok: false, error: '先填论文文件的绝对路径' };
  if (!existsSync(src)) return { ok: false, error: `找不到文档：${src}` };
  let st;
  try { st = statSync(src); } catch (e) {
    return { ok: false, error: `读不到文件：${e?.message ?? e}` };
  }
  if (st.isDirectory()) return { ok: false, error: `这是个目录，不是文件：${src}` };

  const head = headBytes(src);
  const isZip = head.length >= 4 && head.subarray(0, 4).equals(ZIP_MAGIC);
  const isOle = head.length >= 8 && head.subarray(0, 8).equals(OLE_MAGIC);

  if (isZip) {
    if (/\.docx$/i.test(src)) {
      return { ok: true, path: src, originalPath: src, converted: false, method: 'as-is' };
    }
    const out = join(convertedDir(), `${fileSha256(src).slice(0, 16)}.docx`);
    if (existsSync(out)) {
      return { ok: true, path: out, originalPath: src, converted: true, method: 'cache' };
    }
    try {
      mkdirSync(convertedDir(), { recursive: true });
      copyFileSync(src, out);
    } catch (e) {
      return { ok: false, error: `复制文件失败：${e?.message ?? e}` };
    }
    return { ok: true, path: out, originalPath: src, converted: true, method: 'zip-renamed' };
  }

  if (!isOle) {
    return {
      ok: false,
      error: `这个文件既不是 .docx 也不是 .doc（文件头 ${head.toString('hex') || '空'}）。`
        + '支持 Word 文档（.doc/.docx）；PDF 请先转成 Word。',
    };
  }

  const digest = fileSha256(src).slice(0, 16);
  if (!digest) return { ok: false, error: `读不到文件内容：${src}` };
  const out = join(convertedDir(), `${digest}.docx`);
  if (existsSync(out)) {
    return { ok: true, path: out, originalPath: src, converted: true, method: 'cache' };
  }
  mkdirSync(convertedDir(), { recursive: true });
  const notes = [];
  if (process.platform === 'win32') {
    const w = await convertWithWord(src, out);
    if (w.ok) return { ok: true, path: out, originalPath: src, converted: true, method: 'word' };
    notes.push(w.error);
  } else {
    notes.push('非 Windows，跳过 Word COM');
  }
  const s = await convertWithSoffice(src, out);
  if (s.ok) return { ok: true, path: out, originalPath: src, converted: true, method: 'libreoffice' };
  notes.push(s.error);
  return {
    ok: false,
    error: `.doc 转换失败：${notes.filter(Boolean).join('；')}`,
    hint: '可以在 Word 里「另存为 → Word 文档(*.docx)」后再拖进来；或安装 LibreOffice',
  };
}

function outdirFor(docPath) {
  const stem = (parse(docPath).name || 'paper')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '')
    .slice(0, 36);
  return join(stateDir(), 'docs', `${stem || 'paper'}-${documentKey(docPath)}`);
}

// 每次重新诊断都先写入 staging，成功后再替换正式目录。
// 这样引擎失败时，上一次可用产物和 state.lastRun 仍然对得上。
function prepareRunDir(docPath) {
  const outdir = outdirFor(docPath);
  const staging = join(stateDir(), 'staging', `${basename(outdir)}-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  return { outdir, staging };
}

function discardRunDir(prepared) {
  try {
    const archive = join(stateDir(), 'archive');
    mkdirSync(archive, { recursive: true });
    renameSync(prepared.staging, join(archive, `failed-${basename(prepared.staging)}`));
  } catch { /* 保留 staging 便于人工排查 */ }
}

function publishRunDir(prepared) {
  const archive = join(stateDir(), 'archive');
  mkdirSync(archive, { recursive: true });
  mkdirSync(join(stateDir(), 'docs'), { recursive: true });
  let backup = null;
  if (existsSync(prepared.outdir)) {
    backup = join(archive, `${basename(prepared.outdir)}-${Date.now()}`);
    renameSync(prepared.outdir, backup);
  }
  try {
    renameSync(prepared.staging, prepared.outdir);
  } catch (e) {
    if (backup && !existsSync(prepared.outdir)) {
      try { renameSync(backup, prepared.outdir); } catch { /* 保留 archive 便于恢复 */ }
    }
    throw e;
  }
  return backup;
}

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function readJson(p) {
  const t = readText(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

const STALE_FILES = [
  'doc.json', 'profile.json', 'tasks.json', 'prompts.jsonl', 'edits.jsonl', 'lint.json',
  'rewritten.docx', 'rewritten.result.json', 'rewritten.verdict.json', 'report.md',
  'segdiag.json', 'pacing.json', 'aigc-hints.md', 'shuangjiang-hints.md',
];

function archiveStale(outdir, reason) {
  const dest = join(outdir, 'stale', `${Date.now()}-${reason}`);
  const moved = [];
  for (const name of STALE_FILES) {
    const source = join(outdir, name);
    if (!existsSync(source)) continue;
    try {
      mkdirSync(dest, { recursive: true });
      renameSync(source, join(dest, name));
      moved.push(name);
    } catch { /* 留原处，后续 pid 校验仍会拦住串文档 */ }
  }
  return moved;
}

function readJsonl(p) {
  const text = readText(p);
  if (text == null) return null;
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('//')) continue;
    try { rows.push(JSON.parse(s)); } catch { rows.push({ __bad: true }); }
  }
  return rows;
}

function inspectEdits(editsPath, outdir) {
  const rows = readJsonl(editsPath);
  if (rows == null) return { ok: false, error: `没有改写清单：${editsPath}` };
  const doc = readJson(join(outdir, 'doc.json'));
  const pids = new Set((doc?.paragraphs ?? []).map((p) => p.pid));
  const bad = rows.filter((r) => r.__bad);
  if (bad.length) {
    return { ok: false, error: `编辑清单有 ${bad.length} 行不是合法 JSON，先修好再预检/回填` };
  }
  const unknown = rows.filter((r) => !pids.has(String(r.pid ?? '')));
  return {
    ok: true,
    total: rows.length,
    unknownIds: unknown.map((r) => String(r.pid ?? '')),
    // 全部编号都不存在，基本就是上一篇的清单或原文件已换内容。
    foreign: rows.length > 0 && unknown.length === rows.length,
  };
}

function removeIfExists(p) {
  try { unlinkSync(p); } catch { /* 文件不存在或正被占用 */ }
}

function archiveRunArtifacts(outdir, label) {
  const names = [
    'edits.jsonl',
    'lint.json',
    'rewritten.docx',
    'rewritten.result.json',
    'rewritten.verdict.json',
    'report.md',
  ];
  const existing = names.map((name) => join(outdir, name)).filter((p) => existsSync(p));
  if (!existing.length) return null;
  const archive = join(stateDir(), 'archive', `${basename(outdir)}-${label}-${Date.now()}`);
  mkdirSync(archive, { recursive: true });
  const moved = [];
  try {
    for (const source of existing) {
      const target = join(archive, basename(source));
      renameSync(source, target);
      moved.push([source, target]);
    }
  } catch (e) {
    for (const [source, target] of moved.reverse()) {
      try { renameSync(target, source); } catch { /* 保留 archive 中的副本路径便于排查 */ }
    }
    throw e;
  }
  return archive;
}

async function regenerateDiagnosticReport(run) {
  const r = await runCmd(pythonBin(), [
    'scripts/render_report.py',
    '--doc', join(run.outdir, 'doc.json'),
    '--profile', join(run.outdir, 'profile.json'),
    '--out', join(run.outdir, 'report.md'),
    '--mode', 'diagnose',
    '--style', 'plain',
  ], engineDir(), 120000);
  return r.code === 0;
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendFile(res, filePath, downloadName) {
  if (!existsSync(filePath)) return sendJson(res, 404, { ok: false, error: '文件不存在' });
  const body = readFileSync(filePath);
  const safeAscii = downloadName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('content-length', String(body.length));
  res.setHeader('content-disposition',
    `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function runCmd(cmd, args, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (code, extra) => {
      if (done) return;
      done = true;
      resolve({ code, out, err: err + (extra || '') });
    };
    let child;
    try {
      const hfHome = modelCacheRoot();
      const tempDir = join(hfHome, 'tmp');
      mkdirSync(tempDir, { recursive: true });
      child = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          HF_HOME: hfHome,
          HF_HUB_CACHE: join(hfHome, 'hub'),
          HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
          HF_HUB_OFFLINE: modelWeightsCached() ? '1' : '0',
          HF_HUB_DISABLE_XET: '1',
          HF_HUB_DISABLE_PROGRESS_BARS: '1',
          TEMP: tempDir,
          TMP: tempDir,
        },
      });
    } catch (e) {
      finish(-1, String(e?.message ?? e));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(-1, `\n[超时] ${cmd} 超过 ${Math.round(timeoutMs / 1000)}s 被终止`);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); finish(-1, String(e?.message ?? e)); });
    child.on('close', (code) => { clearTimeout(timer); finish(code ?? -1); });
  });
}

function countSentences(text) {
  const n = (String(text ?? '').match(/[。！？；!?;]/g) || []).length;
  return n || (String(text ?? '').trim() ? 1 : 0);
}

// ---------------------------------------------------------------- 诊断

function summarize(doc, profile) {
  const byPid = new Map((doc?.paragraphs ?? []).map((p) => [p.pid, p]));
  const top = (profile?.top ?? []).slice(0, 12).map((item) => ({
    pid: item.pid,
    risk: item.risk,
    level: item.level,
    cause: item.causes?.[0]?.name ?? '—',
    op: item.suggest_op ?? '—',
    chars: item.chars,
    dupRatio: item.dup_ratio ?? 0,
    text: clip(byPid.get(item.pid)?.text ?? '', 180),
  }));
  return {
    stats: doc?.stats ?? {},
    dist: profile?.summary ?? {},
    repeatRate: profile?.duplicates?.stats?.repeat_rate ?? 0,
    lockReasons: doc?.lock_reasons ?? {},
    paragraphs: profile?.paragraphs?.length ?? 0,
    top,
  };
}

async function diagnose(rawPath) {
  const dir = engineDir();
  if (!existsSync(join(dir, 'run.py'))) {
    return {
      ok: false,
      needSetup: true,
      error: `引擎目录里没有 run.py：${dir}（在设置里改成 paper-dual-reduce 的绝对路径）`,
    };
  }

  const conv = await ensureDocx(rawPath);
  if (!conv.ok) return conv;
  const engineInput = conv.path;
  const docPath = conv.originalPath || engineInput;
  const docSha = fileSha256(engineInput);
  const sourceSha = fileSha256(docPath);
  const previousRun = runOf(docPath);
  const contentChanged = Boolean(
    previouslyStoredSha(previousRun) && previouslyStoredSha(previousRun) !== sourceSha,
  );

  let prepared;
  try {
    prepared = prepareRunDir(docPath);
  } catch (e) {
    return { ok: false, error: `无法准备独立产物目录：${String(e?.message ?? e)}` };
  }
  const r = await runCmd(
    pythonBin(),
    ['run.py', 'diagnose', '--in', engineInput, '--outdir', prepared.staging],
    dir,
    180000,
  );
  if (r.code !== 0) {
    discardRunDir(prepared);
    return {
      ok: false,
      error: clip(r.err || r.out || `引擎退出码 ${r.code}`, 600),
      hint: /No such file|can't open file|不是内部或外部命令/i.test(r.err + r.out)
        ? 'python 不在 PATH，或引擎目录不对' : undefined,
    };
  }
  const doc = readJson(join(prepared.staging, 'doc.json'));
  const profile = readJson(join(prepared.staging, 'profile.json'));
  if (!doc || !profile) {
    discardRunDir(prepared);
    return { ok: false, error: '引擎跑完了但没产出 doc.json / profile.json' };
  }
  try {
    copyFileSync(engineInput, join(prepared.staging, 'source.docx'));
  } catch (e) {
    discardRunDir(prepared);
    return { ok: false, error: `无法保存原文档快照：${String(e?.message ?? e)}` };
  }

  const at = new Date().toISOString();
  try {
    writeFileSync(join(prepared.staging, 'meta.json'), JSON.stringify({
      sourcePath: docPath,
      engineInput,
      docSha,
      sourceSha,
      at,
      title: basename(docPath),
      converted: conv.converted,
      convertMethod: conv.method,
    }, null, 2), 'utf8');
  } catch (e) {
    discardRunDir(prepared);
    return { ok: false, error: `无法写入文档元数据：${String(e?.message ?? e)}` };
  }

  let archived = null;
  try {
    archived = publishRunDir(prepared);
  } catch (e) {
    discardRunDir(prepared);
    return { ok: false, error: `无法发布本次产物：${String(e?.message ?? e)}` };
  }
  const outdir = prepared.outdir;

  const summary = summarize(doc, profile);
  saveRun(docKeyOf(docPath), {
    docPath,
    engineInput,
    outdir,
    at,
    title: basename(docPath),
    summary,
    docSha,
    sourceSha,
    activeVersionId: ORIGINAL_VERSION,
    converted: conv.converted,
    convertMethod: conv.method,
    // 新文档 = 旧的改写产物作废
    lastTasks: null, lastApply: null, lastReduce: null, lastReduceCheck: null,
    loopRound: 0,
    pacingBaseline: null,
    pacingOrigin: null,
    archivedStale: archived,
  });
  if (contentChanged) clearAigcStore(docKeyOf(docPath));
  saveState({ lastAigc: null });
  return {
    ok: true,
    at,
    docPath,
    engineInput,
    outdir,
    summary,
    converted: conv.converted,
    convertMethod: conv.method,
    archivedStale: archived,
    stdout: clip(r.out, 400),
  };
}

// ---------------------------------------------------------------- 改写闭环

//: 复制给模型的硬约束。面板与工具共用这一份，避免两处口径分叉。
const CONSTRAINTS = [
  '不新增数字、年份、百分比、引用、书名与英文缩写',
  '不新增「我觉得／我认为」这类主观表述',
  '字数控制在原文的 0.55~1.40 倍',
  '标题、表格、代码块、公式、参考文献一律不动',
  '不改变论断方向与结论强度',
];

function buildModelInstruction(outdir, docPath) {
  return [
    '请按下面的提示词逐行改写，产出编辑清单（一行一条 JSON：{"pid","text","op"}）。',
    '',
    `提示词：${join(outdir, 'prompts.jsonl')}`,
    `编辑清单：${join(outdir, 'edits.jsonl')}`,
    '',
    '约束：',
    ...CONSTRAINTS.map((c, i) => `${i + 1}. ${c}`),
    '',
    `原文档：${docPath}`,
    '写完后调用工具 paper_dual_apply_edits（预检 → 回填 → 冻结块 AIGC 复检），或回到面板点「回填并 AIGC 复检」。',
  ].join('\n');
}

async function ensureDiagnosed(rawPath) {
  const state = loadState();
  const requested = normalizeDocPath(rawPath || state.lastRun?.docPath || '');
  if (!requested) return { ok: false, error: '先诊断一次（或在面板里填路径），才有文档可改写' };
  const existing = runOf(requested);
  const same = existing
    && String(existing.docPath).toLowerCase() === requested.toLowerCase()
    && existsSync(existing.outdir)
    && !runDocChanged(existing);
  if (same) return { ok: true, run: existing };

  const diagnosed = await diagnose(requested);
  if (!diagnosed.ok) return diagnosed;
  return { ok: true, run: currentRun() };
}

async function runRewrite(docPath, options = {}) {
  const dir = engineDir();
  if (!existsSync(join(dir, 'run.py'))) return { ok: false, error: `引擎目录里没有 run.py：${dir}` };
  const ensured = await ensureDiagnosed(docPath);
  if (!ensured.ok) return ensured;
  let run = ensured.run;
  listVersions(run);
  run = currentRun() || run;
  const baseId = options?.baseVersionId || options?.versionId || run.activeVersionId || ORIGINAL_VERSION;
  const revision = createRevisionWorkspace(run, baseId);
  if (!revision.ok) return revision;
  const outdir = revision.dir;
  const round = Number(revision.base.index || 0) + 1;
  const taskCaps = [12, 8, 5, 3, 2];
  const roundTaskLimit = taskCaps[Math.min(round - 1, taskCaps.length - 1)];
  const maxTasks = Math.min(Math.max(Number(options?.maxTasks) || roundTaskLimit, 1), roundTaskLimit, 30);
  const r = await runCmd(pythonBin(),
    ['run.py', 'rewrite', '--in', revision.baseDocx, '--outdir', outdir,
      '--style', 'plain', '--max-tasks', String(maxTasks)], dir, 180000);
  if (r.code !== 0) {
    writeVersionMeta(run, {
      ...revision.meta,
      status: 'failed',
      visible: false,
      error: clip(r.err || r.out, 700),
    });
    return { ok: false, error: clip(r.err || r.out, 700), versionId: revision.id };
  }

  const tasks = readJson(join(outdir, 'tasks.json'));
  const promptsText = readText(join(outdir, 'prompts.jsonl')) ?? '';
  if (!tasks) {
    writeVersionMeta(run, {
      ...revision.meta,
      status: 'failed',
      visible: false,
      error: `缺少 tasks.json：${clip(r.out || r.err, 300)}`,
    });
    return { ok: false, error: `改写任务生成后缺少 tasks.json（引擎输出：${clip(r.out || r.err, 300)}）` };
  }
  let archived;
  try {
    archived = archiveRunArtifacts(outdir, 'new-tasks');
  } catch (e) {
    return { ok: false, error: `新任务已生成，但旧改稿/清单无法归档：${String(e?.message ?? e)}` };
  }
  const reportReady = await regenerateDiagnosticReport({ ...run, outdir });
  const prompts = promptsText.split('\n').filter(Boolean).length;
  const at = new Date().toISOString();
  const payload = {
    at,
    docPath: run.docPath,
    versionId: revision.id,
    baseVersionId: revision.base.id,
    baseVersionLabel: revision.base.label,
    versionLabel: revision.meta.label,
    round,
    outdir,
    tasks: tasks?.tasks?.length ?? 0,
    prompts,
    textStyle: tasks?.text_style ?? 'plain',
    promptsPath: join(outdir, 'prompts.jsonl'),
    editsPath: join(outdir, 'edits.jsonl'),
    belowThreshold: Boolean(tasks?.counts?.below_threshold),
    instruction: [
      `当前基础：${revision.base.label}（${revision.base.id}）；本轮将保存为：${revision.meta.label}（${revision.id}）`,
      buildModelInstruction(outdir, run.docPath || revision.baseDocx),
    ].join('\n'),
    constraints: CONSTRAINTS,
    optimization: {
      mode: round >= 3 ? 'focused' : 'full',
      round,
      maxTasks,
    },
    reportReady,
  };
  const meta = markVersionVisible(run, revision.id, {
    status: 'planned',
    passed: null,
    tasks: payload.tasks,
    prompts: payload.prompts,
    reportReady,
  });
  const version = versionFromMeta(run, meta);
  saveVersionState(run, version, {
    lastTasks: payload,
    lastApply: null,
    lastReduce: null,
    lastReduceCheck: null,
  });
  saveRun(run.key, {
    activeVersionId: revision.id,
    loopRound: 0,
  });
  clearAigcTarget(run.key, revision.id);
  saveState({ lastAigc: null });
  if (archived) payload.archivedPrevious = archived;
  return { ok: true, ...payload, stdout: clip(r.out, 400) };
}

// 预检/回填前先确认 edits.jsonl 属于当前文档，否则会把上一篇的 pid 全部报成
// “复检不过”，用户很难从错误里看出真正原因。
function guardEdits(edits, outdir) {
  if (!existsSync(edits)) {
    return { ok: false, error: `没有改写清单：${edits}（先让模型按 prompts.jsonl 产出 edits.jsonl）` };
  }
  const info = inspectEdits(edits, outdir);
  if (!info.ok) return info;
  if (info.foreign) {
    const kept = join(outdir, `edits.stale-${Date.now()}.jsonl`);
    try { renameSync(edits, kept); } catch { /* 改名失败也仍返回明确错误 */ }
    return {
      ok: false,
      stale: true,
      archived: kept,
      error: `这份 edits.jsonl 的 ${info.total} 条编辑，段落编号在当前文档里一条都不存在 —— `
        + '它属于另一篇文档（或原文件已换过内容）。已改名为 '
        + `${basename(kept)} 留着，请重新「生成改写任务」再让模型写一遍。`,
    };
  }
  return { ok: true, ...info };
}

function writeEditsFromText(file, text) {
  const lines = String(text).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: '贴进来的内容是空的' };
  for (let i = 0; i < lines.length; i += 1) {
    try { JSON.parse(lines[i]); } catch {
      return { ok: false, error: `第 ${i + 1} 行不是合法 JSON：${clip(lines[i], 80)}` };
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return { ok: true, lines: lines.length };
}

function currentWorkingRevision(run) {
  listVersions(run);
  const freshRun = currentRun() || run;
  let version = activeVersion(freshRun);
  if (!version) return { ok: false, error: '当前版本不存在，请切回原文后重试' };
  if (version.id === ORIGINAL_VERSION) {
    const created = createRevisionWorkspace(run, ORIGINAL_VERSION);
    if (!created.ok) return created;
    // 手动清单可能先写在原文目录，再点回填；把这份清单带进新版本工作区。
    for (const name of ['edits.jsonl', 'tasks.json', 'prompts.jsonl']) {
      const source = join(run.outdir, name);
      const target = join(created.dir, name);
      if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
    }
    version = versionFromMeta(run, created.meta);
    saveRun(run.key, { activeVersionId: created.id });
    return { ok: true, version, created: true };
  }
  if (['applied', 'rejected', 'checking'].includes(version.status)) {
    return {
      ok: false,
      error: `${version.label}已经完成一轮。请先基于它生成下一轮任务，再预检或回填。`,
    };
  }
  return { ok: true, version, created: false };
}

function countReasons(items) {
  const out = {};
  for (const item of items ?? []) {
    if (item.status !== 'would_reject' && item.status !== 'rejected') continue;
    const key = String(item.reason ?? '?').split(':')[0];
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

async function runLint(body) {
  const dir = engineDir();
  if (!isEngineDir(dir)) return { ok: false, error: '引擎目录里没有 run.py', needSetup: true };
  const run = currentRun();
  if (!run?.outdir) return { ok: false, error: '先诊断一次' };
  if (runDocChanged(run)) {
    return { ok: false, staleSource: true, error: '原文件在诊断后被修改了，请先重新诊断再预检。' };
  }
  const working = currentWorkingRevision(run);
  if (!working.ok) return working;
  const version = working.version;
  const workdir = version.workdir;
  const edits = join(workdir, 'edits.jsonl');
  const text = typeof body?.edits === 'string' ? body.edits.trim() : '';
  if (text) {
    const saved = writeEditsFromText(edits, text);
    if (!saved.ok) return saved;
  }
  if (!existsSync(edits)) {
    return {
      ok: false,
      versionId: version.id,
      error: `没有改写清单：${edits}（先让模型按 prompts.jsonl 产出，或手动贴清单）`,
    };
  }
  const lintPath = join(workdir, 'lint.json');
  removeIfExists(lintPath);
  const baseDocx = version.baseDocx || version.docx;
  const r = await runCmd(pythonBin(),
    ['run.py', 'lint', '--in', baseDocx, '--outdir', workdir, '--edits', edits],
    dir, 120000);
  const lint = readJson(lintPath);
  if (!lint) return { ok: false, error: clip(r.err || r.out || '预检没有产出 lint.json', 600) };
  if (r.code !== 0 && r.code !== 1) {
    return { ok: false, error: clip(r.err || r.out || `预检异常退出（${r.code}）`, 600) };
  }
  const guard = guardEdits(edits, workdir);
  if (!guard.ok) return guard;
  const meta = markVersionVisible(run, version.id, {
    status: version.status === 'applied' ? 'applied' : 'planned',
    lint: lint.counts,
  });
  saveRun(run.key, { activeVersionId: version.id });
  const rejected = (lint.items ?? []).filter((i) => i.status === 'would_reject').slice(0, 20);
  return {
    ok: true,
    versionId: version.id,
    versionLabel: meta.label,
    baseVersionId: meta.baseId,
    baseVersionLabel: meta.baseLabel,
    counts: lint.counts,
    rejected,
    reasonCounts: countReasons(lint.items),
    unknownEdits: guard.unknownIds?.length ?? 0,
    exitCode: r.code,
  };
}

async function runApply(body) {
  const dir = engineDir();
  if (!isEngineDir(dir)) return { ok: false, error: '引擎目录里没有 run.py', needSetup: true };
  const run = currentRun();
  if (!run?.outdir) return { ok: false, error: '先诊断一次' };
  if (runDocChanged(run)) {
    return { ok: false, staleSource: true, error: '原文件在诊断后被修改了，请先重新诊断再回填。' };
  }
  const working = currentWorkingRevision(run);
  if (!working.ok) return working;
  const version = working.version;
  const workdir = version.workdir;
  const edits = join(workdir, 'edits.jsonl');

  const text = typeof body?.edits === 'string' ? body.edits.trim() : '';
  if (text) {
    const saved = writeEditsFromText(edits, text);
    if (!saved.ok) return saved;
  }
  if (!existsSync(edits)) {
    return {
      ok: false,
      versionId: version.id,
      error: `没有改写清单：${edits}（让模型先产出，或把 JSONL 传上来）`,
    };
  }

  const lintPath = join(workdir, 'lint.json');
  const resultPath = join(workdir, 'rewritten.result.json');
  const verdictPath = join(workdir, 'rewritten.verdict.json');
  removeIfExists(lintPath);
  removeIfExists(resultPath);
  removeIfExists(verdictPath);
  saveVersionState(run, version, { lastApply: null });

  const srcDoc = version.baseDocx || version.docx;

  const lintRun = await runCmd(pythonBin(),
    ['run.py', 'lint', '--in', srcDoc, '--outdir', workdir, '--edits', edits], dir, 120000);
  const lint = readJson(lintPath);
  if (!lint) {
    return { ok: false, error: clip(lintRun.err || lintRun.out || '预检没有产出 lint.json', 700) };
  }
  if (lintRun.code !== 0 && lintRun.code !== 1) {
    return { ok: false, error: clip(lintRun.err || lintRun.out || `预检异常退出（${lintRun.code}）`, 700) };
  }
  const guard = guardEdits(edits, workdir);
  if (!guard.ok) return guard;

  const finRun = await runCmd(pythonBin(),
    ['run.py', 'finish', '--in', srcDoc, '--outdir', workdir, '--edits', edits,
      '--style', 'plain'], dir, 200000);
  const verdict = readJson(verdictPath);
  const result = readJson(resultPath);
  if (![0, 3].includes(finRun.code)) {
    return { ok: false, error: clip(finRun.err || finRun.out || `回填异常退出（${finRun.code}）`, 800) };
  }
  if (!verdict || !result) {
    return {
      ok: false,
      error: clip(finRun.err || finRun.out || '回填结束但缺少 result / verdict 产物', 800),
    };
  }

  const at = new Date().toISOString();
  const applied = result?.counts?.applied ?? 0;
  const rejected = /rolled_back/i.test(result?.status ?? '');
  const versionDocx = join(workdir, 'version.docx');
  const rewrittenDocx = join(workdir, 'rewritten.docx');
  if (existsSync(rewrittenDocx)) {
    copyFileSync(rewrittenDocx, versionDocx);
    copyFileSync(resultPath, join(workdir, 'version.result.json'));
    copyFileSync(verdictPath, join(workdir, 'version.verdict.json'));
  }
  const payload = {
    at,
    versionId: version.id,
    versionLabel: version.label,
    baseVersionId: version.baseId,
    baseVersionLabel: version.baseLabel,
    editsPath: edits,
    lint: lint?.counts ?? null,
    reasonCounts: countReasons(result?.items ?? lint?.items),
    unknownEdits: guard.unknownIds?.length ?? 0,
    apply: result?.counts ?? null,
    applyStatus: result?.status ?? null,
    noop: applied === 0,
    output: versionDocx,
    verdict: verdict
      ? {
        passed: Boolean(verdict.passed),
        summary: verdict.summary,
        changed: verdict.text?.changed_paragraphs ?? 0,
        chars: [verdict.text?.before_chars ?? 0, verdict.text?.after_chars ?? 0],
      }
      : null,
    rolledBack: rejected || !existsSync(versionDocx),
  };
  const passed = Boolean(verdict.passed) && applied > 0 && !rejected && existsSync(versionDocx);
  const scope = body?.scope === 'dedupe'
    ? 'dedupe'
    : body?.scope === 'both' ? 'both' : 'aigc';
  const requiresAigcCheck = passed && scope !== 'dedupe';
  const meta = markVersionVisible(run, version.id, {
    status: requiresAigcCheck ? 'checking' : (passed ? 'applied' : 'rejected'),
    passed: requiresAigcCheck ? false : passed,
    pendingCheck: requiresAigcCheck,
    scope,
    output: versionDocx,
    apply: payload.apply,
    applyStatus: payload.applyStatus,
    verdict: payload.verdict,
    noop: payload.noop,
    rolledBack: payload.rolledBack,
  });
  const appliedVersion = versionFromMeta(run, meta);
  saveVersionState(run, appliedVersion, { lastApply: payload });
  saveRun(run.key, { activeVersionId: version.id });
  clearAigcTarget(run.key, version.id);
  let mandatoryCheck = null;
  if (requiresAigcCheck) {
    mandatoryCheck = await reduceCheck({
      autoRollback: true,
      requireModel: true,
      trigger: 'apply',
    });
    if (mandatoryCheck.ok) {
      const accepted = mandatoryCheck.acceptance?.accepted === true;
      payload.verdict = {
        ...payload.verdict,
        passed: accepted,
        structuralPassed: true,
        aigcChecked: true,
        aigcPassed: mandatoryCheck.acceptance?.probability === true,
      };
      payload.acceptance = mandatoryCheck.acceptance;
      payload.prob = mandatoryCheck.prob;
      payload.detectorAfter = mandatoryCheck.detectorAfter;
      payload.nextRound = mandatoryCheck.nextRound;
      payload.rollback = mandatoryCheck.rollback;
      payload.rolledBack = Boolean(mandatoryCheck.rollback?.performed);
      payload.mandatoryCheck = mandatoryCheck;
      payload.activeVersionId = mandatoryCheck.activeVersionId;
    } else {
      const failedMeta = markVersionVisible(run, version.id, {
        status: 'rejected',
        passed: false,
        pendingCheck: false,
        checkError: clip(mandatoryCheck.error || 'AIGC 复检失败', 600),
      });
      saveVersionState(run, versionFromMeta(run, failedMeta), {
        lastApply: payload,
      });
      payload.verdict = {
        ...payload.verdict,
        passed: false,
        structuralPassed: true,
        aigcChecked: false,
        aigcError: clip(mandatoryCheck.error || 'AIGC 复检失败', 600),
      };
      payload.acceptance = {
        accepted: false,
        probability: false,
        failed: ['AIGC 复检失败'],
        error: clip(mandatoryCheck.error || 'AIGC 复检失败', 600),
      };
      payload.mandatoryCheck = mandatoryCheck;
    }
  } else if (passed) {
    const finalMeta = markVersionVisible(run, version.id, {
      status: 'applied',
      passed: true,
      pendingCheck: false,
    });
    saveVersionState(run, versionFromMeta(run, finalMeta), { lastApply: payload });
  }
  return {
    ok: true,
    ...payload,
    log: clip(`${lintRun.out}${finRun.out}`, 700),
  };
}

function buildCompare(version) {
  const run = currentRun();
  const current = version || (run ? activeVersion(run) : null);
  if (!run?.outdir || !current || current.id === ORIGINAL_VERSION) return [];
  const doc = readJson(join(current.workdir, 'doc.json'))
    ?? readJson(join(run.outdir, 'doc.json'));
  const result = readJson(join(current.workdir, 'version.result.json'))
    ?? readJson(join(current.workdir, 'rewritten.result.json'))
    ?? readJson(join(run.outdir, 'rewritten.result.json'));
  if (!doc || !result) return [];
  const by = new Map((doc.paragraphs ?? []).map((p) => [p.pid, p.text]));
  return (result.items ?? [])
    .filter((i) => i.status === 'applied')
    .map((i) => {
      const before = by.get(i.pid) ?? '';
      const after = i.text ?? '';
      return {
        pid: i.pid,
        op: i.op ?? '—',
        before,
        after,
        chars: [before.length, after.length],
        sentences: [countSentences(before), countSentences(after)],
      };
    });
}

// ---------------------------------------------------------------- AIGC 考官
// 检测器（detector.py）必须依赖 transformers+torch；缺依赖时停止打分并返回安装步骤。
// diag.py 是纯正则，无依赖，永远可用。

const AIGC_DIR = join(HERE, 'aigc');

let detStateCache;

async function detectorState() {
  if (detStateCache !== undefined) return detStateCache;
  await pythonExecutable();
  const probe = [
    'import json',
    'out={"ready":True,"versions":{}}',
    'for name in ("torch","transformers"):',
    '    try:',
    '        m=__import__(name)',
    '        out["versions"][name]=str(getattr(m,"__version__","unknown"))',
    '    except Exception as e:',
    '        out["ready"]=False',
    '        out["versions"][name]=None',
    '        out["error"]=type(e).__name__+": "+str(e)',
    'print(json.dumps(out,ensure_ascii=False))',
  ].join('\n');
  const r = await runCmd(pythonBin(), ['-c', probe], AIGC_DIR, 90000);
  const line = r.out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    detStateCache = JSON.parse(line);
  } catch {
    detStateCache = {
      ready: false,
      versions: { torch: null, transformers: null },
      error: clip(r.err || r.out || '无法检测 Python 依赖', 500),
    };
  }
  return detStateCache;
}

async function detectorReady() {
  return Boolean((await detectorState()).ready);
}

function docTexts(p) {
  const doc = readJson(p);
  if (!doc) return null;
  const ps = doc.paragraphs ?? [];
  const join = (rows) => rows.map((x) => String(x.text ?? '').trim()).filter(Boolean).join('\n\n');
  return { all: join(ps), rewritable: join(ps.filter((x) => !x.locked)) };
}

function resolveVersionId(run, target) {
  if (run) listVersions(run);
  const fresh = currentRun() || run;
  if (target === 'rewritten') {
    const versions = listVersions(fresh).filter((v) => v.id !== ORIGINAL_VERSION && v.downloadable);
    return versions.at(-1)?.id || ORIGINAL_VERSION;
  }
  return VERSION_ID_RE.test(String(target || ''))
    ? String(target)
    : (fresh?.activeVersionId || ORIGINAL_VERSION);
}

async function docJsonFor(target, options = {}) {
  const run = currentRun();
  if (!run?.outdir) return { ok: false, error: '先诊断一次' };
  if (runDocChanged(run)) {
    return { ok: false, staleSource: true, error: '原文件在诊断后被修改了，请先重新诊断。' };
  }
  const versionId = resolveVersionId(run, target);
  const version = versionById(run, versionId);
  if (!version) return { ok: false, error: `版本不存在：${versionId}` };
  if (version.id === ORIGINAL_VERSION) {
    const path = join(run.outdir, 'doc.json');
    const texts = docTexts(path);
    if (!texts) return { ok: false, error: '缺 doc.json：重新诊断一次' };
    return { ok: true, path, texts, run, version, versionId: version.id, docx: version.docx };
  }
  if (options.base) {
    const path = join(version.workdir, 'doc.json');
    const texts = docTexts(path);
    if (!texts) return { ok: false, error: `${version.label}的基础诊断不存在，请重新生成任务` };
    return { ok: true, path, texts, run, version, versionId: version.id, docx: version.baseDocx };
  }
  if (!version.downloadable) {
    return { ok: false, error: `${version.label}还没有回填生成 docx` };
  }
  const docx = version.docx;
  const tmp = join(version.workdir, 'aigc-tmp');
  mkdirSync(tmp, { recursive: true });
  const out = join(tmp, 'output-doc.json');
  const r = await runCmd(pythonBin(),
    ['scripts/inspect_docx.py', '--in', docx, '--out', out], engineDir(), 120000);
  if (r.code !== 0) return { ok: false, error: clip(r.err || r.out, 400) };
  const texts = docTexts(out);
  if (!texts) return { ok: false, error: `${version.label}解析失败` };
  return { ok: true, path: out, texts, run, version, versionId: version.id, docx };
}

async function textFor(target) {
  const d = await docJsonFor(target);
  if (!d.ok) return d;
  return {
    ok: true,
    text: d.texts.all,
    rewritable: d.texts.rewritable,
    version: d.version,
    versionId: d.versionId,
    docx: d.docx,
  };
}

async function resolveAigcText(body) {
  const run = currentRun();
  const target = resolveVersionId(run, body?.versionId || body?.target || run?.activeVersionId);
  const inline = typeof body?.text === 'string' ? body.text : '';
  if (inline.trim()) return { ok: true, target: 'inline', text: inline };
  const t = await textFor(target);
  return t.ok ? { ...t, target, versionId: t.versionId } : t;
}

function modelCacheRoot() {
  const configured = loadState().hfCacheDir;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  if (process.env.HF_HOME) return process.env.HF_HOME;
  return join(stateDir(), 'hf-cache');
}

function hfCacheDir() {
  return join(modelCacheRoot(), 'hub', 'models--yuchuantian--AIGC_detector_zhv3');
}

function modelWeightsCached() {
  const snapshots = join(hfCacheDir(), 'snapshots');
  if (!existsSync(snapshots)) return false;
  try {
    return readdirSync(snapshots, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .some((entry) => (
        existsSync(join(snapshots, entry.name, 'pytorch_model.bin'))
        || existsSync(join(snapshots, entry.name, 'model.safetensors'))
      ));
  } catch {
    return false;
  }
}

function aigcSetup(det) {
  const venv = process.env.PAPER_DUAL_AIGC_HOME || 'E:\\paper-dual-aigc';
  const configured = loadState();
  const cache = configured.hfCacheDir || join(venv, 'hf-cache');
  const python = configured.pythonPath || join(venv, 'Scripts', 'python.exe');
  const installScript = [
    `$Venv = "${venv}"`,
    `$Cache = "${cache}"`,
    '$env:HF_ENDPOINT = "https://hf-mirror.com"',
    '$env:HF_HUB_DISABLE_XET = "1"',
    'New-Item -ItemType Directory -Force -Path $Venv,$Cache | Out-Null',
    'py -3.12 -m venv --upgrade-deps $Venv',
    '& "$Venv\\Scripts\\python.exe" -m pip install --upgrade pip',
    '& "$Venv\\Scripts\\python.exe" -m pip install torch==2.9.1 transformers==5.23.0 --index-url https://pypi.mirrors.ustc.edu.cn/simple/',
    '& "$Venv\\Scripts\\python.exe" -c "import torch, transformers; print(torch.__version__, transformers.__version__)"',
  ].join('\n');
  return {
    required: ['torch==2.9.1', 'transformers==5.23.0'],
    missing: Object.entries(det?.versions ?? {})
      .filter(([, version]) => !version)
      .map(([name]) => name),
    versions: det?.versions ?? {},
    venv,
    python,
    modelCacheDir: cache,
    hfHubCacheDir: join(cache, 'hub'),
    installScript,
    installTitle: '下载并安装 transformers + torch（默认放在 E 盘）',
    manualSteps: [
      `1. 在 PowerShell 粘贴安装命令；venv：${venv}`,
      `2. 面板「设置」解释器填：${python}`,
      `3. 模型缓存填：${cache}`,
      '4. 保存后点「方向标定」；首次会下载约 409MB 模型权重。',
    ],
    modelHint: '安装依赖并填写解释器/缓存路径后，点「方向标定」会联网下载约 409MB 的 pytorch_model.bin。',
    modelUrl: 'https://huggingface.co/yuchuantian/AIGC_detector_zhv3',
    notify: '未安装 transformers + torch，AI 疑似占比不可用；插件不会生成或伪造分数。',
  };
}

function aigcMissing(det) {
  return {
    ok: false,
    code: 'AIGC_DEPS_MISSING',
    error: 'AIGC 真机依赖未安装：先按安装步骤装 torch + transformers，并把面板「python 解释器」指向该 venv。',
    setup: aigcSetup(det),
  };
}

async function aigcStatus() {
  const detInfo = await detectorState();
  const ready = Boolean(detInfo.ready);
  const py = await pythonExecutable();
  const calib = readJson(join(AIGC_DIR, 'calib.json'));
  return {
    ok: true,
    diagReady: existsSync(join(AIGC_DIR, 'diag.py')),
    detectorReady: ready,
    mode: ready ? 'model' : 'unavailable',
    model: 'yuchuantian/AIGC_detector_zhv3',
    python: py || pythonBin(),
    pythonIsCustom: Boolean(loadState().pythonPath),
    versions: detInfo.versions ?? {},
    calibration: calib && typeof calib === 'object' ? {
      version: calib.version,
      calibrated: calib.calibrated === true,
      thrHi: calib.thr_hi,
      thrHard: calib.thr_hard,
      safeMax: calib.band?.safe_max,
      warnMax: calib.band?.warn_max,
      basis: calib.basis,
    } : null,
    note: ready
      ? '真机模式：模型已就绪；主指标是 AI 疑似占比，不是平台概率'
      : '依赖未安装：不会生成 AI 疑似占比，请按面板安装步骤配置',
    setup: aigcSetup(detInfo),
  };
}

// 跑一个「--json 输出」的考官脚本。退出码不可靠：diag.py 在语体门禁未过时故意返回 1，
// 但 stdout 依然是完整 JSON。所以判据是「stdout 能不能解析成 JSON」，不是 exit code。
async function runAigcJson(args, timeoutMs) {
  const r = await runCmd(pythonBin(), args, AIGC_DIR, timeoutMs);
  const text = r.out.trim();
  if (!text) {
    return { ok: false, code: r.code, error: clip(r.err || '考官没有输出', 600) };
  }
  try {
    return { ok: true, code: r.code, json: JSON.parse(text), log: clip(r.err, 300) };
  } catch {
    return { ok: false, code: r.code, error: clip(r.err || text, 600) };
  }
}

function aigcShare(result) {
  const share = Number(result?.ai_share);
  if (Number.isFinite(share)) return share;
  const legacy = Number(result?.ai_prob);
  return Number.isFinite(legacy) ? legacy : null;
}

function aigcMeasurement(result) {
  return Number.isFinite(Number(result?.ai_share)) ? 'ai_share' : 'legacy_mean';
}

const AIGC_BAND_LABELS = {
  safe: 'AI 特征不明显',
  warn: '存在 AI 特征段落',
  risk: 'AI 特征显著',
};

// 按「文档 + 原文/改稿」分别保存，切 tab 时不能拿另一份结果冒充。
function saveAigcStore(kind, target, value) {
  const run = currentRun();
  if (!run?.key || target === 'inline') return;
  const stored = loadState()[kind];
  const all = stored && typeof stored === 'object' ? stored : {};
  all[run.key] = { ...(all[run.key] ?? {}), [target]: value };
  saveState({ [kind]: all });
}

function aigcStore(kind, key) {
  const stored = loadState()[kind];
  const all = stored && typeof stored === 'object' ? stored : {};
  return key ? (all[key] ?? {}) : {};
}

function clearAigcStore(key) {
  if (!key) return;
  const state = loadState();
  const patch = {};
  for (const kind of ['aigcByDoc', 'diagByDoc']) {
    const all = state[kind];
    if (!all || typeof all !== 'object' || !(key in all)) continue;
    const next = { ...all };
    delete next[key];
    patch[kind] = next;
  }
  if (Object.keys(patch).length) saveState(patch);
}

function clearAigcTarget(key, target = 'rewritten') {
  if (!key) return;
  const state = loadState();
  const patch = {};
  for (const kind of ['aigcByDoc', 'diagByDoc']) {
    const all = state[kind];
    if (!all || typeof all !== 'object' || !all[key]?.[target]) continue;
    const nextDoc = { ...all[key] };
    delete nextDoc[target];
    patch[kind] = { ...all, [key]: nextDoc };
  }
  if (Object.keys(patch).length) saveState(patch);
}

function blockPlanPath(run, versionId = ORIGINAL_VERSION) {
  if (!run?.outdir) return '';
  const version = versionById(run, versionId || ORIGINAL_VERSION);
  const dir = version?.workdir ?? run.outdir;
  return join(dir, 'aigc', 'block-plan.json');
}

async function aigcScore(body) {
  const t = await resolveAigcText(body);
  if (!t.ok) return t;
  if (!t.text.trim()) return { ok: false, error: '没有可打分的文本' };
  const detInfo = await detectorState();
  if (!detInfo.ready) return aigcMissing(detInfo);
  const run = currentRun();
  const dir = t.version?.workdir
    ? join(t.version.workdir, 'aigc')
    : (run?.outdir ? join(run.outdir, 'aigc') : join(stateDir(), 'aigc'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `score-${t.target}.txt`);
  writeFileSync(file, t.text, 'utf8');

  let result;
  let planPath = null;
  if (t.target !== 'inline' && t.versionId) {
    const version = t.version || versionById(run, t.versionId);
    const seg = await aigcSegments({
      versionId: t.versionId,
      planVersionId: version?.baseId || ORIGINAL_VERSION,
    });
    if (!seg.ok) return seg;
    result = seg.result;
    planPath = seg.planPath || null;
  } else {
    const args = ['detector.py', '--file', file, '--json'];
    const st = loadState();
    if (Number.isInteger(st.aiLabel)) args.push('--ai-label', String(st.aiLabel));
    const out = await runAigcJson(args, 600000);
    if (!out.ok) return { ok: false, error: out.error };
    result = out.json;
  }
  const at = new Date().toISOString();
  const stored = { at, target: t.target, mode: 'model', result };
  saveAigcStore('aigcByDoc', t.target, stored);
  saveState({
    lastAigc: {
      at, target: t.target, mode: 'model',
      aiProb: result.ai_prob, aiShare: result.ai_share,
      medianProb: result.median_prob, band: result.band,
      stability: result.stability, calibrated: result.calibrated,
      degradation: result.degraded, chars: result.chars,
      bodyShare: result.ai_share, allShare: result.all_ai_share,
      bodyChars: result.body_chars, tableShare: result.table_ai_share,
      referenceShare: result.reference_ai_share,
      comparisonMode: result.comparison_mode, planPath,
    },
    ...(Number.isInteger(result.ai_index) && result.ai_index >= 0
      ? { aiLabel: result.ai_index, calibratedAt: at }
      : {}),
  });
  return {
    ok: true, at, target: t.target, mode: 'model', result, planPath,
  };
}

async function aigcSegments(body) {
  const run = currentRun();
  const target = resolveVersionId(run, body?.versionId || body?.target || run?.activeVersionId);
  const d = await docJsonFor(target);
  if (!d.ok) return d;
  const detInfo = await detectorState();
  if (!detInfo.ready) return aigcMissing(detInfo);
  const baseId = body?.planVersionId
    || (target === ORIGINAL_VERSION
      ? ORIGINAL_VERSION
      : versionById(run, target)?.baseId)
    || ORIGINAL_VERSION;
  const planPath = body?.generatePlan
    ? blockPlanPath(run, target)
    : blockPlanPath(run, baseId);
  if (!existsSync(planPath)) {
    if (body?.generatePlan) {
      // 继续往下：本次会重新切块并写出计划。
    } else {
      const basePlan = await aigcSegments({
        versionId: baseId,
        planVersionId: baseId,
        generatePlan: true,
      });
      if (!basePlan.ok) return basePlan;
      if (target === baseId) {
        basePlan.result.comparison_mode = 'frozen';
        basePlan.result.plan_generated = true;
        return basePlan;
      }
    }
  }
  const outPath = join(d.run.outdir, `segscore-${target}.json`);
  const args = [
    join(AIGC_DIR, 'segscore.py'),
    '--doc', d.path,
    '--out', outPath,
  ];
  if (!body?.generatePlan && existsSync(planPath)) args.push('--plan', planPath);
  if (body?.generatePlan || body?.writePlan) args.push('--plan-out', planPath);
  const st = loadState();
  if (Number.isInteger(st.aiLabel)) args.push('--ai-label', String(st.aiLabel));
  const r = await runCmd(pythonBin(), args, AIGC_DIR, 600000);
  const result = readJson(outPath);
  if (r.code !== 0 || !result) {
    return { ok: false, error: clip(r.err || r.out || '逐段打分没有产出 segscore.json', 700) };
  }
  return {
    ok: true,
    at: new Date().toISOString(),
    target,
    mode: result.mode,
    result,
    outPath,
    planPath: existsSync(planPath) ? planPath : null,
  };
}

async function aigcDiag(body) {
  const t = await resolveAigcText(body);
  if (!t.ok) return t;
  if (!t.text.trim()) return { ok: false, error: '没有可诊断的文本' };
  const run = currentRun();
  const dir = t.version?.workdir
    ? join(t.version.workdir, 'aigc')
    : (run?.outdir ? join(run.outdir, 'aigc') : join(stateDir(), 'aigc'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `diag-${t.target}.txt`);
  writeFileSync(file, t.text, 'utf8');
  const out = await runAigcJson(['diag.py', '--file', file, '--json'], 120000);
  if (!out.ok) return { ok: false, error: out.error };

  // 双口径门禁：锁定段（标题/表格/参考文献/代码块）永远不改写，
  // 若把它们算进语体门禁，就会出现一个「永远改不掉的红灯」。
  // 所以：全文口径只作提示，验收看「只算可改写段」的口径。
  let gateRewritable = out.json.style_gate_passed;
  const rwText = typeof t.rewritable === 'string' ? t.rewritable : '';
  if (rwText && rwText !== t.text) {
    const rwFile = join(dir, `diag-${t.target}-rw.txt`);
    writeFileSync(rwFile, rwText, 'utf8');
    const rw = await runAigcJson(['diag.py', '--file', rwFile, '--json'], 120000);
    if (rw.ok) gateRewritable = rw.json.style_gate_passed;
  }
  const payload = {
    ok: true,
    at: new Date().toISOString(),
    target: t.target,
    result: out.json,
    gateAll: out.json.style_gate_passed,
    gateRewritable,
    hasRewritableView: Boolean(rwText && rwText !== t.text),
    gateExit: out.code !== 0,
  };
  saveAigcStore('diagByDoc', t.target, {
    at: payload.at,
    target: t.target,
    result: out.json,
    gateAll: payload.gateAll,
    gateRewritable,
    hasRewritableView: payload.hasRewritableView,
  });
  return payload;
}

// 标签方向标定：该模型 config.json 缺 id2label，0/1 谁代表 AI 未知。
// 不标定直接跑会得到「反着读」的分数，而且不会报错——所以这一步是必须的。
async function aigcCalibrate() {
  const detInfo = await detectorState();
  if (!detInfo.ready) return aigcMissing(detInfo);
  const r = await runCmd(pythonBin(), ['detector.py', '--calibrate'], AIGC_DIR, 900000);
  const text = `${r.out}`;
  const at = text.indexOf('{');
  let info = null;
  if (at >= 0) {
    try { info = JSON.parse(text.slice(at)); } catch { info = null; }
  }
  if (!info) {
    const log = `${r.err || ''}${r.out || ''}`;
    return {
      ok: false,
      error: clip(log || `校准失败（退出码 ${r.code}）`, 600),
      hint: /标定不可信|gap/.test(log)
        ? '探针区分度不足：改用 --ai-label 0 或 1 手动指定（先在终端跑一次 --calibrate 看 ai_index 方向）'
        : undefined,
    };
  }
  saveState({
    aiLabel: info.ai_index,
    calibratedAt: new Date().toISOString(),
    calibration: info,
  });
  return { ok: true, info, aiLabel: info.ai_index, trusted: info.trusted !== false };
}

// 改写前后重打分：这是「降 AIGC」唯一可验证的口径
async function aigcDelta(body = {}) {
  const run = currentRun();
  if (!run?.outdir) return { ok: false, error: '先诊断一次' };
  const target = resolveVersionId(run, body?.versionId || body?.target || run.activeVersionId);
  if (target === ORIGINAL_VERSION) {
    return { ok: false, error: '原文没有上一版对比；请先完成一版改稿' };
  }
  const version = versionById(run, target);
  if (!version) return { ok: false, error: `版本不存在：${target}` };
  const a = await aigcScore({ target: version.baseId });
  if (!a.ok) return a;
  const b = await aigcScore({ target: target });
  if (!b.ok) return b;
  const before = aigcShare(a.result);
  const after = aigcShare(b.result);
  if (before == null || after == null) return { ok: false, error: '考官结果缺少 AI 疑似占比字段' };
  const sameMetric = aigcMeasurement(a.result) === aigcMeasurement(b.result);
  const comparisonMode = b.result.comparison_mode || 'segmented';
  const frozenBlocks = (a.result.comparison_mode || 'segmented') === 'frozen'
    && comparisonMode === 'frozen';
  return {
    ok: true,
    versionId: target,
    baseVersionId: version.baseId,
    versionLabel: version.label,
    baseVersionLabel: version.baseLabel,
    mode: a.mode,
    metric: 'ai_share',
    mixedMetric: !sameMetric,
    comparisonMode,
    beforeComparisonMode: a.result.comparison_mode || 'segmented',
    frozenBlocks,
    before,
    after,
    delta: sameMetric && frozenBlocks ? Number((before - after).toFixed(4)) : null,
    beforeBand: a.result.band,
    afterBand: b.result.band,
    beforeCalibrated: a.result.calibrated,
    afterCalibrated: b.result.calibrated,
    beforeStability: a.result.stability,
    afterStability: b.result.stability,
    beforeAllShare: a.result.all_ai_share,
    afterAllShare: b.result.all_ai_share,
    beforeTableShare: a.result.table_ai_share,
    afterTableShare: b.result.table_ai_share,
    beforeReferenceShare: a.result.reference_ai_share,
    afterReferenceShare: b.result.reference_ai_share,
    beforeChars: a.result.chars,
    afterChars: b.result.chars,
    segments: [a.result.segments?.length ?? 0, b.result.segments?.length ?? 0],
  };
}

async function aigcSelftest() {
  const r = await runCmd(pythonBin(), ['selftest.py'], AIGC_DIR, 120000);
  const text = `${r.out}${r.err}`;
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  return {
    ok: r.code === 0,
    passed: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
    log: clip(text, 600),
  };
}

// ---------------------------------------------------------------- 降 AIGC 闭环
// 思路：把 9 维痕迹诊断的结论翻译成「改写要求」，注入引擎的每条提示词，
// 再走既有的 预检→回填→复检 管线；改完用 diag 复检（离线可用）与检测器（需模型）各验一次。

function buildHints(diagResult) {
  const d = diagResult ?? {};
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  for (const t of d.todo ?? []) push(t);
  if (d.template?.risk) push('删掉「随着…」「在…方面」「综上所述」这类套话框架，改成具体主语的陈述');
  if (d.passive?.risk) push('把被动句改成主动句，补出施事者');
  if (d.burstiness?.level === 'low') push('打破句长均齐：短句与长句交替，避免连续三句长度接近');
  if (d.symmetry?.risk) push('打破段落对称：相邻段落句数不要雷同');
  if (d.nested?.risk) push('拆开层层嵌套的从句，一句只说一件事');
  if (d.colon?.risk) push('减少冒号并列与编号罗列，改成叙述式表达');
  if (d.punct?.risk) push('标点节奏：不要用句号把句子切成碎片，也不要一句超过 60 字');
  if (d.dash?.gate_failed) push('减少破折号，每段最多 1 个');
  if (d.colloquial?.gate_failed) push('删除口语词，保持书面语（语体门禁会把口语词判为不合格）');
  return out;
}

const DIAG_DIMENSIONS = [
  ['template', '模板套话'],
  ['passive', '被动句'],
  ['burstiness', '句长起伏'],
  ['symmetry', '结构对称'],
  ['nested', '层层嵌套'],
  ['colon', '冒号列举'],
  ['punct', '标点节奏'],
  ['colloquial', '口语化'],
  ['dash', '破折号'],
];

function activeDiagnosticRisks(d) {
  const names = new Set();
  for (const [key, label] of DIAG_DIMENSIONS) {
    const item = d?.[key] ?? {};
    if (item.risk || item.gate_failed || (key === 'burstiness' && item.level === 'low')) {
      names.add(label);
    }
  }
  return names;
}

async function reducePlan(body) {
  const scope = body?.scope === 'both' ? 'both' : 'aigc';
  let run = currentRun();
  if (!run?.docPath) return { ok: false, error: '先诊断一次' };
  if (runDocChanged(run)) {
    return { ok: false, staleSource: true, error: '原文件在诊断后被修改了，请先重新诊断再生成任务。' };
  }
  listVersions(run);
  run = currentRun() || run;
  const baseId = resolveVersionId(run, body?.baseVersionId || run.activeVersionId);
  const baseVersion = versionById(run, baseId);
  if (!baseVersion) return { ok: false, error: `找不到当前基础稿：${baseId}` };
  if (!baseVersion.downloadable) {
    return { ok: false, error: `${baseVersion.label}还没有生成 docx，不能作为下一轮基础` };
  }
  const baseDocJson = await docJsonFor(baseId);
  if (!baseDocJson.ok) return { ok: false, error: `读取当前基础稿失败：${baseDocJson.error}` };
  const d = await aigcDiag({ versionId: baseId });
  if (!d.ok) return { ok: false, error: `先跑 9 维诊断拿到痕迹清单：${d.error}` };
  const hints = buildHints(d.result);
  if (scope === 'both') {
    // 双降不是「两次改写」，而是一次改写同时满足两个目标：
    // AIGC 侧的痕迹要求 + 重复侧的合并/回指要求，一起写进同一批提示词。
    hints.push('对篇内重复的片段做合并、回指或概括：同一内容只讲一遍，重复率不得上升');
    hints.push('合并不改变论点顺序与论据数量；不得为了消重删掉限定词');
  }
  const dir = engineDir();
  const round = Math.max(1, Number(baseVersion.index || 0) + 1);
  if (round > MAX_REVISIONS) {
    return { ok: false, limitReached: true, error: `最多支持五改，当前已经是 ${baseVersion.label}` };
  }
  const maxRounds = Math.min(Math.max(Number(body?.maxRounds) || MAX_REVISIONS, 1), MAX_REVISIONS);

  // 前两轮保留覆盖面；三改后转为“少量高风险段落定向续改”，显著缩短模型读写时间。
  const taskCaps = scope === 'both' ? [16, 10, 6, 4, 2] : [12, 8, 5, 3, 2];
  const roundTaskLimit = taskCaps[Math.min(round - 1, taskCaps.length - 1)];
  const requestedTasks = Number(body?.maxTasks) || roundTaskLimit;
  const maxTasks = Math.min(Math.max(requestedTasks, 1), roundTaskLimit, 30);
  const focusLimit = round >= 5 ? 2 : round === 4 ? 3 : round === 3 ? 5 : 8;

  // 逐段定位痕迹：只改「整篇统计过关」的段落是改不到指标的，
  // 必须把带具体痕迹的段落强制纳入本轮（plan.py --include）。
  let focus = [];
  const pushFocus = (item) => {
    if (!item?.pid || focus.some((x) => x.pid === item.pid)) return;
    focus.push(item);
  };
  try {
    const segPath = join(baseVersion.workdir, 'segdiag.json');
    const sg = await runCmd(pythonBin(), [
      join(AIGC_DIR, 'segdiag.py'), '--doc', baseDocJson.path, '--out', segPath,
    ], AIGC_DIR, 120000);
    if (sg.code === 0) {
      const seg = readJson(segPath);
      for (const item of (seg?.paragraphs ?? []).slice(0, focusLimit)) {
        pushFocus({ ...item, source: 'trace' });
      }
    }
  } catch { /* 没有 segdiag 时就退回纯风险选段 */ }

  // 真机考官的块贡献度是下一轮选段的直接依据。
  let detectorBefore = null;
  let detectorError = null;
  let detectorCached = false;
  const previousCheck = readVersionState(run, baseVersion).lastReduceCheck;
  const replaceVersion = body?.replaceVersionId ? versionById(run, body.replaceVersionId) : null;
  const replaceState = replaceVersion ? readVersionState(run, replaceVersion) : {};
  const cachedDetector = previousCheck?.detectorAfter
    ?? replaceState?.lastReduce?.detectorBefore;
  const cachedShare = cachedDetector?.aiShare ?? cachedDetector?.aiProb;
  if (cachedShare != null) {
    detectorBefore = {
      aiShare: cachedShare,
      aiProb: cachedDetector.aiProb ?? cachedDetector.meanProb,
      metric: cachedDetector.metric ?? 'ai_share',
      band: cachedDetector.band,
      stability: cachedDetector.stability,
      calibrated: cachedDetector.calibrated,
      threshold: cachedDetector.threshold,
      top: (cachedDetector.top?.length ? cachedDetector.top : cachedDetector.fallbackTop) ?? [],
    };
    detectorCached = true;
    for (const item of detectorBefore.top.slice(0, focusLimit)) {
      pushFocus({
        pid: item.pid,
        tags: ['aigc_high'],
        risk_score: item.ai_prob,
        ai_prob: item.ai_prob,
        contribution: item.contribution,
        chars: item.chars,
        source: 'detector-cache',
      });
    }
  } else if (body?.useDetector !== false && await detectorReady()) {
    const ds = await aigcSegments({ versionId: baseId });
    if (ds.ok && ds.mode === 'model') {
      detectorBefore = {
        aiShare: aigcShare(ds.result),
        aiProb: ds.result.ai_prob,
        metric: aigcMeasurement(ds.result),
        band: ds.result.band,
        stability: ds.result.stability,
        calibrated: ds.result.calibrated,
        threshold: ds.result.threshold,
        top: ds.result.top ?? [],
      };
      for (const item of detectorBefore.top.slice(0, focusLimit)) {
        pushFocus({
          pid: item.pid,
          tags: ['aigc_high'],
          risk_score: item.ai_prob,
          ai_prob: item.ai_prob,
          contribution: item.contribution,
          chars: item.chars,
          source: 'detector',
        });
      }
    } else {
      detectorError = ds.ok ? '逐块考官没有进入真机模式' : ds.error;
    }
  }
  if (detectorBefore?.top?.length) {
    hints.push('优先重写高贡献块：这些块的模型得分超过阈值且对 AI 疑似占比贡献最大，其他段落保持原意');
  }

  const explicitPids = Array.isArray(body?.focusPids)
    ? body.focusPids
      .map((pid) => String(pid).trim())
      .filter((pid) => /^[A-Za-z0-9_-]{1,40}$/.test(pid))
      .slice(0, focusLimit)
    : [];
  for (const pid of explicitPids) {
    pushFocus({ pid, tags: ['requested'], source: 'requested' });
  }
  if (!hints.length) {
    if (!focus.length) {
      return {
        ok: false,
        error: '9 维诊断与逐段 AIGC 考官都没有发现需要改写的段落',
        diag: { riskCount: d.result.risk_count, riskScore: d.result.risk_score },
        detectorError,
      };
    }
    hints.push('只改被定向纳入的段落，其他段落保持原文，不改论据与结论');
  }
  const planHints = round >= 3 ? hints.slice(0, 6) : hints;

  const revision = body?.replaceVersionId
    ? reuseRevisionWorkspace(run, body.replaceVersionId)
    : createRevisionWorkspace(run, baseId);
  if (!revision.ok) return revision;
  const workdir = revision.dir;
  const hintsPath = join(workdir, scope === 'both' ? 'shuangjiang-hints.md' : 'aigc-hints.md');
  writeFileSync(hintsPath, `${planHints.map((h) => `· ${h}`).join('\n')}\n`, 'utf8');

  const includePids = focus.slice(0, focusLimit).map((x) => x.pid);

  // 跨段编排：结构对称是跨段属性，给相邻段分配不同目标句数
  let pacingPath = null;
  let pacingInfo = null;
  try {
    const pp = join(workdir, 'pacing.json');
    const pc = await runCmd(pythonBin(), [
      join(dir, 'scripts', 'pacing.py'), '--doc', baseDocJson.path, '--out', pp,
    ], dir, 120000);
    if (pc.code === 0) {
      const pj = readJson(pp);
      pacingPath = pp;
      pacingInfo = {
        runs: (pj?.runs ?? []).length,
        targets: Object.keys(pj?.targets ?? {}).length,
      };
      // 跨段编排的目标段落也要进任务：只给目标不改段，对称 run 永远不会减少。
      for (const pid of Object.keys(pj?.targets ?? {})) {
        if (!includePids.includes(pid) && includePids.length < Math.max(focusLimit, maxTasks)) {
          includePids.push(pid);
        }
      }
    }
  } catch { pacingPath = null; }

  const planArgs = [
    'run.py', 'rewrite', '--in', revision.baseDocx, '--outdir', workdir,
    '--style', 'plain', '--max-tasks', String(maxTasks), '--hints', hintsPath,
  ];
  if (includePids.length) planArgs.push('--include', includePids.join(','));
  if (pacingPath) planArgs.push('--pacing', pacingPath);
  const r = await runCmd(pythonBin(), planArgs, dir, 240000);
  if (r.code !== 0) {
    writeVersionMeta(run, {
      ...revision.meta,
      status: 'failed',
      visible: false,
      error: clip(r.err || r.out, 700),
    });
    return { ok: false, error: clip(r.err || r.out, 700), versionId: revision.id };
  }

  const tasks = readJson(join(workdir, 'tasks.json'));
  if (!tasks) {
    writeVersionMeta(run, {
      ...revision.meta,
      status: 'failed',
      visible: false,
      error: `缺少 tasks.json：${clip(r.out || r.err, 300)}`,
    });
    return { ok: false, error: `降 AI 任务生成后缺少 tasks.json（引擎输出：${clip(r.out || r.err, 300)}）` };
  }
  let archived = revision.archived || null;
  if (!revision.reused) {
    try {
      archived = archiveRunArtifacts(workdir, scope === 'both' ? 'new-both-tasks' : 'new-aigc-tasks');
    } catch (e) {
      return { ok: false, error: `新任务已生成，但旧改稿/清单无法归档：${String(e?.message ?? e)}` };
    }
  }
  const reportReady = await regenerateDiagnosticReport({ ...run, outdir: workdir });
  const prompts = (readText(join(workdir, 'prompts.jsonl')) ?? '').split('\n').filter(Boolean).length;
  const opCount = {};
  for (const t of tasks?.tasks ?? []) opCount[t.op] = (opCount[t.op] ?? 0) + 1;
  const payload = {
    at: new Date().toISOString(),
    scope,
    docPath: run.docPath,
    versionId: revision.id,
    versionLabel: revision.meta.label,
    baseVersionId: baseVersion.id,
    baseVersionLabel: baseVersion.label,
    round,
    maxRounds,
    outdir: workdir,
    hints: planHints,
    hintsPath,
    tasks: tasks?.tasks?.length ?? 0,
    prompts,
    opCount,
    focus,
    detectorBefore,
    detectorCached,
    detectorError,
    optimization: {
      mode: round >= 3 ? 'focused' : 'full',
      round,
      maxTasks,
      focusLimit,
      hints: planHints.length,
      detectorCached,
      reusedVersion: Boolean(revision.reused),
    },
    pacing: pacingInfo,
    archivedPrevious: archived,
    reportReady,
    promptsPath: join(workdir, 'prompts.jsonl'),
    editsPath: join(workdir, 'edits.jsonl'),
    diagBefore: {
      riskCount: d.result.risk_count,
      riskScore: d.result.risk_score,
      level: d.result.level,
      gate: d.result.style_gate_passed,
    },
    repeatBefore: run.summary?.repeatRate ?? null,
    textStyle: 'plain',
    constraints: CONSTRAINTS,
    belowThreshold: Boolean(tasks?.counts?.below_threshold),
    instruction: [
      `当前基础：${baseVersion.label}（${baseVersion.id}）；本轮将保存为：${revision.meta.label}（${revision.id}）。`,
      `请按 ${join(workdir, 'prompts.jsonl')} 逐行改写（每条提示词已带痕迹要求`
      + `${scope === 'both' ? '与消重要求' : ''}），`,
      `把结果写成 ${join(workdir, 'edits.jsonl')}（一行一条 {"pid","text","op"}），`,
      '然后调用工具 paper_dual_apply_edits 完成预检与回填；',
      '或者把清单内容直接贴回面板的「手动贴清单」框里点预检。',
    ].join(''),
    stdout: clip(r.out, 300),
  };
  const meta = markVersionVisible(run, revision.id, {
    status: 'planned',
    passed: null,
    tasks: payload.tasks,
    prompts: payload.prompts,
    reportReady,
  });
  saveVersionState(run, versionFromMeta(run, meta), {
    lastReduce: payload,
    lastTasks: null,
    lastApply: null,
    lastReduceCheck: null,
  });
  saveRun(run.key, { activeVersionId: revision.id, loopRound: round });
  clearAigcTarget(run.key, revision.id);
  saveState({ lastAigc: null });
  return { ok: true, ...payload };
}

// 用 pacing 的口径数「对称串」：连续 ≥3 段句数相差 ≤1 的串。
// 复检时前后各数一次，就能回答「这批改写到底拆掉了几条串」。
async function pacingRuns(docPath) {
  try {
    const run = currentRun();
    const dir = run?.outdir ? join(run.outdir, 'aigc-tmp') : join(stateDir(), 'aigc-tmp');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `pacing-runs-${Date.now()}.json`);
    const r = await runCmd(pythonBin(), [
      join(engineDir(), 'scripts', 'pacing.py'), '--doc', docPath, '--out', out,
    ], workdir(), 120000);
    if (r.code !== 0) return null;
    const pj = readJson(out);
    return (pj?.runs ?? []).length;
  } catch { return null; }
}

function snapshotAccepted(run, version) {
  if (!version?.downloadable || !existsSync(version.docx)) return false;
  copyFileSync(version.docx, join(version.workdir, 'accepted.docx'));
  for (const [name, target] of [
    ['version.result.json', 'accepted.result.json'],
    ['version.verdict.json', 'accepted.verdict.json'],
  ]) {
    const source = join(version.workdir, name);
    if (existsSync(source)) copyFileSync(source, join(version.workdir, target));
  }
  const meta = readVersionMeta(run, version.id);
  if (meta) writeVersionMeta(run, { ...meta, accepted: true, status: 'applied', passed: true });
  return true;
}

async function rollbackSemantic(run, version) {
  const rejected = join(version.workdir, `rejected-${Date.now()}`);
  mkdirSync(rejected, { recursive: true });
  for (const name of [
    'version.docx',
    'version.result.json',
    'version.verdict.json',
    'rewritten.docx',
    'report.md',
  ]) {
    const source = join(version.workdir, name);
    if (existsSync(source)) copyFileSync(source, join(rejected, name));
  }

  const meta = readVersionMeta(run, version.id) ?? {};
  writeVersionMeta(run, {
    ...meta,
    status: 'rejected',
    passed: false,
    rejectedAt: new Date().toISOString(),
    rejectedDir: rejected,
  });
  const base = versionById(run, version.baseId);
  saveRun(run.key, { activeVersionId: version.id });
  const previous = readVersionState(run, version).lastApply ?? {};
  saveVersionState(run, version, {
    lastApply: {
      ...previous,
      semanticRolledBack: true,
      semanticRollbackAt: new Date().toISOString(),
      restoredFrom: version.baseDocx,
      rejectedDir: rejected,
      output: version.docx,
      verdict: previous.verdict
        ? { ...previous.verdict, passed: false, semanticSummary: '语义指标复检未通过，已切回基础稿' }
        : null,
    },
  });
  return {
    performed: true,
    restoredFrom: version.baseDocx,
    activeVersionId: version.id,
    fallbackVersionId: base?.id || ORIGINAL_VERSION,
    rejectedDir: rejected,
    reportReady: true,
  };
}

async function reduceCheck(body) {
  const run = currentRun();
  if (!run?.docPath) return { ok: false, error: '先诊断一次' };
  if (runDocChanged(run)) {
    return { ok: false, staleSource: true, error: '原文件在诊断后被修改了，请先重新诊断再复检。' };
  }
  const version = activeVersion(run);
  if (!version || version.id === ORIGINAL_VERSION) {
    return { ok: false, error: '当前选中原文：请先切换到一版改稿再复检' };
  }
  if (!version.downloadable || !existsSync(version.docx)) {
    return { ok: false, error: `${version.label}还没有回填生成 docx` };
  }
  const baseVersion = versionById(run, version.baseId);
  if (!baseVersion) return { ok: false, error: `找不到${version.label}的基础稿` };
  const before = await aigcDiag({ versionId: baseVersion.id });
  if (!before.ok) return before;
  const after = await aigcDiag({ versionId: version.id });
  if (!after.ok) return after;
  const b = before.result;
  const a = after.result;

  // 重复率复检：对改稿再跑一次引擎诊断，拿 profile 里的篇内重复率
  let dup = null;
  let dupError = null;
  try {
    const baseChkDir = join(version.workdir, 'check-base');
    const currentChkDir = join(version.workdir, 'check-current');
    const baseRun = await runCmd(pythonBin(), [
      'run.py', 'diagnose', '--in', version.baseDocx, '--outdir', baseChkDir,
    ], engineDir(), 180000);
    if (baseRun.code !== 0) {
      throw new Error(clip(baseRun.err || baseRun.out || '基础稿诊断失败', 200));
    }
    const rr = await runCmd(pythonBin(), [
      'run.py', 'diagnose', '--in', version.docx, '--outdir', currentChkDir,
    ], engineDir(), 180000);
    if (rr.code === 0) {
      const baseProf = readJson(join(baseChkDir, 'profile.json'));
      const prof = readJson(join(currentChkDir, 'profile.json'));
      const beforeRate = baseProf?.duplicates?.stats?.repeat_rate ?? null;
      const afterRate = prof?.duplicates?.stats?.repeat_rate;
      if (typeof afterRate === 'number') {
        dup = {
          before: beforeRate,
          after: afterRate,
          delta: beforeRate == null ? null : Number((beforeRate - afterRate).toFixed(4)),
        };
      } else {
        dupError = '改稿诊断没有重复率字段';
      }
    } else {
      dupError = clip(rr.err || rr.out || `改稿诊断异常退出（${rr.code}）`, 200);
    }
  } catch (e) {
    dupError = clip(e?.message ?? e, 200);
  }

  let prob = null;
  const modelRequired = body?.requireModel !== false;
  const sb = modelRequired ? await aigcScore({ target: baseVersion.id }) : { ok: false };
  const sa = modelRequired ? await aigcScore({ target: version.id }) : { ok: false };
  const modelRequested = modelRequired ? await detectorReady() : false;
  const modelMissing = modelRequired && !modelRequested;
  if (sb.ok && sa.ok) {
    const beforeShare = aigcShare(sb.result);
    const afterShare = aigcShare(sa.result);
    const sameMetric = aigcMeasurement(sb.result) === aigcMeasurement(sa.result);
    if (beforeShare != null && afterShare != null) {
      const beforeMode = sb.result.comparison_mode || 'segmented';
      const afterMode = sa.result.comparison_mode || 'segmented';
      prob = {
        mode: sb.mode,
        metric: 'ai_share',
        mixedMetric: !sameMetric,
        comparisonMode: afterMode,
        beforeComparisonMode: beforeMode,
        frozenBlocks: beforeMode === 'frozen' && afterMode === 'frozen',
        before: beforeShare,
        after: afterShare,
        delta: sameMetric ? Number((beforeShare - afterShare).toFixed(4)) : null,
        beforeBand: sb.result.band,
        afterBand: sa.result.band,
        beforeStability: sb.result.stability,
        afterStability: sa.result.stability,
        beforeCalibrated: sb.result.calibrated,
        afterCalibrated: sa.result.calibrated,
        beforeAllShare: sb.result.all_ai_share,
        afterAllShare: sa.result.all_ai_share,
        beforeTableShare: sb.result.table_ai_share,
        afterTableShare: sa.result.table_ai_share,
        beforeReferenceShare: sb.result.reference_ai_share,
        afterReferenceShare: sa.result.reference_ai_share,
      };
    }
  }

  let detectorAfter = null;
  if (prob?.mode === 'model') {
    detectorAfter = {
      aiShare: aigcShare(sa.result),
      aiProb: sa.result.ai_prob,
      metric: aigcMeasurement(sa.result),
      comparisonMode: sa.result.comparison_mode,
      band: sa.result.band,
      stability: sa.result.stability,
      calibrated: sa.result.calibrated,
      threshold: sa.result.threshold,
      bodyChars: sa.result.body_chars,
      tableShare: sa.result.table_ai_share,
      referenceShare: sa.result.reference_ai_share,
      top: sa.result.top ?? [],
      fallbackTop: (sa.result.paragraphs ?? [])
        .filter((x) => x.group === 'rewritable' && !x.locked)
        .slice()
        .sort((x, y) => (
          Number(y.contribution ?? 0) - Number(x.contribution ?? 0)
          || Number(y.ai_prob ?? 0) - Number(x.ai_prob ?? 0)
        ))
        .slice(0, 8),
    };
  }

  const gateOk = after.gateRewritable === true;
  const beforeRisks = activeDiagnosticRisks(b);
  const afterRisks = activeDiagnosticRisks(a);
  const newRisks = [...afterRisks].filter((name) => !beforeRisks.has(name));
  const diagOk = Number(a.risk_score) <= Number(b.risk_score)
    && Number(a.risk_count) <= Number(b.risk_count)
    && newRisks.length === 0;
  const dupOk = dup ? Number(dup.after) <= Number(dup.before) : null;
  const probOk = prob?.mode === 'model'
    ? Boolean(prob.frozenBlocks) && Number(prob.after) <= Number(prob.before)
    : null;
  const probUnknown = modelRequested && !prob;
  const failed = [
    gateOk ? null : '语体门禁',
    diagOk ? null : `9 维风险${newRisks.length ? `（新增：${newRisks.join('、')}）` : ''}`,
    dupOk === false ? '篇内重复率' : null,
    dupError ? `篇内重复率未复检：${dupError}` : null,
    probOk === false ? '正文 AI 疑似占比' : null,
    prob?.mode === 'model' && !prob.frozenBlocks ? 'AIGC 复检未使用冻结块' : null,
    probUnknown ? `正文 AI 疑似占比未复检：${clip(sb.error || sa.error || '考官失败', 160)}` : null,
    modelMissing ? 'AIGC 真机依赖未安装' : null,
    process.env.PAPER_DUAL_TEST_FORCE_ROLLBACK === '1' ? '测试注入失败' : null,
  ].filter(Boolean);
  const acceptance = {
    accepted: failed.length === 0,
    gate: gateOk,
    diag: diagOk,
    newRisks,
    repeat: dupError ? false : dupOk,
    probability: (probUnknown || modelMissing) ? false : probOk,
    failed,
  };

  // 对称串口径：origin=最初诊断，before=上一轮复检的值（本批基线），after=当前改稿。
  // 只报 origin→after 会让人以为每批都在拆同几条，所以两个差值都算出来。
  const baseDoc = await docJsonFor(baseVersion.id);
  const afterDoc = await docJsonFor(version.id);
  const originRuns = baseDoc.ok ? await pacingRuns(baseDoc.path) : null;
  const afterRuns = afterDoc.ok ? await pacingRuns(afterDoc.path) : null;
  const baselineRuns = originRuns;
  const origin = originRuns;

  const round = Number(version.index || 1);
  const maxRounds = MAX_REVISIONS;
  const focusPids = detectorAfter
    ? (detectorAfter.top.length ? detectorAfter.top : detectorAfter.fallbackTop)
      .slice(0, 8).map((x) => x.pid)
    : [];
  const nextRound = {
    ready: prob?.mode === 'model',
    canContinue: !acceptance.accepted && prob?.mode === 'model'
      && round < maxRounds && focusPids.length > 0,
    round,
    nextRound: round < maxRounds ? round + 1 : null,
    maxRounds,
    reason: acceptance.failed,
    baseVersionId: version.id,
    baseVersionLabel: version.label,
    focusPids,
    detector: detectorAfter,
  };

  let acceptedSnapshot = false;
  let rollback = null;
  if (acceptance.accepted) {
    try { acceptedSnapshot = snapshotAccepted(run, version); } catch { acceptedSnapshot = false; }
  } else if (body?.autoRollback !== false) {
    try {
      rollback = await rollbackSemantic(run, version);
    } catch (e) {
      return {
        ok: false,
        error: `复检未通过，且自动回退失败：${clip(e?.message ?? e, 600)}`,
        acceptance,
      };
    }
  }

  const payload = {
    at: new Date().toISOString(),
    versionId: version.id,
    versionLabel: version.label,
    baseVersionId: baseVersion.id,
    baseVersionLabel: baseVersion.label,
    round,
    pacing: {
      origin,
      before: baselineRuns,
      after: afterRuns,
      deltaBatch: (baselineRuns != null && afterRuns != null) ? baselineRuns - afterRuns : null,
      deltaTotal: (origin != null && afterRuns != null) ? origin - afterRuns : null,
    },
    diag: {
      before: {
        riskCount: b.risk_count, riskScore: b.risk_score, level: b.level,
        gate: before.gateRewritable, gateAll: before.gateAll,
      },
      after: {
        riskCount: a.risk_count, riskScore: a.risk_score, level: a.level,
        gate: after.gateRewritable, gateAll: after.gateAll,
      },
      deltaScore: b.risk_score - a.risk_score,
      deltaRisks: b.risk_count - a.risk_count,
      todoAfter: a.todo ?? [],
    },
    dup,
    dupError,
    prob,
    acceptance,
    detectorAfter,
    nextRound,
    acceptedSnapshot,
    rollback,
    activeVersionId: rollback?.activeVersionId || version.id,
  };
  const currentMeta = readVersionMeta(run, version.id);
  if (currentMeta) {
    saveVersionState(run, versionFromMeta(run, currentMeta), { lastReduceCheck: payload });
  }
  return { ok: true, ...payload };
}

// ---------------------------------------------------------------- 状态与路由

function status() {
  const state = loadState();
  const dir = engineDir();
  let run = currentRun();
  const key = run?.key ?? '';
  const byTarget = aigcStore('aigcByDoc', key);
  const diagByTarget = aigcStore('diagByDoc', key);
  const docChanged = runDocChanged(run);
  const versions = run ? listVersions(run) : [];
  run = currentRun() || run;
  let current = run ? activeVersion(run) : null;
  if (!current && versions.length) current = versions[0];
  const currentState = run && current ? readVersionState(run, current) : {};
  const base = run && current?.baseId ? versionById(run, current.baseId) : null;
  const publicVersions = versions.map((v) => ({
    id: v.id,
    index: v.index,
    label: v.label,
    status: v.status,
    baseId: v.baseId || null,
    baseLabel: v.baseLabel || null,
    passed: v.passed ?? null,
    downloadable: Boolean(v.downloadable),
    docx: v.downloadable ? v.docx : null,
    createdAt: v.createdAt || null,
    updatedAt: v.updatedAt || null,
    error: v.error || null,
  }));
  return {
    ok: true,
    version: VERSION,
    engineDir: dir,
    engineReady: existsSync(join(dir, 'run.py')),
    engineFromEnv: Boolean(process.env.PAPER_DUAL_ENGINE),
    docx: {
      canConvertDoc: process.platform === 'win32',
      docHint: '拖入 .doc 会自动转成 .docx 再诊断（转换件是副本，不改原文件）',
    },
    lastRun: run,
    runCount: Object.keys(runs()).length,
    activeVersionId: current?.id || ORIGINAL_VERSION,
    activeVersion: current ? publicVersions.find((v) => v.id === current.id) ?? null : null,
    baseVersionId: base?.id || null,
    baseVersionLabel: base?.label || null,
    versions: publicVersions,
    versionCount: publicVersions.length,
    maxRevisions: MAX_REVISIONS,
    canCreateVersion: Number(current?.index || 0) < MAX_REVISIONS,
    lastTasks: currentState.lastTasks ?? null,
    lastApply: currentState.lastApply ?? null,
    lastReduce: currentState.lastReduce ?? null,
    lastReduceCheck: currentState.lastReduceCheck ?? null,
    loopRound: Number(current?.index ?? run?.loopRound ?? 0),
    hasEdits: Boolean(current?.workdir) && existsSync(join(current.workdir, 'edits.jsonl')),
    docChanged,
    rewrittenAvailable: Boolean(current && current.id !== ORIGINAL_VERSION && current.downloadable),
    downloadAvailable: Boolean(current?.downloadable),
    currentDocx: current?.docx || null,
    currentBaseDocx: current?.baseDocx || null,
    compareCount: buildCompare(current).length,
    aigc: {
      detectorReady: detStateCache?.ready === true,
      mode: detStateCache?.ready === true ? 'model' : 'unavailable',
      versions: detStateCache?.versions ?? null,
      last: state.lastAigc ?? null,
      aiLabel: Number.isInteger(state.aiLabel) ? state.aiLabel : null,
      calibratedAt: state.calibratedAt ?? null,
      calibrated: Number.isInteger(state.aiLabel),
      byTarget,
      diagByTarget,
    },
  };
}

const handler = async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://dsh');
  const path = url.pathname.replace(PREFIX, '') || '/';
  try {
    if (path === '/status' || path === '/') return sendJson(res, 200, status());

    if (path === '/diagnose' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await diagnose(String(body.path ?? '').trim()));
    }
    if (path === '/rewrite' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await runRewrite(
        body.path ? String(body.path).trim() : '',
        { baseVersionId: body.baseVersionId, versionId: body.versionId },
      ));
    }
    if (path === '/lint' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await runLint(body));
    }
    if (path === '/apply' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await runApply(body));
    }
    if (path === '/aigc/status') return sendJson(res, 200, await aigcStatus());
    if (path === '/aigc/score' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await aigcScore(body));
    }
    if (path === '/aigc/segments' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await aigcSegments(body));
    }
    if (path === '/aigc/diag' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await aigcDiag(body));
    }
    if (path === '/aigc/selftest' && req.method === 'POST') {
      return sendJson(res, 200, await aigcSelftest());
    }
    if (path === '/aigc/calibrate' && req.method === 'POST') {
      return sendJson(res, 200, await aigcCalibrate());
    }
    if (path === '/aigc/delta' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await aigcDelta(body));
    }
    if (path === '/reduce/plan' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await reducePlan(body));
    }
    if (path === '/reduce/check' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await reduceCheck(body));
    }
    // 拖拽兜底：新版 Electron 不再暴露 File.path，只有文件名。
    // 前端把文件内容 base64 送来，这里落盘到 state 目录，返回真实绝对路径。
    if (path === '/upload' && req.method === 'POST') {
      const body = await readBody(req);
      const rawName = String(body?.name || 'upload.docx');
      // 只替换 Windows 非法字符，保留中文与空格；否则「测试文档.docx」会变成「____.docx」
      const name = (basename(rawName).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)) || 'upload.docx';
      if (!/\.(docx|doc)$/i.test(name)) {
        return sendJson(res, 400, {
          ok: false,
          error: `只收 Word 文档（.doc / .docx），收到的是 ${name.split('.').pop()}。PDF 请先转成 Word。`,
        });
      }
      const b64 = String(body?.dataBase64 || '');
      if (!b64) return sendJson(res, 400, { ok: false, error: '没有文件内容' });
      if (b64.length > 48 * 1024 * 1024) {
        return sendJson(res, 413, { ok: false, error: '文件太大（超过 36MB）' });
      }
      const buf = Buffer.from(b64, 'base64');
      const dir = join(stateDir(), 'uploads');
      mkdirSync(dir, { recursive: true });
      const digest = createHash('sha256').update(buf).digest('hex').slice(0, 12);
      const out = join(dir, `${digest}-${name}`);
      const existed = existsSync(out);
      if (!existed) writeFileSync(out, buf);
      return sendJson(res, 200, { ok: true, path: out, size: buf.length, reused: existed });
    }
    if (path === '/compare') {
      const rows = buildCompare();
      return sendJson(res, 200, { ok: true, rows, count: rows.length });
    }
    if (path === '/versions') {
      const s = status();
      return sendJson(res, 200, {
        ok: true,
        activeVersionId: s.activeVersionId,
        versions: s.versions,
      });
    }
    if (path === '/versions/select' && req.method === 'POST') {
      const run = currentRun();
      if (!run) return sendJson(res, 200, { ok: false, error: '先诊断一次' });
      const body = await readBody(req);
      const selected = selectVersion(run, String(body?.versionId || ''));
      if (!selected.ok) return sendJson(res, 200, selected);
      return sendJson(res, 200, status());
    }
    if (path === '/download') {
      const run = currentRun();
      if (!run) return sendJson(res, 404, { ok: false, error: '先诊断一次' });
      const id = resolveVersionId(run, url.searchParams.get('version') || run.activeVersionId);
      const version = versionById(run, id);
      if (!version) return sendJson(res, 404, { ok: false, error: `版本不存在：${id}` });
      if (!version.downloadable || !existsSync(version.docx)) {
        return sendJson(res, 404, { ok: false, error: `${version.label}还没有生成 docx` });
      }
      const stem = basename(run.docPath || '论文').replace(/\.(docx|doc)$/i, '');
      return sendFile(res, version.docx, `${stem}-${version.label}.docx`);
    }
    // 手动贴清单：GET 读回当前文档目录里的 edits.jsonl；POST 校验后落盘。
    if (path === '/edits' && req.method === 'POST') {
      const run = currentRun();
      if (!run?.outdir) return sendJson(res, 200, { ok: false, error: '还没有诊断结果' });
      const version = activeVersion(run);
      if (!version) return sendJson(res, 200, { ok: false, error: '当前版本不存在' });
      const body = await readBody(req);
      const file = join(version.workdir, 'edits.jsonl');
      const saved = writeEditsFromText(file, String(body?.text ?? ''));
      if (!saved.ok) return sendJson(res, 200, saved);
      const guard = guardEdits(file, version.workdir);
      return sendJson(res, 200, {
        ok: guard.ok,
        lines: saved.lines,
        path: file,
        counts: guard.ok ? { total: guard.total, unknown: guard.unknownIds?.length ?? 0 } : null,
        stale: guard.ok ? false : Boolean(guard.stale),
        error: guard.ok ? undefined : guard.error,
      });
    }
    if (path === '/edits') {
      const run = currentRun();
      if (!run?.outdir) return sendJson(res, 200, { ok: false, error: '还没有诊断结果' });
      const version = activeVersion(run);
      if (!version) return sendJson(res, 200, { ok: false, error: '当前版本不存在' });
      const file = join(version.workdir, 'edits.jsonl');
      const text = readText(file);
      return sendJson(res, 200, { ok: true, exists: text != null, path: file, text: text ?? '' });
    }
    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.engineDir === 'string') {
        patch.engineDir = body.engineDir.trim().replace(/^["']+|["']+$/g, '');
      }
      if (typeof body.pythonPath === 'string') {
        // 空字符串 = 清空，回到 PATH 上的 python
        patch.pythonPath = body.pythonPath.trim();
        pyExeCache = undefined;
        detStateCache = undefined;
      }
      if (typeof body.hfCacheDir === 'string') {
        patch.hfCacheDir = body.hfCacheDir.trim();
      }
      const next = saveState(patch);
      return sendJson(res, 200, {
        ok: true,
        engineDir: next.engineDir || engineDir(),
        pythonPath: next.pythonPath || '',
        hfCacheDir: next.hfCacheDir || modelCacheRoot(),
      });
    }
    if (path === '/report') {
      const run = currentRun();
      if (!run?.outdir) return sendJson(res, 200, { ok: false, error: '还没有跑过诊断' });
      const version = activeVersion(run);
      const reportDir = version?.workdir || run.outdir;
      const which = url.searchParams.get('which') || 'report.md';
      const allowed = ['report.md', 'profile.json', 'rewritten.verdict.json', 'rewritten.result.json'];
      const safe = allowed.includes(which) ? which : 'report.md';
      return sendJson(res, 200, { ok: true, which: safe, text: readText(join(reportDir, safe)) ?? '' });
    }
    return sendJson(res, 404, { ok: false, error: `未知接口：${path}` });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
};

const toolOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

function verdictLine(v) {
  if (!v) return '未复检';
  return v.passed
    ? `通过（改写 ${v.changed} 段，字数 ${v.chars[0]}→${v.chars[1]}）`
    : '不通过（已整篇回退）';
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'dsh-paper-dual: routes',
  );

  ctx.tools.register({
    name: 'paper_dual_status',
    description: '论文双降引擎状态：引擎目录、诊断/改写/复检进度、是否有待回填的编辑清单。只读。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: toolOutput,
    isConcurrencySafe: () => true,
    timeoutMs: 15000,
    async execute() {
      const s = status();
      const lines = [
        `引擎：${s.engineDir}${s.engineReady ? '（就绪）' : '（找不到 run.py）'}`,
        s.lastRun ? `最近诊断：${s.lastRun.title} @ ${s.lastRun.at}` : '最近诊断：无',
        `当前版本：${s.activeVersion?.label || '原文'}（${s.activeVersionId}）`
          + `${s.baseVersionLabel ? `，基础：${s.baseVersionLabel}` : ''}；共 ${s.versionCount} 个标签`,
        `版本上限：最多五改；${s.canCreateVersion ? '还可继续生成下一版' : '已达到上限'}`,
        `已保存 ${s.runCount} 篇运行记录；原文${s.docChanged ? '已变化，需要重新诊断' : '未变化'}`,
        s.lastTasks ? `改写任务：${s.lastTasks.tasks} 段 / ${s.lastTasks.prompts} 条提示词` : '改写任务：未生成',
        s.hasEdits ? '编辑清单：已存在' : '编辑清单：无',
        `复检：${verdictLine(s.lastApply?.verdict)}`,
      ];
      return { text: lines.join('\n') };
    },
  });

  ctx.tools.register({
    name: 'paper_dual_diagnose',
    description: '诊断一篇中文论文 .doc/.docx：跑 paper-dual-reduce 的 diagnose，返回风险分布、Top 风险段落与报告路径。只读，不改原始文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: '论文 .doc 或 .docx 的绝对路径' } },
    },
    output: toolOutput,
    timeoutMs: 200000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const r = await diagnose(String(args.path ?? ''));
      if (!r.ok) return { text: `诊断失败：${r.error}${r.hint ? `（${r.hint}）` : ''}` };
      const d = r.summary.dist;
      const top = r.summary.top.slice(0, 5)
        .map((x) => `  ${x.pid} 风险 ${Number(x.risk).toFixed(2)} ｜ ${x.cause} ｜ ${x.chars} 字`)
        .join('\n');
      return {
        text: [
          `诊断完成：${r.docPath}`,
          `风险分布 高/中/低：${d.high ?? 0}/${d.mid ?? 0}/${d.low ?? 0}`,
          `篇内重复率：${(100 * r.summary.repeatRate).toFixed(1)}%`,
          'Top 段落：',
          top || '  （无可改写段落）',
          `报告：${join(r.outdir, 'report.md')}`,
        ].join('\n'),
      };
    },
  });

  ctx.tools.register({
    name: 'paper_dual_rewrite',
    description: '为已诊断的论文生成改写任务与提示词。之后由模型逐行改写产出 edits.jsonl。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '可选的 .doc/.docx 路径；省略则用最近一次诊断的文档' },
        baseVersionId: { type: 'string', description: '可选的基础版本，例如 original、v1、v2' },
      },
    },
    output: toolOutput,
    timeoutMs: 200000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const r = await runRewrite(args?.path ? String(args.path) : '', {
        baseVersionId: args?.baseVersionId,
      });
      if (!r.ok) return { text: `生成改写任务失败：${r.error}` };
      return {
        text: [
          `任务 ${r.tasks} 段 ｜ 提示词 ${r.prompts} 条 ｜ 文风 ${r.textStyle}`,
          `版本：${r.baseVersionLabel || '原文'} → ${r.versionLabel || '新改稿'}（${r.versionId || '?'}）`,
          r.belowThreshold ? '注意：全文没有段落达到风险阈值，已按相对排序取前几段' : '',
          `提示词：${r.promptsPath}`,
          `编辑清单：${r.editsPath}`,
          '',
          r.instruction,
        ].filter(Boolean).join('\n'),
      };
    },
  });

  ctx.tools.register({
    name: 'paper_dual_apply_edits',
    description: '把当前版本任务对应的 edits.jsonl 回填成新版本，并保存 docx/结果/判词。AIGC/双降模式会在同块边界下强制模型复检，复检不过自动回退。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        edits: {
          type: 'string',
          description: 'edits.jsonl 的内容（多行 JSONL）。省略则用 out 目录里已有的 edits.jsonl',
        },
      },
    },
    output: toolOutput,
    timeoutMs: 900000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const r = await runApply({ edits: args?.edits });
      if (!r.ok) return { text: `回填失败：${r.error}` };
      const c = r.apply ?? {};
      const lint = r.lint ?? {};
      return {
        text: [
          `版本：${r.baseVersionLabel || '原文'} → ${r.versionLabel || '新改稿'}（${r.versionId || '?'}）`,
          `预检：可通过 ${lint.would_apply ?? '?'} ｜ 会被拒 ${lint.would_reject ?? '?'}`,
          `回填：提交 ${c.edits ?? '?'} ｜ 接受 ${c.applied ?? '?'} ｜ 拒绝 ${c.rejected ?? '?'} ｜ 状态 ${r.applyStatus ?? '?'}`,
          `结构复检：${r.verdict?.structuralPassed ?? r.verdict?.passed ? '通过' : '未通过'}`,
          r.mandatoryCheck ? `AIGC 复检：${r.mandatoryCheck.acceptance?.accepted ? '通过' : '未通过'}` : '',
          r.mandatoryCheck ? `正文 AI 疑似：${(100 * Number(r.prob?.before ?? 0)).toFixed(1)}% → ${(100 * Number(r.prob?.after ?? 0)).toFixed(1)}%` : '',
          `改稿：${r.output}`,
          r.rolledBack ? '注意：篇级校验未通过，本版仍保留供下载/继续修改' : '',
        ].filter(Boolean).join('\n'),
      };
    },
  });

  ctx.tools.register({
    name: 'paper_dual_aigc',
    description: 'AIGC 考官：计算当前论文（或改稿）的 AI 疑似占比并做 9 维 AI 痕迹诊断。'
      + '必须安装 transformers + torch；缺依赖时只返回安装步骤，不生成伪分数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['original', 'rewritten'],
          description: 'original=原文，rewritten=最新可下载改稿；也可用 versionId 指定 v1/v2/...',
        },
        versionId: { type: 'string', description: '版本 id，例如 original、v1、v2' },
      },
    },
    output: toolOutput,
    timeoutMs: 900000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const target = args?.versionId || args?.target || 'original';
      const s = await aigcScore({ target });
      if (!s.ok) {
        return {
          text: [
            `打分失败：${s.error}`,
            s.setup?.installScript ? 'PowerShell 安装步骤：' : '',
            s.setup?.installScript || '',
            s.setup?.python ? `安装后解释器：${s.setup.python}` : '',
            s.setup?.modelCacheDir ? `模型缓存：${s.setup.modelCacheDir}` : '',
          ].filter(Boolean).join('\n'),
        };
      }
      const d = await aigcDiag({ target });
      const r = s.result;
      const share = aigcShare(r);
      const legacy = aigcMeasurement(r) !== 'ai_share';
      const segsAll = (r.segments ?? []).filter((g) => !g.group || g.group === 'rewritable');
      const segs = segsAll.slice()
        .sort((a, b) => (
          Number(b.contribution ?? 0) - Number(a.contribution ?? 0)
          || Number(b.ai_prob ?? 0) - Number(a.ai_prob ?? 0)
        ))
        .slice(0, 8)
        .map((g) => `#${g.index} 块分 ${(100 * g.ai_prob).toFixed(0)}% / 贡献 ${(100 * Number(g.contribution ?? 0)).toFixed(1)}%`)
        .join(' · ');
      const lines = [
        `AIGC 考官（真机）｜ ${target}`,
        `正文 AI 疑似占比 ${(100 * (share ?? 0)).toFixed(1)}% ｜ ${r.body_chars ?? r.chars} 字 ｜ ${segsAll.length} 块`
          + ` ｜ ${r.calibrated ? '已校准' : '未校准'} ｜ ${AIGC_BAND_LABELS[r.band] || '未判档'}`
          + ` ｜ ${r.comparison_mode === 'frozen' ? '冻结块' : '重新切块'}`
          + `${legacy ? ' ｜ 旧口径（均值）' : ''}`,
        `全篇 ${(100 * Number(r.all_ai_share ?? r.ai_share ?? 0)).toFixed(1)}%`
          + ` ｜ 表格 ${r.table_ai_share == null ? '—' : `${(100 * r.table_ai_share).toFixed(1)}%`}`
          + ` ｜ 参考文献 ${r.reference_ai_share == null ? '—' : `${(100 * r.reference_ai_share).toFixed(1)}%`}`,
        r.stability != null ? `切分稳定度 ${Number(r.stability).toFixed(4)}${Number(r.stability) > 0.06 ? '（结论依赖切分，建议看块级）' : ''}` : '',
        segs ? `贡献最高块：${segs}${segsAll.length > 8 ? ` …共 ${segsAll.length} 块` : ''}` : '',
      ];
      if (r.top?.length) {
        lines.push(
          `正文块定位：${r.top.slice(0, 8).map((x) => (
            `${x.pid} 块分 ${(100 * x.ai_prob).toFixed(0)}% / 贡献 ${(100 * Number(x.contribution ?? 0)).toFixed(1)}%`
          )).join(' · ')}`,
        );
      }
      if (d.ok) {
        const dg = d.result;
        lines.push(
          `9 维诊断：风险 ${dg.risk_count} 项 ｜ 等级 ${dg.level} ｜ 语体门禁 ${dg.style_gate_passed ? '通过' : '未通过'}`,
          ...(dg.todo ?? []).map((t) => `  · ${t}`),
        );
      } else {
        lines.push(`9 维诊断失败：${d.error}`);
      }
      return { text: lines.filter(Boolean).join('\n') };
    },
  });
}
