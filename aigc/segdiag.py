#!/usr/bin/env python3
"""segdiag.py —— 逐段跑 diag，找出「带具体痕迹」的段落。

为什么需要它：diag.py 给的是全篇 9 维统计，但改写是按段落做的。
不逐段定位，就会出现「全篇说口语词超标，改的却是另外 16 段」——
改完指标一点不动。这里的输出直接给 plan.py 的 --include 用。

用法
----
    python segdiag.py --doc out/doc.json --out out/segdiag.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import diag  # noqa: E402

MIN_CHARS = 10  # 门禁类痕迹（口语词/破折号）经常就藏在短句里，阈值不能高


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="逐段痕迹定位（给定向改写选段用）")
    ap.add_argument("--doc", required=True, help="doc.json")
    ap.add_argument("--out", required=True, help="输出 segdiag.json")
    ap.add_argument("--min-chars", type=int, default=MIN_CHARS)
    args = ap.parse_args(argv)

    doc = json.loads(Path(args.doc).read_text(encoding="utf-8"))
    hits = []
    for p in doc.get("paragraphs", []):
        if p.get("locked"):
            continue
        text = (p.get("text") or "").strip()
        if len(text) < args.min_chars:
            continue
        r = diag.diagnose(text).to_dict()
        tags = []
        if r["colloquial"]["gate_failed"]:
            tags.append("colloquial")
        if r["dash"]["gate_failed"]:
            tags.append("dash")
        if r["colon"]["risk"]:
            tags.append("colon")
        if r["nested"]["risk"]:
            tags.append("nested")
        if r["template"]["risk"]:
            tags.append("template")
        if r["passive"]["risk"]:
            tags.append("passive")
        if r["symmetry"]["risk"]:
            tags.append("symmetry")
        if tags:
            hits.append({
                "pid": p["pid"],
                "tags": tags,
                "risk_score": r["risk_score"],
                "risk_count": r["risk_count"],
                "style_gate": r["style_gate_passed"],
                "chars": len(text),
            })

    # 优先：命中的痕迹种类多 → 风险分高 → 段落更长（同样一条痕迹，长段收益更大）
    hits.sort(key=lambda x: (-len(x["tags"]), -x["risk_score"], -x["chars"]))
    data = {"schema": "paper-dual-reduce/segdiag@1", "paragraphs": hits}
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    print("[segdiag] 带痕迹段落 %d 条" % len(hits))
    for x in hits[:8]:
        print("  %s %s risk=%d chars=%d" % (x["pid"], ",".join(x["tags"]), x["risk_score"], x["chars"]))
    print("[segdiag] 已写出 %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
