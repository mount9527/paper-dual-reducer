# 降 AIGC 率技术实施方案（可行性论证版）

| 项目 | 内容 |
|---|---|
| 目标 | 将学术论文的本地 AIGC 检测概率显著下降，同时保持学术语体、事实、引用、术语不变 |
| 技术底座 | 全部基于 GitHub / HuggingFace 开源组件，无商业 API 依赖 |
| 存储需求 | **不需要比对语料库 / 向量库 / 检索服务** |
| 单人工作量 | 2–3 周（P0 可 3 天跑通单篇闭环） |
| 主要风险 | 检测器本身不可靠；"降分"与"保真"天然冲突；跨平台分数不可换算 |

---

## 0. 先回答：为什么不需要数据库

### 0.1 本质区别

| | 查重（重复率） | 降 AIGC（AIGC 率） |
|---|---|---|
| 计算对象 | 待查文本 **×** 比对库 | 待查文本 **×** 检测模型 |
| 是否需要语料 | 必须，分母就是库 | 不需要，模型权重即全部 |
| 缺失后果 | 无库 → 结果恒为 0 | 无库 → 无影响 |
| 数据体量 | 亿级文档 | 0 |

查重必须有分母，降重没有分母。降 AIGC 是**单篇文本的转换问题**：输入一篇稿子，输出改过的稿子加一个分数。没有任何"跟谁比"的动作，所以不存在语料库需求。

### 0.2 实际需要的东西（都不是数据库）

| 资产 | 形态 | 体量 | 来源 |
|---|---|---|---|
| 检测模型权重 | PyTorch / safetensors | 400 MB – 1.1 GB | HuggingFace 直接下载 |
| 规则资产 | YAML / JSON / 正则 | < 1 MB | 直接复用 MIT 协议开源仓库 |
| 术语保护表 | 纯文本词表 | < 100 KB | 从论文自身抽取 |

全部可以进 Git 仓库，随代码一起版本化。

### 0.3 两个"看起来像库"的例外（需要明说）

1. **要做「知网等效分」→ 需要校准集。**
   300–500 篇带平台实测分数的标注样本，用来拟合一个从"本地模型分"到"平台分"的映射。这是几百篇的人工标注活，不是亿级语料。**不做校准也可以，只是报告里只能写"本地模型分"，不能写"AIGC 率"。**
2. **要做多用户/批量任务管理 → 需要业务库。**
   任务表、结果表、版本记录。这是普通 Web 后端的事，跟查重库没有关系，SQLite 都够。

**结论：零检索库；校准集可选；业务库可选。**

---

## 1. 方案定位与红线

这一节不是免责声明，是工程约束。写进代码里，否则方案会跑偏。

**定位**：降低「本来就是人写的稿子被误判为 AI」的概率。检测器对高质量流畅文本的假阳性率约 6.5%，对带口语瑕疵的文本只有 1.8%——这意味着**写得越规范越容易被误判**，这才是要解决的问题。

**四条红线（硬编码，不靠人自觉）**：

1. **禁止 AI 全量重写。** 用大模型重写 AI 文本会叠加 AI 指纹，PaperPure 实测重写后检测率反而升到 100%。所有改写必须是**受限的、局部的、可回溯的**。
2. **禁止编造。** 不得为降分新增原文没有的数据、案例、文献、实验细节。
3. **禁止口语化降重。** 口语色彩确实能骗过统计检测器，但过不了人审。学术语体优先级高于修改率目标。
4. **禁止承诺与任何商业平台分数等效。**

---

## 2. 技术路线：闭环，不是单向

单次调 LLM 改写是开环控制——改完不知道效果，也无法判断是否改坏。本方案把本地检测器当作**目标函数**，构成闭环：

```
         ┌──────────────────────────────────────────┐
         │                                          │
   输入 docx                                    达标输出
         │                                          │
         ▼                                          │
   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ ① 解析   │──▶│ ② 诊断   │──▶│ ③ 改写   │──▶│ ④ 护栏   │
   │ 段落+保护│   │ 9维扫描  │   │ 三级算子 │   │ 4道校验  │
   │ 片段标注 │   │ +AI概率  │   │ +受限LLM │   │ 不过则回滚│
   └──────────┘   └──────────┘   └──────────┘   └────┬─────┘
                        ▲                             │
                        │        未达标且轮次<3       │
                        └─────────────────────────────┘
                                                      │
                                                      ▼
                                                ⑤ 重扫 + 出报告
```

**为什么必须闭环**：没有本地检测器，你无法回答"这版比上版好还是坏"，只能靠猜。开源检测器虽然不是知网，但作为**相对变化的度量**是有效的——它衡量的是同一把尺子下的位移。

---

## 3. 技术选型（全部开源）

### 3.1 检测层（打分器）——现成度核实

**核心结论：权重是现成的，`transformers` 一行加载，不需要训练。** 但不存在 `pip install aigc-detector` 这类成品包，也没有自带 HTTP 服务的现成部署。

| 现成度 | 模型 | 下载量 | 协议 | 说明 |
|---|---|---|---|---|
| **A. 装上就能用** | `yuchuantian/AIGC_detector_zhv3` | **22.8k** | apache-2.0 | 中文首选。标准 `BertForSequenceClassification`（底座 `chinese-roberta-wwm-ext`），818 MB，512 token，覆盖 DeepSeek-V3 / GPT-4 / R1 类文本。`pipeline("text-classification")` 直接加载 |
| **A. 轻量版** | `krito2025/aigc-detector-zh-onnx` | 99 | 见仓库 | 上者的 ONNX 量化版，CPU 推理快数倍、不依赖 torch。下载量低，需自测与 FP32 版输出一致性 |
| **B. 中文待验证** | `followsci/bert-ai-text-detector`（[Open-Detector](https://github.com/Imalwayshere/Open-Detector)） | 1.2k | MIT | 438 MB safetensors，140 万学术文本训练。**但 HF 元数据 `language: en`，中文效果需自测，不可默认可用** |
| C. 论文索引 | [`Daisy-Zhang/Awesome-AIGC-Detection`](https://github.com/Daisy-Zhang/Awesome-AIGC-Detection) | — | — | 跟进新方法，非引擎 |

**两个必须处理的坑：**

1. **标签顺序没写进配置。** zhv3 的 `config.json` 中 `id2label`、`label2id`、`num_labels` 三项全部缺失。加载后 `num_labels` 默认取 2，但**哪个下标代表 AI 是未知的**。必须先用一对已知样本做方向标定，否则整个分数会反着读且不易察觉。
   ```python
   from transformers import pipeline
   clf = pipeline("text-classification", model="yuchuantian/AIGC_detector_zhv3")
   print(clf("综上所述，本研究具有重要的理论意义与实践价值。"))   # 典型 AI 稿
   print(clf("这个结果和最初的预期并不一致，后续复测了三次。"))    # 典型人写稿
   ```
2. **512 token 硬截断。** 万字论文不滑窗就只看得到开头，必须按 5.1 的方式切块。

**工程建议（已修正）**：直接用 zhv3 作为唯一检测器，不必再从 Open-Detector 冷启动——两者都是标准分类头，加载成本相同，而 zhv3 的中文场景下载量与验证度都高一个量级。Open-Detector 留作交叉验证的第二把尺子：两个模型都判高才算高风险段落，可显著降低假阳性。

### 3.2 诊断层（规则引擎）

| 仓库 | 协议 | 可直接复用的部分 |
|---|---|---|
| [`xiaofenggan01/aigc-reduce`](https://github.com/xiaofenggan01/aigc-reduce) | MIT | **`scripts/aigc_scan.py`（9 维扫描，纯正则，无模型依赖）**、`references/replacement-tables.md`（AI 高频词 + 替换表 + 口语负面清单）、`references/protected-spans.md`（禁改片段规则） |
| [`redbaronyyyyy-eng/humanizer-zh-academic`](https://github.com/redbaronyyyyy-eng/humanizer-zh-academic) | MIT | 16 种模式分类、7 项硬约束阈值、噪声预算规则、6 维质量评分表 |

这两个仓库是本方案规则资产的主要来源。`aigc_scan.py` 是纯 Python 正则实现，可以零成本搬进流水线当诊断器。

### 3.3 改写层

| 用途 | 选型 | 说明 |
|---|---|---|
| 词级替换 | 规则表 + 确定性替换 | 不经过 LLM 采样，保证可复现 |
| 句级/段落级重构 | 规则 + 受限 LLM | LLM 只在"目标 span 内"作业，输出需通过护栏 |
| 语义保真校验 | [`BAAI/bge-small-zh-v1.5`](https://huggingface.co/BAAI/bge-small-zh-v1.5) | 95 MB，CPU 可跑，算原句/新句余弦相似度 |
| 纯模型改写（英文可选） | [`martiansideofthemoon/ai-detection-paraphrases`](https://github.com/martiansideofthemoon/ai-detection-paraphrases) | NeurIPS'23，DIPPER 释义模型。**仅英文**，中文不可直接套用 |

> 中文不要指望有现成的"降 AI 模型"。可行做法是用本地小模型（Qwen3-4B 量级）+ 强约束提示词 + 规则后处理，效果由闭环反馈保证，而不是由模型能力保证。

---

## 4. 分层架构与模块职责

```
aigc-reducer/
├── config/
│   ├── detectors.yaml        # 检测器权重路径、滑窗参数
│   ├── thresholds.yaml       # 所有阈值集中管理
│   ├── templates.yaml        # 模板句式正则（来自 aigc-reduce）
│   ├── ai_words.yaml         # AI 高频词 → 替换候选
│   └── colloquial.yaml       # 口语负面清单（门禁）
├── core/
│   ├── parser.py             # docx/pdf → 章节树 → 段落
│   ├── span_guard.py         # 识别 protected spans
│   ├── detector.py           # Detector 接口 + 两个实现
│   ├── diag.py               # 9 维扫描（移植 aigc_scan.py）
│   ├── rewriter/
│   │   ├── word_level.py     # 词级确定性替换
│   │   ├── sent_level.py     # 句级四类变换
│   │   ├── para_level.py     # 段落对称性打破
│   │   └── llm_span.py       # 受限 LLM 改写
│   ├── guard.py              # 4 道护栏校验
│   └── controller.py         # 闭环调度
├── output/
│   ├── writer.py             # 回写 docx（保格式）
│   └── report.py             # HTML/PDF 报告
└── cli.py
```

各模块职责边界清楚，**唯一有状态的是 controller**，其余全是纯函数，方便单测。

---

## 5. 核心算子实现

### 5.1 段落级打分（不要整篇喂模型）

长文整篇输入会被 512 token 截断，分数失真。必须滑窗：

```python
def score_document(detector, paragraphs, win=500, stride=400):
    results = []
    for i, para in enumerate(paragraphs):
        if len(para) <= win:
            p = detector.predict(para)
            results.append({"idx": i, "ai_prob": p, "chars": len(para)})
            continue
        # 长段滑窗，按重叠区加权平均
        chunks = [para[s:s+win] for s in range(0, len(para)-win+1, stride)]
        probs = [detector.predict(c) for c in chunks]
        results.append({"idx": i, "ai_prob": sum(probs)/len(probs), "chars": len(para)})
    total = sum(r["chars"] for r in results)
    doc_score = sum(r["ai_prob"] * r["chars"] for r in results) / total
    return doc_score, results   # 全文分 = 字数加权，与平台口径一致
```

**关键**：全文分必须按**字数加权**，不是段落算术平均。否则短段落会过度影响结果。

### 5.2 九维诊断（复用 `aigc_scan.py` 的指标与阈值）

| # | 维度 | 阈值 | 处置方向 |
|---|---|---|---|
| 1 | 模板句式密度 | 命中 > 3 处 | 删除或改写句首模板 |
| 2 | 被动语态比例 | > 0.3 /句 | 改主动，保留方法学合规被动 |
| 3 | 句子长度变异系数 CV | < 0.35 中风险，< 0.25 高风险 | 节奏工程，目标 CV ≈ 0.45 |
| 4 | 段落长度对称性 | 连续 3 段偏差 < 20% | 打破段长 |
| 5 | 嵌套编号 | > 3 处 | 改写为叙述式列举 |
| 6 | 冒号并列结构 | > 1 处 | 拆解 |
| 7 | 标点规律 | 逗号 > 2.5 /句 | 断句 |
| 8 | 口语化词 | **命中任意一个即失败** | 语体门禁，无条件改回 |
| 9 | 破折号密度 | **每段 > 1 个即超标** | 替换为逗号/括号 |

维度 8、9 是**语体门禁**，不是优化项——它们防的是"降重把论文改成大白话"。

### 5.3 修改率的计算与目标

```python
import difflib
def modification_rate(orig, new):
    return 1 - difflib.SequenceMatcher(None, orig, new).ratio()
```

开源仓库给出的经验区间（来自 `aigc-reduce` README，属经验数据、非严格实验）：

| 修改率 | 规避效果 |
|---|---|
| < 20%（轻度） | 15–25% |
| 20–40%（中度） | 35–50% |
| **> 40%（深度）** | **60–80%** |

**目标：修改率 > 40%，但语体优先。** 冲突时宁可停在 38%，也不能靠口语化凑到 45%。

修改率的贡献只允许来自两类手段：
- **结构性改写**（语序重组、句式变换、主被动互换、长句拆分）——贡献 25–35%
- **模板句去除**（AI 高频模板词、套话、空洞结论）——贡献 10–15%

明令禁止的凑数手段：加口语词、堆破折号、无意义同义词轮换。这些能提高字面修改率，但会同时破坏语体，属于负收益。

### 5.4 句级四类确定性变换

不经过 LLM 的四种原子操作，可复现、可回滚：

```python
TRANSFORMS = {
    # 1. 语序重组：状语前移/后置
    "adverbial_shift": lambda s: move_adverbial(s),
    # 2. 长句拆分：>50 字在语义边界切分为 15–30 字短句
    "long_split":      lambda s: split_at_clause(s, max_len=50, target=(15, 30)),
    # 3. 被动改主动：仅限非方法学语句
    "passive_to_active": lambda s: de_passivize(s, keep_domain=["测定", "标定", "采样"]),
    # 4. 主语更换：把"本文/本研究"与具体对象轮换
    "subject_swap":    lambda s: swap_subject(s),
}
```

约束：同一段内同一变换**最多用 1 次**，避免产生新的模式化。

### 5.5 受限 LLM 改写（关键设计）

不用 LLM 重写全文。只对"高风险段落"逐段调用，并且：

```python
PROMPT_CONTRACT = """
只改写以下段落，保持：
- 全部数字、百分比、单位、P 值不变
- 全部引用标记（如 [12]、(张三, 2023)）不变
- 全部专业术语、方法名、模型名不变
- 学术书面语体，不出现口语、网络用语、情绪词
- 每段破折号不超过 1 个
- 不得新增原文没有的事实、数据、案例、文献
输出仅包含改写后的段落，不要解释。
"""
```

调用后的输出**必须**过 4 道护栏（见第 6 节），任一不过则**整段回滚**为规则改写版本。

---

## 6. 护栏：4 道校验（决定方案能不能用）

这是整个方案里最不能省的部分。没有护栏，闭环会收敛到"改坏的稿子"。

| # | 校验 | 方法 | 不通过处置 |
|---|---|---|---|
| 1 | **数字一致性** | 正则抽取原文/新文全部数字+单位集合，做差集 | 回滚该段 |
| 2 | **引用标记一致性** | 抽取 `[n]`、`(作者, 年)`、脚注编号集合比对 | 回滚该段 |
| 3 | **语义保真** | `bge-small-zh` 句向量余弦，段落级 ≥ 0.85 | 回滚或重写 |
| 4 | **语体门禁** | 口语词表命中数 = 0；破折号每段 ≤ 1；模板句不新增 | 回滚该段 |

补充第 5 道（业务层）：**术语表命中率**。从原文抽专业术语（可用 jieba + 领域词典或简单的 n-gram 高频），改写后术语保留率应 ≥ 95%。

```python
def guard(orig: str, new: str) -> tuple[bool, str]:
    if numbers(orig) != numbers(new):        return False, "数字被改动"
    if citations(orig) != citations(new):    return False, "引用标记被改动"
    if cosine(embed(orig), embed(new)) < .85: return False, "语义漂移"
    if hit_colloquial(new):                  return False, "语体破坏"
    if new.count("——") > orig.count("——") + 1: return False, "破折号增加"
    return True, "ok"
```

---

## 7. 评测方法：双向 benchmark

只测"分数降了多少"是不够的，会把系统优化成"改得越烂分越低"。必须双向：

| 测试集 | 构成 | 期望 | 指标 |
|---|---|---|---|
| **SF（该改）** | 30–50 篇 AI 生成/重度 AI 辅助稿 | 检测分显著下降 | 平均 Δ、达标率（如降至 < 15%） |
| **SNF（不该动）** | 30–50 篇纯人写稿 | 分数不升、语体不降 | 误改率、语体合格率、语义保真度 |

参考 `aigc-reduce` 的 `evals/benchmark.md` 设计（双向：SF 该改 / SNF 不该误杀）。

**外部抽检**：腾讯朱雀（`matrix.tencent.com/ai-detect/ai_gen_txt`）提供免费网页检测，可作人工抽样验证，无公开 API，只能手动抽查。

**必须做的回归**：检测模型更新后，全部 benchmark 重跑。开源检测器换代频繁（v1 → v2 → v3），旧阈值会失效。

---

## 8. 实施排期

| 阶段 | 内容 | 产出 | 工期 |
|---|---|---|---|
| **P0** | 解析 txt/docx → zhv3 打分（含标签方向标定）→ 规则改写 → 重打分 | 单篇闭环 CLI 跑通，能看到 Δ | 3 天 |
| **P1** | 移植 9 维诊断 + protected spans + 4 道护栏 | 改写不再"改坏"，护栏拦截率可观测 | 5 天 |
| **P2** | 检测器滑窗调优 + 受限 LLM 改写 + docx 保格式回写 | 可交付给真实用户 | 5 天 |
| **P3** | 双向 benchmark + 报告生成 + 批量 | 效果有数、可对外说明 | 3 天 |
| **P4（可选）** | 校准集标注 → 分数映射 | 报告可写"平台等效分" | 独立 2 周 |

P0 完成即可判断方案是否成立；P1 完成才能给别人用。

---

## 9. 成本测算

| 项 | 估算 |
|---|---|
| GPU | **不需要**。BERT-base 在 CPU 上单段 512 token 约 30–80 ms，1 万字论文约 25 段，全量打分 < 5 秒 |
| 显存/内存 | 权重 400 MB–1.1 GB，常驻内存 2 GB 内 |
| LLM 调用 | 只对约 40% 高风险段落调用，1 万字论文约 6k tokens 往返，单篇 0.02–0.1 元；换本地 Qwen3-4B 则接近 0 |
| 存储 | 无数据库。模型 + 规则 + 结果文件，< 5 GB |
| 依赖 | `torch`、`transformers`、`python-docx`、`sentence-transformers`、`jieba`，全部 pip 可装 |

---

## 10. 风险清单（必须写进交付说明）

1. **检测器本身不可靠。** 高质量流畅文本假阳性率约 6.5%，跨平台同篇差异可达几十个百分点（知网 35% / 万方 12% 的案例在社区里很常见）。本方案降低的是**误判概率**，不是"保证过关"。
2. **分数不可换算。** 本地模型的 87% 和知网看到的 12% 之间没有映射关系，除非做校准集。
3. **改写有上限。** 修改率超过 40% 后收益递减，继续加码会伤语义和语体。到瓶颈应该停手，而不是硬改。
4. **规则会过期。** 检测模型换代后，模板词表和阈值需要定期重标。建议每季度跑一次 benchmark。
5. **合规边界。** 如果对外宣称"能帮 AI 稿通过检测"，项目性质就变了，且技术上也不成立（AI 全量重写必然失败）。定位必须是"降低人写稿的误判"。

---

## 11. 参考仓库清单

| 仓库 | 星 | 协议 | 本方案中的角色 |
|---|---|---|---|
| [xiaofenggan01/aigc-reduce](https://github.com/xiaofenggan01/aigc-reduce) | ~740 | MIT | **诊断器 + 规则资产主要来源**（9 维扫描脚本、替换表、禁改片段） |
| [YuchuanTian/AIGC_text_detector](https://github.com/YuchuanTian/AIGC_text_detector) | ~480 | 见仓库 | 主检测器（中文 zh-v3） |
| [redbaronyyyyy-eng/humanizer-zh-academic](https://github.com/redbaronyyyyy-eng/humanizer-zh-academic) | ~378 | MIT | 模式分类 + 硬约束阈值 + 噪声预算 |
| [Imalwayshere/Open-Detector](https://github.com/Imalwayshere/Open-Detector) | ~260 | MIT | 冷启动检测器（十行可用） |
| [Haimbeau1o/thesis-optimizer](https://github.com/Haimbeau1o/thesis-optimizer) | ~273 | 见仓库 | 三维协同优化思路参考 |
| [free-revalution/AIGC-Detector-Pro](https://github.com/free-revalution/AIGC-Detector-Pro) | ~162 | 见仓库 | 工程化组织参考 |
| [martiansideofthemoon/ai-detection-paraphrases](https://github.com/martiansideofthemoon/ai-detection-paraphrases) | ~209 | 见仓库 | 英文释义改写（DIPPER），中文不适用 |
| [HoneyMeta/ai-check-skills](https://github.com/HoneyMeta/ai-check-skills) | ~39 | MIT | 报告结构参考（章节 AI 率、高频模式） |
| [Daisy-Zhang/Awesome-AIGC-Detection](https://github.com/Daisy-Zhang/Awesome-AIGC-Detection) | ~138 | — | 检测方法论文索引 |

> 引用数据说明：本文中「修改率–规避率」区间、各平台准确率数字、humanizer 的 ">50% → 11%" 均来自上述仓库自述，**属经验数据，未独立复现**。用于方案论证可以，用于对外承诺不行。

---

## 12. 一句话总结

不需要数据库，需要一个会打分的考官和一个不会乱改的改写工。

考官用开源检测模型 `yuchuantian/AIGC_detector_zhv3`（HuggingFace 一行加载，22.8k 下载，apache-2.0，无需训练）；改写工用规则算子打底、受限 LLM 补刀；护栏用四道校验兜住底线。三者串成闭环，用双向 benchmark 证明它真的在降分而不是在破坏论文。
