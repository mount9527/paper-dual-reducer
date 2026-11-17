#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""detector.py —— 中文 AIGC 检测器封装（A/B 两层口径）。

A 层：块级模型分聚合为 AI 疑似占比、档位与稳定性。
B 层：把短段噪声合并为 300-480 字语义块，并按三粒度复算。

设计边界：
1. 直接操作 logits，不依赖 pipeline 的未知标签名。
2. 长文本按 token 级滑窗聚合，重叠区不重复计数。
3. 全文主指标是 ai_share，不是概率均值；ai_prob 仅保留兼容。
4. 阈值和档位全部来自 calib.json；缺失时按规格回退。
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from bands import band_label, band_of, load as load_bands
from blocking import (
    Block,
    apply_block_plan,
    backmatter_start,
    classify_blocks,
    coverage,
    plan_from_blocks,
    split_blocks,
)

DEFAULT_MODEL = "yuchuantian/AIGC_detector_zhv3"
MAX_TOKENS = 510
STRIDE_RATIO = 0.75
BATCH_SIZE = 16
DEFAULT_THRESHOLD: Optional[float] = None
STABILITY_TARGETS = (300, 400, 600)
DEFAULT_TARGET = 400

# 标签方向标定探针只判断 0/1 的相对方向，不承担语料校准。
AI_PROBES = [
    "综上所述，本研究具有重要的理论意义与实践价值，为相关领域提供了新的思路。",
    "随着信息技术的飞速发展，人工智能在各行各业得到了广泛应用，深刻改变了人们的生产和生活方式。",
    "本研究旨在探讨数字化转型对企业创新绩效的影响机制，采用定量与定性相结合的研究方法。",
    "值得注意的是，该结果进一步验证了本文提出的理论框架的有效性与适用性。",
]
HUMAN_PROBES = [
    "这个结果和我们最初的预期并不一致，后来又复测了三次，才把标定环节的问题定位出来。",
    "访谈里没有一个人主动提到这件事，我一开始以为是提纲设计有问题，翻了开放题才明白过来。",
    "样本量其实不太够，但重做一轮的成本太高，只能先在结论里把适用范围写窄一些。",
    "第三章那份数据是去年十一月补测的，仪器换过一次，前后可比性我心里没底。",
]


# ─────────────────────────── 数据结构 ───────────────────────────


@dataclass
class SegmentScore:
    """单个语义块的打分结果。"""

    index: int
    chars: int
    ai_prob: float
    windows: int
    preview: str = ""
    kind: str = "body"
    pid_span: Tuple[int, int] = (0, 0)
    contribution: float = 0.0
    truncated: bool = False
    group: str = "rewritable"


@dataclass
class DocScore:
    """整篇文档的打分与口径信息。"""

    ai_prob: float
    chars: int
    segments: List[SegmentScore]
    ai_index: int
    model: str
    mode: str = "model"
    ai_share: float = 0.0
    ai_share_hard: float = 0.0
    median_prob: float = 0.0
    band: str = "safe"
    stability: Optional[float] = None
    thr_hi: Optional[float] = None
    thr_hard: Optional[float] = None
    calibrated: bool = False
    degraded: bool = False
    mean_prob: float = 0.0
    granularity: int = DEFAULT_TARGET
    config_version: str = ""
    detectable_chars: int = 0
    coverage: float = 0.0
    body_chars: int = 0
    table_chars: int = 0
    reference_chars: int = 0
    excluded_chars: int = 0
    all_ai_share: float = 0.0
    table_ai_share: Optional[float] = None
    reference_ai_share: Optional[float] = None
    group_stats: dict = field(default_factory=dict)
    comparison_mode: str = "segmented"
    block_plan: List[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ─────────────────────────── 文本切分 ───────────────────────────


def split_paragraphs(text: str) -> List[str]:
    """按空行切段；超长单块按句号切成约 400 字的伪段落。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paras) == 1 and len(paras[0]) > 800:
        sents = re.split(r"(?<=[。！？；])", paras[0])
        buf, out = "", []
        for s in sents:
            if len(buf) + len(s) > 400 and buf:
                out.append(buf)
                buf = s
            else:
                buf += s
        if buf:
            out.append(buf)
        return [p for p in out if p.strip()]
    return paras


def _weighted_median(pairs: Sequence[Tuple[float, int]]) -> float:
    valid = [(float(p), max(0, int(n))) for p, n in pairs if n > 0]
    total = sum(n for _, n in valid)
    if not total:
        return 0.0
    half = total / 2.0
    acc = 0
    for prob, weight in sorted(valid, key=lambda item: item[0]):
        acc += weight
        if acc >= half:
            return prob
    return sorted(valid, key=lambda item: item[0])[-1][0]


def _aggregate(scored: Sequence[Tuple[Block, float, int]], config: dict) -> dict:
    total = sum(block.chars for block, _, _ in scored)
    if not total:
        return {
            "mean_prob": 0.0,
            "ai_share": 0.0,
            "ai_share_hard": 0.0,
            "median_prob": 0.0,
            "numerator": 0.0,
        }
    numerator = sum(block.chars for block, prob, _ in scored if prob >= float(config["thr_hi"]))
    numerator_hard = sum(
        block.chars for block, prob, _ in scored if prob >= float(config["thr_hard"])
    )
    return {
        "mean_prob": sum(block.chars * prob for block, prob, _ in scored) / total,
        "ai_share": numerator / total,
        "ai_share_hard": numerator_hard / total,
        "median_prob": _weighted_median([(p, b.chars) for b, p, _ in scored]),
        "numerator": numerator,
    }


def _group_stats(scored: Sequence[Tuple[Block, float, int]], config: dict) -> dict:
    stats = {}
    for group in ("rewritable", "table", "reference", "excluded"):
        subset = [item for item in scored if item[0].group == group]
        if not subset:
            stats[group] = {
                "blocks": 0,
                "chars": 0,
                "ai_share": None,
                "ai_share_hard": None,
                "median_prob": None,
                "mean_prob": None,
                "numerator": 0,
            }
            continue
        metrics = _aggregate(subset, config)
        stats[group] = {
            "blocks": len(subset),
            "chars": sum(block.chars for block, _, _ in subset),
            "ai_share": metrics["ai_share"],
            "ai_share_hard": metrics["ai_share_hard"],
            "median_prob": metrics["median_prob"],
            "mean_prob": metrics["mean_prob"],
            "numerator": metrics["numerator"],
        }
    return stats


# ─────────────────────────── 检测器 ───────────────────────────


class Detector:
    """真实使用流程：Detector().load().calibrate().score_document(text)。"""

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL,
        device: str = "cpu",
        ai_index: Optional[int] = None,
        max_tokens: int = MAX_TOKENS,
        config_path: Optional[str | Path] = None,
    ) -> None:
        self.model_id = model_id
        self.device = device
        self.max_tokens = max_tokens
        self.ai_index: Optional[int] = ai_index
        self.tokenizer = None
        self.model = None
        self.calibration: Optional[dict] = None
        self.calibration_config_path = Path(config_path) if config_path else None
        self.calibration_config = load_bands(self.calibration_config_path)
        self._torch = None

    # ---- 加载 ----

    def load(self) -> "Detector":
        try:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer
        except ImportError as exc:  # pragma: no cover
            raise SystemExit(
                "缺少依赖：pip install -r requirements.txt（transformers + torch）"
            ) from exc

        self.calibration_config = load_bands(self.calibration_config_path)
        self._torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_id)
        self.model = AutoModelForSequenceClassification.from_pretrained(
            self.model_id, num_labels=2, use_safetensors=False
        )
        self.model.to(self.device)
        self.model.eval()

        if self.ai_index is None:
            self.ai_index = self._ai_index_from_config()
        return self

    def _ai_index_from_config(self) -> Optional[int]:
        id2label = getattr(self.model.config, "id2label", {}) or {}
        for idx, name in id2label.items():
            low = str(name).lower()
            if any(k in low for k in ("ai", "machine", "gpt", "generated", "fake")):
                return int(idx)
        return None

    def _build_inputs_with_special_tokens(self, ids: Sequence[int]) -> List[int]:
        ids = list(ids)
        fn = getattr(self.tokenizer, "build_inputs_with_special_tokens", None)
        if callable(fn):
            return fn(ids)
        cls_id = getattr(self.tokenizer, "cls_token_id", None)
        sep_id = getattr(self.tokenizer, "sep_token_id", None)
        if cls_id is not None and sep_id is not None:
            return [cls_id] + ids + [sep_id]
        prepare = getattr(self.tokenizer, "prepare_for_model", None)
        if callable(prepare):
            return prepare(ids, add_special_tokens=True)["input_ids"]
        raise AttributeError(
            f"{type(self.tokenizer).__name__} 无法为输入添加特殊 token"
        )

    # ---- 前向 ----

    def _probs_batch(self, id_lists: Sequence[Sequence[int]]) -> List[Tuple[float, float]]:
        out: List[Tuple[float, float]] = []
        for i in range(0, len(id_lists), BATCH_SIZE):
            chunk = list(id_lists[i : i + BATCH_SIZE])
            enc = self.tokenizer.pad(
                {"input_ids": chunk}, padding=True, return_tensors="pt"
            )
            enc = {k: v.to(self.device) for k, v in enc.items()}
            with self._torch.no_grad():
                logits = self.model(**enc).logits
            probs = self._torch.softmax(logits, dim=-1).tolist()
            out.extend((float(p[0]), float(p[1])) for p in probs)
        return out

    # ---- 窗口规划 ----

    def _windows(self, n_tokens: int) -> List[Tuple[int, int]]:
        if n_tokens <= self.max_tokens:
            return [(0, n_tokens)]
        stride = max(1, int(self.max_tokens * STRIDE_RATIO))
        wins: List[Tuple[int, int]] = []
        start = 0
        while start + self.max_tokens < n_tokens:
            wins.append((start, start + self.max_tokens))
            start += stride
        if not wins:
            return [(0, n_tokens)]
        if wins[-1][1] < n_tokens:
            tail = (n_tokens - self.max_tokens, n_tokens)
            if tail != wins[-1]:
                wins.append(tail)
        return wins

    def _score_text(self, text: str) -> Tuple[float, int]:
        if not text.strip():
            return 0.0, 0
        ids = self.tokenizer(text, add_special_tokens=False, truncation=False)["input_ids"]
        n = len(ids)
        if n == 0:
            return 0.0, 0
        wins = self._windows(n)
        payload = [
            self._build_inputs_with_special_tokens(ids[s:e]) for s, e in wins
        ]
        raws = self._probs_batch(payload)
        p_ai = [r[self.ai_index or 0] for r in raws]
        acc = [0.0] * n
        cnt = [0] * n
        for (s, e), p in zip(wins, p_ai):
            for i in range(s, e):
                acc[i] += p
                cnt[i] += 1
        per_token = [acc[i] / cnt[i] for i in range(n) if cnt[i] > 0]
        if not per_token:
            return 0.0, len(wins)
        return sum(per_token) / len(per_token), len(wins)

    def _pack_run(
        self,
        target: int,
        blocks: Sequence[Block],
        text: str,
    ) -> dict:
        scored = [
            (block, *self._score_text(block.text))
            for block in blocks
        ]
        body_scored = [item for item in scored if item[0].group == "rewritable"]
        all_metrics = _aggregate(scored, self.calibration_config)
        body_metrics = _aggregate(body_scored, self.calibration_config)
        return {
            "target": target,
            "blocks": list(blocks),
            "scored": scored,
            "body_scored": body_scored,
            "coverage": coverage(blocks, text),
            "group_stats": _group_stats(scored, self.calibration_config),
            "all_ai_share": all_metrics["ai_share"],
            "all_ai_share_hard": all_metrics["ai_share_hard"],
            **body_metrics,
        }

    def _score_at_granularity(
        self,
        text: str,
        paras: Sequence[str],
        target: int,
        locked_flags: Sequence[bool] | None = None,
    ) -> dict:
        hard_max = 480 if target <= 480 else target
        boundary = backmatter_start(paras)
        blocks = split_blocks(
            text,
            target=target,
            hard_max=hard_max,
            min_para=40,
            min_block=200,
            paragraphs=paras,
            break_before_indices={boundary} if boundary < len(paras) else None,
        )
        blocks = classify_blocks(blocks, paras, locked_flags)
        return self._pack_run(target, blocks, text)

    def _score_frozen_plan(
        self,
        paras: Sequence[str],
        plan: Sequence[dict],
        locked_flags: Sequence[bool] | None = None,
    ) -> dict:
        blocks = apply_block_plan(paras, plan, hard_max=480)
        # 计划分组来自基础稿；若基础稿没有分组信息，再按新版段落补分类。
        if any(block.group not in {"rewritable", "table", "reference", "excluded"}
               for block in blocks):
            blocks = classify_blocks(blocks, paras, locked_flags)
        target = int(plan[0].get("target", DEFAULT_TARGET)) if plan else DEFAULT_TARGET
        return self._pack_run(target, blocks, "\n\n".join(paras))

    def _empty_score(self, config: dict) -> DocScore:
        return DocScore(
            ai_prob=0.0,
            chars=0,
            segments=[],
            ai_index=self.ai_index if self.ai_index is not None else -1,
            model=self.model_id,
            mode="model",
            band=band_of(0.0, config),
            thr_hi=float(config["thr_hi"]),
            thr_hard=float(config["thr_hard"]),
            calibrated=bool(config.get("calibrated", False)),
            mean_prob=0.0,
            config_version=str(config.get("version", "")),
            coverage=1.0,
        )

    def score_document(
        self,
        text: str,
        fast: bool = False,
        paragraphs: Sequence[str] | None = None,
        locked_flags: Sequence[bool] | None = None,
        block_plan: Sequence[dict] | None = None,
    ) -> DocScore:
        """正文主指标取三粒度中位；传入 block_plan 时冻结基础稿块边界。"""
        self.calibration_config = load_bands(self.calibration_config_path)
        config = self.calibration_config
        paras = list(paragraphs) if paragraphs is not None else split_paragraphs(text)
        if not paras:
            return self._empty_score(config)

        comparison_mode = "frozen" if block_plan else "segmented"
        if block_plan:
            selected = self._score_frozen_plan(paras, block_plan, locked_flags)
            runs = [selected]
            degraded = False
        else:
            default_run = self._score_at_granularity(
                text, paras, DEFAULT_TARGET, locked_flags,
            )
            degraded = len(default_run["blocks"]) < 3
            if degraded:
                boundary = backmatter_start(paras)
                full_block = Block(
                    index=0,
                    text=text,
                    chars=len(re.sub(r"\s+", "", text)),
                    kind="body",
                    pid_span=(0, max(0, len(paras) - 1)),
                    source_ranges=tuple((i, 0.0, 1.0) for i in range(len(paras))),
                    group="rewritable" if boundary else "reference",
                )
                selected = self._pack_run(DEFAULT_TARGET, [full_block], text)
                selected["coverage"] = 1.0
                runs = [selected]
            else:
                targets = (DEFAULT_TARGET,) if fast else STABILITY_TARGETS
                runs = [
                    default_run if target == DEFAULT_TARGET
                    else self._score_at_granularity(
                        text, paras, target, locked_flags,
                    )
                    for target in targets
                ]
                median_share = statistics.median(run["ai_share"] for run in runs)
                selected = min(
                    runs,
                    key=lambda run: (
                        abs(run["ai_share"] - median_share),
                        0 if run["target"] == DEFAULT_TARGET else 1,
                    ),
                )

        stability = None
        if comparison_mode == "segmented" and not fast and not degraded:
            values = [run["ai_share"] for run in runs]
            stability = max(values) - min(values)

        segments: List[SegmentScore] = []
        if not degraded:
            for block, prob, windows in selected["scored"]:
                group_metrics = selected["group_stats"].get(block.group) or {}
                numerator = float(group_metrics.get("numerator") or 0.0)
                contribution = (
                    block.chars / numerator
                    if numerator > 0 and prob >= float(config["thr_hi"])
                    else 0.0
                )
                segments.append(SegmentScore(
                    index=block.index,
                    chars=block.chars,
                    ai_prob=round(float(prob), 4),
                    windows=windows,
                    preview=block.text[:40].replace("\n", " "),
                    kind=block.kind,
                    pid_span=block.pid_span,
                    contribution=round(contribution, 4),
                    truncated=block.truncated,
                    group=block.group,
                ))

        final_share = float(selected["ai_share"])
        mean_prob = float(selected["mean_prob"])
        stats = selected["group_stats"]
        body_stats = stats.get("rewritable") or {}
        table_stats = stats.get("table") or {}
        reference_stats = stats.get("reference") or {}
        excluded_stats = stats.get("excluded") or {}
        return DocScore(
            ai_prob=round(mean_prob, 4),
            chars=len(text),
            segments=segments,
            ai_index=self.ai_index if self.ai_index is not None else -1,
            model=self.model_id,
            mode="model",
            ai_share=round(final_share, 4),
            ai_share_hard=round(float(selected["ai_share_hard"]), 4),
            median_prob=round(float(selected["median_prob"]), 4),
            band=band_of(final_share, config),
            stability=round(stability, 4) if stability is not None else None,
            thr_hi=round(float(config["thr_hi"]), 4),
            thr_hard=round(float(config["thr_hard"]), 4),
            calibrated=bool(config.get("calibrated", False)),
            degraded=degraded,
            mean_prob=round(mean_prob, 4),
            granularity=int(selected["target"]),
            config_version=str(config.get("version", "")),
            detectable_chars=sum(block.chars for block in selected["blocks"]),
            coverage=round(float(selected["coverage"]), 4),
            body_chars=int(body_stats.get("chars") or 0),
            table_chars=int(table_stats.get("chars") or 0),
            reference_chars=int(reference_stats.get("chars") or 0),
            excluded_chars=int(excluded_stats.get("chars") or 0),
            all_ai_share=round(float(selected["all_ai_share"]), 4),
            table_ai_share=(
                round(float(table_stats["ai_share"]), 4)
                if table_stats.get("ai_share") is not None else None
            ),
            reference_ai_share=(
                round(float(reference_stats["ai_share"]), 4)
                if reference_stats.get("ai_share") is not None else None
            ),
            group_stats=stats,
            comparison_mode=comparison_mode,
            block_plan=(
                list(block_plan) if block_plan
                else plan_from_blocks(selected["blocks"])
            ),
        )

    # ---- 标签方向标定 ----

    def calibrate(self, verbose: bool = False) -> dict:
        if self.model is None:
            self.load()

        def mean_p1(texts: Sequence[str]) -> float:
            payload = [
                self._build_inputs_with_special_tokens(
                    self.tokenizer(
                        t, add_special_tokens=False, truncation=True,
                        max_length=self.max_tokens,
                    )["input_ids"]
                )
                for t in texts
            ]
            raws = self._probs_batch(payload)
            return sum(r[1] for r in raws) / len(raws)

        ai_p1 = mean_p1(AI_PROBES)
        hu_p1 = mean_p1(HUMAN_PROBES)
        gap = ai_p1 - hu_p1
        ai_index = 1 if gap > 0 else 0
        trusted = abs(gap) >= 0.15

        self.ai_index = ai_index
        self.calibration = {
            "method": "probe",
            "ai_index": ai_index,
            "p1_on_ai_probes": round(ai_p1, 4),
            "p1_on_human_probes": round(hu_p1, 4),
            "gap": round(abs(gap), 4),
            "trusted": trusted,
        }
        if verbose:
            print(f"  index=1 在 AI 探针上的均值 : {ai_p1:.4f}")
            print(f"  index=1 在人写探针上的均值 : {hu_p1:.4f}")
            print(f"  差值                       : {abs(gap):.4f}")
            print(f"  判定 ai_index              : {ai_index}")
        if not trusted:
            raise RuntimeError(
                f"标签方向标定不可信（gap={abs(gap):.4f} < 0.15）。"
                "请换一组更有区分度的探针，或用 --ai-label 手动指定。"
            )
        return self.calibration


# ─────────────────────────── CLI ───────────────────────────


def _bar(p: float, width: int = 20) -> str:
    n = max(0, min(width, int(round(p * width))))
    return "█" * n + "·" * (width - n)


def _print_report(doc: DocScore, threshold: Optional[float] = None) -> None:
    thr = doc.thr_hi if threshold is None else threshold
    print("=" * 72)
    print("  AIGC 检测报告（AI 疑似占比）")
    print("=" * 72)
    print(f"  模型      : {doc.model}")
    print(f"  配置      : {doc.config_version or 'unknown'}")
    print(f"  校准状态  : {'已校准' if doc.calibrated else '未校准（阈值为占位值）'}")
    print(f"  正文块    : {len(doc.segments)} ｜ 正文字数 {doc.body_chars} / {doc.chars}")
    print(f"  比较口径  : {'冻结基础稿块' if doc.comparison_mode == 'frozen' else '重新切块'}")
    print(f"  块覆盖率  : {doc.coverage:.1%}")
    print()
    print(
        f"  正文 AI 疑似占比: {doc.ai_share * 100:.1f}%  [{_bar(doc.ai_share)}] "
        f"｜ {band_label(doc.band)}"
    )
    print(
        f"  全篇/表格/参考文献: {doc.all_ai_share * 100:.1f}% / "
        f"{'—' if doc.table_ai_share is None else f'{doc.table_ai_share * 100:.1f}%'} / "
        f"{'—' if doc.reference_ai_share is None else f'{doc.reference_ai_share * 100:.1f}%'}"
    )
    print(f"  硬阈值占比: {doc.ai_share_hard * 100:.1f}% ｜ 块得分中位数 {doc.median_prob:.4f}")
    if doc.stability is not None:
        print(f"  切分稳定度: {doc.stability:.4f}（极差，越小越稳）")
    if doc.degraded:
        print("  退化保护  : 可用块不足 3 个，已按整篇单块打分，不输出定位")
    print()
    if doc.segments:
        risky = [s for s in doc.segments if s.ai_prob >= (thr if thr is not None else 0)]
        print(f"  块得分 ≥ {float(thr or 0):.2f} 的块: {len(risky)} / {len(doc.segments)}")
        print("-" * 72)
        print(f"  {'#':>3}  {'字数':>5}  {'块分':>6}  {'贡献':>7}  {'类型':>5}  预览")
        for s in sorted(doc.segments, key=lambda item: item.contribution, reverse=True):
            flag = "!" if thr is not None and s.ai_prob >= thr else " "
            span = f"{s.pid_span[0]}-{s.pid_span[1]}"
            print(
                f"  {s.index:>3}  {s.chars:>5}  {s.ai_prob * 100:>5.1f}%{flag} "
                f"{s.contribution:>7.1%}  {s.kind:>5}  [{span}] {s.preview}"
            )
    print("=" * 72)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="AIGC 检测器封装（AI 疑似占比口径）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  python detector.py --calibrate\n"
            "  python detector.py --file samples/ai_sample.txt\n"
            "  python detector.py --text \"待检测文本\" --json --fast\n"
        ),
    )
    ap.add_argument("--file", help="待检测文本文件（UTF-8）")
    ap.add_argument("--text", help="直接传入文本")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="HF 模型 id")
    ap.add_argument("--device", default="cpu", help="cpu / cuda")
    ap.add_argument("--ai-label", type=int, choices=(0, 1), help="手动指定 AI 对应的下标")
    ap.add_argument("--calibrate", action="store_true", help="只做标签方向标定")
    ap.add_argument("--threshold", type=float, default=None, help="报告展示用块阈值覆盖")
    ap.add_argument("--fast", action="store_true", help="只跑 400 字粒度，stability 记为 null")
    ap.add_argument("--calib", help="可选 calib.json 路径")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(argv)

    det = Detector(
        model_id=args.model,
        device=args.device,
        ai_index=args.ai_label,
        config_path=args.calib,
    )
    det.load()

    if args.calibrate:
        print("标签方向标定中 ...")
        info = det.calibrate(verbose=True)
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0

    if det.ai_index is None:
        det.calibrate(verbose=False)

    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    elif args.text:
        text = args.text
    else:
        ap.print_help()
        return 2

    doc = det.score_document(text, fast=args.fast)
    if args.json:
        print(json.dumps(doc.to_dict(), ensure_ascii=False, indent=2))
    else:
        _print_report(doc, args.threshold)
    return 0


if __name__ == "__main__":
    sys.exit(main())
