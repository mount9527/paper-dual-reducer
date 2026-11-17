#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把论文正文切成稳定的语义块，再送给 512 token 检测器。

本模块只做文本切分，不接触模型。默认粒度是 400 字、硬上限 480 字；
三粒度稳定性检查可显式传入 300 / 400 / 600，并在需要时放宽硬上限。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List, Sequence, Tuple

SourceRange = Tuple[int, float, float]


@dataclass(frozen=True)
class Block:
    index: int
    text: str
    chars: int
    kind: str
    pid_span: Tuple[int, int]
    truncated: bool = False
    source_ranges: Tuple[SourceRange, ...] = ()
    group: str = "rewritable"


def _meaningful_chars(text: str) -> int:
    return len(re.sub(r"\s+", "", text or ""))


def backmatter_start(paragraphs: Sequence[str]) -> int:
    """返回参考文献/附录起点；找不到时返回段落总数。"""
    for index, raw in enumerate(paragraphs):
        text = (raw or "").strip()
        low = text.lower()
        if re.match(r"^(?:\d+(?:\.\d+)*\s*)?(参考文献|references)\s*[:：]?$", low):
            return index
        if re.match(r"^(?:\d+(?:\.\d+)*\s*)?(附录|appendix)(?:\s|$|[A-Za-z0-9一二三四五六七八九十])", low):
            return index
    return len(paragraphs)


def _is_meta_note(text: str) -> bool:
    return bool(re.match(r"^(处理说明|改写说明|操作说明)\s*[:：]", (text or "").strip()))


def _fallback_paragraphs(text: str) -> List[str]:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paras) == 1 and len(paras[0]) > 800:
        sentences = re.split(r"(?<=[。！？；])", paras[0])
        out: List[str] = []
        buf = ""
        for sentence in sentences:
            if len(buf) + len(sentence) > 400 and buf:
                out.append(buf)
                buf = sentence
            else:
                buf += sentence
        if buf:
            out.append(buf)
        return [p.strip() for p in out if p.strip()]
    return paras


def _looks_like_table(texts: Sequence[str]) -> bool:
    merged = "\n".join(texts)
    return len(re.findall(r"\d", merged)) >= 2 or "\t" in merged


def _split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[。！？；!?;])", text)
    return [p for p in (part.strip() for part in parts) if p]


def _split_long_piece(text: str, hard_max: int) -> List[str]:
    if len(text) <= hard_max:
        return [text]
    clauses = re.split(r"(?<=[，,：:])", text)
    pieces: List[str] = []
    buf = ""
    for clause in clauses:
        if len(clause) > hard_max:
            if buf:
                pieces.append(buf)
                buf = ""
            pieces.extend(
                clause[i : i + hard_max]
                for i in range(0, len(clause), hard_max)
            )
            continue
        if buf and len(buf) + len(clause) > hard_max:
            pieces.append(buf)
            buf = clause
        else:
            buf += clause
    if buf:
        pieces.append(buf)
    return pieces


def _paragraph_pieces(text: str, hard_max: int) -> List[str]:
    out: List[str] = []
    for sentence in _split_sentences(text):
        out.extend(_split_long_piece(sentence, hard_max))
    return out


def _paragraph_pieces_with_ranges(
    text: str, hard_max: int,
) -> List[Tuple[str, float, float]]:
    """返回片段及其在原文中的相对区间，供后续版本复用同一块。"""
    out: List[Tuple[str, float, float]] = []
    total = max(1, len(text))
    cursor = 0
    for piece in _paragraph_pieces(text, hard_max):
        start = text.find(piece, cursor)
        if start < 0:
            start = cursor
        end = min(total, start + len(piece))
        out.append((piece, start / total, end / total))
        cursor = end
    return out


def split_blocks(
    text: str,
    target: int = 400,
    hard_max: int = 480,
    min_para: int = 40,
    min_block: int = 200,
    paragraphs: Sequence[str] | None = None,
    break_before_indices: Iterable[int] | None = None,
) -> List[Block]:
    """按 R1-R7 切块。

    paragraphs 可传入上游已经解析好的段落序列，用于保持 pid 与原
    doc.json 的顺序一致。没有传时，本函数按空行自行切段。
    """
    target = max(1, int(target))
    hard_max = max(target, int(hard_max))
    min_para = max(1, int(min_para))
    min_block = max(1, int(min_block))
    paras = list(paragraphs) if paragraphs is not None else _fallback_paragraphs(text)
    if not paras:
        return []

    pids = list(range(len(paras)))
    breaks = set(int(i) for i in (break_before_indices or ()))
    # units: body 单元保存普通段；table 单元已合并连续碎片。
    units: List[dict] = []
    pending_frag: List[Tuple[int, str]] = []
    i = 0
    while i < len(paras):
        para = paras[i].strip()
        if _meaningful_chars(para) < min_para:
            run: List[Tuple[int, str]] = []
            j = i
            while j < len(paras) and _meaningful_chars(paras[j]) < min_para:
                run.append((pids[j], paras[j].strip()))
                j += 1
            if len(run) >= 3 and _looks_like_table([p[1] for p in run]):
                if pending_frag:
                    if units and units[-1]["kind"] == "body":
                        units[-1]["parts"].extend(pending_frag)
                    else:
                        run = pending_frag + run
                    pending_frag = []
                merged = "\n".join(p[1] for p in run)
                truncated = len(merged) > hard_max
                if truncated:
                    merged = merged[:hard_max]
                units.append({
                    "kind": "table",
                    "parts": [(p[0], p[1]) for p in run],
                    "text": merged,
                    "truncated": truncated,
                })
                i = j
                continue
            pending_frag.extend(run)
            i = j
            continue

        if pending_frag:
            units.append({
                "kind": "body",
                "parts": pending_frag + [(pids[i], para)],
            })
            pending_frag = []
        else:
            units.append({"kind": "body", "parts": [(pids[i], para)]})
        i += 1

    if pending_frag:
        if units and units[-1]["kind"] == "body":
            units[-1]["parts"].extend(pending_frag)
        elif units:
            units[-1]["text"] = units[-1]["text"] + "\n" + "\n".join(p[1] for p in pending_frag)
        else:
            units.append({"kind": "body", "parts": pending_frag})

    blocks: List[Block] = []
    current_parts: List[str] = []
    current_pids: List[int] = []
    current_ranges: List[SourceRange] = []
    current_chars = 0

    def flush_body() -> None:
        nonlocal current_parts, current_pids, current_ranges, current_chars
        if not current_parts:
            return
        body = "\n".join(current_parts).strip()
        chars = _meaningful_chars(body)
        if chars >= min_block:
            blocks.append(Block(
                index=len(blocks),
                text=body,
                chars=chars,
                kind="body",
                pid_span=(min(current_pids), max(current_pids)),
                source_ranges=tuple(current_ranges),
            ))
        current_parts = []
        current_pids = []
        current_ranges = []
        current_chars = 0

    for unit in units:
        if unit["kind"] == "table":
            flush_body()
            table_text = str(unit["text"])
            blocks.append(Block(
                index=len(blocks),
                text=table_text,
                chars=_meaningful_chars(table_text),
                kind="table",
                pid_span=(min(p[0] for p in unit["parts"]), max(p[0] for p in unit["parts"])),
                truncated=bool(unit["truncated"]),
                source_ranges=tuple((p[0], 0.0, 1.0) for p in unit["parts"]),
            ))
            continue

        for pid, para in unit["parts"]:
            if pid in breaks:
                flush_body()
            for piece, start, end in _paragraph_pieces_with_ranges(para, hard_max):
                piece_chars = _meaningful_chars(piece)
                if current_parts and current_chars + piece_chars > hard_max:
                    flush_body()
                if not current_parts:
                    current_pids = []
                    current_ranges = []
                current_parts.append(piece)
                current_pids.append(pid)
                current_ranges.append((pid, start, end))
                current_chars += piece_chars
    flush_body()

    # R6：正文残片不足 min_block 时丢弃。优先与前一块合并；合不上才丢弃。
    compact: List[Block] = []
    for block in blocks:
        if block.kind == "body" and block.chars < min_block:
            if compact and compact[-1].kind == "body":
                prev = compact[-1]
                merged = f"{prev.text}\n{block.text}".strip()
                crosses_break = any(
                    prev.pid_span[0] < boundary <= block.pid_span[1]
                    for boundary in breaks
                )
                if _meaningful_chars(merged) <= hard_max and not crosses_break:
                    compact[-1] = Block(
                        index=len(compact) - 1,
                        text=merged,
                        chars=_meaningful_chars(merged),
                        kind="body",
                        pid_span=(prev.pid_span[0], block.pid_span[1]),
                        truncated=prev.truncated or block.truncated,
                        source_ranges=prev.source_ranges + block.source_ranges,
                    )
                    continue
            continue
        compact.append(Block(
            index=len(compact),
            text=block.text,
            chars=block.chars,
            kind=block.kind,
            pid_span=block.pid_span,
            truncated=block.truncated,
            source_ranges=block.source_ranges,
            group=block.group,
        ))
    return compact


def classify_blocks(
    blocks: Sequence[Block],
    paragraphs: Sequence[str],
    locked_flags: Sequence[bool] | None = None,
) -> List[Block]:
    """把块分为可改写正文、表格、参考文献/附录、排除区。"""
    start = backmatter_start(paragraphs)
    locked = list(locked_flags) if locked_flags is not None else []
    out: List[Block] = []
    for block in blocks:
        pids = sorted({pid for pid, _, _ in block.source_ranges}) or list(
            range(block.pid_span[0], block.pid_span[1] + 1)
        )
        if block.kind == "table":
            group = "table"
        elif start < len(paragraphs) and min(pids) >= start:
            group = "reference"
        elif locked and all(
            (index < len(locked) and locked[index]) or _is_meta_note(paragraphs[index])
            for index in pids if index < len(paragraphs)
        ):
            group = "excluded"
        else:
            group = "rewritable"
        out.append(Block(
            index=block.index,
            text=block.text,
            chars=block.chars,
            kind=block.kind,
            pid_span=block.pid_span,
            truncated=block.truncated,
            source_ranges=block.source_ranges,
            group=group,
        ))
    return out


def plan_from_blocks(blocks: Sequence[Block]) -> List[dict]:
    return [
        {
            "index": block.index,
            "kind": block.kind,
            "pid_span": list(block.pid_span),
            "source_ranges": [list(source) for source in block.source_ranges],
            "truncated": block.truncated,
            "group": block.group,
        }
        for block in blocks
    ]


def apply_block_plan(
    paragraphs: Sequence[str],
    plan: Sequence[dict],
    hard_max: int = 480,
) -> List[Block]:
    """用原稿块计划重建新版本文本；pid 和块边界保持冻结。"""
    out: List[Block] = []
    for index, row in enumerate(plan):
        pieces: List[str] = []
        ranges: List[SourceRange] = []
        raw_ranges = row.get("source_ranges") or []
        if not raw_ranges:
            span = row.get("pid_span") or [0, 0]
            raw_ranges = [[int(span[0]) + i, 0.0, 1.0]
                          for i in range(max(1, int(span[1]) - int(span[0]) + 1))]
        for raw in raw_ranges:
            pid = int(raw[0])
            if pid < 0 or pid >= len(paragraphs):
                continue
            start_ratio = max(0.0, min(1.0, float(raw[1])))
            end_ratio = max(start_ratio, min(1.0, float(raw[2])))
            text = paragraphs[pid]
            start = min(len(text), int(round(start_ratio * len(text))))
            end = min(len(text), int(round(end_ratio * len(text))))
            if end <= start < len(text):
                end = start + 1
            piece = text[start:end].strip()
            if piece:
                pieces.append(piece)
                ranges.append((pid, start_ratio, end_ratio))
        text = "\n".join(pieces).strip()
        if not text:
            continue
        truncated = bool(row.get("truncated"))
        if len(text) > hard_max:
            text = text[:hard_max]
            truncated = True
        pids = [pid for pid, _, _ in ranges] or [
            int((row.get("pid_span") or [0, 0])[0])
        ]
        out.append(Block(
            index=len(out),
            text=text,
            chars=_meaningful_chars(text),
            kind=str(row.get("kind") or "body"),
            pid_span=(min(pids), max(pids)),
            truncated=truncated,
            source_ranges=tuple(ranges),
            group=str(row.get("group") or "rewritable"),
        ))
    return out


def coverage(blocks: Sequence[Block], text: str) -> float:
    """块字数占非空白正文的比例，正常应不低于 0.85。"""
    total = _meaningful_chars(text)
    if not total:
        return 1.0
    covered = sum(max(0, block.chars) for block in blocks)
    return min(1.0, covered / total)
