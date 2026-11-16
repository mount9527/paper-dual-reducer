# dsh-paper-dual · 论文双降工作台（DSH 插件）

> 仓库：<https://github.com/mount9527/paper-dual-reducer> ｜ 许可：插件代码 MIT
> AIGC 检测模型 `yuchuantian/AIGC_detector_zhv3`（Apache-2.0，基座 `chinese-roberta-wwm-ext` 亦为 Apache-2.0）
> **不随本仓库分发**：权重由使用者首次运行时从 HuggingFace 自行下载，仓库里只有模型 id 字符串。详见 `LICENSE` 末尾的第三方说明。

左栏点开「论文双降」，填一条中文论文 `.docx` 的绝对路径，点「诊断」——**只读**原文件，不改它。

## 面板里能做什么

**诊断**
- 风险分布条（高/中/低）、段落 / 可改写 / 锁定统计、篇内重复率
- Top 12 高风险段落：点行展开原文，看主因与建议算子

**改写闭环（四步）**

| 步 | 动作 | 说明 |
|---|---|---|
| 1 | 生成改写任务 | 跑 `run.py rewrite`，出 `out/plugin/prompts.jsonl`；面板给出「贴给模型的指令」，可一键复制 |
| 2 | 模型改写 | 模型读 `prompts.jsonl`、写 `edits.jsonl`（一行一条 `{"pid","text","op"}`），**不碰 docx** |
| 3 | 预检 / 回填复检 | 「预检」只跑闸门；「回填并复检」写 docx 并做篇级校验，不过就整篇回退 |
| 4 | 三栏对照 | 原文 / 改文 / 字数与句数变化，逐段列出 |

「查看报告」把 `report.md` **渲染成排版**（标题层级、表格、引用、列表都成形，不再是一堵管道符），
支持横向滚动、复制 Markdown、一键收起。

**AIGC 考官（v0.3 新增）**
- 「打分」：对原文或改稿跑 AIGC 检测器，给出 AI 概率 + 分段概率条
- 「9 维诊断」：模板套话 / 被动句 / 句长起伏 / 结构对称 / 层层嵌套 / 冒号列举 / 标点节奏 / 口语化 / 破折号，
  并输出**改写作业清单**（`todo`）
- 「自检」：跑考官自带离线自检（11 项）

> **真机 / dry-run**：检测器需要 `transformers + torch`（模型 `yuchuantian/AIGC_detector_zhv3`，约 818MB）。
> 本机装不了包，所以面板会显著标注 **dry-run 伪概率** —— 结构一致、数值无意义，只能验流程。
> 在能 `pip install -r aigc/requirements.txt` 的机器上，插件自动切到**真机**，分数才是模型推理结果。
> `diag.py` 是纯正则，任何机器都可用。

## 给 agent 的工具

| 工具 | 作用 |
|---|---|
| `paper_dual_status` | 引擎目录、诊断/改写/复检进度、是否有待回填的清单 |
| `paper_dual_diagnose` | 诊断一篇 .docx，返回风险分布与 Top 段落 |
| `paper_dual_rewrite` | 为已诊断的论文生成改写任务与提示词 |
| `paper_dual_apply_edits` | 写入 `edits.jsonl` → 预检 → 回填 → 篇级复检 |
| `paper_dual_aigc` | AIGC 考官：对原文/改稿打分 + 9 维诊断（dry-run 会明确标注） |

## 依赖

- 引擎：`paper-dual-reduce` 仓库（含 `run.py`），默认
  `E:\ruanjianxiazai\deepseek\work\paper-dual-reduce`，可在面板「设置」里改
- `python` 在 PATH；引擎零第三方依赖
- 本插件不联网、不读 token、不写任何远端

## 边界（别拿它当"过检测"用）

- 风险分是**篇内相对指标**，只用于同篇排序，跨文档不可比，**不是任何平台的检测概率**
- AIGC 考官给的是**单一开源模型**的概率，不等于知网/维普/格Z达的判定；dry-run 下更是占位值
- 不模拟任何平台，不承诺通过率
- 标题、表格、代码块、公式、脚注、参考文献一律不改；不新增数字/引用/主观表述
- 改稿必须由作者复核

**复现边界**：本插件复现的是「检测 + 诊断 + 定向改写」，**没有**复现「自动迭代到分数下降」的闭环——
那一步依赖真机分数，本机跑不了；接上真机后可以作为下一步。

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
node tools/render.mjs                   # 报告渲染回归：块类型 / 表格 / 行内语法
```

装进 profile / 热重载：

```
plugin_manager install_bundle target="link:E:/ruanjianxiazai/deepseek/work/dsh-paper-dual"
plugin_manager set_plugin target="include:dsh-paper-dual" enabled=false   # 再 true
```

宿主侧坑：`apply(ctx)` 里用 `ctx.webServer` / `ctx.tools` 必须在模块里
`export const inject = ['webServer', 'tools']`，否则激活报
`cannot get property "webServer" without inject`。
