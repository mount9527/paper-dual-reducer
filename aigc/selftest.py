#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
selftest.py —— 离线自检：不下载模型也能验证核心逻辑

覆盖：
  1. 滑窗规划：覆盖无空洞、尾窗不残留碎片
  2. 窗口聚合：重叠区不被重复计数（token 级加权）
  3. 全文分口径：按字数加权而非段落算术平均
  4. 段落切分：空行切分 + 单块退化切分
  5. 诊断器：模板句命中、语体门禁、作业清单生成

运行：python selftest.py
退出码 0 表示全部通过。CI / 交接验收的第一步就是跑这个。
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import List, Sequence, Tuple

import bands as B
import blocking as K
import detector as D
import diag as G
import segscore as S


class FakeTokenizer:
    """1 字符 = 1 token，用于精确控制窗口边界。"""

    def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None):
        ids = list(range(len(text)))
        if truncation and max_length:
            ids = ids[:max_length]
        return {"input_ids": ids}

    def build_inputs_with_special_tokens(self, ids):
        return [101] + list(ids) + [102]

    def pad(self, batch, padding=True, return_tensors="pt"):
        seqs = batch["input_ids"]
        width = max(len(s) for s in seqs)
        ids = [s + [0] * (width - len(s)) for s in seqs]
        mask = [[1] * len(s) + [0] * (width - len(s)) for s in seqs]
        return {"input_ids": ids, "attention_mask": mask}


def make_detector(max_tokens=10, ai_index=1):
    det = D.Detector(model_id="fake", ai_index=ai_index, max_tokens=max_tokens)
    det.tokenizer = FakeTokenizer()
    det._torch = None
    return det


# ─────────────── 用例 ───────────────

CASES: List[Tuple[str, callable]] = []


def case(fn):
    CASES.append((fn.__name__, fn))
    return fn


@case
def test_windows_no_gap():
    det = make_detector(max_tokens=10)
    for n in (3, 10, 11, 17, 25, 40, 100, 511):
        wins = det._windows(n)
        cover = [0] * n
        for s, e in wins:
            assert 0 <= s < e <= n, f"n={n} 窗口越界 {s},{e}"
            assert e - s <= det.max_tokens, f"n={n} 窗口超长 {e-s}"
            for i in range(s, e):
                cover[i] += 1
        assert all(c > 0 for c in cover), f"n={n} 存在未覆盖 token"
        assert cover[0] == 1 and cover[-1] == 1, f"n={n} 首尾 token 被重复覆盖"


@case
def test_no_tail_fragment():
    """尾窗必须是整窗，不能是几个 token 的残片（残片分数噪声极大）。"""
    det = make_detector(max_tokens=10)
    for n in range(11, 300):
        wins = det._windows(n)
        assert wins[-1][1] == n, f"n={n} 末窗未对齐文末: {wins[-1]}"
        assert wins[-1][1] - wins[-1][0] == min(det.max_tokens, n), (
            f"n={n} 末窗非整窗: {wins[-1]}"
        )


@case
def test_overlap_not_double_counted():
    """恒定概率下，token 级聚合必须还原该常数；算术平均会因重叠而偏移。"""
    det = make_detector(max_tokens=10, ai_index=1)
    det._probs_batch = lambda payloads: [(0.2, 0.8) for _ in payloads]
    prob, nw = det._score_text("字" * 25)
    assert nw > 1, "25 token / 窗口 10 应产生多个窗口"
    assert abs(prob - 0.8) < 1e-9, f"聚合偏差: {prob}"


@case
def test_ai_index_respected():
    det = make_detector(max_tokens=10, ai_index=0)
    det._probs_batch = lambda payloads: [(0.9, 0.1) for _ in payloads]
    prob, _ = det._score_text("字" * 25)
    assert abs(prob - 0.9) < 1e-9, f"未按 ai_index=0 取值: {prob}"


@case
def test_doc_score_uses_share_and_keeps_legacy_mean():
    """主指标是超阈值字数占比；ai_prob 只保留为 mean_prob 的兼容别名。"""
    det = make_detector(max_tokens=2000)
    probabilities = {"甲": 0.9, "乙": 0.5, "丙": 0.1}

    def fake_score(text):
        first = next(ch for ch in text if ch in probabilities)
        return probabilities[first], 1

    det._score_text = fake_score
    text = "\n\n".join(key * 300 for key in ("甲", "乙", "丙"))
    doc = det.score_document(text, fast=True)
    assert len(doc.segments) == 3, len(doc.segments)
    assert abs(doc.ai_share - 2 / 3) < 1e-4, doc.ai_share
    assert abs(doc.median_prob - 0.5) < 1e-6, doc.median_prob
    assert abs(doc.mean_prob - 0.5) < 1e-6, doc.mean_prob
    assert abs(doc.ai_prob - doc.mean_prob) < 1e-9, "旧字段必须等于 mean_prob"
    assert doc.band == "risk"
    assert abs(sum(s.contribution for s in doc.segments) - 1.0) < 1e-4
    assert doc.stability is None


@case
def test_split_paragraphs_fallback():
    assert D.split_paragraphs("") == []
    assert len(D.split_paragraphs("第一段\n\n第二段")) == 2
    long_single = "这是一个句子。" * 300
    got = D.split_paragraphs(long_single)
    assert len(got) > 1, "超长单块应退化为多段"


@case
def test_real_path_is_deterministic():
    det = make_detector(max_tokens=10)
    det._probs_batch = lambda payloads: [(0.3, 0.7) for _ in payloads]
    a = det.score_document("测试文本内容" * 20)
    b = det.score_document("测试文本内容" * 20)
    assert a.ai_prob == b.ai_prob, "同一输入的模型路径应可复现"
    assert a.mode == "model"


@case
def test_segscore_is_char_weighted():
    score = SimpleNamespace(segments=[
        SimpleNamespace(chars=90, ai_prob=0.2),
        SimpleNamespace(chars=10, ai_prob=0.8),
    ])
    assert abs(S.weighted_probability(score) - 0.26) < 1e-9


@case
def test_diag_flags_template():
    ai_text = (
        "随着信息技术的飞速发展，人工智能在各领域得到广泛应用。\n\n"
        "综上所述，本研究具有重要的理论意义与实践价值，为相关领域提供了新思路。\n\n"
        "基于社会建构主义理论，知识通过社会互动建构而成。值得注意的是，该结果具有广阔的应用前景。"
    )
    r = G.diagnose(ai_text)
    assert r.template["count"] >= 3, f"模板句应命中 ≥3，实际 {r.template['count']}"
    assert r.template["risk"] is True
    assert r.todo, "应生成作业清单"


@case
def test_diag_colloquial_gate():
    bad = "这个实验结果说实话挺离谱的，我们一开始完全没跑偏，后来才搞定。" * 3
    r = G.diagnose(bad)
    assert r.colloquial["gate_failed"] is True, "口语词应触发门禁"
    assert r.style_gate_passed is False
    assert any("门禁" in t for t in r.todo)


@case
def test_diag_colloquial_no_substring_false_positive():
    # 「无语料授权」不等于口语词「无语」。子串匹配会把整篇门禁误判为未通过，
    # 而这类段落往往还是锁定段（永不改写），形成一个永远改不掉的红灯。
    txt = "本研究不做全库查重，原因是无语料授权，且爬取会违反服务条款。"
    r = G.diagnose(txt)
    assert r.colloquial["count"] == 0, f"误判为口语词: {r.colloquial['terms']}"
    assert r.colloquial["gate_failed"] is False, "无语料 不应触发言语门禁"
    # 真口语仍然必须抓
    r2 = G.diagnose("这个结果说实话挺离谱的，我们一开始完全没跑偏，后来才搞定。")
    assert r2.colloquial["gate_failed"] is True, "真口语词必须仍然触发门禁"


@case
def test_diag_dash_gate():
    bad = "这个方法——经过三轮测试——最终收敛，效果——超出预期。\n\n另一段——也有问题。"
    r = G.diagnose(bad)
    assert r.dash["gate_failed"] is True, "破折号超限应触发门禁"
    assert r.style_gate_passed is False


@case
def test_diag_clean_text_passes_gate():
    clean = (
        "本研究共采集样本 312 份，剔除缺失值后保留 287 份。\n\n"
        "需要说明的是，第三批数据的采集时间比原计划晚了两个月，仪器在此期间更换过一次，"
        "因此前后批次的指标不完全可比。\n\n"
        "基于这一限制，本文的结论只适用于同一批次内部比较。"
    )
    r = G.diagnose(clean)
    assert r.style_gate_passed is True, f"干净文本不应触发门禁: {r.colloquial['terms']}"


@case
def test_blocking_document_shape_and_coverage():
    text = "\n\n".join("甲" * 50 for _ in range(320))
    blocks = K.split_blocks(text, target=400, hard_max=480)
    assert 35 <= len(blocks) <= 45, f"块数异常: {len(blocks)}"
    assert min(block.chars for block in blocks) >= 200
    assert max(block.chars for block in blocks) <= 480
    assert K.coverage(blocks, text) >= 0.85


@case
def test_blocking_merges_table_and_marks_truncation():
    frags = ["123\t456\t789" for _ in range(50)]
    text = "\n\n".join(frags)
    blocks = K.split_blocks(text, target=400, hard_max=480)
    assert blocks and blocks[0].kind == "table", [block.kind for block in blocks]
    assert blocks[0].truncated is True
    assert blocks[0].chars <= 480


@case
def test_band_boundaries_come_from_policy_config():
    cfg = B.load()
    assert cfg["thr_hi"] == 0.38
    assert cfg["calibrated"] is False
    assert B.band_of(0.1499, cfg) == "safe"
    assert B.band_of(0.15, cfg) == "warn"
    assert B.band_of(0.2999, cfg) == "warn"
    assert B.band_of(0.30, cfg) == "risk"


@case
def test_missing_config_uses_spec_fallback():
    cfg = B.load(Path("__missing_calib__.json"))
    assert cfg["thr_hi"] == 0.50
    assert cfg["thr_hard"] == 0.85
    assert cfg["band"] == {"safe_max": 0.15, "warn_max": 0.30}
    assert cfg["calibrated"] is False


@case
def test_weighted_median_expands_block_chars():
    p = D._weighted_median([(0.1, 90), (0.9, 10)])
    assert p == 0.1, p


@case
def test_three_granularity_stability_and_serialization():
    det = make_detector(max_tokens=2000)
    det._probs_batch = lambda payloads: [(0.2, 0.8) for _ in payloads]
    text = "\n\n".join("甲" * 50 for _ in range(32))
    doc = det.score_document(text)
    assert doc.stability is not None
    assert abs(doc.stability) < 1e-6
    data = doc.to_dict()
    for key in (
        "ai_share", "ai_share_hard", "median_prob", "band", "stability",
        "thr_hi", "thr_hard", "calibrated", "degraded",
    ):
        assert key in data, key
    assert "kind" in data["segments"][0]
    assert "pid_span" in data["segments"][0]
    assert "contribution" in data["segments"][0]


@case
def test_short_document_degrades_without_block_localization():
    det = make_detector(max_tokens=2000)
    det._probs_batch = lambda payloads: [(0.2, 0.8) for _ in payloads]
    doc = det.score_document("甲" * 300 + "\n\n" + "乙" * 300)
    assert doc.degraded is True
    assert doc.segments == []
    assert doc.ai_share == 1.0


@case
def test_body_table_reference_are_measured_separately():
    det = make_detector(max_tokens=2000)

    def fake_score(text):
        if text.startswith("甲"):
            return 0.80, 1
        if text.startswith("乙"):
            return 0.10, 1
        return 0.95, 1

    det._score_text = fake_score
    paras = [
        "甲" * 300,
        "乙" * 300,
        "表 1",
        "1\t2",
        "3\t4",
        "参考文献",
        "丙" * 300,
    ]
    text = "\n\n".join(paras)
    doc = det.score_document(text, fast=True, paragraphs=paras)
    assert doc.body_chars == 600, doc.body_chars
    assert doc.table_chars > 0, doc.table_chars
    assert doc.reference_chars > 0, doc.reference_chars
    assert abs(doc.ai_share - 0.5) < 1e-6, doc.ai_share
    assert doc.table_ai_share == 1.0, doc.table_ai_share
    assert doc.reference_ai_share == 1.0, doc.reference_ai_share
    assert doc.all_ai_share > doc.ai_share


@case
def test_frozen_block_plan_reuses_base_boundaries():
    det = make_detector(max_tokens=2000)
    det._score_text = lambda text: (0.6, 1)
    base_paras = ["甲" * 300, "乙" * 300, "丙" * 300, "丁" * 300]
    base_text = "\n\n".join(base_paras)
    base = det.score_document(base_text, fast=True, paragraphs=base_paras)
    plan = base.block_plan
    assert plan

    revised_paras = [
        base_paras[0][:240] + "甲" * 60,
        base_paras[1][:180],
        base_paras[2] + "新增短语。",
        base_paras[3][:200],
    ]
    revised_text = "\n\n".join(revised_paras)
    revised = det.score_document(
        revised_text,
        fast=True,
        paragraphs=revised_paras,
        block_plan=plan,
    )
    assert revised.comparison_mode == "frozen"
    assert stable_spans(revised.block_plan) == stable_spans(plan)


def stable_spans(plan):
    return [
        (
            block.get("kind"),
            tuple(block.get("pid_span") or []),
            tuple(tuple(range_row) for range_row in (block.get("source_ranges") or [])),
        )
        for block in plan
    ]


def main() -> int:
    passed, failed = 0, []
    for name, fn in CASES:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  FAIL  {name}\n        {e}")
        except Exception as e:  # noqa: BLE001
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ERROR {name}\n        {type(e).__name__}: {e}")
        else:
            passed += 1
            print(f"  ok    {name}")
    print("-" * 56)
    print(f"  {passed}/{len(CASES)} 通过" + (f"，{len(failed)} 失败" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
