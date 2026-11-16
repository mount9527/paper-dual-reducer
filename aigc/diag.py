#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diag.py —— 规则诊断器：9 维 AI 痕迹扫描

纯正则 + 统计，无模型依赖，可离线跑、可单测、结果完全可复现。
它是改写阶段的「作业清单」来源：告诉改写器哪里该动、动到什么程度。

规则与阈值的来源：
  - 模板句式、被动语态、口语负面清单：参考 xiaofenggan01/aigc-reduce (MIT)
  - 硬约束阈值（高频词密度、三元并列、泛化结尾等）：参考
    redbaronyyyyy-eng/humanizer-zh-academic (MIT)
本文件为重新实现，非逐行复制。

九维中最后两维（口语化、破折号）不是 AI 痕迹，而是「改写过度」的语体门禁：
命中即代表把论文改成了大白话，必须回滚。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Sequence

# ─────────────── 规则表 ───────────────

TEMPLATE_PATTERNS: List[str] = [
    r"^综上所述[，,]",
    r"^基于.{2,10}(分析|研究|探讨|理论)",
    r"^通过.{2,15}(验证|实验|研究|测定)",
    r"^随着.{2,20}(发展|进步|深入|普及)",
    r"^近年来[，,]",
    r"^在.{2,20}(背景下|条件下|过程中)",
    r"^(目前|当前)[，,]",
    r"^(因此|由此可见|总而言之|总的来说)[，,]",
    r"(此外|另外|与此同时|值得注意的是|需要指出的是)[，,]",
    r"(据统计|相关研究表明|一般认为|业内普遍认为)[，,]",
    r"具有(重要|深远)的.{2,10}(意义|价值|作用)",
    r"具有广阔的应用前景",
    r"为.{2,20}(提供了|奠定了).{2,10}(基础|依据|参考|新思路)",
    r"(不是[^。！？\n]{1,40}而是)",
    r"(但至少|不代表|不等于)",
]

PASSIVE_MARKERS: List[str] = [
    r"被.{1,15}(测定|检测|验证|确认|证明|发现|计算|认为)",
    r"由.{1,15}(进行|完成|测定|检测|计算)",
    r"经.{1,15}(测定|检测|计算|分析)",
    r"通过.{1,15}(测定|检测|验证|实验|计算)",
]

# 口语 / 网络用语负面清单：命中即判定语体破坏，属门禁而非优化项
COLLOQUIAL_TERMS: List[str] = [
    "yyds", "绝绝子", "破防", "拿捏", "整活", "无语", "离谱", "逆天",
    "炸裂", "社死", "摆烂", "搞定", "踩坑", "翻车", "封神", "硬核",
    "谁懂啊", "手感", "气死", "乐死", "笑死", "烦躁", "郁闷",
    "说实话", "坦白讲", "老实说", "说白了", "讲真", "反正", "说到底",
    "这事儿", "一点一点磨出来", "撑起来", "拉满", "没跑偏", "大概齐",
]

EM_DASH = "——"

# 阈值（集中在这里改，不要在函数里写魔法数）
LIMITS: Dict[str, float] = {
    "template_count": 3.0,       # 命中 > 3 处判偏高
    "passive_per_sentence": 0.30,
    "cv_mid": 0.35,              # 句子长度变异系数
    "cv_high": 0.25,
    "commas_per_sentence": 2.5,
    "nested_numbers": 3,
    "colon_lists": 1,
    "dash_per_para": 1,
}


# ─────────────── 切分工具 ───────────────


def split_paragraphs(text: str) -> List[str]:
    text = text.replace("\r\n", "\n").strip()
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def split_sentences(text: str) -> List[str]:
    parts = re.split(r"[。！？!?\n]|(?<!\d)\.(?!\d)", text)
    return [s.strip() for s in parts if s.strip() and len(s.strip()) > 5]


# ─────────────── 各项指标 ───────────────


def template_density(text: str) -> dict:
    hits: List[str] = []
    for pat in TEMPLATE_PATTERNS:
        for m in re.finditer(pat, text, re.MULTILINE):
            hits.append(m.group(0))
    density = len(hits) / max(len(text), 1) * 1000
    return {
        "count": len(hits),
        "per_1000_chars": round(density, 2),
        "examples": hits[:8],
        "risk": len(hits) > LIMITS["template_count"],
    }


def passive_ratio(text: str) -> dict:
    n = sum(len(re.findall(p, text)) for p in PASSIVE_MARKERS)
    sents = max(len(split_sentences(text)), 1)
    per = n / sents
    return {
        "count": n,
        "per_sentence": round(per, 3),
        "risk": per > LIMITS["passive_per_sentence"],
    }


def burstiness(paragraphs: Sequence[str]) -> dict:
    """句子长度变异系数 CV = std / mean。AI 文本通常 CV < 0.3。"""
    lens = [len(s) for p in paragraphs for s in split_sentences(p)]
    if len(lens) < 3:
        return {"avg": 0, "std": 0, "cv": None, "risk": False, "note": "句子不足"}
    avg = sum(lens) / len(lens)
    var = sum((x - avg) ** 2 for x in lens) / len(lens)
    std = var ** 0.5
    cv = std / max(avg, 1)
    risk = cv < LIMITS["cv_mid"]
    level = "high" if cv < LIMITS["cv_high"] else ("mid" if risk else "low")
    return {
        "avg": round(avg, 1),
        "std": round(std, 1),
        "cv": round(cv, 3),
        "level": level,
        "risk": risk,
    }


def para_symmetry(paragraphs: Sequence[str]) -> dict:
    """连续 3 段以上长度偏差 < 20% 视为对称段落组。"""
    lens = [len(p) for p in paragraphs]
    if len(lens) < 3:
        return {"runs": [], "risk": False}
    runs: List[int] = []
    cur = 0
    for i in range(1, len(lens)):
        dev = abs(lens[i] - lens[i - 1]) / max(lens[i - 1], 1)
        if dev < 0.2:
            cur += 1
        else:
            if cur >= 2:
                runs.append(cur + 1)
            cur = 0
    if cur >= 2:
        runs.append(cur + 1)
    return {"runs": runs, "risk": bool(runs)}


def nested_numbers(text: str) -> dict:
    n = len(re.findall(r"[（(]\s*\d+\s*[）)]", text))
    return {"count": n, "risk": n > LIMITS["nested_numbers"]}


def colon_lists(text: str) -> dict:
    n = len(re.findall(r"[：:]\s*.+?[；;]\s*.+?[；;]", text))
    return {"count": n, "risk": n > LIMITS["colon_lists"]}


def punctuation(text: str) -> dict:
    commas = text.count("，") + text.count(",")
    sents = max(len(split_sentences(text)), 1)
    per = commas / sents
    return {"commas_per_sentence": round(per, 2), "risk": per > LIMITS["commas_per_sentence"]}


def colloquial(text: str) -> dict:
    hits: List[str] = []
    for t in COLLOQUIAL_TERMS:
        hits.extend([t] * text.count(t))
    return {"count": len(hits), "terms": sorted(set(hits)), "gate_failed": bool(hits)}


def dash_density(paragraphs: Sequence[str]) -> dict:
    over, total = 0, 0
    for p in paragraphs:
        n = p.count(EM_DASH)
        total += n
        if n > LIMITS["dash_per_para"]:
            over += 1
    return {"total": total, "over_limit_paras": over, "gate_failed": over > 0}


# ─────────────── 汇总 ───────────────


@dataclass
class DiagResult:
    chars: int
    paragraphs: int
    sentences: int
    template: dict
    passive: dict
    burstiness: dict
    symmetry: dict
    nested: dict
    colon: dict
    punct: dict
    colloquial: dict
    dash: dict
    risk_count: int = 0
    risk_score: int = 0
    level: str = "low"
    style_gate_passed: bool = True
    todo: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def diagnose(text: str) -> DiagResult:
    paras = split_paragraphs(text) or [text]
    sents = split_sentences(text)

    r = DiagResult(
        chars=len(text),
        paragraphs=len(paras),
        sentences=len(sents),
        template=template_density(text),
        passive=passive_ratio(text),
        burstiness=burstiness(paras),
        symmetry=para_symmetry(paras),
        nested=nested_numbers(text),
        colon=colon_lists(text),
        punct=punctuation(text),
        colloquial=colloquial(text),
        dash=dash_density(paras),
    )

    risk_dims = [
        r.template["risk"],
        r.passive["risk"],
        r.burstiness.get("risk", False),
        r.symmetry["risk"],
        r.nested["risk"],
        r.colon["risk"],
        r.punct["risk"],
    ]
    r.risk_count = sum(1 for x in risk_dims if x)
    # 模板句式是各平台权重最高的维度（知网主打语义指纹与格式规范性），
    # 单维度命中时不足以判 high，但也不该和其他维度等权归入 low。
    r.risk_score = sum(2 if x else 0 for x in risk_dims[:1]) + sum(
        1 for x in risk_dims[1:] if x
    )
    r.level = "high" if r.risk_score >= 5 else ("mid" if r.risk_score >= 2 else "low")
    r.style_gate_passed = not (r.colloquial["gate_failed"] or r.dash["gate_failed"])

    # 生成改写作业清单，顺序即优先级
    if r.template["risk"]:
        r.todo.append("删除/改写句首模板与套话（模板句 %d 处）" % r.template["count"])
    if r.burstiness.get("risk"):
        r.todo.append("节奏工程：长句拆分、长短交错，目标 CV≈0.45（当前 %s）" % r.burstiness.get("cv"))
    if r.symmetry["risk"]:
        r.todo.append("打破对称段长（连续 %s 段长度相近）" % r.symmetry["runs"])
    if r.passive["risk"]:
        r.todo.append("被动改主动（保留方法学合规被动）")
    if r.colon["risk"] or r.nested["risk"]:
        r.todo.append("拆解冒号并列 / 嵌套编号，改为叙述式")
    if r.punct["risk"]:
        r.todo.append("断句，降低逗号密度")
    if r.colloquial["gate_failed"]:
        r.todo.append("【门禁】删除口语词：%s" % ", ".join(r.colloquial["terms"]))
    if r.dash["gate_failed"]:
        r.todo.append("【门禁】破折号超限 %d 段，改逗号或括号" % r.dash["over_limit_paras"])
    return r


def _print(r: DiagResult) -> None:
    g = lambda b: "FAIL" if b else "ok  "
    print("=" * 60)
    print("  9 维 AI 痕迹诊断")
    print("=" * 60)
    print(f"  {r.chars} 字 / {r.paragraphs} 段 / {r.sentences} 句")
    print(f"  综合风险: {r.level.upper()}   触发维度: {r.risk_count}/7（加权分 {r.risk_score}）")
    print(f"  语体门禁: {'PASS' if r.style_gate_passed else 'FAIL'}")
    print("-" * 60)
    print(f"  [1] 模板句式      {r.template['count']:>3} 处  {r.template['per_1000_chars']}/千字  {g(r.template['risk'])}")
    print(f"  [2] 被动语态      {r.passive['count']:>3} 处  {r.passive['per_sentence']}/句  {g(r.passive['risk'])}")
    print(f"  [3] 句长 CV       {str(r.burstiness.get('cv')):>6}  {g(r.burstiness.get('risk'))}")
    print(f"  [4] 段落对称      {len(r.symmetry['runs'])} 组  {g(r.symmetry['risk'])}")
    print(f"  [5] 嵌套编号      {r.nested['count']:>3} 处  {g(r.nested['risk'])}")
    print(f"  [6] 冒号并列      {r.colon['count']:>3} 处  {g(r.colon['risk'])}")
    print(f"  [7] 逗号密度      {r.punct['commas_per_sentence']:>6}/句  {g(r.punct['risk'])}")
    print(f"  [8] 口语词        {r.colloquial['count']:>3} 处  {g(r.colloquial['gate_failed'])}  <- 门禁")
    print(f"  [9] 破折号超限    {r.dash['over_limit_paras']:>3} 段  {g(r.dash['gate_failed'])}  <- 门禁")
    if r.todo:
        print("-" * 60)
        print("  作业清单（按优先级）:")
        for i, t in enumerate(r.todo, 1):
            print(f"    {i}. {t}")
    print("=" * 60)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="9 维 AI 痕迹诊断")
    ap.add_argument("--file", help="文本文件")
    ap.add_argument("--text", help="直接传文本")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    elif args.text:
        text = args.text
    else:
        ap.print_help()
        return 2

    r = diagnose(text)
    print(json.dumps(r.to_dict(), ensure_ascii=False, indent=2) if args.json else "")
    if not args.json:
        _print(r)
    return 0 if r.style_gate_passed else 1


if __name__ == "__main__":
    sys.exit(main())
