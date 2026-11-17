# dsh-paper-dual · 论文双降工作台（DSH 插件）

> 仓库：<https://github.com/mount9527/paper-dual-reducer> ｜ 许可：插件代码 MIT
> AIGC 检测模型 `yuchuantian/AIGC_detector_zhv3`（Apache-2.0，基座 `chinese-roberta-wwm-ext` 亦为 Apache-2.0）
> **不随本仓库分发**：权重由使用者首次运行时从 HuggingFace 自行下载，仓库里只有模型 id 字符串。详见 `LICENSE` 末尾的第三方说明。

左栏点开「论文双降」，填一条中文论文 `.docx` 的绝对路径，点「诊断」——**只读**原文件，不改它。

## 面板里能做什么

打开面板先是**入口页**：填路径 → 诊断 → 选一个模式进入。三个模式共用同一条流水线
（生成任务 → 模型写 `edits.jsonl` → 预检 → 回填 → 复检），只是关注点不同：

| 模式 | 关注 | 能验什么 |
|---|---|---|
| **降低篇内重复率** | 13 字指纹找「自己抄自己」 | 重复率前后对比（离线可验） |
| **降低 AIGC 率** | 9 维痕迹诊断 → 写进提示词 → 改写 | 风险项/分数/语体门禁（离线可验）+ AIGC 概率（需模型） |
| **双降** | 一次改写同时注入消重与 AIGC 痕迹要求 | 两者分别报告 |

每个模式内都是同一套按钮：生成改写任务 / 预检 / 回填并复检 / 三栏对照 / 查看报告。
「降 AI」「双降」的任务按钮在各自卡片内（生成降 AI 任务 / 生成双降任务），生成后同样走
预检 → 回填 → 三栏对照，进度条会显示「edits.jsonl 已写入 / 已回填，复检通过」。

**双降不是两个模式的并排**：一次改写把「9 维痕迹要求」和「消重要求」写进同一批提示词，
验收时看两边指标（篇内重复率、AIGC 风险项/分数、真机时的概率）。引擎只在单段重复占比 ≥ 45%
时才归因为内部重复并派 O9；没有重复段时，双降任务就只由 AIGC 侧驱动，面板会说明原因。

**诊断**
- 风险分布条（高/中/低）、段落 / 可改写 / 锁定统计、篇内重复率
- Top 12 高风险段落：点行展开原文，看主因与建议算子

**改写闭环（四步）**

| 步 | 动作 | 说明 |
|---|---|---|
| 1 | 生成改写任务 | 跑 `run.py rewrite`，出当前文档产物目录里的 `prompts.jsonl`；面板给出可复制的模型指令 |
| 2 | 模型改写 | 模型读 `prompts.jsonl`、写 `edits.jsonl`（一行一条 `{"pid","text","op"}`），**不碰 docx** |
| 3 | 预检 / 回填复检 | 「预检」只跑闸门；「回填并复检」写 docx 并做篇级校验，不过就整篇回退 |
| 4 | 三栏对照 | 原文 / 改文 / 字数与句数变化，逐段列出 |

「查看报告」把 `report.md` **渲染成排版**（标题层级、表格、引用、列表都成形，不再是一堵管道符），
支持横向滚动、复制 Markdown、一键收起。

**AIGC 考官（v0.3 新增）**
- 「打分」：对原文或改稿跑 AIGC 检测器，给出 AI 概率 + 分段概率条
- 真机模式会把每个概率重新映射到 `pid`，用于定向纳入下一轮和高风险段落定位
- 「9 维诊断」：模板套话 / 被动句 / 句长起伏 / 结构对称 / 层层嵌套 / 冒号列举 / 标点节奏 / 口语化 / 破折号，
  并输出**改写作业清单**（`todo`）
- 「自检」：跑考官自带离线自检（13 项）

**降 AIGC（v0.3.1 新增）**
- 「生成降 AI 任务」：先跑 9 维诊断（离线可用），把结论翻译成改写要求，注入**每一条**提示词，
  再生成改写任务；模型改完回填后点「复检痕迹」
- 「复检痕迹」：改写前后各跑一次 9 维诊断 + 检测器打分，给出风险项/分数/语门禁/概率的对比
- 「自动回退」：任何离线/真机验收项恶化时，保留被拒改稿到 `archive/`，恢复上一版已验收
  `accepted.docx`；若没有已验收版本则恢复原文
- 「下一轮」：真机概率未下降时，从逐段分数中挑出高风险 `pid`，生成下一轮定向任务；
  默认最多 3 轮，避免无限迭代
- 完整方法与验收矩阵见 [`docs/design.md`](docs/design.md)（双降设计：降 AIGC 率 + 篇内重复率）

**AIGC 考官必须安装 `torch + transformers`。** 未安装时插件会停止打分并显示安装步骤，
**不会生成或显示伪概率**。`diag.py` 的 9 维痕迹诊断仍是纯正则，可离线使用。

Windows PowerShell 可直接复制执行（默认装到 E 盘；没有 E 盘时改前两行路径）：

```powershell
$Venv = "E:\paper-dual-aigc"
$Cache = "E:\paper-dual-aigc\hf-cache"
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"
New-Item -ItemType Directory -Force -Path $Venv,$Cache | Out-Null
py -3.12 -m venv --upgrade-deps $Venv
& "$Venv\Scripts\python.exe" -m pip install --upgrade pip
& "$Venv\Scripts\python.exe" -m pip install torch==2.9.1 transformers==5.23.0 --index-url https://pypi.mirrors.ustc.edu.cn/simple/
& "$Venv\Scripts\python.exe" -c "import torch, transformers; print(torch.__version__, transformers.__version__)"
```

安装后在面板「设置」填写：

- python 解释器：`E:\paper-dual-aigc\Scripts\python.exe`
- AIGC 模型缓存：`E:\paper-dual-aigc\hf-cache`

保存后点「校准」。首次会联网下载约 409MB 的 `pytorch_model.bin`，并自动完成 0/1 标签方向标定。

状态与产物按文档路径哈希隔离在 `~/.dsh/paper-dual/docs/<文件名>-<哈希>/`。重新诊断同一路径时，
上一批产物会移入 `~/.dsh/paper-dual/archive/`，不会把旧 `edits.jsonl` 当成新文档的改写清单。

## 给 agent 的工具

| 工具 | 作用 |
|---|---|
| `paper_dual_status` | 引擎目录、诊断/改写/复检进度、是否有待回填的清单 |
| `paper_dual_diagnose` | 诊断一篇 .docx，返回风险分布与 Top 段落 |
| `paper_dual_rewrite` | 为已诊断的论文生成改写任务与提示词 |
| `paper_dual_apply_edits` | 写入 `edits.jsonl` → 预检 → 回填 → 篇级复检 |
| `paper_dual_aigc` | AIGC 考官：全文概率 + 逐段 `pid` 定位 + 9 维诊断（缺依赖时只返回安装步骤） |

## 依赖

- 引擎：`paper-dual-reduce` 仓库（含 `run.py`）。优先用面板「设置」或环境变量
  `PAPER_DUAL_ENGINE`，否则依次探测插件同级、当前目录、家目录以及
  `~/.dsh/skills/paper-dual-reduce`
- `python` 在 PATH；引擎零第三方依赖
- 插件本身不读 token、不写任何远端。首次安装 Python 依赖或首次下载 AIGC 模型权重时，
  `pip` / `transformers` / HuggingFace 会访问网络；模型权重不随本仓库分发

## 边界（别拿它当"过检测"用）

- 风险分是**篇内相对指标**，只用于同篇排序，跨文档不可比，**不是任何平台的检测概率**
- AIGC 考官给的是**单一开源模型**的概率，不等于知网/维普/格Z达的判定
- 不模拟任何平台，不承诺通过率
- 标题、表格、代码块、公式、脚注、参考文献一律不改；不新增数字/引用/主观表述
- 改稿必须由作者复核

**复现边界**：本插件复现的是「检测 + 诊断 + 定向改写 + 分项验收 + 自动回退 + 下一轮任务」
的辅助闭环。模型写文本这一步仍由 agent/用户完成，插件不替作者生成论文内容；真机概率和
平台判定也不等同。

## 它相对笔灵做了什么、没做什么

对照 `https://ibiling.cn/paper-ai-detect`（REA/CDP 被动观察：Next.js + antd，
客户端 JSZip + docx-preview 解析文件，评分在服务端）：

| 笔灵 | 本插件 |
|---|---|
| 上传 ≤3 万字 / 云端评分 | 本地路径、本机评分，文档不出机器 |
| 模拟三平台、全文 AI 率 % | 不模拟、不给百分比，只给等级与排序 |
| 逐段标注 | Top 12 + 展开原文 |
| 报告 / 降 AI 文件下载 | 面板内看报告；改稿由 `run.py finish` 出 docx |
| 检测记录、设备指纹 | 无（不追踪、不上传） |

## 开发

```bash
node --check index.js && node --check client.js
node tools/smoke.mjs "<论文.docx>"      # 不起 DSH 也能验证宿主路由
node tools/render.mjs "<report.md>"     # 报告渲染回归：块类型 / 表格 / 行内语法
```

宿主状态与换文档回归：

```powershell
$env:PAPER_DUAL_ENGINE = "<paper-dual-reduce 目录>"
$env:PAPER_DUAL_PYTHON = "E:\paper-dual-aigc\Scripts\python.exe"
$env:HF_HOME = "E:\paper-dual-aigc\hf-cache"
$env:HF_HUB_CACHE = "$env:HF_HOME\hub"
node tools/regression.mjs "<论文一.docx>" "<论文二.docx>" "<edits.jsonl>"
```

它会验证：版本号一致、不同文档产物目录隔离、`rewrite` 传新路径会先诊断、
真机模型打分、缺依赖时不产生伪分数、自动回退、下一轮定向任务和上传中文文件名。

装进 profile / 热重载：

```
plugin_manager install_bundle target="link:<paper-dual-reducer 目录>"
plugin_manager set_plugin target="include:dsh-paper-dual" enabled=false   # 再 true
```

宿主侧坑：`apply(ctx)` 里用 `ctx.webServer` / `ctx.tools` 必须在模块里
`export const inject = ['webServer', 'tools']`，否则激活报
`cannot get property "webServer" without inject`。
