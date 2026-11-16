// 宿主半边冒烟测试：不装进 DSH 也能验证路由逻辑。
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

const routes = [];
const tools = [];
const ctx = {
  effect: (fn) => fn(),
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
  tools: { register: (t) => { tools.push(t); return () => {}; } },
};

apply(ctx);

function call(path, method = 'GET', body) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.url = path;
    req.method = method;
    const chunks = [];
    const res = {
      statusCode: 0,
      setHeader: () => {},
      end: (s) => {
        const text = String(s);
        try { resolve({ code: res.statusCode, json: JSON.parse(text) }); }
        catch { resolve({ code: res.statusCode, text }); }
      },
    };
    const handler = routes[0].handler;
    const p = handler(req, res);
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
    setTimeout(() => p?.catch?.((e) => resolve({ code: -1, error: String(e) })), 200);
  });
}

const out = {};
out.routes = routes.map((r) => `${r.kind}:${r.path}`);
out.tools = tools.map((t) => t.name);

out.status = await call('/dsh-paper-dual/status');
if (out.status?.json) delete out.status.json.runs; // 太长

const doc = process.argv[2];
if (doc) {
  const r = await call('/dsh-paper-dual/diagnose', 'POST', { path: doc });
  out.diagnose = r.json
    ? {
      ok: r.json.ok,
      error: r.json.error,
      dist: r.json.summary?.dist,
      paragraphs: r.json.summary?.stats?.paragraphs,
      rewritable: r.json.summary?.stats?.rewritable,
      repeatRate: r.json.summary?.repeatRate,
      topCount: r.json.summary?.top?.length,
      top1: r.json.summary?.top?.[0],
      reportPath: r.json.outdir,
    }
    : r;
  const rp = await call('/dsh-paper-dual/report?which=report.md');
  out.report = { ok: rp.json?.ok, len: rp.json?.text?.length ?? 0 };
  const bad = await call('/dsh-paper-dual/diagnose', 'POST', { path: 'Z:\\nope.docx' });
  out.badPath = { ok: bad.json?.ok, error: bad.json?.error };
}

// AIGC 考官：只依赖 python + 正则，任何机器都该跑通
const as = await call('/dsh-paper-dual/aigc/status');
out.aigcStatus = { ok: as.json?.ok, mode: as.json?.mode, detectorReady: as.json?.detectorReady };

const SAMPLE = '随着数字化转型的不断深入，企业创新绩效的影响因素日益受到学界关注。'
  + '综上所述，本研究不仅丰富了理论体系，也为企业实践提供了有益参考。';
const ad = await call('/dsh-paper-dual/aigc/diag', 'POST', { text: SAMPLE });
out.aigcDiag = {
  ok: ad.json?.ok,
  level: ad.json?.result?.level,
  riskCount: ad.json?.result?.risk_count,
  gate: ad.json?.result?.style_gate_passed,
  todo: ad.json?.result?.todo,
};
const asc = await call('/dsh-paper-dual/aigc/score', 'POST', { text: SAMPLE });
out.aigcScore = {
  ok: asc.json?.ok,
  mode: asc.json?.mode,
  aiProb: asc.json?.result?.ai_prob,
  segments: asc.json?.result?.segments?.length,
};

const t = tools.find((x) => x.name === 'paper_dual_status');
out.toolStatus = (await t.execute({})).text.split('\n')[0];

console.log(JSON.stringify(out, null, 2));
