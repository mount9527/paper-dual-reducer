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
from typing import List, Sequence, Tuple

import detector as D
import diag as G


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
    det.dry_run = False
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
def test_doc_score_is_char_weighted():
    """两段等概率时，字数加权应等于该概率；断言不依赖段落数量。"""
    det = make_detector(max_tokens=10)
    det._probs_batch = lambda payloads: [(0.5, 0.5) for _ in payloads]
    text = "甲" * 100 + "\n\n" + "乙" * 5
    doc = det.score_document(text)
    assert abs(doc.ai_prob - 0.5) < 1e-6, f"加权口径异常: {doc.ai_prob}"
    assert len(doc.segments) == 2


@case
def test_split_paragraphs_fallback():
    assert D.split_paragraphs("") == []
    assert len(D.split_paragraphs("第一段\n\n第二段")) == 2
    long_single = "这是一个句子。" * 300
    got = D.split_paragraphs(long_single)
    assert len(got) > 1, "超长单块应退化为多段"


@case
def test_dry_run_deterministic():
    det = D.Detector(model_id="fake", dry_run=True).load()
    a = det.score_document("测试文本内容" * 20)
    b = det.score_document("测试文本内容" * 20)
    assert a.ai_prob == b.ai_prob, "dry-run 应可复现"
    assert a.mode == "dry-run"


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
