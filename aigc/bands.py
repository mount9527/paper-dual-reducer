#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""加载零语料 AIGC 配置并计算 AI 疑似占比档位。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = HERE / "calib.json"

FALLBACK_CONFIG: dict[str, Any] = {
    "version": "fallback",
    "genre": "undergraduate_thesis",
    "calibrated": False,
    "thr_hi": 0.50,
    "thr_hard": 0.85,
    "band": {"safe_max": 0.15, "warn_max": 0.30},
    "basis": {
        "thr_hi": "runtime_fallback",
        "band": "university_policy, 15pct_most_strict, 30pct_mode",
    },
    "n_docs_human": 0,
    "n_chunks_human": 0,
}


def _valid_config(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    try:
        thr_hi = float(raw["thr_hi"])
        thr_hard = float(raw["thr_hard"])
        safe_max = float(raw["band"]["safe_max"])
        warn_max = float(raw["band"]["warn_max"])
    except (KeyError, TypeError, ValueError):
        return False
    return (
        0.0 <= thr_hi <= 1.0
        and 0.0 <= thr_hard <= 1.0
        and 0.0 <= safe_max < warn_max <= 1.0
    )


def load(path: str | Path | None = None) -> dict[str, Any]:
    """读取 calib.json；缺失或损坏时使用规格规定的运行时回退值。"""
    source = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return json.loads(json.dumps(FALLBACK_CONFIG))
    if not _valid_config(raw):
        return json.loads(json.dumps(FALLBACK_CONFIG))
    raw["calibrated"] = bool(raw.get("calibrated", False))
    raw["thr_hi"] = float(raw["thr_hi"])
    raw["thr_hard"] = float(raw["thr_hard"])
    raw["band"] = {
        **raw.get("band", {}),
        "safe_max": float(raw["band"]["safe_max"]),
        "warn_max": float(raw["band"]["warn_max"]),
    }
    raw["source"] = str(source)
    return raw


def band_of(ai_share: float, config: dict[str, Any]) -> str:
    value = max(0.0, min(1.0, float(ai_share)))
    safe_max = float(config["band"]["safe_max"])
    warn_max = float(config["band"]["warn_max"])
    if value < safe_max:
        return "safe"
    if value < warn_max:
        return "warn"
    return "risk"


def band_label(band: str) -> str:
    return {
        "safe": "AI 特征不明显",
        "warn": "存在 AI 特征段落",
        "risk": "AI 特征显著",
    }.get(band, "未判档")
