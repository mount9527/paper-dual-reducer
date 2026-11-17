#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按 doc.json 的语义块输出 AI 疑似占比与贡献度定位。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from detector import DEFAULT_MODEL, DEFAULT_THRESHOLD, Detector  # noqa: E402


def weighted_probability(score: Any) -> float:
    """兼容旧调用的字数加权块得分均值。"""
    total = sum(seg.chars for seg in score.segments)
    if not total:
        return 0.0
    return round(
        sum(seg.ai_prob * seg.chars for seg in score.segments) / total,
        4,
    )


def _block_row(segment: Any, source_rows: list[dict]) -> dict:
    start = max(0, int(segment.pid_span[0]))
    end = min(len(source_rows) - 1, int(segment.pid_span[1]))
    rows = source_rows[start : end + 1] if start <= end else [source_rows[start]]
    pids = [str(row.get("pid")) for row in rows if row.get("pid") is not None]
    unlocked = [row for row in rows if not row.get("locked")]
    focus_row = unlocked[0] if unlocked else (rows[0] if rows else {})
    return {
        "pid": focus_row.get("pid"),
        "pid_span": pids,
        "index": segment.index,
        "chars": segment.chars,
        "locked": bool(rows) and all(bool(row.get("locked")) for row in rows),
        "kind": segment.kind,
        "group": segment.group,
        "ai_prob": segment.ai_prob,
        "contribution": segment.contribution,
        "windows": segment.windows,
        "truncated": segment.truncated,
        "preview": segment.preview,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="按语义块计算 AI 疑似占比")
    ap.add_argument("--doc", required=True, help="inspect_docx.py 生成的 doc.json")
    ap.add_argument("--out", required=True, help="输出 segscore.json")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--ai-label", type=int, choices=(0, 1))
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--fast", action="store_true", help="只跑 400 字粒度")
    ap.add_argument("--calib", help="可选 calib.json 路径")
    ap.add_argument("--plan", help="基础稿 block-plan.json；传入后冻结块边界")
    ap.add_argument("--plan-out", help="输出本稿 block-plan.json")
    args = ap.parse_args(argv)

    doc = json.loads(Path(args.doc).read_text(encoding="utf-8"))
    source_rows = [
        p for p in doc.get("paragraphs", [])
        if str(p.get("text") or "").strip()
    ]
    texts = [str(row.get("text") or "").strip() for row in source_rows]
    locked_flags = [bool(row.get("locked")) for row in source_rows]
    joined = "\n\n".join(texts)
    plan = None
    if args.plan:
        raw_plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
        plan = raw_plan.get("blocks", raw_plan) if isinstance(raw_plan, dict) else raw_plan
        granularity = raw_plan.get("granularity") if isinstance(raw_plan, dict) else None
        if granularity is not None:
            for block in plan:
                block.setdefault("target", granularity)

    det = Detector(
        model_id=args.model,
        device=args.device,
        ai_index=args.ai_label,
        config_path=args.calib,
    ).load()
    if det.ai_index is None:
        det.calibrate(verbose=False)

    score = det.score_document(
        joined,
        fast=args.fast,
        paragraphs=texts,
        locked_flags=locked_flags,
        block_plan=plan,
    )
    threshold = float(args.threshold if args.threshold is not None else score.thr_hi)
    blocks = (
        [_block_row(segment, source_rows) for segment in score.segments]
        if not score.degraded
        else []
    )
    ranked = sorted(
        blocks,
        key=lambda row: (
            float(row.get("contribution") or 0.0),
            float(row.get("ai_prob") or 0.0) * int(row.get("chars") or 0),
        ),
        reverse=True,
    )
    top = [
        row for row in ranked
        if row["group"] == "rewritable"
        and not row["locked"]
        and float(row["ai_prob"]) >= threshold
    ][:20]
    body = score.group_stats.get("rewritable", {})
    table = score.group_stats.get("table", {})
    reference = score.group_stats.get("reference", {})
    data = {
        "schema": "paper-dual-reduce/segscore@3",
        "ai_share": score.ai_share,
        "ai_share_hard": score.ai_share_hard,
        "median_prob": score.median_prob,
        "band": score.band,
        "stability": score.stability,
        "thr_hi": score.thr_hi,
        "thr_hard": score.thr_hard,
        "calibrated": score.calibrated,
        "degraded": score.degraded,
        "mean_prob": score.mean_prob,
        "ai_prob": score.ai_prob,
        "granularity": score.granularity,
        "config_version": score.config_version,
        "chars": score.chars,
        "detectable_chars": score.detectable_chars,
        "coverage": score.coverage,
        "body_chars": score.body_chars,
        "table_chars": score.table_chars,
        "reference_chars": score.reference_chars,
        "excluded_chars": score.excluded_chars,
        "all_ai_share": score.all_ai_share,
        "table_ai_share": score.table_ai_share,
        "reference_ai_share": score.reference_ai_share,
        "group_stats": score.group_stats,
        "comparison_mode": score.comparison_mode,
        "block_plan": score.block_plan,
        "threshold": threshold,
        "model": args.model,
        "mode": "model",
        "paragraphs": blocks,
        "segments": blocks,
        "top": top,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.plan_out:
        plan_out = Path(args.plan_out)
        plan_out.parent.mkdir(parents=True, exist_ok=True)
        plan_out.write_text(json.dumps({
            "schema": "paper-dual-reduce/block-plan@1",
            "source": str(Path(args.doc).resolve()),
            "granularity": score.granularity,
            "blocks": score.block_plan,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        "[segscore] %s ｜ 正文 AI 疑似占比 %.1f%% ｜ 表格 %s ｜ 参考文献 %s ｜ %d 块"
        % (
            data["comparison_mode"],
            data["ai_share"] * 100,
            "—" if score.table_ai_share is None else f"{score.table_ai_share * 100:.1f}%",
            "—" if score.reference_chars == 0 or score.reference_ai_share is None
            else f"{score.reference_ai_share * 100:.1f}%",
            len(blocks),
        )
    )
    if data["degraded"]:
        print("[segscore] 可用块不足 3 个，已退化整篇单块打分，不输出定位")
    print("[segscore] 已写出 %s" % out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
