# SPEC · AIGC 分数口径 v3.1 / 插件 v0.8.0

v0.8.0 在 v3 的 A/B 两层上补齐三个工程约束：版本比较冻结基础稿块边界；正文、表格、参考文献分账；AIGC/双降回填强制模型复检。仍不包含语料拟合，不承诺与任何商业平台对齐。

## 1. 目标与主指标

输入一篇中文学术论文，输出：

- `ai_share`：**可改写正文块**中得分不低于 `thr_hi` 的字数 ÷ 可改写正文字数，作为主指标；
- `all_ai_share`：全部块（正文 + 表格 + 参考文献 + 排除区）的同口径占比；
- `table_ai_share` / `reference_ai_share`：表格与参考文献/附录分项；
- `ai_share_hard`：块得分不低于 `thr_hard` 的字数占比；
- `median_prob`：按块字数展开后的加权中位数；
- `band`：`safe / warn / risk`；
- `stability`：300 / 400 / 600 三种粒度下 `ai_share` 的极差；
- 每块来源、块分和贡献度，用于定位高风险段落。

旧字段 `ai_prob` 保留，但值恒等于 `mean_prob`，只用于读取历史记录，不再作为改写前后优劣判据。

## 2. 切块契约

新增 `aigc/blocking.py`，导出：

```python
Block(index, text, chars, kind, pid_span, truncated=False,
      source_ranges=(), group='rewritable')
split_blocks(text, target=400, hard_max=480, min_para=40, min_block=200,
             paragraphs=None, break_before_indices=None)
classify_blocks(blocks, paragraphs, locked_flags=None)
plan_from_blocks(blocks)
apply_block_plan(paragraphs, plan, hard_max=480)
coverage(blocks, text)
```

规则：

1. 复用已解析段落顺序，`pid_span` 指向原段落区间；
2. 少于 40 字的段落不独立打分；
3. 连续 3 条以上碎片，且含至少 2 个数字或制表符时，合并为 `table`；超过硬上限时截断并设 `truncated=True`；
4. 其余碎片优先并入后一个正文块，末段并入前一个正文块；
5. 正文按 300–480 字聚合，尽量在句号、分号处断开；
6. 正文块不足 200 字不进入分母；
7. 可用块少于 3 个时，整篇单块打分，`degraded=True`，不输出块级定位。
8. `source_ranges` 记录 `(pid, start_ratio, end_ratio)`，用于新版本文本重建；
9. 参考文献/附录起点强制断块；分组为 `rewritable / table / reference / excluded`。

默认粒度：`target=400, hard_max=480`。三粒度复算时，600 字粒度允许使用 600 字硬上限。

## 3. 聚合与档位

设块集合为 B，块字数为 `c_i`，块模型输出为 `p_i`：

```text
ai_share      = body Σ c_i · [p_i >= thr_hi]   / body Σ c_i
ai_share_hard = body Σ c_i · [p_i >= thr_hard] / body Σ c_i
all_ai_share  = all  Σ c_i · [p_i >= thr_hi]   / all  Σ c_i
mean_prob     = Σ c_i · p_i               / Σ c_i
median_prob   = weighted_median(p_i, c_i)
```

原文主指标取三种切分粒度正文 `ai_share` 的中位数，`stability=max-min`。后续版本传入基础稿 `block_plan`，`comparison_mode='frozen'`；没有冻结块的版本不得用于判优。

档位：

| 档位 | 条件 | 文案 |
|---|---|---|
| safe | `ai_share < 0.15` | AI 特征不明显 |
| warn | `0.15 <= ai_share < 0.30` | 存在 AI 特征段落 |
| risk | `ai_share >= 0.30` | AI 特征显著 |

## 4. 配置与回退

`aigc/calib.json` 是唯一阈值来源：

```json
{
  "version": "2026-11-18",
  "genre": "undergraduate_thesis",
  "calibrated": false,
  "thr_hi": 0.38,
  "thr_hard": 0.85,
  "band": {"safe_max": 0.15, "warn_max": 0.3},
  "basis": {
    "thr_hi": "human_academic_p95, n_chunks=73, provisional",
    "band": "university_policy, 15pct_most_strict, 30pct_mode"
  },
  "n_docs_human": 3,
  "n_chunks_human": 73
}
```

文件缺失或损坏时，`aigc/bands.py` 回退到 `thr_hi=0.50`、`thr_hard=0.85`、档位线 `0.15/0.30`，并保持 `calibrated=False`。不得在业务代码里另写一套阈值。

## 5. 检测器数据结构

```python
@dataclass
class SegmentScore:
    index: int
    chars: int
    ai_prob: float      # 单块模型输出，不是全文概率
    windows: int
    preview: str
    kind: str
    pid_span: tuple[int, int]
    contribution: float
    truncated: bool
    group: str

@dataclass
class DocScore:
    ai_prob: float      # deprecated alias of mean_prob
    chars: int
    segments: list[SegmentScore]
    ai_index: int
    model: str
    mode: str
    ai_share: float
    ai_share_hard: float
    median_prob: float
    band: str
    stability: float | None
    thr_hi: float
    thr_hard: float
    calibrated: bool
    degraded: bool
    mean_prob: float
    granularity: int
    config_version: str
    detectable_chars: int
    coverage: float
    body_chars: int
    table_chars: int
    reference_chars: int
    excluded_chars: int
    all_ai_share: float
    table_ai_share: float | None
    reference_ai_share: float | None
    group_stats: dict
    comparison_mode: str   # frozen / segmented
    block_plan: list[dict]
```

`to_dict()` 必须完整序列化上述字段。

## 6. segscore.json 契约

`aigc/segscore.py` 输出 `paper-dual-reduce/segscore@3`：

- `paragraphs[]` 是语义块，不是原 doc.json 的全部段落；
- `top[]` 按 `contribution` 降序，只保留 `group=rewritable`、未锁定且 `ai_prob >= threshold` 的块；
- `pid` 是可改写的代表段号，`pid_span` 保留完整来源范围；
- 全文字段必须与 `Detector.score_document` 一致；
- 退化模式下 `paragraphs=[]`、`top=[]`。
- `block_plan` 写入基础稿计划；后续版本用 `--plan block-plan.json` 复用，不接受重新切块结果作为前后对比。

## 7. 模型滑窗不变式

模型上限 512 token，实际窗口 `max_tokens=510`：

- 每个 token 至少被一个窗口覆盖；
- 首尾 token 恰好覆盖一次；
- 任意窗口不超过 `max_tokens`；
- 尾窗为整窗；
- 重叠区按 token 级平均，不重复计数。

这些不变式由 `selftest.py` 守护。

## 8. CLI

```text
python detector.py --file paper.txt --json
python detector.py --file paper.txt --json --fast
python detector.py --calibrate
python segscore.py --doc original.json --out original-score.json --plan-out block-plan.json
python segscore.py --doc revised.json --out revised-score.json --plan block-plan.json
```

`--threshold` 只覆盖定位阈值，不改变 `calib.json` 或档位线。

## 9. 界面与兼容

- 主数字统一叫「正文 AI 疑似占比」，表格/参考文献单列；
- 显示 `band`、`calibrated`、`stability`、块数和块覆盖率；
- `calibrated=False` 必须显示「未校准」水印；
- 历史结果只有 `ai_prob` 时标成「旧口径」，不得与新记录直接相减；
- 改写循环和下一轮定位只使用 `group=rewritable` 的 `ai_share` 与 `contribution`；
- AIGC/双降回填必须自动做冻结块模型复检；模型缺失、未冻结块或正文占比上升均判失败并回退；
- 面板固定显示三条免责声明：不可跨平台横比、以本校平台为准、阈值仅用于定位。

## 10. 验收

```text
python selftest.py
# 期望：22/22 通过

python detector.py --file samples/human_sample.txt --json --fast
# 期望：真实模型输出新字段；不再输出 percentile
```

三粒度回归要求：

- 同文极差不超过 0.06；
- 同一输入重复运行结果完全一致；
- 16k 字样本块数约 35–45；
- 正文块不足 200 字或超过默认 480 字均为 0；
- 不足 40 字独立推理请求为 0。
- 同一原稿/改稿的 `pid_span` 列表必须完全一致；
- 表格与参考文献不进入正文 top 改写列表。

## 11. 边界

本指标是本工具自有口径下的 AI 疑似占比，不是任何平台的概率，不是学术不端判决，也不承诺通过率。阈值 `0.38` 的样本量不足且体裁只是近似，`calibrated` 必须保持 `false`，直到有足够合法、同体裁的校准证据。
