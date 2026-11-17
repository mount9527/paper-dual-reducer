// 宿主路由回归：版本、文档隔离、安全失败、上传文件名。
// 用法：
//   node tools/regression.mjs <first.docx> <second.docx>
// 需要环境变量 PAPER_DUAL_ENGINE 与 PAPER_DUAL_PYTHON 指向可用的引擎和解释器。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
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
      headers: {},
      setHeader: (key, value) => { res.headers[String(key).toLowerCase()] = value; },
      end: (s) => {
        if (Buffer.isBuffer(s)) {
          resolveCall({ code: res.statusCode, headers: res.headers, binary: s });
          return;
        }
        const text = String(s);
        try { resolveCall({ code: res.statusCode, headers: res.headers, json: JSON.parse(text) }); }
        catch { resolveCall({ code: res.statusCode, headers: res.headers, text }); }
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
  assert.equal(status.runCount >= 0, true);

  const one = assertOk(
    await call('/dsh-paper-dual/diagnose', 'POST', { path: firstDoc }),
    'diagnose-1',
  );
  const aigcReady = assertOk(await call('/dsh-paper-dual/aigc/status'), 'aigc-status');
  assert.equal(aigcReady.mode, 'model');
  assert.equal(aigcReady.detectorReady, true);
  assert.equal(aigcReady.calibration?.calibrated, false);
  const realScore = assertOk(await call('/dsh-paper-dual/aigc/score', 'POST', {
    target: 'original',
  }), 'aigc-real-score');
  assert.equal(realScore.mode, 'model');
  assert.equal(realScore.result.ai_share >= 0 && realScore.result.ai_share <= 1, true);
  assert.equal(realScore.result.all_ai_share >= 0 && realScore.result.all_ai_share <= 1, true);
  assert.equal(typeof realScore.result.body_chars, 'number');
  assert.equal(typeof realScore.result.group_stats, 'object');
  assert.equal(['safe', 'warn', 'risk'].includes(realScore.result.band), true);
  assert.equal(typeof realScore.result.median_prob, 'number');
  assert.equal(typeof realScore.result.calibrated, 'boolean');
  const storedScore = assertOk(await call('/dsh-paper-dual/status'), 'status-aigc-store');
  assert.equal(typeof storedScore.aigc?.byTarget?.original?.result?.ai_share, 'number');
  assert.equal(storedScore.runCount >= 1, true);
  assert.equal(typeof storedScore.lastRun?.engineInput, 'string');
  if (process.env.PAPER_DUAL_NO_DEPS_PYTHON) {
    assertOk(await call('/dsh-paper-dual/config', 'POST', {
      pythonPath: process.env.PAPER_DUAL_NO_DEPS_PYTHON,
    }), 'config-no-deps-python');
    const missingStatus = assertOk(await call('/dsh-paper-dual/aigc/status'), 'aigc-missing-status');
    assert.equal(missingStatus.detectorReady, false);
    assert.match(missingStatus.setup?.installScript || '', /pip install[^\n]*torch[^\n]*transformers/);
    assert.match(missingStatus.setup?.installScript || '', /E:\\paper-dual-aigc/);
    assert.match(missingStatus.setup?.notify || '', /不会生成或伪造分数/);
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
    const fixtureText = readFileSync(editsFixture, 'utf8');
    const savedEdits = assertOk(await call('/dsh-paper-dual/edits', 'POST', {
      text: fixtureText,
    }), 'save-edits');
    assert.equal(savedEdits.lines > 0, true);
    const unlocked = assertOk(await call('/dsh-paper-dual/status'), 'status-after-save-edits');
    assert.equal(unlocked.hasEdits, true, '保存清单后状态必须立即显示可回填');
    const loadedEdits = assertOk(await call('/dsh-paper-dual/edits'), 'load-edits');
    assert.equal(loadedEdits.exists, true);
    assert.equal(loadedEdits.text.replace(/\r/g, ''), fixtureText.replace(/\r/g, ''));

    const applied = assertOk(await call('/dsh-paper-dual/apply', 'POST', {
      edits: fixtureText, scope: 'dedupe',
    }), 'apply-fixture');
    assert.equal(applied.verdict?.passed, true);
    assert.equal(applied.versionId, 'v1');
    assert.equal(applied.baseVersionId, 'original');
    const compared = assertOk(await call('/dsh-paper-dual/compare'), 'compare');
    assert.equal(compared.count > 0, true);
    let versionStatus = assertOk(await call('/dsh-paper-dual/status'), 'status-v1');
    assert.equal(versionStatus.activeVersionId, 'v1');
    assert.equal(versionStatus.versions.length, 2);
    assert.equal(versionStatus.versions[1].label, '改稿');
    assert.equal(versionStatus.versions[1].downloadable, true);
    assert.equal(existsSync(applied.output), true);

    const download = await call('/dsh-paper-dual/download?version=v1');
    assert.equal(download.code, 200);
    assert.equal(Buffer.isBuffer(download.binary), true);
    assert.equal(download.binary.length > 1000, true);
    assert.match(download.headers?.['content-disposition'] || '', /filename\*=UTF-8/);

    const originalSelected = assertOk(
      await call('/dsh-paper-dual/versions/select', 'POST', { versionId: 'original' }),
      'select-original',
    );
    assert.equal(originalSelected.activeVersionId, 'original');
    assert.equal(originalSelected.lastApply, null);
    const v1Selected = assertOk(
      await call('/dsh-paper-dual/versions/select', 'POST', { versionId: 'v1' }),
      'select-v1',
    );
    assert.equal(v1Selected.activeVersionId, 'v1');
    assert.equal(v1Selected.lastApply?.versionId, 'v1');

    const frozenCheck = assertOk(
      await call('/dsh-paper-dual/reduce/check', 'POST', { autoRollback: false }),
      'frozen-aigc-check',
    );
    assert.equal(frozenCheck.prob?.comparisonMode, 'frozen');
    assert.equal(frozenCheck.prob?.frozenBlocks, true);
    assert.equal(typeof frozenCheck.prob?.beforeAllShare, 'number');
    assert.equal(frozenCheck.detectorAfter?.comparisonMode, 'frozen');
    console.log('冻结块 AIGC 复检：前后块计划一致，分组统计可用');

    process.env.PAPER_DUAL_TEST_FORCE_ROLLBACK = '1';
    const sourceRollback = assertOk(
      await call('/dsh-paper-dual/reduce/check', 'POST', {
        autoRollback: true, requireModel: false,
      }),
      'source-rollback',
    );
    delete process.env.PAPER_DUAL_TEST_FORCE_ROLLBACK;
    assert.equal(sourceRollback.rollback?.performed, true);
    assert.equal(sourceRollback.nextRound?.maxRounds, 5);
    assert.match(sourceRollback.rollback.restoredFrom, /base\.docx$/);
    assert.equal(sourceRollback.activeVersionId, 'v1', '未过版本仍保留，可继续作为下一轮输入');
    const rejectedStatus = assertOk(await call('/dsh-paper-dual/status'), 'status-v1-rejected');
    assert.equal(rejectedStatus.activeVersionId, 'v1');
    assert.equal(rejectedStatus.lastApply?.semanticRolledBack, true);
    assert.equal(rejectedStatus.versions.find((v) => v.id === 'v1')?.status, 'rejected');
    console.log('版本链：v1 保留、下载、切回与未达标回退通过');

    const loopPid = one.summary.top.find((p) => p.level !== 'locked')?.pid;
    assert.ok(loopPid);
    const loopPlan = assertOk(await call('/dsh-paper-dual/reduce/plan', 'POST', {
      scope: 'aigc',
      baseVersionId: 'v1',
      focusPids: [loopPid],
      useDetector: false,
      maxTasks: 1,
    }), 'detector-focus-plan');
    assert.equal(loopPlan.round >= 1, true);
    assert.equal(loopPlan.versionId, 'v2');
    assert.equal(loopPlan.baseVersionId, 'v1');
    assert.equal(loopPlan.focus.some((x) => x.pid === loopPid), true);

    const cleanStatus = assertOk(await call('/dsh-paper-dual/status'), 'status-new-round');
    assert.equal(cleanStatus.activeVersionId, 'v2');
    assert.equal(cleanStatus.versions.length, 3);
    assert.equal(cleanStatus.versions[2].status, 'planned');
    assert.equal(cleanStatus.hasEdits, false, '新任务轮次不能继承上一轮的 edits.jsonl');
    assert.equal(cleanStatus.compareCount, 0, '新任务轮次不能展示上一轮的对照');
    assert.equal(cleanStatus.lastApply, null);
    const freshReport = assertOk(
      await call('/dsh-paper-dual/report?which=report.md'),
      'report-new-round',
    );
    assert.equal(freshReport.text.length > 0, true);

    // 二改必须从 v1 作为输入，而不是再次从原文开始。
    const v1DocPath = join(home, 'v1-output-doc.json');
    execFileSync(process.env.PAPER_DUAL_PYTHON || 'python', [
      'scripts/inspect_docx.py', '--in', applied.output, '--out', v1DocPath,
    ], { cwd: realEngine, env: process.env, stdio: 'pipe' });
    const v1Doc = JSON.parse(readFileSync(v1DocPath, 'utf8'));
    const secondTarget = v1Doc.paragraphs.find((p) => (
      !p.locked && p.text.length >= 80 && p.text.includes('已有研究') && p.anchor?.sha1
    ));
    assert.ok(secondTarget, '二改测试需要可改写的 v1 段落');
    const secondText = secondTarget.text.replace('已有研究', '现有研究');
    assert.notEqual(secondText, secondTarget.text);
    const secondEdits = `${JSON.stringify({
      pid: secondTarget.pid,
      text: secondText,
      op: 'O4',
      expected_sha1: secondTarget.anchor.sha1,
    })}\n`;
    const secondApplied = assertOk(await call('/dsh-paper-dual/apply', 'POST', {
      edits: secondEdits, scope: 'dedupe',
    }), 'apply-v2-from-v1');
    assert.equal(secondApplied.versionId, 'v2');
    assert.equal(secondApplied.baseVersionId, 'v1');
    assert.equal(secondApplied.verdict?.passed, true);
    const v2Status = assertOk(await call('/dsh-paper-dual/status'), 'status-v2-applied');
    assert.equal(v2Status.activeVersionId, 'v2');
    assert.equal(v2Status.versions.find((v) => v.id === 'v2')?.status, 'applied');
    const v2Download = await call('/dsh-paper-dual/download?version=v2');
    assert.equal(v2Download.code, 200);
    assert.equal(Buffer.isBuffer(v2Download.binary), true);
    assert.equal(v2Download.binary.length > 1000, true);
    const v3Plan = assertOk(await call('/dsh-paper-dual/reduce/plan', 'POST', {
      scope: 'both',
      baseVersionId: 'v2',
      focusPids: [loopPid],
      useDetector: false,
      maxTasks: 1,
    }), 'plan-v3-from-v2');
    assert.equal(v3Plan.versionId, 'v3');
    assert.equal(v3Plan.baseVersionId, 'v2');
    assert.equal(v3Plan.optimization?.mode, 'focused');
    assert.equal(v3Plan.optimization?.focusLimit, 5);
    const v3Status = assertOk(await call('/dsh-paper-dual/status'), 'status-v3-planned');
    assert.equal(v3Status.activeVersionId, 'v3');
    assert.equal(v3Status.versions.length, 4);
    assert.equal(v3Status.versions.find((v) => v.id === 'v3')?.label, '三改');
    assert.equal(v3Status.maxRevisions, 5);
    const v3Optimized = assertOk(await call('/dsh-paper-dual/reduce/plan', 'POST', {
      scope: 'both',
      baseVersionId: 'v2',
      replaceVersionId: 'v3',
      focusPids: [loopPid],
      useDetector: false,
      maxTasks: 20,
    }), 'reoptimize-v3');
    assert.equal(v3Optimized.versionId, 'v3');
    assert.equal(v3Optimized.optimization?.reusedVersion, true);
    assert.equal(v3Optimized.tasks <= 6, true, '三改双降任务必须压缩到 6 段以内');
    const afterOptimize = assertOk(await call('/dsh-paper-dual/status'), 'status-v3-reoptimized');
    assert.equal(afterOptimize.versions.length, 4, '快速压缩不能新增版本');

    // 宿主硬上限：即使界面传了 v5，也只能创建到五改，不能生成 v6。
    const versionsDir = join(one.outdir, 'versions');
    const v2Meta = JSON.parse(readFileSync(join(versionsDir, 'v2', 'meta.json'), 'utf8'));
    for (const [id, index, label] of [['v4', 4, '四改'], ['v5', 5, '五改']]) {
      const dir = join(versionsDir, id);
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(versionsDir, 'v2', 'version.docx'), join(dir, 'version.docx'));
      copyFileSync(join(versionsDir, 'v2', 'base.docx'), join(dir, 'base.docx'));
      copyFileSync(join(versionsDir, 'v2', 'doc.json'), join(dir, 'doc.json'));
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        ...v2Meta,
        id,
        index,
        label,
        status: 'applied',
        visible: true,
        passed: true,
        baseId: 'v2',
        baseLabel: '二改',
        baseDocx: join(dir, 'base.docx'),
        output: join(dir, 'version.docx'),
      }, null, 2), 'utf8');
    }
    const atLimit = await call('/dsh-paper-dual/reduce/plan', 'POST', {
      scope: 'aigc',
      baseVersionId: 'v5',
      focusPids: [loopPid],
      useDetector: false,
    });
    assert.equal(atLimit.json?.ok, false);
    assert.match(atLimit.json?.error || '', /最多支持五改/);
    const v5Selected = assertOk(
      await call('/dsh-paper-dual/versions/select', 'POST', { versionId: 'v5' }),
      'select-v5-limit',
    );
    assert.equal(v5Selected.canCreateVersion, false);

    const v1Again = assertOk(
      await call('/dsh-paper-dual/versions/select', 'POST', { versionId: 'v1' }),
      'select-v1-again',
    );
    assert.equal(v1Again.activeVersionId, 'v1');
    assert.equal(v1Again.downloadAvailable, true);
    assert.equal(v1Again.compareCount > 0, true);
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
    edits: '{"pid":"p0004","text":"测试文本","op":"O4"}\n', scope: 'dedupe',
  });
  assert.equal(failedApply.json?.ok, false, '引擎失败不能返回 ok=true');
  assert.match(failedApply.json?.error || '', /预检|异常退出|run\.py/);
  assertOk(await call('/dsh-paper-dual/config', 'POST', {
    engineDir: realEngine,
  }), 'restore-engine-for-doc-test');

  // .doc 里装着的如果是 docx（PK 头），应直接复制为引擎可读的 .docx；
  // 诊断后改动原 .doc，status 要明确报 docChanged。
  const renamedDoc = join(home, 'renamed.doc');
  copyFileSync(firstDoc, renamedDoc);
  const converted = assertOk(
    await call('/dsh-paper-dual/diagnose', 'POST', { path: renamedDoc }),
    'diagnose-doc-alias',
  );
  assert.equal(converted.converted, true);
  assert.equal(converted.convertMethod, 'zip-renamed');
  assert.notEqual(converted.engineInput.toLowerCase(), renamedDoc.toLowerCase());
  appendFileSync(renamedDoc, Buffer.from([0]));
  const changed = assertOk(await call('/dsh-paper-dual/status'), 'status-doc-changed');
  assert.equal(changed.docChanged, true);

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
