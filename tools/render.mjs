// 渲染回归：不开浏览器，直接用真实 report.md 跑一遍 Markdown 渲染树。
// 断言：块类型分布、表格是 table 元素、标题带层级、没有把管道符漏成文本。
import { existsSync, readFileSync } from 'node:fs';

const MINI = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
};

let captured = null;
globalThis.window = {
  __PDR_TEST__: true,
  __ModuleLoader__: { load: (def) => { captured = def; } },
};
globalThis.document = { baseURI: 'http://127.0.0.1/' };
// Node 26 的 globalThis.navigator 只有 getter，不能直接赋值；
// client 里 navigator.clipboard 只在事件回调里用，渲染测试不触发。

await import('../client.js');
if (!captured) throw new Error('client.js 没有向 __ModuleLoader__ 注册');

const mod = captured.factory((name) => {
  if (name === 'react') return MINI;
  throw new Error(`意外的 require：${name}`);
});
const { parseBlocks, renderInline, Markdown, TopTable, AigcCard } = mod.__test ?? {};
if (!parseBlocks || !renderInline || !Markdown || !TopTable || !AigcCard) throw new Error('测试钩子缺失');

const reportPath = process.argv[2]
  || process.env.PAPER_DUAL_REPORT
  || '../paper-dual-reduce/out/e2e/report.md';
if (!existsSync(reportPath)) {
  throw new Error(`找不到 report.md：${reportPath}（传入路径或设置 PAPER_DUAL_REPORT）`);
}
const md = readFileSync(reportPath, 'utf8');

const blocks = parseBlocks(md);
const kinds = blocks.reduce((acc, b) => { acc[b.t] = (acc[b.t] ?? 0) + 1; return acc; }, {});

const tree = Markdown({ text: md });
const seen = {};
function walk(node) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(walk); return; }
  const key = String(node.type);
  seen[key] = (seen[key] ?? 0) + 1;
  const kids = node.children ?? [];
  kids.forEach(walk);
  if (node.props && node.props.children) walk(node.props.children);
}
walk(tree);

const failures = [];
if ((kinds.h ?? 0) < 3) failures.push(`标题块过少：${kinds.h}`);
if ((kinds.table ?? 0) < 1) failures.push('没有解析出表格');
if (!seen.table) failures.push('渲染树里没有 table 元素');
if (!seen.th || !seen.td) failures.push('表格缺少 th/td');

// 行内语法单独验：真实报告里不一定出现加粗/代码，不能拿它当断言依据
const inlineSeen = {};
(function walkInline(n) {
  if (n == null || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(walkInline); return; }
  inlineSeen[String(n.type)] = (inlineSeen[String(n.type)] ?? 0) + 1;
  (n.children ?? []).forEach(walkInline);
  if (n.props?.children) walkInline(n.props.children);
})(MINI.createElement('div', null, renderInline('**粗体** 与 `code` 与普通文字', 't')));
if (!inlineSeen.strong) failures.push('renderInline 没处理 **加粗**');
if (!inlineSeen.code) failures.push('renderInline 没处理 `行内代码`');
seen.inline = inlineSeen;

// 段落表：表头与单位必须存在（这是"看不懂列含义"那类回归）
function collectText(node, acc = []) {
  if (node == null) return acc;
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { node.forEach((n) => collectText(n, acc)); return acc; }
  if (typeof node !== 'object') return acc;
  // 函数组件：真 React 会调用它，这里也必须调用，否则拿不到 Markdown/卡片里的文本
  if (typeof node.type === 'function') {
    try {
      collectText(node.type({ ...(node.props || {}), children: node.children }), acc);
    } catch {
      acc.push('[[render-error]]');
    }
    return acc;
  }
  (node.children ?? []).forEach((n) => collectText(n, acc));
  if (node.props?.children) collectText(node.props.children, acc);
  return acc;
}

const sampleRows = [
  { pid: 'p0350', risk: 0.3771, level: 'low', cause: '句长均齐', op: 'O1', chars: 54, text: '示例原文' },
  { pid: 'p0252', risk: 0.31, level: 'low', cause: '信息空泛', op: 'O5', chars: 118, text: '' },
];
const tableText = collectText(TopTable({ rows: sampleRows, open: '', onToggle: () => {} })).join(' ');
for (const need of ['段落', '风险分 0–1', '等级', '主因', '字数']) {
  if (!tableText.includes(need)) failures.push(`段落表缺少表头：${need}`);
}
if (!tableText.includes('54 字')) failures.push('字数列没有带单位');
if (!tableText.includes('0.38') && !tableText.includes('0.37')) {
  failures.push('风险分没有显示数值');
}
if (tableText.includes('%')) failures.push('风险分被误标成了百分比');

// AIGC 考官卡：模式徽标、概率、9 维、作业清单都必须出现
const aigcText = collectText(AigcCard({
  status: { detectorReady: true, mode: 'model', note: '真机' },
  score: {
    mode: 'model',
    result: {
      ai_prob: 0.464, chars: 310,
      segments: [{ index: 0, chars: 103, ai_prob: 0.5072, preview: '随着数字化转型的不断深入' }],
    },
  },
  diag: {
    result: {
      risk_count: 1, level: 'mid', style_gate_passed: true,
      template: { count: 7, per_1000_chars: 22.58, risk: true },
      passive: { count: 0, per_sentence: 0, risk: false },
      burstiness: { cv: 0.403, level: 'low', risk: false },
      symmetry: { runs: [], risk: false },
      nested: { count: 0, risk: false },
      colon: { count: 0, risk: false },
      punct: { commas_per_sentence: 1.5, risk: false },
      colloquial: { count: 0, gate_failed: false },
      dash: { total: 0, gate_failed: false },
      todo: ['删除/改写句首模板与套话（模板句 7 处）'],
    },
  },
  target: 'original', onTarget: () => {}, onScore: () => {}, onDiag: () => {}, onSelftest: () => {},
  busy: '',
})).join(' ');
for (const need of ['AIGC 考官', '真机', '46.4%', '模板套话', '语体门禁（可改写段） 通过', '删除/改写句首模板']) {
  if (!aigcText.includes(need)) failures.push(`AIGC 卡缺少：${need}`);
}

const missingText = collectText(AigcCard({
  status: {
    detectorReady: false, mode: 'unavailable',
    python: 'E:\\paper-dual-aigc\\Scripts\\python.exe',
    setup: {
      python: 'E:\\paper-dual-aigc\\Scripts\\python.exe',
      modelCacheDir: 'E:\\paper-dual-aigc\\hf-cache',
      installScript: 'pip install torch==2.9.1 transformers==5.23.0',
    },
  },
  target: 'original', onTarget: () => {}, onScore: () => {}, onDiag: () => {},
  onSelftest: () => {}, busy: '',
})).join(' ');
for (const need of ['依赖未安装', '已取消伪概率', 'pip install torch==2.9.1']) {
  if (!missingText.includes(need)) failures.push(`缺依赖提示缺少：${need}`);
}

// 首页三选一与报告页：结构必须能渲染出来
const { ModeHome, ReportCard, Panel, MODES } = mod.__test ?? {};
if (!ModeHome || !ReportCard || !Panel || !MODES) throw new Error('入口组件未导出');

const homeText = collectText(ModeHome({
  docPath: '', onPath: () => {}, onDiagnose: () => {}, busy: '', lastRun: null,
  mode: null, onMode: () => {},
})).join(' ');
for (const need of ['降低篇内重复率', '降低 AIGC 率', '双降', '诊断']) {
  if (!homeText.includes(need)) failures.push(`首页缺少模式入口：${need}`);
}

const reportText = collectText(ReportCard({
  mode: 'both',
  metrics: [
    { label: '篇内重复', value: '24.1%' },
    { label: 'AIGC 风险', value: '2→1', tone: 'ok' },
    { label: 'AIGC 概率', value: '49.7%→48.6%', tone: 'warn' },
  ],
  report: '## 一、文档概览\n\n| 指标 | 数值 |\n|---|---|\n| 段落总数 | 862 |\n',
  extraMarkdown: '## AIGC 复检\n\n| 指标 | 改写前 | 改写后 |\n|---|---|---|\n| 风险项 | 2 | 1 |\n',
  onCopy: () => {}, copied: '', onClose: () => {},
})).join(' ');
for (const need of ['报告', '篇内重复 24.1%', 'AIGC 风险 2→1', 'AIGC 复检', '段落总数']) {
  if (!reportText.includes(need)) failures.push(`报告页缺少：${need}`);
}

// 整块 Panel 直接渲染一次（首页态），确认没有结构性错误
const panelText = collectText(Panel()).join(' ');
if (!panelText.includes('论文双降')) failures.push('Panel 首页渲染异常');

// 管道符不应以纯文本行出现（表格分隔行漏渲染是最常见的坏味道）
const leaks = blocks.filter((b) => b.t === 'p' && /^\|.*\|$/.test(b.text));
if (leaks.length) failures.push(`有 ${leaks.length} 行表格被当成了段落`);

console.log(JSON.stringify({ blocks: kinds, elements: seen }, null, 2));
if (failures.length) {
  console.error('渲染回归失败：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('渲染回归通过');
