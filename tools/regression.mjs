// 宿主路由回归：版本、文档隔离、安全失败、上传文件名。
// 用法：
//   node tools/regression.mjs <first.docx> <second.docx>
// 需要环境变量 PAPER_DUAL_ENGINE 与 PAPER_DUAL_PYTHON 指向可用的引擎和解释器。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const [firstDoc, secondDoc, editsFixture] = process.argv.slice(2).map((p) => resolve(p));
if (!firstDoc || !secondDoc) {
  throw new Error('用法：node tools/regression.mjs <first.docx> <second.docx>');
}

const home = mkdtempSync(join(tmpdir(), 'dsh-paper-dual-test-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.PAPER_DUAL_ENGINE ||= resolve('..', 'paper-dual-reduce');
process.env.PAPER_DUAL_PYTHON ||= 'python';

const routes = [];
const tools = [];
const ctx = {
  effect: (fn) => fn(),
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
  tools: { register: (t) => { tools.push(t); return () => {}; } },
};

const { apply } = await import(`../index.js?regression=${Date.now()}`);
apply(ctx);

function call(path, method = 'GET', body) {
  return new Promise((resolveCall) => {
    const req = new EventEmitter();
    req.url = path;
    req.method = method;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      end: (s) => {
        const text = String(s);
        try { resolveCall({ code: res.statusCode, json: JSON.parse(text) }); }
        catch { resolveCall({ code: res.statusCode, text }); }
      },
    };
    const pending = routes[0].handler(req, res);
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    pending?.catch?.((e) => resolveCall({ code: -1, error: String(e) }));
  });
}

function assertOk(result, label) {
  assert.equal(result.code, 200, `${label}: HTTP ${result.code}`);
  assert.equal(result.json?.ok, true, `${label}: ${JSON.stringify(result.json)}`);
  return result.json;
}

try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const status = assertOk(await call('/dsh-paper-dual/status'), 'status');
  assert.equal(status.version, pkg.version);
  assert.equal(status.engineReady, true);

  const one = assertOk(
    await call('/dsh-paper-dual/diagnose', 'POST', { path: firstDoc }),
    'diagnose-1',
  );
  const aigcReady = assertOk(await call('/dsh-paper-dual/aigc/status'), 'aigc-status');
  assert.equal(aigcReady.mode, 'model');
  assert.equal(aigcReady.detectorReady, true);
  const realScore = assertOk(await call('/dsh-paper-dual/aigc/score', 'POST', {
    text: '综上所述，本研究具有重要的理论意义和实践价值。',
  }), 'aigc-real-score');
  assert.equal(realScore.mode, 'model');
  assert.equal(realScore.result.ai_prob >= 0 && realScore.result.ai_prob <= 1, true);
  if (process.env.PAPER_DUAL_NO_DEPS_PYTHON) {
    assertOk(await call('/dsh-paper-dual/config', 'POST', {
      pythonPath: process.env.PAPER_DUAL_NO_DEPS_PYTHON,
    }), 'config-no-deps-python');
    const missingStatus = assertOk(await call('/dsh-paper-dual/aigc/status'), 'aigc-missing-status');
    assert.equal(missingStatus.detectorReady, false);
    const missingScore = await call('/dsh-paper-dual/aigc/score', 'POST', { text: '测试文本' });
    assert.equal(missingScore.json?.ok, false);
    assert.equal(missingScore.json?.code, 'AIGC_DEPS_MISSING');
    assert.equal(missingScore.json?.result, undefined);
    assertOk(await call('/dsh-paper-dual/config', 'POST', {
      pythonPath: process.env.PAPER_DUAL_PYTHON,
    }), 'restore-aigc-python');
  }
  const realEngine = process.env.PAPER_DUAL_ENGINE;
  const fakeEngine = join(home, 'broken-engine');
  mkdirSync(fakeEngine, { recursive: true });
  writeFileSync(join(fakeEngine, 'run.py'), 'import sys\nsys.exit(2)\n', 'utf8');
  assertOk(await call('/dsh-paper-dual/config', 'POST', {
    engineDir: fakeEngine,
  }), 'config-broken-engine-diagnose');
  const failedDiagnose = await call('/dsh-paper-dual/diagnose', 'POST', { path: firstDoc });
  assert.equal(failedDiagnose.json?.ok, false, '诊断失败不能返回 ok=true');
  const preserved = assertOk(await call('/dsh-paper-dual/status'), 'status-after-failed-diagnose');
  assert.equal(preserved.lastRun.outdir, one.outdir);
  assert.equal(existsSync(preserved.lastRun.outdir), true, '诊断失败不能把上一版产物搬走');
  assertOk(await call('/dsh-paper-dual/config', 'POST', {
    engineDir: realEngine,
  }), 'restore-real-engine');

  if (editsFixture) {
    const applied = assertOk(await call('/dsh-paper-dual/apply', 'POST', {
      edits: readFileSync(editsFixture, 'utf8'),
    }), 'apply-fixture');
    assert.equal(applied.verdict?.passed, true);
    const compared = assertOk(await call('/dsh-paper-dual/compare'), 'compare');
    assert.equal(compared.count > 0, true);

    process.env.PAPER_DUAL_TEST_FORCE_ROLLBACK = '1';
    const sourceRollback = assertOk(
      await call('/dsh-paper-dual/reduce/check', 'POST', {
        autoRollback: true, requireModel: false,
      }),
      'source-rollback',
    );
    delete process.env.PAPER_DUAL_TEST_FORCE_ROLLBACK;
    assert.equal(sourceRollback.rollback?.performed, true);
    assert.match(sourceRollback.rollback.restoredFrom, /source\.docx$/);

    const reapplied = assertOk(await call('/dsh-paper-dual/apply', 'POST', {
      edits: readFileSync(editsFixture, 'utf8'),
    }), 'reapply-after-source-rollback');
    assert.equal(reapplied.verdict?.passed, true);
    const checked = assertOk(await call('/dsh-paper-dual/reduce/check', 'POST', {
      requireModel: false,
    }), 'reduce-check');
    assert.equal(typeof checked.acceptance?.accepted, 'boolean');
    assert.equal(checked.nextRound?.ready, false);
    if (checked.acceptance.accepted) {
      assert.equal(checked.acceptedSnapshot, true);
    } else {
      assert.equal(checked.rollback?.performed, true);
      const rolled = assertOk(await call('/dsh-paper-dual/status'), 'status-after-rollback');
      assert.equal(rolled.lastApply?.semanticRolledBack, true);
    }
    process.env.PAPER_DUAL_TEST_FORCE_ROLLBACK = '1';
    const forcedRollback = assertOk(
      await call('/dsh-paper-dual/reduce/check', 'POST', {
        autoRollback: true, requireModel: false,
      }),
      'forced-rollback',
    );
    delete process.env.PAPER_DUAL_TEST_FORCE_ROLLBACK;
    assert.equal(forcedRollback.acceptance.accepted, false);
    assert.equal(forcedRollback.rollback?.performed, true);
    assert.match(forcedRollback.rollback.restoredFrom, /accepted\.docx$/);
    const forcedStatus = assertOk(await call('/dsh-paper-dual/status'), 'status-forced-rollback');
    assert.equal(forcedStatus.lastApply?.semanticRolledBack, true);
    console.log(`复检路径：${checked.acceptance.accepted ? '达标快照' : '未达标自动回退'}；强制回退通过`);
    const loopPid = one.summary.top.find((p) => p.level !== 'locked')?.pid;
    assert.ok(loopPid);
    const loopPlan = assertOk(await call('/dsh-paper-dual/reduce/plan', 'POST', {
      scope: 'aigc',
      focusPids: [loopPid],
      useDetector: false,
      maxTasks: 1,
    }), 'detector-focus-plan');
    assert.equal(loopPlan.round >= 1, true);
    assert.equal(loopPlan.focus.some((x) => x.pid === loopPid), true);
    const replanned = assertOk(
      await call('/dsh-paper-dual/rewrite', 'POST', {}),
      'rewrite-new-round',
    );
    assert.equal(typeof replanned.archivedPrevious, 'string');
    const cleanStatus = assertOk(await call('/dsh-paper-dual/status'), 'status-new-round');
    assert.equal(cleanStatus.hasEdits, false, '新任务轮次不能继承上一轮的 edits.jsonl');
    assert.equal(cleanStatus.compareCount, 0, '新任务轮次不能展示上一轮的对照');
    assert.equal(cleanStatus.lastApply, null);
    const freshReport = assertOk(
      await call('/dsh-paper-dual/report?which=report.md'),
      'report-new-round',
    );
    assert.equal(freshReport.text.length > 0, true);
  } else {
    writeFileSync(join(one.outdir, 'edits.jsonl'), '{"stale":true}\n', 'utf8');
  }

  // 传一篇新文档给 rewrite：必须先自动诊断，不能把任务写进上一篇的产物目录。
  const rewrite = assertOk(
    await call('/dsh-paper-dual/rewrite', 'POST', { path: secondDoc }),
    'rewrite-auto-diagnose',
  );
  assert.notEqual(rewrite.outdir, one.outdir);
  assert.equal(rewrite.docPath, secondDoc);
  assert.equal(rewrite.tasks > 0, true);

  const afterSwitch = assertOk(await call('/dsh-paper-dual/status'), 'status-after-switch');
  assert.equal(afterSwitch.lastRun.docPath, secondDoc);
  assert.equal(afterSwitch.hasEdits, false, '新文档不能继承上一篇的 edits.jsonl');
  assert.equal(afterSwitch.lastApply, null, '新文档不能继承上一篇的回填状态');

  const profile = await call('/dsh-paper-dual/report?which=profile.json');
  assert.equal(profile.code, 200);
  assert.equal(typeof profile.json?.text, 'string');
  JSON.parse(profile.json.text);

  const uploadName = '\u6d4b\u8bd5\u6587\u6863.docx';
  const upload = assertOk(await call('/dsh-paper-dual/upload', 'POST', {
    name: uploadName,
    dataBase64: Buffer.from('PK-test').toString('base64'),
  }), 'upload');
  assert.equal(upload.path.includes('\u6d4b\u8bd5\u6587\u6863'), true);

  // 引擎异常时必须返回失败，不能把“没有 result/verdict”包装成成功。
  assertOk(await call('/dsh-paper-dual/config', 'POST', {
    engineDir: fakeEngine,
  }), 'config-broken-engine');
  const failedApply = await call('/dsh-paper-dual/apply', 'POST', {
    edits: '{"pid":"p0004","text":"测试文本","op":"O4"}\n',
  });
  assert.equal(failedApply.json?.ok, false, '引擎失败不能返回 ok=true');
  assert.match(failedApply.json?.error || '', /预检|异常退出|run\.py/);

  const toolNames = tools.map((t) => t.name);
  assert.deepEqual(toolNames, [
    'paper_dual_status',
    'paper_dual_diagnose',
    'paper_dual_rewrite',
    'paper_dual_apply_edits',
    'paper_dual_aigc',
  ]);
  console.log('宿主回归通过');
} finally {
  const tmpRoot = `${resolve(tmpdir())}${sep}`;
  if (resolve(home).startsWith(tmpRoot)) {
    rmSync(home, { recursive: true, force: true });
  }
}
