# SPEC —— 实现规格书

本文件是给实现方的契约。**动手前先读完，实现时不要偏离接口签名**；偏离会让 `selftest.py` 失效。

---

## 1. 目标与非目标

**目标**：输入一篇中文学术论文，输出一篇改写稿与一个 AIGC 概率，且改写稿满足：

- 本地检测器概率显著下降
- 数字、引用、术语、结论方向完全不变
- 学术书面语体不降级

**非目标（明确不做）**

- ❌ 论文查重（重复率）——那是另一条技术路线，需要比对语料库，本包不涉及
- ❌ 与知网 / 维普 / Turnitin 分数对齐——没有校准集就做不到，不要假装能做到
- ❌ 用 LLM 整篇重写——见第 12 节禁令

---

## 2. 已有资产（不要重写）

### 2.1 `detector.py`

```python
class Detector:
    def __init__(self, model_id: str = "yuchuantian/AIGC_detector_zhv3",
                 device: str = "cpu", ai_index: int | None = None,
                 max_tokens: int = 510, dry_run: bool = False) -> None: ...

    def load(self) -> "Detector": ...
    def calibrate(self, verbose: bool = False) -> dict: ...
    def score_document(self, text: str) -> DocScore: ...
    def _score_text(self, text: str) -> tuple[float, int]: ...
    def _windows(self, n_tokens: int) -> list[tuple[int, int]]: ...
```

```python
@dataclass
class SegmentScore:
    index: int; chars: int; ai_prob: float; windows: int; preview: str

@dataclass
class DocScore:
    ai_prob: float          # 全文分，字数加权，0~1
    chars: int; segments: list[SegmentScore]
    ai_index: int; model: str; mode: str   # "model" | "dry-run"
```

**不变式**（由 `selftest.py` 守护，改动必须让自检仍然全绿）：

- 每个 token 至少被 1 个窗口覆盖
- 首尾 token 恰好被覆盖 1 次
- 任何窗口长度 ≤ `max_tokens`
- 尾窗是整窗，不留残片
- 恒定概率输入下，聚合结果精确等于该常数（重叠不重复计数）

### 2.2 `diag.py`

```python
def diagnose(text: str) -> DiagResult
```

`DiagResult` 关键字段：`risk_count`（触发维度数）、`risk_score`（模板句式双权）、`level`（high/mid/low）、`style_gate_passed`、`todo`（作业清单）。

**注意**：`style_gate_passed == False` 表示语体被破坏，**不代表文本是 AI 写的**。这两个概念在代码里必须分开表达，不要合并成一个"AI 分数"。

---

## 3. 待实现清单

### P0 —— 单篇闭环（3 天）

| # | 任务 | 验收 |
|---|---|---|
| 1 | 真实模型冒烟：跑通 `detector.py --calibrate` 与 `--file` | 标定 gap ≥ 0.15，exit 0；两样本的 AI 稿分数 > 人写稿分数 |
| 2 | `guard.py`：四道校验 | 对 10 组"人为改坏"的文本，四类破坏各能拦下 |
| 3 | `rewriter/word_level.py`：词级确定性替换 | 同一输入两次运行输出完全一致 |
| 4 | `rewriter/sent_level.py`：四类句级变换 | 每种变换有单测；同段内同类变换不超过 1 次 |
| 5 | `controller.py`：闭环调度 | 单篇能跑完最多 3 轮，输出每轮分数轨迹 |

### P1 —— 可用（5 天）

| # | 任务 | 验收 |
|---|---|---|
| 6 | `span_guard.py`：protected spans 识别 | 引用/公式/百分比/术语识别召回 ≥ 95% |
| 7 | `rewriter/llm_span.py`：受限 LLM 改写 | 输出必须过护栏，否则整段回滚 |
| 8 | `output/writer.py`：docx 回写保格式 | 改写后 docx 打开无格式错位，图片/公式/脚注完好 |
| 9 | `report.py`：段落高亮报告 | 能定位到具体段落与命中的诊断维度 |

### P2 —— 可评估（3 天）

| # | 任务 | 验收 |
|---|---|---|
| 10 | 双向 benchmark | SF/SNF 各 30 篇，输出规避率与误改率 |
| 11 | 阈值回归脚本 | 换模型后一键重跑，输出维度漂移报告 |

---

## 4. 第一步必做：真实模型验证

本机未安装 torch，真实权重从未跑过。接手后第一个动作是：

```bash
pip install -r requirements.txt
python detector.py --calibrate
```

**期望**：`trusted: true`，`gap ≥ 0.15`。

**如果 `gap < 0.15`**，说明探针句在该模型上没有区分度，按顺序尝试：

1. 把 `AI_PROBES` 换成更长的 AI 稿片段（≥100 字，纯 AI 生成）
2. 把 `HUMAN_PROBES` 换成更口语化的人写片段
3. 仍不行则用 `--ai-label 0` / `--ai-label 1` 手动试，用 3 篇已知来源的文本人工确认方向

**不要**因为标定失败就去改 `calibrate()` 里的阈值来"让它通过"——那等于放弃这项检查。

验证完毕后记录实测数据（供后续回归对比）：

| 样本 | 期望 | 实测 ai_prob（ai_index） | 备注 |
|---|---|---|---|
| `samples/ai_sample.txt` | 高 | ______ | |
| `samples/human_sample.txt` | 低 | ______ | |
| `samples/colloquial_bad.txt` | 不应过高 | ______ | 口语化会干扰检测器，属已知现象 |

---

## 5. 512 token 截断：能修吗？

**结论：模型层面不能修，工程层面已完整绕过。**

- 不能修的原因：zhv3 的 `config.json` 中 `max_position_embeddings = 512`，BERT 用绝对位置编码，扩长必须重新训练位置编码，不是改配置能解决的。
- 已实现的绕过：`detector.py::_windows` + token 级聚合。无信息损失（除跨窗口的长距离依赖），代价是推理次数变为 N 倍。

### 5.1 窗口算法（不要改）

```
if n <= max_tokens: 返回 [(0, n)]
stride = int(max_tokens * 0.75)
while start + max_tokens < n:
    产出 (start, start + max_tokens)
    start += stride
若末窗未覆盖到 n：追加 (n - max_tokens, n)（若与末窗相同则不追加）
```

`max_tokens = 510` 而非 512，为 `[CLS]` / `[SEP]` 留位。

### 5.2 聚合公式（关键）

**错误做法**：把所有窗口概率算术平均。重叠区会被重复计数，分数向窗口内容偏斜。

**正确做法**：token 级加权。

```
acc[i] = Σ 覆盖 token i 的窗口的概率
cnt[i] = 覆盖 token i 的窗口数
p_token[i] = acc[i] / cnt[i]
text_prob = mean(p_token)
```

**全文分**：`Σ(段落分 × 段字数) / 总字数`。不是段落算术平均——否则 50 字的引言和 800 字的分析段等权，短段会过度影响结果。

### 5.3 残余限制（必须写进交付说明）

分块后得到的是**局部风格统计的加权**，不是整篇语义判断。若论文存在跨段落的统一节奏（如全文每段都以"此外"起头），滑窗无法捕捉这类长距离模式。这是方法论限制，不是 bug，不要试图用"更长窗口"解决。

---

## 6. 标签标定规格

`config.json` 缺 `id2label`，因此方向必须实测。`calibrate()` 的逻辑：

```
p1_ai    = mean( index=1 在 AI 探针上的概率 )
p1_human = mean( index=1 在人写探针上的概率 )
gap = p1_ai - p1_human
ai_index = 1 if gap > 0 else 0
trusted  = abs(gap) >= 0.15
```

- `trusted == False` → **抛 RuntimeError，不返回结果**。宁可失败，不要静默给出可能反向的分数。
- 标定结果应缓存到本地文件（如 `.calibration.json`），避免每次启动重跑；换模型时缓存失效。

---

## 7. 阈值表（集中管理，不要散落在函数里）

| 维度 | 阈值 | 出处 |
|---|---|---|
| 模板句式命中数 | > 3 处 | aigc-reduce |
| 被动语态 | > 0.30 /句 | aigc-reduce |
| 句长 CV | < 0.35 中风险，< 0.25 高风险 | aigc-reduce |
| 段落对称 | 连续 3 段偏差 < 20% | aigc-reduce |
| 嵌套编号 | > 3 处 | aigc-reduce |
| 冒号并列 | > 1 处 | aigc-reduce |
| 逗号密度 | > 2.5 /句 | aigc-reduce |
| 口语词 | > 0 处即门禁失败 | aigc-reduce |
| 破折号 | > 1 /段即门禁失败 | aigc-reduce |
| 修改率目标 | > 40% | aigc-reduce（经验值） |

> 这些阈值来自 `xiaofenggan01/aigc-reduce`（MIT）的经验设定，**不是严格实验结果**。换模型或换语料后需要重标。重标时只改 `LIMITS`，不要改函数。

---

## 8. 护栏规格（四道，缺一不可）

| # | 校验 | 实现要点 | 不通过处置 |
|---|---|---|---|
| 1 | 数字一致 | 抽取 `\d+(\.\d+)?%?` 及其单位，比对集合；注意保留原文顺序无关 | 回滚该段 |
| 2 | 引用一致 | 抽取 `[n]`、`[n-m]`、`(作者, 年份)`、`（作者，年份）`、脚注上标 | 回滚该段 |
| 3 | 语义保真 | `BAAI/bge-small-zh-v1.5` 句向量，段落级余弦 ≥ 0.85 | 回滚或重写 |
| 4 | 语体门禁 | 复用 `diag.colloquial()` 与 `diag.dash_density()`，均须为 0 | 回滚该段 |

补充第 5 道（业务层）：术语保留率 ≥ 95%。术语表从原文抽取（jieba + 领域词典，或简单的 3-gram 高频 + 白名单）。

**回滚语义**：回滚到该段的「上一个通过护栏的版本」，不是回到原文。若规则版也过不了，回滚到原文并记录。

---

## 9. 改写算子规格

### 9.1 三级贡献

| 层级 | 手段 | 修改率贡献 |
|---|---|---|
| 词级 | 模板词替换、AI 高频词替换（每处用不同替代词） | 10–15% |
| 句级 | 语序重组、长句拆分、被动改主动、主语更换 | 15–20% |
| 段落级 | 打破对称段长、段间过渡改写 | 10–15% |

### 9.2 句级变换约束

- 同一段落内，同一类变换最多使用 1 次（否则产生新的模式化）
- 长句拆分在语义边界切，目标 15–30 字，**不得拆成电报体碎句**
- 被动改主动**保留方法学合规被动**（"样品被置于…"这类不能改）

### 9.3 受限 LLM 改写

只在「高风险段落」调用，且必须带输出契约：

```
只改写以下段落，保持：
- 全部数字、百分比、单位、P 值不变
- 全部引用标记不变
- 全部专业术语、方法名、模型名不变
- 学术书面语体，不出现口语、网络用语、情绪词
- 每段破折号不超过 1 个
- 不得新增原文没有的事实、数据、案例、文献
仅输出改写后的段落，不要解释。
```

输出**必须**过第 8 节四道护栏，任一不过则整段回滚为规则改写版本。

---

## 10. docx 保格式

用 `python-docx` 按 run 级替换，不要整段替换字符串——整段替换会丢失加粗、上标引用、域代码。

要点：

- 先把段落拆成 run，只在目标 span 所在 run 内改
- 受保护片段（公式、图表号、引用上标、脚注引用）的 run 不参与改写
- 表格默认跳过（诊断器与检测器都不处理表格内容）
- 改写结果写**新文件**，不原地修改

---

## 11. 验收标准

全部可执行，逐条通过才算交付：

```bash
# 1. 自检全绿
python selftest.py                       # exit 0，11/11

# 2. 标定可信
python detector.py --calibrate           # trusted: true, gap >= 0.15

# 3. 方向正确（AI 稿分数应高于人写稿）
python detector.py --file samples/ai_sample.txt    --json
python detector.py --file samples/human_sample.txt --json

# 4. 门禁有效
python diag.py --file samples/colloquial_bad.txt   # 语体门禁 FAIL，exit 1
python diag.py --file samples/human_sample.txt     # 语体门禁 PASS，exit 0

# 5. 闭环可复现（同一输入两次运行，输出一致）
python detector.py --file samples/ai_sample.txt --dry-run --json | md5sum
python detector.py --file samples/ai_sample.txt --dry-run --json | md5sum
```

**P0 的业务验收**：对一篇真实论文，改写后

- 段落平均 AIGC 概率下降
- 四道护栏全程无漏放（故意改坏 10 处，全部被拦）
- 人工通读无口语化、无事实改动

**不要用"分数降了 30 个百分点"作为验收门槛**——绝对水平取决于检测器，且已知不可靠。验收的是**方向、可复现性、护栏有效性**。

---

## 12. 禁止事项（触犯即方案失效）

1. **禁止用 LLM 整篇重写。** AI 重写 AI 文本会叠加指纹，社区实测检测率反而升到 100%。改写只能局部、受限、可回溯。
2. **禁止为降分编造**数据、案例、文献、实验细节。
3. **禁止靠口语化降分。** 口语词能骗过统计检测器，但过不了人审。语体优先级高于修改率——冲突时宁可停在 38%。
4. **禁止串通检测器。** 不要用"改写后立刻用同一模型打分并把分数写进报告"当成效果证明，必须用独立样本做双向 benchmark。
5. **禁止宣称与任何商业平台等效。** 报告里写"本地模型分"，不要写"AIGC 率"。
6. **禁止改 `selftest.py` 里的断言来让测试通过。** 若要改不变式，先在 SPEC 里说明理由。

---

## 13. 数据契约

`score_document` 的 JSON 输出（`--json`）：

```json
{
  "ai_prob": 0.4638,
  "chars": 310,
  "segments": [
    {"index": 0, "chars": 103, "ai_prob": 0.5067, "windows": 1, "preview": "随着数字化转型的不断深入……"}
  ],
  "ai_index": 1,
  "model": "yuchuantian/AIGC_detector_zhv3",
  "mode": "model"
}
```

`diagnose` 的 JSON 输出：见 `diag.py::DiagResult.to_dict()`，字段固定，新增字段只能追加不能改名。

---

## 14. 参考

- 检测模型：`yuchuantian/AIGC_detector_zhv3`（apache-2.0，22.8k 下载）
- 规则与阈值：`xiaofenggan01/aigc-reduce`（MIT）
- 模式分类与硬约束：`redbaronyyyyy-eng/humanizer-zh-academic`（MIT）
- 背景论证：同目录 `降AIGC率技术实施方案.md`
