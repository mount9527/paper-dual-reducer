// dsh-paper-dual · 宿主半边（v0.2）
// 职责：跑 paper-dual-reduce 引擎（python）、读 JSON 产物、把结果整理成面板要的形状。
// 只用 Node 内置模块：profile 里的 @deepseek-ai/* 包在插件目录解析不到（实测），
// 所以宿主这一侧不依赖任何第三方库。
//
// v0.2 变更：删除 GitHub 同步（/sync 与相关状态）；新增改写闭环
//   /rewrite（生成任务）→ 模型写 edits.jsonl → /apply（预检+回填+复检）→ /compare（三栏对照）
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
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

function stateDir() { return join(homedir(), '.dsh', 'paper-dual'); }
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
}

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function readJson(p) {
  const t = readText(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
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
  const docPath = normalizeDocPath(rawPath);
  if (!existsSync(join(dir, 'run.py'))) {
    return { ok: false, error: `引擎目录里没有 run.py：${dir}（在设置里改成 paper-dual-reduce 的绝对路径）` };
  }
  if (!docPath || !existsSync(docPath)) {
    return { ok: false, error: `找不到文档：${docPath || '（空）'}` };
  }
  if (!/\.docx$/i.test(docPath)) {
    return { ok: false, error: '只支持 .docx（.doc 请先在 Word 里另存为 .docx）' };
  }
  let prepared;
  try {
    prepared = prepareRunDir(docPath);
  } catch (e) {
    return { ok: false, error: `无法准备独立产物目录：${String(e?.message ?? e)}` };
  }
  const r = await runCmd(
    pythonBin(),
    ['run.py', 'diagnose', '--in', docPath, '--outdir', prepared.staging],
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
    copyFileSync(docPath, join(prepared.staging, 'source.docx'));
  } catch (e) {
    discardRunDir(prepared);
    return { ok: false, error: `无法保存原文档快照：${String(e?.message ?? e)}` };
  }
  try {
    publishRunDir(prepared);
  } catch (e) {
    discardRunDir(prepared);
    return { ok: false, error: `无法发布本次产物：${String(e?.message ?? e)}` };
  }
  const outdir = prepared.outdir;

  const summary = summarize(doc, profile);
  const at = new Date().toISOString();
  saveState({
    lastRun: { key: documentKey(docPath), docPath, outdir, at, title: basename(docPath), summary },
    // 新文档 = 旧的改写产物作废
    lastTasks: null,
    lastApply: null,
    lastReduce: null,
    lastReduceCheck: null,
    lastAigc: null,
    loopRound: 0,
    pacingBaseline: null,
    pacingOrigin: null,
  });
  return { ok: true, at, docPath, outdir, summary, stdout: clip(r.out, 400) };
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
    '写完后调用工具 paper_dual_apply_edits（预检 → 回填 → 复检），或回到面板点「回填并复检」。',
  ].join('\n');
}

async function ensureDiagnosed(rawPath) {
  const state = loadState();
  const requested = normalizeDocPath(rawPath || state.lastRun?.docPath || '');
  if (!requested) return { ok: false, error: '先诊断一次（或在面板里填路径），才有文档可改写' };
  const same = state.lastRun
    && String(state.lastRun.docPath).toLowerCase() === requested.toLowerCase()
    && existsSync(state.lastRun.outdir);
  if (same) return { ok: true, run: state.lastRun };

  const diagnosed = await diagnose(requested);
  if (!diagnosed.ok) return diagnosed;
  return { ok: true, run: loadState().lastRun };
}

async function runRewrite(docPath) {
  const dir = engineDir();
  if (!existsSync(join(dir, 'run.py'))) return { ok: false, error: `引擎目录里没有 run.py：${dir}` };
  const ensured = await ensureDiagnosed(docPath);
  if (!ensured.ok) return ensured;
  const run = ensured.run;
  const doc = run.docPath;
  const outdir = run.outdir;
  const r = await runCmd(pythonBin(),
    ['run.py', 'rewrite', '--in', doc, '--outdir', outdir, '--style', 'plain'], dir, 180000);
  if (r.code !== 0) return { ok: false, error: clip(r.err || r.out, 700) };

  const tasks = readJson(join(outdir, 'tasks.json'));
  const promptsText = readText(join(outdir, 'prompts.jsonl')) ?? '';
  if (!tasks) return { ok: false, error: `改写任务生成后缺少 tasks.json（引擎输出：${clip(r.out || r.err, 300)}）` };
  let archived;
  try {
    archived = archiveRunArtifacts(outdir, 'new-tasks');
  } catch (e) {
    return { ok: false, error: `新任务已生成，但旧改稿/清单无法归档：${String(e?.message ?? e)}` };
  }
  const reportReady = await regenerateDiagnosticReport(run);
  const prompts = promptsText.split('\n').filter(Boolean).length;
  const at = new Date().toISOString();
  const payload = {
    at,
    docPath: doc,
    outdir,
    tasks: tasks?.tasks?.length ?? 0,
    prompts,
    textStyle: tasks?.text_style ?? 'plain',
    promptsPath: join(outdir, 'prompts.jsonl'),
    editsPath: join(outdir, 'edits.jsonl'),
    belowThreshold: Boolean(tasks?.counts?.below_threshold),
    instruction: buildModelInstruction(outdir, doc),
    constraints: CONSTRAINTS,
    reportReady,
  };
  saveState({
    lastTasks: payload,
    loopRound: 0,
    lastApply: null,
    lastReduce: null,
    lastReduceCheck: null,
    lastAigc: null,
  });
  if (archived) payload.archivedPrevious = archived;
  return { ok: true, ...payload, stdout: clip(r.out, 400) };
}

async function runLint() {
  const dir = engineDir();
  const run = loadState().lastRun;
  if (!run?.docPath) return { ok: false, error: '先诊断一次' };
  const edits = join(run.outdir, 'edits.jsonl');
  if (!existsSync(edits)) return { ok: false, error: `没有改写清单：${edits}（先让模型产出）` };
  const lintPath = join(run.outdir, 'lint.json');
  removeIfExists(lintPath);
  const r = await runCmd(pythonBin(),
    ['run.py', 'lint', '--in', run.docPath, '--outdir', run.outdir, '--edits', edits], dir, 120000);
  const lint = readJson(lintPath);
  if (!lint) return { ok: false, error: clip(r.err || r.out || '预检没有产出 lint.json', 600) };
  if (r.code !== 0 && r.code !== 1) {
    return { ok: false, error: clip(r.err || r.out || `预检异常退出（${r.code}）`, 600) };
  }
  const rejected = (lint.items ?? []).filter((i) => i.status === 'would_reject').slice(0, 20);
  return { ok: true, counts: lint.counts, rejected, exitCode: r.code };
}

async function runApply(body) {
  const dir = engineDir();
  const run = loadState().lastRun;
  if (!run?.docPath) return { ok: false, error: '先诊断一次' };
  const edits = join(run.outdir, 'edits.jsonl');

  const text = typeof body?.edits === 'string' ? body.edits.trim() : '';
  if (text) {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      try { JSON.parse(lines[i]); } catch {
        return { ok: false, error: `edits 第 ${i + 1} 行不是合法 JSON：${clip(lines[i], 80)}` };
      }
    }
    writeFileSync(edits, `${lines.join('\n')}\n`, 'utf8');
  }
  if (!existsSync(edits)) {
    return { ok: false, error: `没有改写清单：${edits}（让模型先产出，或把 JSONL 传上来）` };
  }

  const lintPath = join(run.outdir, 'lint.json');
  const resultPath = join(run.outdir, 'rewritten.result.json');
  const verdictPath = join(run.outdir, 'rewritten.verdict.json');
  removeIfExists(lintPath);
  removeIfExists(resultPath);
  removeIfExists(verdictPath);
  saveState({ lastApply: null });

  const lintRun = await runCmd(pythonBin(),
    ['run.py', 'lint', '--in', run.docPath, '--outdir', run.outdir, '--edits', edits], dir, 120000);
  const lint = readJson(lintPath);
  if (!lint) {
    return { ok: false, error: clip(lintRun.err || lintRun.out || '预检没有产出 lint.json', 700) };
  }
  if (lintRun.code !== 0 && lintRun.code !== 1) {
    return { ok: false, error: clip(lintRun.err || lintRun.out || `预检异常退出（${lintRun.code}）`, 700) };
  }

  const finRun = await runCmd(pythonBin(),
    ['run.py', 'finish', '--in', run.docPath, '--outdir', run.outdir, '--edits', edits,
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
  const payload = {
    at,
    editsPath: edits,
    lint: lint?.counts ?? null,
    apply: result?.counts ?? null,
    applyStatus: result?.status ?? null,
    output: join(run.outdir, 'rewritten.docx'),
    verdict: verdict
      ? {
        passed: Boolean(verdict.passed),
        summary: verdict.summary,
        changed: verdict.text?.changed_paragraphs ?? 0,
        chars: [verdict.text?.before_chars ?? 0, verdict.text?.after_chars ?? 0],
      }
      : null,
    rolledBack: /rolled_back/i.test(result?.status ?? ''),
  };
  saveState({ lastApply: payload });
  return {
    ok: true,
    ...payload,
    log: clip(`${lintRun.out}${finRun.out}`, 700),
  };
}

function buildCompare() {
  const run = loadState().lastRun;
  if (!run?.outdir) return [];
  const doc = readJson(join(run.outdir, 'doc.json'));
  const result = readJson(join(run.outdir, 'rewritten.result.json'));
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

async function docJsonFor(target) {
  const run = loadState().lastRun;
  if (!run?.outdir) return { ok: false, error: '先诊断一次' };
  if (target === 'rewritten') {
    const docx = join(run.outdir, 'rewritten.docx');
    if (!existsSync(docx)) return { ok: false, error: '还没有改稿：先做一次「回填并复检」' };
    const tmp = join(stateDir(), 'aigc-tmp');
    mkdirSync(tmp, { recursive: true });
    const out = join(tmp, `${run.key || documentKey(run.docPath)}-rewritten.json`);
    const r = await runCmd(pythonBin(),
      ['scripts/inspect_docx.py', '--in', docx, '--out', out], engineDir(), 120000);
    if (r.code !== 0) return { ok: false, error: clip(r.err || r.out, 400) };
    const texts = docTexts(out);
    if (!texts) return { ok: false, error: '改稿解析失败' };
    return { ok: true, path: out, texts, run };
  }
  const path = join(run.outdir, 'doc.json');
  const texts = docTexts(path);
  if (!texts) return { ok: false, error: '缺 doc.json：重新诊断一次' };
  return { ok: true, path, texts, run };
}

async function textFor(target) {
  const d = await docJsonFor(target);
  if (!d.ok) return d;
  return { ok: true, text: d.texts.all, rewritable: d.texts.rewritable };
}

async function resolveAigcText(body) {
  const target = body?.target === 'rewritten' ? 'rewritten' : 'original';
  const inline = typeof body?.text === 'string' ? body.text : '';
  if (inline.trim()) return { ok: true, target: 'inline', text: inline };
  const t = await textFor(target);
  return t.ok ? { ...t, target } : t;
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
  const venv = 'E:\\paper-dual-aigc';
  const configured = loadState();
  const cache = configured.hfCacheDir || 'E:\\paper-dual-aigc\\hf-cache';
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
    modelHint: '安装依赖并填写解释器/缓存路径后，点「校准」会联网下载约 409MB 的 pytorch_model.bin。',
    modelUrl: 'https://huggingface.co/yuchuantian/AIGC_detector_zhv3',
    notify: '未安装 transformers + torch，AIGC 概率不可用；插件不会生成或显示伪概率。',
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
  return {
    ok: true,
    diagReady: existsSync(join(AIGC_DIR, 'diag.py')),
    detectorReady: ready,
    mode: ready ? 'model' : 'unavailable',
    model: 'yuchuantian/AIGC_detector_zhv3',
    python: py || pythonBin(),
    pythonIsCustom: Boolean(loadState().pythonPath),
    versions: detInfo.versions ?? {},
    note: ready
      ? '真机模式：torch + transformers 已就绪，分数是模型推理结果'
      : '依赖未安装：不会显示 AIGC 概率，请按面板安装步骤配置',
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

async function aigcScore(body) {
  const t = await resolveAigcText(body);
  if (!t.ok) return t;
  if (!t.text.trim()) return { ok: false, error: '没有可打分的文本' };
  const detInfo = await detectorState();
  if (!detInfo.ready) return aigcMissing(detInfo);
  mkdirSync(stateDir(), { recursive: true });
  const file = join(stateDir(), `aigc-${t.target}.txt`);
  writeFileSync(file, t.text, 'utf8');

  const args = ['detector.py', '--file', file, '--json'];
  const st = loadState();
  if (Number.isInteger(st.aiLabel)) args.push('--ai-label', String(st.aiLabel));
  const out = await runAigcJson(args, 300000);
  if (!out.ok) return { ok: false, error: out.error };

  const result = out.json;
  const at = new Date().toISOString();
  saveState({
    lastAigc: {
      at, target: t.target, mode: 'model',
      aiProb: result.ai_prob, chars: result.chars,
    },
    ...(Number.isInteger(result.ai_index) && result.ai_index >= 0
      ? { aiLabel: result.ai_index, calibratedAt: at }
      : {}),
  });
  return { ok: true, at, target: t.target, mode: 'model', result };
}

async function aigcSegments(body) {
  const target = body?.target === 'rewritten' ? 'rewritten' : 'original';
  const d = await docJsonFor(target);
  if (!d.ok) return d;
  const detInfo = await detectorState();
  if (!detInfo.ready) return aigcMissing(detInfo);
  const outPath = join(d.run.outdir, `segscore-${target}.json`);
  const args = [
    join(AIGC_DIR, 'segscore.py'),
    '--doc', d.path,
    '--out', outPath,
  ];
  const st = loadState();
  if (Number.isInteger(st.aiLabel)) args.push('--ai-label', String(st.aiLabel));
  const r = await runCmd(pythonBin(), args, AIGC_DIR, 300000);
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
  };
}

async function aigcDiag(body) {
  const t = await resolveAigcText(body);
  if (!t.ok) return t;
  if (!t.text.trim()) return { ok: false, error: '没有可诊断的文本' };
  mkdirSync(stateDir(), { recursive: true });
  const file = join(stateDir(), `aigc-${t.target}.txt`);
  writeFileSync(file, t.text, 'utf8');
  const out = await runAigcJson(['diag.py', '--file', file, '--json'], 120000);
  if (!out.ok) return { ok: false, error: out.error };

  // 双口径门禁：锁定段（标题/表格/参考文献/代码块）永远不改写，
  // 若把它们算进语体门禁，就会出现一个「永远改不掉的红灯」。
  // 所以：全文口径只作提示，验收看「只算可改写段」的口径。
  let gateRewritable = out.json.style_gate_passed;
  const rwText = typeof t.rewritable === 'string' ? t.rewritable : '';
  if (rwText && rwText !== t.text) {
    const rwFile = join(stateDir(), `aigc-${t.target}-rw.txt`);
    writeFileSync(rwFile, rwText, 'utf8');
    const rw = await runAigcJson(['diag.py', '--file', rwFile, '--json'], 120000);
    if (rw.ok) gateRewritable = rw.json.style_gate_passed;
  }
  return {
    ok: true,
    at: new Date().toISOString(),
    target: t.target,
    result: out.json,
    gateAll: out.json.style_gate_passed,
    gateRewritable,
    hasRewritableView: Boolean(rwText && rwText !== t.text),
    gateExit: out.code !== 0,
  };
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
async function aigcDelta() {
  const a = await aigcScore({ target: 'original' });
  if (!a.ok) return a;
  const b = await aigcScore({ target: 'rewritten' });
  if (!b.ok) return b;
  const before = Number(a.result.ai_prob);
  const after = Number(b.result.ai_prob);
  return {
    ok: true,
    mode: a.mode,
    before,
    after,
    delta: Number((before - after).toFixed(4)),
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
  const run = loadState().lastRun;
  if (!run?.docPath) return { ok: false, error: '先诊断一次' };
  const d = await aigcDiag({ target: 'original' });
  if (!d.ok) return { ok: false, error: `先跑 9 维诊断拿到痕迹清单：${d.error}` };
  const hints = buildHints(d.result);
  if (scope === 'both') {
    // 双降不是「两次改写」，而是一次改写同时满足两个目标：
    // AIGC 侧的痕迹要求 + 重复侧的合并/回指要求，一起写进同一批提示词。
    hints.push('对篇内重复的片段做合并、回指或概括：同一内容只讲一遍，重复率不得上升');
    hints.push('合并不改变论点顺序与论据数量；不得为了消重删掉限定词');
  }
  const dir = engineDir();
  const round = Math.max(1, Number(loadState().loopRound || 0) + 1);
  const maxRounds = Math.min(Math.max(Number(body?.maxRounds) || 3, 1), 8);
  const hintsPath = join(run.outdir, scope === 'both' ? 'shuangjiang-hints.md' : 'aigc-hints.md');
  mkdirSync(run.outdir, { recursive: true });

  const fallbackTasks = scope === 'both' ? 16 : 12;
  const maxTasks = Math.min(Math.max(Number(body?.maxTasks) || fallbackTasks, 1), 30);

  // 逐段定位痕迹：只改「整篇统计过关」的段落是改不到指标的，
  // 必须把带具体痕迹的段落强制纳入本轮（plan.py --include）。
  let focus = [];
  const pushFocus = (item) => {
    if (!item?.pid || focus.some((x) => x.pid === item.pid)) return;
    focus.push(item);
  };
  try {
    const segPath = join(run.outdir, 'segdiag.json');
    const sg = await runCmd(pythonBin(), [
      join(AIGC_DIR, 'segdiag.py'), '--doc', join(run.outdir, 'doc.json'), '--out', segPath,
    ], AIGC_DIR, 120000);
    if (sg.code === 0) {
      const seg = readJson(segPath);
      for (const item of (seg?.paragraphs ?? []).slice(0, 8)) {
        pushFocus({ ...item, source: 'trace' });
      }
    }
  } catch { /* 没有 segdiag 时就退回纯风险选段 */ }

  // 真机考官逐段概率是最直接的下一轮选段依据。
  let detectorBefore = null;
  let detectorError = null;
  if (body?.useDetector !== false && await detectorReady()) {
    const ds = await aigcSegments({ target: 'original' });
    if (ds.ok && ds.mode === 'model') {
      detectorBefore = {
        aiProb: ds.result.ai_prob,
        threshold: ds.result.threshold,
        top: ds.result.top ?? [],
      };
      for (const item of detectorBefore.top.slice(0, 8)) {
        pushFocus({
          pid: item.pid,
          tags: ['aigc_high'],
          risk_score: item.ai_prob,
          ai_prob: item.ai_prob,
          chars: item.chars,
          source: 'detector',
        });
      }
      if (detectorBefore.top.length) {
        hints.push('优先重写 H 分段：它们由当前 AIGC 模型判为高概率，其他段落保持原意');
      }
    } else {
      detectorError = ds.ok ? '逐段考官没有进入真机模式' : ds.error;
    }
  }

  const explicitPids = Array.isArray(body?.focusPids)
    ? body.focusPids
      .map((pid) => String(pid).trim())
      .filter((pid) => /^[A-Za-z0-9_-]{1,40}$/.test(pid))
      .slice(0, 20)
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
  writeFileSync(hintsPath, `${hints.map((h) => `· ${h}`).join('\n')}\n`, 'utf8');

  const includePids = focus.map((x) => x.pid);

  // 跨段编排：结构对称是跨段属性，给相邻段分配不同目标句数
  let pacingPath = null;
  let pacingInfo = null;
  try {
    const pp = join(run.outdir, 'pacing.json');
    const pc = await runCmd(pythonBin(), [
      join(dir, 'scripts', 'pacing.py'), '--doc', join(run.outdir, 'doc.json'), '--out', pp,
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
        if (!includePids.includes(pid)) includePids.push(pid);
      }
    }
  } catch { pacingPath = null; }

  const planArgs = [
    'run.py', 'rewrite', '--in', run.docPath, '--outdir', run.outdir,
    '--style', 'plain', '--max-tasks', String(maxTasks), '--hints', hintsPath,
  ];
  if (includePids.length) planArgs.push('--include', includePids.join(','));
  if (pacingPath) planArgs.push('--pacing', pacingPath);
  const r = await runCmd(pythonBin(), planArgs, dir, 240000);
  if (r.code !== 0) return { ok: false, error: clip(r.err || r.out, 700) };

  const tasks = readJson(join(run.outdir, 'tasks.json'));
  if (!tasks) return { ok: false, error: `降 AI 任务生成后缺少 tasks.json（引擎输出：${clip(r.out || r.err, 300)}）` };
  let archived;
  try {
    archived = archiveRunArtifacts(run.outdir, scope === 'both' ? 'new-both-tasks' : 'new-aigc-tasks');
  } catch (e) {
    return { ok: false, error: `新任务已生成，但旧改稿/清单无法归档：${String(e?.message ?? e)}` };
  }
  const reportReady = await regenerateDiagnosticReport(run);
  const prompts = (readText(join(run.outdir, 'prompts.jsonl')) ?? '').split('\n').filter(Boolean).length;
  const opCount = {};
  for (const t of tasks?.tasks ?? []) opCount[t.op] = (opCount[t.op] ?? 0) + 1;
  const payload = {
    at: new Date().toISOString(),
    scope,
    round,
    maxRounds,
    outdir: run.outdir,
    hints,
    hintsPath,
    tasks: tasks?.tasks?.length ?? 0,
    prompts,
    opCount,
    focus,
    detectorBefore,
    detectorError,
    pacing: pacingInfo,
    archivedPrevious: archived,
    reportReady,
    promptsPath: join(run.outdir, 'prompts.jsonl'),
    editsPath: join(run.outdir, 'edits.jsonl'),
    diagBefore: {
      riskCount: d.result.risk_count,
      riskScore: d.result.risk_score,
      level: d.result.level,
      gate: d.result.style_gate_passed,
    },
    repeatBefore: run.summary?.repeatRate ?? null,
    instruction: [
      `请按 ${join(run.outdir, 'prompts.jsonl')} 逐行改写（每条提示词已带痕迹要求`
      + `${scope === 'both' ? '与消重要求' : ''}），`,
      `把结果写成 ${join(run.outdir, 'edits.jsonl')}（一行一条 {"pid","text","op"}），`,
      '然后调用工具 paper_dual_apply_edits 完成预检与回填。',
    ].join(''),
    stdout: clip(r.out, 300),
  };
  saveState({
    lastReduce: payload,
    loopRound: round,
    lastTasks: null,
    lastApply: null,
    lastReduceCheck: null,
    lastAigc: null,
  });
  return { ok: true, ...payload };
}

// 用 pacing 的口径数「对称串」：连续 ≥3 段句数相差 ≤1 的串。
// 复检时前后各数一次，就能回答「这批改写到底拆掉了几条串」。
async function pacingRuns(docPath) {
  try {
    const out = join(stateDir(), `pacing-runs-${Date.now()}.json`);
    const r = await runCmd(pythonBin(), [
      join(engineDir(), 'scripts', 'pacing.py'), '--doc', docPath, '--out', out,
    ], engineDir(), 120000);
    if (r.code !== 0) return null;
    const pj = readJson(out);
    return (pj?.runs ?? []).length;
  } catch { return null; }
}

function snapshotAccepted(run) {
  const rewritten = join(run.outdir, 'rewritten.docx');
  if (!existsSync(rewritten)) return false;
  copyFileSync(rewritten, join(run.outdir, 'accepted.docx'));
  for (const name of ['rewritten.result.json', 'rewritten.verdict.json']) {
    const source = join(run.outdir, name);
    if (existsSync(source)) {
      copyFileSync(source, join(run.outdir, `accepted.${name.replace('rewritten.', '')}`));
    }
  }
  return true;
}

async function rollbackSemantic(run) {
  const rejected = join(stateDir(), 'archive', `${basename(run.outdir)}-semantic-reject-${Date.now()}`);
  mkdirSync(rejected, { recursive: true });
  for (const name of [
    'rewritten.docx',
    'rewritten.result.json',
    'rewritten.verdict.json',
    'report.md',
  ]) {
    const source = join(run.outdir, name);
    if (existsSync(source)) copyFileSync(source, join(rejected, name));
  }

  const accepted = join(run.outdir, 'accepted.docx');
  const sourceSnapshot = join(run.outdir, 'source.docx');
  const restoredFrom = existsSync(accepted)
    ? accepted
    : existsSync(sourceSnapshot) ? sourceSnapshot : run.docPath;
  copyFileSync(restoredFrom, join(run.outdir, 'rewritten.docx'));
  removeIfExists(join(run.outdir, 'rewritten.result.json'));
  removeIfExists(join(run.outdir, 'rewritten.verdict.json'));
  const reportReady = await regenerateDiagnosticReport(run);

  const state = loadState();
  const previous = state.lastApply ?? {};
  saveState({
    lastApply: {
      ...previous,
      semanticRolledBack: true,
      semanticRollbackAt: new Date().toISOString(),
      restoredFrom,
      rejectedDir: rejected,
      output: join(run.outdir, 'rewritten.docx'),
      verdict: previous.verdict
        ? { ...previous.verdict, passed: false, semanticSummary: '语义指标复检未通过，已回退' }
        : null,
    },
  });
  return {
    performed: true,
    restoredFrom,
    rejectedDir: rejected,
    reportReady,
  };
}

async function reduceCheck(body) {
  const run = loadState().lastRun;
  if (!run?.docPath) return { ok: false, error: '先诊断一次' };
  if (!existsSync(join(run.outdir, 'rewritten.docx'))) {
    return { ok: false, error: '还没有改稿：先回填一次' };
  }
  const before = await aigcDiag({ target: 'original' });
  if (!before.ok) return before;
  const after = await aigcDiag({ target: 'rewritten' });
  if (!after.ok) return after;
  const b = before.result;
  const a = after.result;

  // 重复率复检：对改稿再跑一次引擎诊断，拿 profile 里的篇内重复率
  let dup = null;
  let dupError = null;
  try {
    const chkDir = join(run.outdir, 'check');
    const rr = await runCmd(pythonBin(), [
      'run.py', 'diagnose', '--in', join(run.outdir, 'rewritten.docx'), '--outdir', chkDir,
    ], engineDir(), 180000);
    if (rr.code === 0) {
      const prof = readJson(join(chkDir, 'profile.json'));
      const beforeRate = run.summary?.repeatRate ?? null;
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
  const sb = modelRequired ? await aigcScore({ target: 'original' }) : { ok: false };
  const sa = modelRequired ? await aigcScore({ target: 'rewritten' }) : { ok: false };
  const modelRequested = modelRequired ? await detectorReady() : false;
  const modelMissing = modelRequired && !modelRequested;
  if (sb.ok && sa.ok) {
    prob = {
      mode: sb.mode,
      before: sb.result.ai_prob,
      after: sa.result.ai_prob,
      delta: Number((sb.result.ai_prob - sa.result.ai_prob).toFixed(4)),
    };
  }

  let detectorAfter = null;
  if (prob?.mode === 'model') {
    const seg = await aigcSegments({ target: 'rewritten' });
    if (seg.ok) {
      detectorAfter = {
        aiProb: seg.result.ai_prob,
        threshold: seg.result.threshold,
        top: seg.result.top ?? [],
        fallbackTop: (seg.result.paragraphs ?? [])
          .filter((x) => !x.locked)
          .slice()
          .sort((x, y) => y.ai_prob - x.ai_prob)
          .slice(0, 8),
      };
    }
  }

  const gateOk = after.gateRewritable === true;
  const beforeRisks = activeDiagnosticRisks(b);
  const afterRisks = activeDiagnosticRisks(a);
  const newRisks = [...afterRisks].filter((name) => !beforeRisks.has(name));
  const diagOk = Number(a.risk_score) <= Number(b.risk_score)
    && Number(a.risk_count) <= Number(b.risk_count)
    && newRisks.length === 0;
  const dupOk = dup ? Number(dup.after) <= Number(dup.before) : null;
  const probOk = prob?.mode === 'model' ? Number(prob.after) <= Number(prob.before) : null;
  const probUnknown = modelRequested && !prob;
  const failed = [
    gateOk ? null : '语体门禁',
    diagOk ? null : `9 维风险${newRisks.length ? `（新增：${newRisks.join('、')}）` : ''}`,
    dupOk === false ? '篇内重复率' : null,
    dupError ? `篇内重复率未复检：${dupError}` : null,
    probOk === false ? 'AIGC 概率' : null,
    probUnknown ? `AIGC 概率未复检：${clip(sb.error || sa.error || '考官失败', 160)}` : null,
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
  const originRuns = await pacingRuns(join(run.outdir, 'doc.json'));
  const rewrittenDoc = await docJsonFor('rewritten');
  const afterRuns = rewrittenDoc.ok ? await pacingRuns(rewrittenDoc.path) : null;
  const prevState = loadState();
  const baselineRuns = Number.isInteger(prevState.pacingBaseline)
    ? prevState.pacingBaseline
    : originRuns;
  const origin = Number.isInteger(prevState.pacingOrigin) ? prevState.pacingOrigin : originRuns;
  if (Number.isInteger(afterRuns)) saveState({ pacingBaseline: afterRuns, pacingOrigin: origin });

  const round = Number(prevState.loopRound || 0);
  const maxRounds = Number(prevState.lastReduce?.maxRounds || 3);
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
    focusPids,
    detector: detectorAfter,
  };

  let acceptedSnapshot = false;
  let rollback = null;
  if (acceptance.accepted) {
    try { acceptedSnapshot = snapshotAccepted(run); } catch { acceptedSnapshot = false; }
  } else if (body?.autoRollback !== false) {
    try {
      rollback = await rollbackSemantic(run);
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
  };
  saveState({ lastReduceCheck: payload });
  return { ok: true, ...payload };
}

// ---------------------------------------------------------------- 状态与路由

function status() {
  const state = loadState();
  const dir = engineDir();
  const run = state.lastRun ?? null;
  const outdir = run?.outdir ?? join(dir, 'out', 'plugin');
  return {
    ok: true,
    version: VERSION,
    engineDir: dir,
    engineReady: existsSync(join(dir, 'run.py')),
    lastRun: run,
    lastTasks: state.lastTasks ?? null,
    lastApply: state.lastApply ?? null,
    lastReduce: state.lastReduce ?? null,
    lastReduceCheck: state.lastReduceCheck ?? null,
    loopRound: Number(state.loopRound || 0),
    hasEdits: existsSync(join(outdir, 'edits.jsonl')),
    compareCount: buildCompare().length,
    aigc: {
      detectorReady: detStateCache?.ready === true,
      mode: detStateCache?.ready === true ? 'model' : 'unknown',
      versions: detStateCache?.versions ?? null,
      last: state.lastAigc ?? null,
      aiLabel: Number.isInteger(state.aiLabel) ? state.aiLabel : null,
      calibratedAt: state.calibratedAt ?? null,
      calibrated: Number.isInteger(state.aiLabel),
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
      return sendJson(res, 200, await runRewrite(body.path ? String(body.path).trim() : ''));
    }
    if (path === '/lint' && req.method === 'POST') {
      return sendJson(res, 200, await runLint());
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
      return sendJson(res, 200, await aigcDelta());
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
      const b64 = String(body?.dataBase64 || '');
      if (!b64) return sendJson(res, 400, { ok: false, error: '没有文件内容' });
      if (b64.length > 48 * 1024 * 1024) {
        return sendJson(res, 413, { ok: false, error: '文件太大（超过 36MB）' });
      }
      const buf = Buffer.from(b64, 'base64');
      const dir = join(stateDir(), 'uploads');
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `${Date.now()}-${name}`);
      writeFileSync(out, buf);
      return sendJson(res, 200, { ok: true, path: out, size: buf.length });
    }
    if (path === '/compare') {
      const rows = buildCompare();
      return sendJson(res, 200, { ok: true, rows, count: rows.length });
    }
    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.engineDir === 'string' && body.engineDir.trim()) {
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
      const run = loadState().lastRun;
      if (!run?.outdir) return sendJson(res, 200, { ok: false, error: '还没有跑过诊断' });
      const which = url.searchParams.get('which') || 'report.md';
      const allowed = ['report.md', 'profile.json', 'rewritten.verdict.json', 'rewritten.result.json'];
      const safe = allowed.includes(which) ? which : 'report.md';
      return sendJson(res, 200, { ok: true, which: safe, text: readText(join(run.outdir, safe)) ?? '' });
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
        s.lastTasks ? `改写任务：${s.lastTasks.tasks} 段 / ${s.lastTasks.prompts} 条提示词` : '改写任务：未生成',
        s.hasEdits ? '编辑清单：已存在' : '编辑清单：无',
        `复检：${verdictLine(s.lastApply?.verdict)}`,
      ];
      return { text: lines.join('\n') };
    },
  });

  ctx.tools.register({
    name: 'paper_dual_diagnose',
    description: '诊断一篇中文论文 .docx：跑 paper-dual-reduce 的 diagnose，返回风险分布、Top 风险段落与报告路径。只读，不改原始文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: '论文 .docx 的绝对路径' } },
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
    description: '为已诊断的论文生成改写任务与提示词（out/prompts.jsonl）。之后由模型逐行改写产出 edits.jsonl。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', description: '可选的 .docx 路径；省略则用最近一次诊断的文档' } },
    },
    output: toolOutput,
    timeoutMs: 200000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const r = await runRewrite(args?.path ? String(args.path) : '');
      if (!r.ok) return { text: `生成改写任务失败：${r.error}` };
      return {
        text: [
          `任务 ${r.tasks} 段 ｜ 提示词 ${r.prompts} 条 ｜ 文风 ${r.textStyle}`,
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
    description: '把改写结果写进 edits.jsonl，然后预检 → 回填 → 篇级复检。校验不过的段会被逐条拒绝；篇级不过则整篇回退。',
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
    timeoutMs: 260000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const r = await runApply({ edits: args?.edits });
      if (!r.ok) return { text: `回填失败：${r.error}` };
      const c = r.apply ?? {};
      const lint = r.lint ?? {};
      return {
        text: [
          `预检：可通过 ${lint.would_apply ?? '?'} ｜ 会被拒 ${lint.would_reject ?? '?'}`,
          `回填：提交 ${c.edits ?? '?'} ｜ 接受 ${c.applied ?? '?'} ｜ 拒绝 ${c.rejected ?? '?'} ｜ 状态 ${r.applyStatus ?? '?'}`,
          `复检：${verdictLine(r.verdict)}`,
          `改稿：${r.output}`,
          r.rolledBack ? '注意：篇级校验未通过，已整篇回退为原件' : '',
        ].filter(Boolean).join('\n'),
      };
    },
  });

  ctx.tools.register({
    name: 'paper_dual_aigc',
    description: 'AIGC 考官：给当前论文（或改稿）打 AIGC 分并做 9 维 AI 痕迹诊断。'
      + '必须安装 transformers + torch；缺依赖时只返回安装步骤，不生成伪概率。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['original', 'rewritten'],
          description: 'original=诊断的原文，rewritten=回填后的改稿',
        },
      },
    },
    output: toolOutput,
    timeoutMs: 900000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const target = args?.target === 'rewritten' ? 'rewritten' : 'original';
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
      const ps = await aigcSegments({ target });
      const r = s.result;
      const segsAll = r.segments ?? [];
      const segs = segsAll.slice()
        .sort((a, b) => b.ai_prob - a.ai_prob)
        .slice(0, 8)
        .map((g) => `#${g.index} ${(100 * g.ai_prob).toFixed(0)}%`)
        .join(' · ');
      const lines = [
        `AIGC 考官（真机）｜ ${target}`,
        `AI 概率 ${(100 * r.ai_prob).toFixed(1)}% ｜ ${r.chars} 字 ｜ ${segsAll.length} 段`,
        segs ? `最高分段：${segs}${segsAll.length > 8 ? ` …共 ${segsAll.length} 段` : ''}` : '',
      ];
      if (ps.ok && ps.result.top?.length) {
        lines.push(
          `逐段定位：${ps.result.top.slice(0, 8).map((x) => (
            `${x.pid} ${(100 * x.ai_prob).toFixed(0)}%`
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
