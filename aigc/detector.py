#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
detector.py —— 「考官」：中文 AIGC 文本检测器封装

把 HuggingFace 上的 AIGC 检测模型包装成一个可直接调用的打分组件，
解决三个工程问题：标签方向未知、512 token 截断、全文分数口径不一致。

设计决策（改动前请先读）：
1. 直接操作 logits，不用 pipeline —— pipeline 输出的 label 名是 LABEL_0/LABEL_1，
   不携带语义；且我们必须在标定前拿到两类原始概率。
2. 按 token 级做窗口聚合，而不是按窗口算术平均 —— 重叠窗口若直接平均，
   重叠区会被重复计数，导致分数向窗口内容偏斜。
3. max_tokens = 510 而非 512 —— 给 [CLS] / [SEP] 留位置。
4. 全文分 = 段落分按字数加权，不是段落算术平均 —— 否则短段落权重过高。

依赖：transformers + torch（仅真实打分需要；--dry-run 不需要）
模型权重许可：见对应 HuggingFace 页面（zhv3 为 apache-2.0）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, asdict
from typing import List, Optional, Sequence, Tuple

DEFAULT_MODEL = "yuchuantian/AIGC_detector_zhv3"
MAX_TOKENS = 510
STRIDE_RATIO = 0.75
BATCH_SIZE = 16
DEFAULT_THRESHOLD = 0.5

# 标签方向标定用的探针句。要求：短（远低于 510 token）、语义明确、风格典型。
# 标定只依赖「AI 组相对人组偏高」这一相对关系，不依赖绝对分数。
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
    """单个段落的打分结果。"""

    index: int
    chars: int
    ai_prob: float
    windows: int
    preview: str = ""


@dataclass
class DocScore:
    """整篇文档的打分结果。"""

    ai_prob: float
    chars: int
    segments: List[SegmentScore]
    ai_index: int
    model: str
    mode: str = "model"  # model | dry-run

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


# ─────────────────────────── 文本切分 ───────────────────────────


def split_paragraphs(text: str) -> List[str]:
    """按空行切段落；若只有一整块，则按句号切成 ~400 字的伪段落。

    为什么要退化切分：单段超长文本若整块送去滑窗，虽然不会崩，
    但段落级报告会退化成一行，失去「哪几段像 AI」的定位能力。
    """
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


# ─────────────────────────── 检测器 ───────────────────────────


class Detector:
    """AIGC 检测器。真实使用流程：Detector().load().calibrate().score_document(text)"""

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL,
        device: str = "cpu",
        ai_index: Optional[int] = None,
        max_tokens: int = MAX_TOKENS,
        dry_run: bool = False,
    ) -> None:
        self.model_id = model_id
        self.device = device
        self.max_tokens = max_tokens
        self.dry_run = dry_run
        self.ai_index: Optional[int] = ai_index
        self.tokenizer = None
        self.model = None
        self.calibration: Optional[dict] = None
        self._torch = None

    # ---- 加载 ----

    def load(self) -> "Detector":
        if self.dry_run:
            self.ai_index = 1 if self.ai_index is None else self.ai_index
            return self
        try:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer
        except ImportError as exc:  # pragma: no cover
            raise SystemExit(
                "缺少依赖：pip install -r requirements.txt（transformers + torch）"
            ) from exc

        self._torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_id)
        # 显式 num_labels=2：zhv3 的 config.json 缺 num_labels，不写会走默认值，
        # 虽然默认也是 2，但显式声明可在换模型时避免静默错配。
        self.model = AutoModelForSequenceClassification.from_pretrained(
            self.model_id, num_labels=2
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

    # ---- 前向 ----

    def _probs_batch(self, id_lists: Sequence[Sequence[int]]) -> List[Tuple[float, float]]:
        """返回每个序列的 (p0, p1)。批次过大时自动切分。"""
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

    def _dry_probs(self, text: str) -> Tuple[float, float]:
        """dry-run 用的确定性伪概率，保证同一文本每次结果一致。"""
        h = int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:8], 16)
        p1 = (h % 10000) / 10000.0
        return 1.0 - p1, p1

    # ---- 窗口规划 ----

    def _windows(self, n_tokens: int) -> List[Tuple[int, int]]:
        """按 token 生成 [start, end) 窗口。

        不变式（由 selftest.test_windows_no_gap 守护）：
          - 每个 token 至少被 1 个窗口覆盖
          - 首尾 token 恰好被覆盖 1 次（否则边缘分数会向窗口内容偏斜）
          - 任何窗口长度 <= max_tokens
          - 尾窗是整窗，不留残片
        """
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

    # ---- 打分 ----

    def _score_text(self, text: str) -> Tuple[float, int]:
        """返回 (AI 概率, 窗口数)。概率为 token 级加权平均。"""
        if not text.strip():
            return 0.0, 0

        if self.dry_run:
            p0, p1 = self._dry_probs(text)
            ai = (p0, p1)[self.ai_index or 0]
            return ai, 1

        ids = self.tokenizer(text, add_special_tokens=False, truncation=False)["input_ids"]
        n = len(ids)
        if n == 0:
            return 0.0, 0

        wins = self._windows(n)
        payload = [
            self.tokenizer.build_inputs_with_special_tokens(ids[s:e]) for s, e in wins
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

    def score_document(self, text: str) -> DocScore:
        paras = split_paragraphs(text)
        if not paras:
            return DocScore(0.0, 0, [], self.ai_index or -1, self.model_id,
                            "dry-run" if self.dry_run else "model")

        segs: List[SegmentScore] = []
        for i, p in enumerate(paras):
            prob, nw = self._score_text(p)
            segs.append(
                SegmentScore(
                    index=i,
                    chars=len(p),
                    ai_prob=round(prob, 4),
                    windows=nw,
                    preview=p[:40].replace("\n", " "),
                )
            )

        total_chars = sum(s.chars for s in segs) or 1
        doc_prob = sum(s.ai_prob * s.chars for s in segs) / total_chars
        return DocScore(
            ai_prob=round(doc_prob, 4),
            chars=len(text),
            segments=segs,
            ai_index=self.ai_index if self.ai_index is not None else -1,
            model=self.model_id,
            mode="dry-run" if self.dry_run else "model",
        )

    # ---- 标签方向标定 ----

    def calibrate(self, verbose: bool = False) -> dict:
        """用 AI 探针组 / 人写探针组判定哪个下标代表 AI。

        判据：比较 index=1 在两组探针上的均值，AI 组更高则 ai_index=1。
        若两组差异小于 0.15，判定为「不可信」，抛错要求人工指定 --ai-label。
        """
        if self.dry_run:
            self.ai_index = self.ai_index if self.ai_index is not None else 1
            self.calibration = {
                "method": "dry-run",
                "ai_index": self.ai_index,
                "gap": None,
                "trusted": True,
            }
            return self.calibration

        if self.model is None:
            self.load()

        def mean_p1(texts: Sequence[str]) -> float:
            payload = [
                self.tokenizer.build_inputs_with_special_tokens(
                    self.tokenizer(t, add_special_tokens=False, truncation=True,
                                   max_length=self.max_tokens)["input_ids"]
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


def _print_report(doc: DocScore, threshold: float) -> None:
    print("=" * 64)
    print("  AIGC 检测报告")
    print("=" * 64)
    print(f"  模型      : {doc.model}")
    print(f"  模式      : {doc.mode}")
    print(f"  标签方向  : ai_index = {doc.ai_index}")
    print(f"  总字数    : {doc.chars}")
    print(f"  段落数    : {len(doc.segments)}")
    print()
    print(f"  全文 AI 概率（字数加权）: {doc.ai_prob * 100:.1f}%  [{_bar(doc.ai_prob)}]")
    print()
    risky = [s for s in doc.segments if s.ai_prob >= threshold]
    print(f"  超过阈值 {threshold:.2f} 的段落: {len(risky)} / {len(doc.segments)}")
    print("-" * 64)
    print(f"  {'#':>3}  {'字数':>5}  {'AI%':>6}  {'窗口':>4}  预览")
    for s in doc.segments:
        flag = "!" if s.ai_prob >= threshold else " "
        print(
            f"  {s.index:>3}  {s.chars:>5}  {s.ai_prob * 100:>5.1f}%{flag} "
            f"{s.windows:>4}    {s.preview}"
        )
    print("=" * 64)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="AIGC 检测器封装（考官）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
        "  python detector.py --calibrate\n"
        "  python detector.py --file samples/ai_sample.txt\n"
        "  python detector.py --text \"待检测文本\" --json\n"
        "  python detector.py --file x.txt --dry-run   # 不加载模型，验证流程\n",
    )
    ap.add_argument("--file", help="待检测文本文件（UTF-8）")
    ap.add_argument("--text", help="直接传入文本")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="HF 模型 id")
    ap.add_argument("--device", default="cpu", help="cpu / cuda")
    ap.add_argument("--ai-label", type=int, choices=(0, 1), help="手动指定 AI 对应的下标")
    ap.add_argument("--calibrate", action="store_true", help="只做标签方向标定")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--dry-run", action="store_true", help="不加载模型，用伪概率跑通流程")
    args = ap.parse_args(argv)

    det = Detector(
        model_id=args.model, device=args.device, ai_index=args.ai_label,
        dry_run=args.dry_run,
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

    doc = det.score_document(text)
    if args.json:
        print(json.dumps(doc.to_dict(), ensure_ascii=False, indent=2))
    else:
        _print_report(doc, args.threshold)
    return 0


if __name__ == "__main__":
    sys.exit(main())
