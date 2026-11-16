// dsh-paper-dual · 宿主半边（v0.2）
// 职责：跑 paper-dual-reduce 引擎（python）、读 JSON 产物、把结果整理成面板要的形状。
// 只用 Node 内置模块：profile 里的 @deepseek-ai/* 包在插件目录解析不到（实测），
// 所以宿主这一侧不依赖任何第三方库。
//
// v0.2 变更：删除 GitHub 同步（/sync 与相关状态）；新增改写闭环
//   /rewrite（生成任务）→ 模型写 edits.jsonl → /apply（预检+回填+复检）→ /compare（三栏对照）
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '/dsh-paper-dual';
const VERSION = '0.4.2';
const DEFAULT_ENGINE = 'E:\\ruanjianxiazai\\deepseek\\work\\paper-dual-reduce';

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

function engineDir() {
  return loadState().engineDir || DEFAULT_ENGINE;
}

// 用哪个 python：venv / conda / 系统解释器可能都不一样，而插件只认一个。
// 优先级：设置里的 pythonPath > 环境变量 PAPER_DUAL_PYTHON > PATH 上的 python。
function pythonBin() {
  const s = loadState();
  return s.pythonPath || process.env.PAPER_DUAL_PYTHON || 'python';
}

let pyExeCache;

async function pythonExecutable() {
  if (pyExeCache !== undefined) return pyExeCache;
  const r = await runCmd(pythonBin(), ['-c', 'import sys;print(sys.executable)'], engineDir(), 30000);
  pyExeCache = r.code === 0 ? (r.out.trim().split(/\r?\n/).pop() || '') : '';
  return pyExeCache;
}

function outdirOf() {
  const run = loadState().lastRun;
  return run?.outdir || join(engineDir(), 'out', 'plugin');
}

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function readJson(p) {
  const t = readText(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
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
      child = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
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

async function diagnose(docPath) {
  const dir = engineDir();
  if (!existsSync(join(dir, 'run.py'))) {
    return { ok: false, error: `引擎目录里没有 run.py：${dir}（在设置里改成 paper-dual-reduce 的绝对路径）` };
  }
  if (!docPath || !existsSync(docPath)) {
    return { ok: false, error: `找不到文档：${docPath || '（空）'}` };
  }
  if (!/\.docx$/i.test(docPath)) {
    return { ok: false, error: '只支持 .docx（.doc 请先在 Word 里另存为 .docx）' };
  }
  const outdir = join(dir, 'out', 'plugin');
  const r = await runCmd(pythonBin(), ['run.py', 'diagnose', '--in', docPath, '--outdir', outdir], dir, 180000);
  if (r.code !== 0) {
    return {
      ok: false,
      error: clip(r.err || r.out || `引擎退出码 ${r.code}`, 600),
      hint: /No such file|can't open file|不是内部或外部命令/i.test(r.err + r.out)
        ? 'python 不在 PATH，或引擎目录不对' : undefined,
    };
  }
  const doc = readJson(join(outdir, 'doc.json'));
  const profile = readJson(join(outdir, 'profile.json'));
  if (!doc || !profile) return { ok: false, error: '引擎跑完了但没产出 doc.json / profile.json' };

  const summary = summarize(doc, profile);
  const at = new Date().toISOString();
  saveState({
    lastRun: { docPath, outdir, at, title: basename(docPath), summary },
    engineDir: dir,
    // 新文档 = 旧的改写产物作废
    lastTasks: null,
    lastApply: null,
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

async function runRewrite(docPath) {
  const dir = engineDir();
  const run = loadState().lastRun;
  const doc = docPath || run?.docPath;
  if (!doc) return { ok: false, error: '先诊断一次（或在面板里填路径），才有文档可改写' };
  if (!existsSync(join(dir, 'run.py'))) return { ok: false, error: `引擎目录里没有 run.py：${dir}` };
  const outdir = run?.outdir || join(dir, 'out', 'plugin');
  const r = await runCmd(pythonBin(),
    ['run.py', 'rewrite', '--in', doc, '--outdir', outdir, '--style', 'plain'], dir, 180000);
  if (r.code !== 0) return { ok: false, error: clip(r.err || r.out, 700) };

  const tasks = readJson(join(outdir, 'tasks.json'));
  const promptsText = readText(join(outdir, 'prompts.jsonl')) ?? '';
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
  };
  saveState({ lastTasks: payload });
  return { ok: true, ...payload, stdout: clip(r.out, 400) };
}

async function runLint() {
  const dir = engineDir();
  const run = loadState().lastRun;
  if (!run?.docPath) return { ok: false, error: '先诊断一次' };
  const edits = join(run.outdir, 'edits.jsonl');
  if (!existsSync(edits)) return { ok: false, error: `没有改写清单：${edits}（先让模型产出）` };
  const r = await runCmd(pythonBin(),
    ['run.py', 'lint', '--in', run.docPath, '--outdir', run.outdir, '--edits', edits], dir, 120000);
  const lint = readJson(join(run.outdir, 'lint.json'));
  if (!lint) return { ok: false, error: clip(r.err || r.out || '预检没有产出 lint.json', 600) };
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

  const lintRun = await runCmd(pythonBin(),
    ['run.py', 'lint', '--in', run.docPath, '--outdir', run.outdir, '--edits', edits], dir, 120000);
  const lint = readJson(join(run.outdir, 'lint.json'));

  const finRun = await runCmd(pythonBin(),
    ['run.py', 'finish', '--in', run.docPath, '--outdir', run.outdir, '--edits', edits,
      '--style', 'plain'], dir, 200000);
  const verdict = readJson(join(run.outdir, 'rewritten.verdict.json'));
  const result = readJson(join(run.outdir, 'rewritten.result.json'));

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
// 检测器（detector.py）需要 transformers+torch；缺依赖时用 --dry-run 打通结构，
// 面板会显著标注「伪概率」。diag.py 是纯正则，无依赖，永远可用。

const HERE = fileURLToPath(new URL('.', import.meta.url));
const AIGC_DIR = join(HERE, 'aigc');

let detReadyCache;

async function detectorReady() {
  if (detReadyCache !== undefined) return detReadyCache;
  await pythonExecutable();
  const r = await runCmd(pythonBin(), ['-c', 'import torch, transformers'], AIGC_DIR, 90000);
  detReadyCache = r.code === 0;
  return detReadyCache;
}

function docTexts(p) {
  const doc = readJson(p);
  if (!doc) return null;
  const ps = doc.paragraphs ?? [];
  const join = (rows) => rows.map((x) => String(x.text ?? '').trim()).filter(Boolean).join('\n\n');
  return { all: join(ps), rewritable: join(ps.filter((x) => !x.locked)) };
}

async function textFor(target) {
  const run = loadState().lastRun;
  if (!run?.outdir) return { ok: false, error: '先诊断一次' };
  if (target === 'rewritten') {
    const docx = join(run.outdir, 'rewritten.docx');
    if (!existsSync(docx)) return { ok: false, error: '还没有改稿：先做一次「回填并复检」' };
    const tmp = join(stateDir(), 'aigc-tmp');
    mkdirSync(tmp, { recursive: true });
    const out = join(tmp, 'doc.json');
    const r = await runCmd(pythonBin(),
      ['scripts/inspect_docx.py', '--in', docx, '--out', out], engineDir(), 120000);
    if (r.code !== 0) return { ok: false, error: clip(r.err || r.out, 400) };
    const texts = docTexts(out);
    if (!texts) return { ok: false, error: '改稿解析失败' };
    return { ok: true, text: texts.all, rewritable: texts.rewritable };
  }
  const texts = docTexts(join(run.outdir, 'doc.json'));
  if (!texts) return { ok: false, error: '缺 doc.json：重新诊断一次' };
  return { ok: true, text: texts.all, rewritable: texts.rewritable };
}

async function resolveAigcText(body) {
  const target = body?.target === 'rewritten' ? 'rewritten' : 'original';
  const inline = typeof body?.text === 'string' ? body.text : '';
  if (inline.trim()) return { ok: true, target: 'inline', text: inline };
  const t = await textFor(target);
  return t.ok ? { ...t, target } : t;
}

// HuggingFace 默认缓存目录（Windows 也在 ~/.cache/huggingface/hub）。
// 用户可能用 HF_HOME / HF_HUB_CACHE 改过，这里按同样优先级显示。
function hfCacheDir() {
  const hub = process.env.HF_HUB_CACHE;
  if (hub) return join(hub, 'models--yuchuantian--AIGC_detector_zhv3');
  const home = process.env.HF_HOME;
  if (home) return join(home, 'hub', 'models--yuchuantian--AIGC_detector_zhv3');
  return join(homedir(), '.cache', 'huggingface', 'hub', 'models--yuchuantian--AIGC_detector_zhv3');
}

async function aigcStatus() {
  const ready = await detectorReady();
  const py = await pythonExecutable();
  const req = join(AIGC_DIR, 'requirements.txt');
  const det = join(AIGC_DIR, 'detector.py');
  return {
    ok: true,
    diagReady: existsSync(join(AIGC_DIR, 'diag.py')),
    detectorReady: ready,
    mode: ready ? 'model' : 'dry-run',
    model: 'yuchuantian/AIGC_detector_zhv3',
    python: py || pythonBin(),
    pythonIsCustom: Boolean(loadState().pythonPath),
    note: ready
      ? '真机模式：transformers + torch 已装，分数是模型推理结果'
      : 'dry-run 模式：未装 transformers + torch，分数是伪随机占位（结构一致，数值无意义）',
    // 拿到「真分数」需要三步，缺一步都不算数
    setup: {
      step1Install: `"${pythonBin()}" -m pip install -r "${req}"`,
      modelHint: '首次运行会从 HuggingFace 下载约 818MB 权重；国内可先设 HF_ENDPOINT=https://hf-mirror.com',
      modelUrl: 'https://huggingface.co/yuchuantian/AIGC_detector_zhv3',
      modelCacheDir: hfCacheDir(),
      step3Calibrate: `"${pythonBin()}" "${det}" --calibrate`,
      whyCalibrate: '该模型 config.json 缺 id2label，0/1 哪个是 AI 未知；不标定会得到反着读的分数且不报错',
      pythonNote: '装依赖必须装进上面那个解释器，装到别的 venv 里插件仍然显示 dry-run',
    },
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
  const ready = await detectorReady();
  mkdirSync(stateDir(), { recursive: true });
  const file = join(stateDir(), `aigc-${t.target}.txt`);
  writeFileSync(file, t.text, 'utf8');

  const args = ['detector.py', '--file', file, '--json'];
  const st = loadState();
  if (Number.isInteger(st.aiLabel)) args.push('--ai-label', String(st.aiLabel));
  if (!ready) args.push('--dry-run');
  const out = await runAigcJson(args, 300000);
  if (!out.ok) return { ok: false, error: out.error };

  const result = out.json;
  const at = new Date().toISOString();
  saveState({
    lastAigc: {
      at, target: t.target, mode: ready ? 'model' : 'dry-run',
      aiProb: result.ai_prob, chars: result.chars,
    },
  });
  return { ok: true, at, target: t.target, mode: ready ? 'model' : 'dry-run', result };
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
  const ready = await detectorReady();
  if (!ready) {
    return {
      ok: false,
      error: '未装 transformers + torch：先按三步装依赖再校准',
      hint: 'dry-run 下校准没有意义（它直接返回 ai_index=1）',
    };
  }
  const r = await runCmd(pythonBin(), ['detector.py', '--calibrate'], AIGC_DIR, 300000);
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
  if (!hints.length) {
    return {
      ok: false,
      error: '9 维诊断没有发现明显 AI 痕迹，这篇不需要「降 AI」改写',
      diag: { riskCount: d.result.risk_count, riskScore: d.result.risk_score },
    };
  }
  const dir = engineDir();
  const hintsPath = join(run.outdir, scope === 'both' ? 'shuangjiang-hints.md' : 'aigc-hints.md');
  mkdirSync(run.outdir, { recursive: true });
  writeFileSync(hintsPath, `${hints.map((h) => `· ${h}`).join('\n')}\n`, 'utf8');

  const fallbackTasks = scope === 'both' ? 16 : 12;
  const maxTasks = Math.min(Math.max(Number(body?.maxTasks) || fallbackTasks, 1), 30);

  // 逐段定位痕迹：只改「整篇统计过关」的段落是改不到指标的，
  // 必须把带具体痕迹的段落强制纳入本轮（plan.py --include）。
  let focus = [];
  try {
    const segPath = join(run.outdir, 'segdiag.json');
    const sg = await runCmd(pythonBin(), [
      join(AIGC_DIR, 'segdiag.py'), '--doc', join(run.outdir, 'doc.json'), '--out', segPath,
    ], AIGC_DIR, 120000);
    if (sg.code === 0) {
      const seg = readJson(segPath);
      focus = (seg?.paragraphs ?? []).slice(0, 8);
    }
  } catch { /* 没有 segdiag 时就退回纯风险选段 */ }
  const includePids = focus.map((x) => x.pid);

  const planArgs = [
    'run.py', 'rewrite', '--in', run.docPath, '--outdir', run.outdir,
    '--style', 'plain', '--max-tasks', String(maxTasks), '--hints', hintsPath,
  ];
  if (includePids.length) planArgs.push('--include', includePids.join(','));
  const r = await runCmd(pythonBin(), planArgs, dir, 240000);
  if (r.code !== 0) return { ok: false, error: clip(r.err || r.out, 700) };

  const tasks = readJson(join(run.outdir, 'tasks.json'));
  const prompts = (readText(join(run.outdir, 'prompts.jsonl')) ?? '').split('\n').filter(Boolean).length;
  const opCount = {};
  for (const t of tasks?.tasks ?? []) opCount[t.op] = (opCount[t.op] ?? 0) + 1;
  const payload = {
    at: new Date().toISOString(),
    scope,
    outdir: run.outdir,
    hints,
    hintsPath,
    tasks: tasks?.tasks?.length ?? 0,
    prompts,
    opCount,
    focus,
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
  saveState({ lastReduce: payload });
  return { ok: true, ...payload };
}

async function reduceCheck() {
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
      }
    }
  } catch { /* 重复率复检失败不阻塞 AIGC 结论 */ }

  let prob = null;
  const sb = await aigcScore({ target: 'original' });
  const sa = await aigcScore({ target: 'rewritten' });
  if (sb.ok && sa.ok) {
    prob = {
      mode: sb.mode,
      before: sb.result.ai_prob,
      after: sa.result.ai_prob,
      delta: Number((sb.result.ai_prob - sa.result.ai_prob).toFixed(4)),
    };
  }

  const payload = {
    at: new Date().toISOString(),
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
    prob,
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
    hasEdits: existsSync(join(outdir, 'edits.jsonl')),
    compareCount: buildCompare().length,
    aigc: {
      detectorReady: detReadyCache === true,
      mode: detReadyCache === true ? 'model' : 'dry-run',
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
      return sendJson(res, 200, await reduceCheck());
    }
    if (path === '/compare') {
      const rows = buildCompare();
      return sendJson(res, 200, { ok: true, rows, count: rows.length });
    }
    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.engineDir === 'string' && body.engineDir.trim()) {
        patch.engineDir = body.engineDir.trim();
      }
      if (typeof body.pythonPath === 'string') {
        // 空字符串 = 清空，回到 PATH 上的 python
        patch.pythonPath = body.pythonPath.trim();
        pyExeCache = undefined;
        detReadyCache = undefined;
      }
      const next = saveState(patch);
      return sendJson(res, 200, {
        ok: true,
        engineDir: next.engineDir || DEFAULT_ENGINE,
        pythonPath: next.pythonPath || '',
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
      + '缺 transformers/torch 时自动 dry-run（伪概率）并明确标注，不会假装是真分数。',
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
    timeoutMs: 320000,
    async execute(args) {
      const target = args?.target === 'rewritten' ? 'rewritten' : 'original';
      const st = await aigcStatus();
      const s = await aigcScore({ target });
      if (!s.ok) return { text: `打分失败：${s.error}` };
      const d = await aigcDiag({ target });
      const r = s.result;
      const segsAll = r.segments ?? [];
      const segs = segsAll.slice()
        .sort((a, b) => b.ai_prob - a.ai_prob)
        .slice(0, 8)
        .map((g) => `#${g.index} ${(100 * g.ai_prob).toFixed(0)}%`)
        .join(' · ');
      const lines = [
        `AIGC 考官（${st.mode === 'model' ? '真机' : 'dry-run 伪概率'}）｜ ${target}`,
        `AI 概率 ${(100 * r.ai_prob).toFixed(1)}% ｜ ${r.chars} 字 ｜ ${segsAll.length} 段`,
        segs ? `最高分段：${segs}${segsAll.length > 8 ? ` …共 ${segsAll.length} 段` : ''}` : '',
      ];
      if (d.ok) {
        const dg = d.result;
        lines.push(
          `9 维诊断：风险 ${dg.risk_count} 项 ｜ 等级 ${dg.level} ｜ 语体门禁 ${dg.style_gate_passed ? '通过' : '未通过'}`,
          ...(dg.todo ?? []).map((t) => `  · ${t}`),
        );
      } else {
        lines.push(`9 维诊断失败：${d.error}`);
      }
      if (st.mode !== 'model') {
        lines.push('注意：该模式下的分数是占位值，不能用来判断改写效果。');
      }
      return { text: lines.filter(Boolean).join('\n') };
    },
  });
}
