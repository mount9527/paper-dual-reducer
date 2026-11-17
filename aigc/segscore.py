#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按 doc.json 的段落逐段打 AIGC 分，供定向改写和自动闭环选段。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from detector import DEFAULT_MODEL, DEFAULT_THRESHOLD, Detector  # noqa: E402


def weighted_probability(score) -> float:
    total = sum(seg.chars for seg in score.segments)
    if not total:
        return 0.0
    return round(
        sum(seg.ai_prob * seg.chars for seg in score.segments) / total,
        4,
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="逐段 AIGC 打分")
    ap.add_argument("--doc", required=True, help="inspect_docx.py 生成的 doc.json")
    ap.add_argument("--out", required=True, help="输出 segscore.json")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--ai-label", type=int, choices=(0, 1))
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    args = ap.parse_args(argv)

    doc = json.loads(Path(args.doc).read_text(encoding="utf-8"))
    rows = [
        p for p in doc.get("paragraphs", [])
        if str(p.get("text") or "").strip()
    ]

    det = Detector(
        model_id=args.model,
        device=args.device,
        ai_index=args.ai_label,
    ).load()
    if det.ai_index is None:
        det.calibrate(verbose=False)

    paragraphs = []
    for index, row in enumerate(rows):
        text = str(row.get("text") or "").strip()
        score = det.score_document(text)
        paragraphs.append({
            "pid": row.get("pid"),
            "index": index,
            "chars": len(text),
            "locked": bool(row.get("locked")),
            "ai_prob": weighted_probability(score),
            "preview": text[:48],
        })

    total_chars = sum(p["chars"] for p in paragraphs) or 1
    doc_prob = sum(p["ai_prob"] * p["chars"] for p in paragraphs) / total_chars
    ranked = sorted(paragraphs, key=lambda p: p["ai_prob"], reverse=True)
    data = {
        "schema": "paper-dual-reduce/segscore@1",
        "ai_prob": round(doc_prob, 4),
        "chars": total_chars,
        "threshold": args.threshold,
        "model": args.model,
        "mode": "model",
        "paragraphs": paragraphs,
        "top": [
            p for p in ranked
            if not p["locked"] and p["ai_prob"] >= args.threshold
        ][:20],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        "[segscore] %s ｜ %.4f ｜ %d 段 ｜ 超阈值 %d"
        % (data["mode"], data["ai_prob"], len(paragraphs), len(data["top"]))
    )
    print("[segscore] 已写出 %s" % out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
