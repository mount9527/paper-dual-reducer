// dsh-paper-dual · 客户端半边（v0.2，浏览器模块，无 node:fs）
// 平台按 __ModuleLoader__ 工厂格式直接加载，不经打包。
//
// 结构：常量/配色 → 小部件 → Panel（诊断 → 生成任务 → 预检 → 回填复检 → 三栏对照）→ 注册
window.__ModuleLoader__.load({
  id: 'dsh-paper-dual',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PANEL_ID = 'dsh-paper-dual';
    const PREFIX = '/dsh-paper-dual';
    const VERSION = '0.4.6';

    const api = (p) => new URL(String(p).replace(/^\/+/, ''), document.baseURI).pathname;
    const getJson = async (p) => (await fetch(api(p), { cache: 'no-store' })).json();
    const postJson = async (p, body) => (await fetch(api(p), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })).json();

    const C = {
      border: 'rgba(127,127,127,0.25)',
      dim: 'rgba(127,127,127,0.95)',
      pill: 'rgba(127,127,127,0.12)',
      card: 'rgba(127,127,127,0.06)',
      code: 'rgba(127,127,127,0.10)',
      high: '#e5484d',
      mid: '#f5a524',
      low: '#30a46c',
      accent: '#3b82f6',
      subtle: 'rgba(127,127,127,0.75)',
    };

    const pythonBinFallback = '（未探测到）';

    const LEVEL = { high: '高', mid: '中', low: '低' };
    const LEVEL_COLOR = { high: C.high, mid: C.mid, low: C.low };

    // ------------------------------------------------------------ 小部件

    function Dot({ color, size = 7 }) {
      return h('span', {
        style: {
          display: 'inline-block', width: size, height: size, borderRadius: size,
          background: color, flex: '0 0 auto',
        },
      });
    }

    function Pill({ children, tone = 'dim', title }) {
      const color = tone === 'ok' ? C.low : tone === 'warn' ? C.mid : tone === 'bad' ? C.high : C.dim;
      return h('span', {
        title,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px',
          borderRadius: 999, background: C.pill, color, fontSize: 11, whiteSpace: 'nowrap',
        },
      }, h(Dot, { color }), children);
    }

    function Btn({ children, onClick, primary, disabled, title }) {
      return h('button', {
        type: 'button', onClick, disabled, title,
        style: {
          padding: '6px 11px', fontSize: 12, borderRadius: 7,
          cursor: disabled ? 'not-allowed' : 'pointer',
          border: `1px solid ${primary ? 'transparent' : C.border}`,
          background: primary ? C.accent : 'transparent',
          color: primary ? '#fff' : 'inherit',
          opacity: disabled ? 0.55 : 1, whiteSpace: 'nowrap',
        },
      }, children);
    }

    function Bar({ risk, level }) {
      const pct = Math.max(3, Math.min(100, Math.round((risk ?? 0) * 100)));
      return h('div', {
        style: { height: 5, borderRadius: 3, background: C.pill, overflow: 'hidden', width: 60 },
        title: `风险 ${Number(risk ?? 0).toFixed(2)}`,
      }, h('div', {
        style: { width: `${pct}%`, height: '100%', background: LEVEL_COLOR[level] || C.dim },
      }));
    }

    function DistBar({ dist }) {
      const high = dist?.high ?? 0;
      const mid = dist?.mid ?? 0;
      const low = dist?.low ?? 0;
      const total = Math.max(1, high + mid + low);
      const seg = (n, color) => (n > 0
        ? h('div', { key: color, style: { width: `${(100 * n) / total}%`, background: color } })
        : null);
      return h('div', null, [
        h('div', {
          key: 'bar',
          style: {
            display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden',
            background: C.pill, marginTop: 6,
          },
        }, seg(high, C.high), seg(mid, C.mid), seg(low, C.low)),
        h('div', {
          key: 'legend', style: { display: 'flex', gap: 12, marginTop: 6, fontSize: 11, color: C.dim },
        },
        h('span', null, h(Dot, { color: C.high }), ` 高 ${high}`),
        h('span', null, h(Dot, { color: C.mid }), ` 中 ${mid}`),
        h('span', null, h(Dot, { color: C.low }), ` 低 ${low}`)),
      ]);
    }

    function Stat({ label, value, hint }) {
      return h('div', {
        title: hint || '',
        style: {
          flex: '1 1 0', minWidth: 70, padding: '7px 9px',
          border: `1px solid ${C.border}`, borderRadius: 8,
        },
      }, [
        h('div', { key: 'v', style: { fontSize: 16, fontWeight: 600, lineHeight: 1.2 } }, value),
        h('div', { key: 'l', style: { fontSize: 11, color: C.dim, marginTop: 2 } }, label),
      ]);
    }

    // ------------------------------------------------------------ 报告渲染
    // report.md 只用到一小撮语法：标题 / 表格 / 引用 / 列表 / 加粗 / 行内代码。
    // 这里手写解析，输出 React 元素（不用 innerHTML，避免注入与样式逃逸）。
    function renderInline(text, base) {
      const nodes = [];
      const rx = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last = 0;
      let m;
      let n = 0;
      while ((m = rx.exec(text))) {
        if (m.index > last) nodes.push(text.slice(last, m.index));
        const tok = m[0];
        if (tok.startsWith('**')) {
          nodes.push(h('strong', { key: `${base}-b${n++}`, style: { fontWeight: 650 } }, tok.slice(2, -2)));
        } else {
          nodes.push(h('code', {
            key: `${base}-c${n++}`,
            style: {
              fontSize: 11, padding: '1px 4px', borderRadius: 4, background: C.code,
            },
          }, tok.slice(1, -1)));
        }
        last = m.index + tok.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    function parseBlocks(src) {
      const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
      const blocks = [];
      const isTableSep = (l) => /^\|[\s:|-]+\|$/.test(l.trim());
      const cellsOf = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
      let i = 0;
      while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) { i += 1; continue; }
        if (/^-{3,}$/.test(line)) { blocks.push({ t: 'hr' }); i += 1; continue; }
        const hm = /^(#{1,4})\s+(.*)$/.exec(line);
        if (hm) { blocks.push({ t: 'h', level: hm[1].length, text: hm[2] }); i += 1; continue; }
        if (line.startsWith('>')) {
          const buf = [];
          while (i < lines.length && lines[i].trim().startsWith('>')) {
            buf.push(lines[i].trim().replace(/^>\s?/, ''));
            i += 1;
          }
          blocks.push({ t: 'quote', text: buf.join(' ') });
          continue;
        }
        if (line.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const head = cellsOf(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].trim().startsWith('|')) {
            rows.push(cellsOf(lines[i]));
            i += 1;
          }
          blocks.push({ t: 'table', head, rows });
          continue;
        }
        if (/^[-*·]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^[-*·]\s+/.test(lines[i].trim())) {
            items.push(lines[i].trim().replace(/^[-*·]\s+/, ''));
            i += 1;
          }
          blocks.push({ t: 'ul', items });
          continue;
        }
        if (/^\d+[.)]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
            items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
            i += 1;
          }
          blocks.push({ t: 'ol', items });
          continue;
        }
        const buf = [line];
        i += 1;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (!t) break;
          if (/^(#{1,4}\s|>|\||[-*·]\s|\d+[.)]\s|-{3,}$)/.test(t)) break;
          buf.push(t);
          i += 1;
        }
        blocks.push({ t: 'p', text: buf.join('') });
      }
      return blocks;
    }

    function Markdown({ text }) {
      const blocks = useMemo(() => parseBlocks(text), [text]);
      return h('div', { style: { fontSize: 12, lineHeight: 1.85, wordBreak: 'break-word' } },
        blocks.map((b, i) => {
          if (b.t === 'hr') {
            return h('hr', {
              key: i, style: { border: 0, borderTop: `1px solid ${C.border}`, margin: '12px 0' },
            });
          }
          if (b.t === 'h') {
            const size = b.level === 1 ? 15 : b.level === 2 ? 13.5 : 12.5;
            const mt = b.level === 1 ? 4 : b.level === 2 ? 16 : 12;
            return h('div', {
              key: i,
              style: {
                fontSize: size, fontWeight: 650, margin: `${mt}px 0 6px`,
                paddingBottom: b.level === 1 ? 6 : 0,
                borderBottom: b.level === 1 ? `1px solid ${C.border}` : 'none',
                lineHeight: 1.5,
              },
            }, renderInline(b.text, `h${i}`));
          }
          if (b.t === 'quote') {
            return h('div', {
              key: i,
              style: {
                margin: '8px 0', padding: '6px 10px', fontSize: 11.5, color: C.dim,
                borderLeft: `3px solid ${C.border}`, background: C.pill, borderRadius: '0 6px 6px 0',
                lineHeight: 1.75,
              },
            }, renderInline(b.text, `q${i}`));
          }
          if (b.t === 'ul' || b.t === 'ol') {
            return h('div', { key: i, style: { margin: '4px 0' } },
              b.items.map((it, j) => h('div', {
                key: `${i}-${j}`,
                style: { paddingLeft: 14, textIndent: -14, fontSize: 12, lineHeight: 1.8 },
              }, `${b.t === 'ol' ? `${j + 1}.` : '·'} ${''}`,
              renderInline(it, `l${i}-${j}`))));
          }
          if (b.t === 'table') {
            const headRow = h('tr', null, b.head.map((c, ci) => h('th', {
              key: `h${ci}`,
              style: {
                textAlign: 'left', padding: '5px 8px', fontSize: 11.5, fontWeight: 600,
                background: C.pill, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
              },
            }, renderInline(c, `th${i}${ci}`))));

            const bodyRows = b.rows.map((row, r) => {
              const tds = row.map((c, ci) => h('td', {
                key: `c${ci}`,
                style: { padding: '5px 8px', verticalAlign: 'top', lineHeight: 1.65 },
              }, renderInline(c, `td${i}${r}${ci}`)));
              return h('tr', {
                key: `r${r}`, style: { borderBottom: `1px solid ${C.border}` },
              }, tds);
            });

            const tableEl = h('table', {
              style: { borderCollapse: 'collapse', width: '100%', fontSize: 11.5 },
            }, [
              h('thead', { key: 'head' }, headRow),
              h('tbody', { key: 'body' }, bodyRows),
            ]);

            return h('div', {
              key: i, style: { margin: '8px 0', overflowX: 'auto' },
            }, tableEl);
          }
          return h('div', {
            key: i, style: { margin: '5px 0', lineHeight: 1.85 },
          }, renderInline(b.text, `p${i}`));
        }));
    }

    // 路径太长时不换行、不撑破面板：保留首段与末两级，中间省略；tooltip 给全路径
    function shortPath(p) {
      const s = String(p || '');
      if (s.length <= 48) return s;
      const sep = s.includes('\\') ? '\\' : '/';
      const parts = s.split(/[\\/]+/).filter(Boolean);
      if (parts.length <= 3) return `${s.slice(0, 22)}…${s.slice(-22)}`;
      return `${parts[0]}${sep}…${sep}${parts.slice(-2).join(sep)}`;
    }

    function PathChip({ label, path, hint }) {
      const [hover, setHover] = useState(false);
      const [done, setDone] = useState(false);
      const text = String(path || '');
      const doCopy = async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch { /* 剪贴板不可用时静默，tooltip 仍可手动选 */ }
      };
      return h('div', {
        title: hint || text,
        onClick: doCopy,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
          marginTop: 4, borderRadius: 7, background: C.code, cursor: 'pointer',
          border: `1px solid ${hover ? C.border : 'transparent'}`, fontSize: 11, minWidth: 0,
        },
      }, [
        label ? h('span', { key: 'l', style: { color: C.dim, flex: '0 0 auto' } }, label) : null,
        h('code', {
          key: 'p',
          style: {
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', fontSize: 11,
          },
        }, shortPath(text)),
        h('span', {
          key: 'c', style: { color: done ? C.low : C.dim, flex: '0 0 auto' },
        }, done ? '已复制' : '复制'),
      ]);
    }

    function InstructionCard({ tasks, onCopy, copied }) {
      const meta = [
        ['任务', `${tasks.tasks} 段`],
        ['提示词', `${tasks.prompts} 条`],
        ['文风', tasks.textStyle === 'academic' ? '学术润色' : '平实五条'],
      ];
      return h('div', {
        style: {
          marginTop: 9, border: `1px solid ${C.border}`, borderRadius: 10,
          background: C.card, padding: 11,
        },
      }, [
        h('div', {
          key: 'h',
          style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' },
        }, [
          h('span', { key: 't', style: { fontSize: 12, fontWeight: 600 } }, '改写指令'),
          tasks.belowThreshold
            ? h('span', { key: 'w', style: { fontSize: 11, color: C.mid } }, '全文未达阈值，按相对排序取样')
            : null,
        ]),
        h('div', {
          key: 'lead',
          style: { fontSize: 11.5, color: C.dim, lineHeight: 1.7, marginBottom: 8 },
        }, `把它贴进对话：模型按提示词改写 ${tasks.tasks} 个段落，只产出编辑清单，不碰 docx。`),
        h('div', {
          key: 'meta', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
        }, meta.map(([k, v]) => h('span', {
          key: k,
          style: {
            fontSize: 11, padding: '2px 8px', borderRadius: 999, background: C.pill, color: C.dim,
          },
        }, `${k} ${v}`))),
        h(PathChip, { key: 'pp', label: '提示词', path: tasks.promptsPath }),
        h(PathChip, { key: 'ep', label: '编辑清单', path: tasks.editsPath }),
        h('div', {
          key: 'cl', style: { margin: '9px 0 3px', fontSize: 11, color: C.dim },
        }, '约束'),
        ...(tasks.constraints ?? []).map((c, i) => h('div', {
          key: `c${i}`,
          style: {
            fontSize: 11.5, color: C.dim, lineHeight: 1.75, paddingLeft: 11, textIndent: -11,
          },
        }, `· ${c}`)),
        h('div', {
          key: 'next', style: { fontSize: 11, color: C.dim, marginTop: 8, lineHeight: 1.6 },
        }, '模型写完后，回到这里点「回填并复检」。'),
        h('div', { key: 'b', style: { display: 'flex', gap: 8, marginTop: 9 } }, [
          h(Btn, { key: 'c', onClick: onCopy, primary: true }, copied ? '已复制' : '复制整段指令'),
        ]),
      ]);
    }

    function Step({ n, title, hint, active, done }) {
      const color = done ? C.low : active ? C.accent : C.dim;
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 },
      }, [
        h('span', {
          key: 'n',
          style: {
            width: 18, height: 18, borderRadius: 999, background: C.pill, color,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 600, flex: '0 0 auto',
          },
        }, done ? '✓' : n),
        h('span', { key: 't', style: { fontWeight: 500 } }, title),
        hint ? h('span', { key: 'h', style: { color: C.dim, fontSize: 11 } }, hint) : null,
      ]);
    }

    // AIGC 考官的 9 个维度：键 → 中文名 → 数值摘要
    const AIGC_DIMS = [
      ['template', '模板套话', (v) => `${v.count} 处 · ${v.per_1000_chars}/千字`],
      ['passive', '被动句', (v) => `${v.count} 处 · ${v.per_sentence}/句`],
      ['burstiness', '句长起伏', (v) => `CV ${v.cv}（${v.level}）`],
      ['symmetry', '结构对称', (v) => `${(v.runs ?? []).length} 组`],
      ['nested', '层层嵌套', (v) => `${v.count} 层`],
      ['colon', '冒号列举', (v) => `${v.count} 处`],
      ['punct', '标点节奏', (v) => `${v.commas_per_sentence} 逗号/句`],
      ['colloquial', '口语化', (v) => `${v.count} 个${v.gate_failed ? ' · 门禁未过' : ''}`],
      ['dash', '破折号', (v) => `${v.total} 处${v.gate_failed ? ' · 超限' : ''}`],
    ];

    function ProbBar({ value, color }) {
      const pct = Math.max(2, Math.min(100, Math.round((value ?? 0) * 100)));
      return h('div', {
        style: { height: 5, borderRadius: 3, background: C.pill, overflow: 'hidden', width: 54 },
      }, h('div', { style: { width: `${pct}%`, height: '100%', background: color } }));
    }

    function AigcCard({ status, score, diag, delta, aiLabel, target, onTarget, onScore, onDiag,
      onSelftest, onCalibrate, onDelta, onCopy, copied, busy }) {      const dry = status?.detectorReady === false || status?.mode === 'dry-run';
      const r = score?.result;
      const d = diag?.result;
      const prob = r ? Number(r.ai_prob) : null;
      const probColor = prob == null ? C.dim : prob >= 0.65 ? C.high : prob >= 0.4 ? C.mid : C.low;
      const setup = status?.setup;

      const segRow = (seg) => {
        const p = Number(seg.ai_prob);
        const col = p >= 0.65 ? C.high : p >= 0.4 ? C.mid : C.low;
        return h('div', {
          key: `s${seg.index}`,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 11.5 },
        }, [
          h('code', { key: 'i', style: { fontSize: 11, color: C.dim, width: 16 } }, seg.index),
          h(ProbBar, { key: 'b', value: p, color: col }),
          h('span', {
            key: 'p', style: { width: 42, textAlign: 'right', color: col, fontSize: 11 },
          }, `${(100 * p).toFixed(0)}%`),
          h('span', {
            key: 't', style: { flex: 1, minWidth: 0, color: C.dim, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, seg.preview || ''),
        ]);
      };

      return h('div', {
        style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: 11, background: C.card },
      }, [
        h('div', {
          key: 'h',
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
        }, [
          h('span', { key: 't', style: { fontSize: 12, fontWeight: 600 } }, 'AIGC 考官'),
          h('span', { key: 'm', style: { fontSize: 11, color: C.dim } }, '模型检测 + 9 维痕迹'),
          h('span', { key: 's', style: { flex: 1 } }),
          h(Pill, {
            key: 'p', tone: dry ? 'warn' : 'ok', title: status?.note,
          }, dry ? 'dry-run 伪概率' : '真机'),
          aiLabel != null ? h(Pill, {
            key: 'al', tone: 'ok', title: '标签方向已标定（0/1 哪个代表 AI）',
          }, `已标定 ${aiLabel}`) : null,
          h(Btn, { key: 'st', onClick: onSelftest, disabled: busy === 'selftest' }, '自检'),
          h(Btn, {
            key: 'cl', onClick: onCalibrate, disabled: busy === 'aigcCalib',
            title: '标定 0/1 哪个代表 AI（真机必做）',
          }, busy === 'aigcCalib' ? '校准中…' : '校准'),        ]),
        h('div', {
          key: 'what',
          style: { fontSize: 11, color: C.dim, lineHeight: 1.75, marginBottom: 8 },
        }, [
          h('div', { key: '1' },
            '这页三步：① 给整篇打一个「像不像 AI 写的」概率 → ② 看 9 类 AI 痕迹体检 → ③ 把痕迹要求交给改写。'),
          h('div', { key: '2' },
            '读法：概率 0–100%，越高越像 AI；9 维里带黄点的是本轮要改的点；「改写作业清单」就是下一轮改写的具体要求。'),
        ]),

        dry ? h('div', {
          key: 'setup',
          style: {
            border: `1px dashed ${C.border}`, borderRadius: 8, padding: 10,
            marginBottom: 8, background: C.code,
          },
        }, [
          h('div', { key: 'why-h', style: { fontSize: 11.5, color: C.mid, fontWeight: 600, marginBottom: 4 } },
            '为什么是 dry-run'),
          h('div', { key: 'why', style: { fontSize: 11, color: C.dim, lineHeight: 1.7, marginBottom: 6 } },
            `插件在下面这个 python 里没找到 transformers + torch，加载不了模型，`
            + `于是用「文本哈希 → 确定性伪随机数」占位：同一段文本每次得到同一个数，但那个数和文本质量无关。`),

          h('div', { key: 'bad-h', style: { fontSize: 11.5, color: C.high, fontWeight: 600, marginBottom: 4 } },
            '它的缺点（所以别拿它当结论）'),
          h('div', { key: 'bad', style: { fontSize: 11, color: C.dim, lineHeight: 1.75, marginBottom: 6 } }, [
            h('div', { key: '1' }, '· 数值没有意义：改写前后那点差值（如 49.7% → 48.6%）是随机差，不是真实降幅'),
            h('div', { key: '2' }, '· 不能验收：无法判断某次改写到底有没有降低 AIGC 概率'),
            h('div', { key: '3' }, '· 唯一真实的是 9 维诊断：diag.py 是纯正则，不依赖模型，任何机器都能用'),
          ]),

          h('div', { key: 'steps-h', style: { fontSize: 11.5, color: C.dim, fontWeight: 600, marginBottom: 4 } },
            '切到真机：三步，约 1.2GB 磁盘'),
          h('div', {
            key: 's1', style: { display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 6 },
          }, [
            h('span', { key: 'n', style: { fontSize: 11, color: C.dim, paddingTop: 1 } }, '1'),
            h('div', { key: 'b', style: { flex: 1, minWidth: 0 } }, [
              h('div', { key: 't', style: { fontSize: 11, color: C.dim, marginBottom: 2 } },
                '装依赖（必须装进下面这个解释器）'),
              h('code', {
                key: 'c', style: { fontSize: 10.5, display: 'block', wordBreak: 'break-all', lineHeight: 1.6 },
              }, setup?.step1Install || 'pip install -r aigc/requirements.txt'),
            ]),
            h(Btn, {
              key: 'cp', onClick: () => onCopy?.('install', setup?.step1Install || ''),
            }, copied === 'install' ? '已复制' : '复制'),
          ]),
          h('div', { key: 's2', style: { display: 'flex', gap: 6, marginBottom: 6 } }, [
            h('span', { key: 'n', style: { fontSize: 11, color: C.dim, paddingTop: 1 } }, '2'),
            h('div', { key: 't', style: { flex: 1, minWidth: 0, fontSize: 11, color: C.dim, lineHeight: 1.7 } }, [
              h('div', { key: 'a' }, '下模型权重（首次打分时自动下载；也可先手动下好）'),
              h('div', { key: 'u', style: { wordBreak: 'break-all' } },
                '下载页：https://huggingface.co/yuchuantian/AIGC_detector_zhv3'),
              h('div', { key: 'p', style: { wordBreak: 'break-all' } },
                `落盘目录（默认缓存）：${status?.setup?.modelCacheDir || 'C:\\Users\\<你>\\.cache\\huggingface\\hub\\models--yuchuantian--AIGC_detector_zhv3'}`),
              h('div', { key: 'm' },
                '国内镜像：先执行 set HF_ENDPOINT=https://hf-mirror.com 再跑第 3 步'),
              h('div', { key: 's' }, '体积：约 818MB（pytorch_model.bin + vocab.txt + config/tokenizer）'),
            ]),
            h(Btn, {
              key: 'cp2',
              onClick: () => onCopy?.('modelurl', 'https://huggingface.co/yuchuantian/AIGC_detector_zhv3'),
            }, copied === 'modelurl' ? '已复制' : '复制链接'),
          ]),
          h('div', { key: 's3', style: { display: 'flex', gap: 6, marginBottom: 4 } }, [
            h('span', { key: 'n', style: { fontSize: 11, color: C.dim, paddingTop: 1 } }, '3'),
            h('div', { key: 't', style: { flex: 1, minWidth: 0 } }, [
              h('div', { key: 'a', style: { fontSize: 11, color: C.dim } },
                '校准标签方向（该模型 config 缺 id2label，0/1 谁是 AI 未知；不校准会读反且不报错）'),
              h('code', {
                key: 'c', style: { fontSize: 10.5, display: 'block', wordBreak: 'break-all', marginTop: 2 },
              }, setup?.step3Calibrate || ''),
            ]),
            h(Btn, {
              key: 'cp3', onClick: () => onCopy?.('calib', setup?.step3Calibrate || ''),
            }, copied === 'calib' ? '已复制' : '复制'),
          ]),
          h('div', {
            key: 'py', style: { fontSize: 10.5, color: C.dim, marginTop: 6, wordBreak: 'break-all' },
          }, `当前解释器：${status?.python || pythonBinFallback}`),
          h('div', {
            key: 'tip', style: { fontSize: 10.5, color: C.subtle, marginTop: 2 },
          }, '装完仍是 dry-run？多半是装到了别的 venv：在「设置」里把解释器路径改成那个 python.exe，然后点「校准」。'),
        ]) : null,

        h('div', {
          key: 'bar',
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 },
        }, [
          h('div', { key: 'seg', style: { display: 'flex', borderRadius: 7, overflow: 'hidden',
            border: `1px solid ${C.border}` } },
          ['original', 'rewritten'].map((t, i) => h('button', {
            key: t, type: 'button', onClick: () => onTarget(t),
            style: {
              padding: '4px 10px', fontSize: 11, cursor: 'pointer', border: 'none',
              background: target === t ? C.accent : 'transparent',
              color: target === t ? '#fff' : C.dim,
              borderLeft: i ? `1px solid ${C.border}` : 'none',
            },
          }, t === 'original' ? '原文' : '改稿'))),
          h(Btn, { key: 'sc', onClick: onScore, primary: true, disabled: busy === 'aigcScore' },
            busy === 'aigcScore' ? '检测中…' : '检测 AIGC 率'),
          h(Btn, { key: 'dg', onClick: onDiag, disabled: busy === 'aigcDiag' },
            busy === 'aigcDiag' ? '体检中…' : 'AI 痕迹体检'),
          h(Btn, {
            key: 'dl', onClick: onDelta, disabled: busy === 'aigcDelta',
            title: '对原文和改稿各打一次分，看差了多少',
          }, busy === 'aigcDelta' ? '对比中…' : '前后对比'),
        ]),

        delta ? h('div', {
          key: 'delta',
          style: {
            display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
            padding: '6px 0', marginTop: 2,
          },
        }, [
          h('span', { key: 'l', style: { fontSize: 11, color: C.dim } }, '改写前后'),
          h('span', { key: 'b', style: { fontSize: 14, fontWeight: 600 } },
            `${(100 * delta.before).toFixed(1)}%`),
          h('span', { key: 'a', style: { color: C.dim } }, '→'),
          h('span', {
            key: 'c',
            style: {
              fontSize: 14, fontWeight: 600,
              color: delta.delta > 0 ? C.low : delta.delta < 0 ? C.high : C.dim,
            },
          }, `${(100 * delta.after).toFixed(1)}%`),
          h('span', {
            key: 'd',
            style: { fontSize: 11, color: delta.delta > 0 ? C.low : delta.delta > -0.0001 ? C.dim : C.high },
          }, `${delta.delta >= 0 ? '降' : '升'} ${Math.abs(100 * delta.delta).toFixed(1)} 个百分点`),
          delta.mode !== 'model'
            ? h('span', { key: 'w', style: { fontSize: 10.5, color: C.mid } }, '（dry-run 占位值，不算数）')
            : null,
        ]) : null,

        r ? h('div', { key: 'score' }, [
          h('div', {
            key: 'num',
            style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 },
          }, [
            h('span', { key: 'v', style: { fontSize: 26, fontWeight: 700, color: probColor, lineHeight: 1.1 } },
              `${(100 * prob).toFixed(1)}%`),
            h('span', { key: 'l', style: { fontSize: 11, color: C.dim } },
              `AI 概率 ｜ ${r.chars} 字 ｜ ${(r.segments ?? []).length} 段${score.mode === 'model' ? '' : '（占位）'}`),
          ]),
          ...(r.segments ?? []).slice(0, 8).map(segRow),
        ]) : null,

        d ? h('div', { key: 'diag', style: { marginTop: 9 } }, [
          h('div', {
            key: 'sum',
            style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
          }, [
            h('span', {
              key: 'r',
              style: { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: C.pill,
                color: d.risk_count ? C.mid : C.low },
            }, `风险 ${d.risk_count} 项`),
            h('span', {
              key: 'l',
              style: { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: C.pill, color: C.dim },
            }, `等级 ${d.level}`),
            h('span', {
              key: 'g',
              title: `全文口径：${diag?.gateAll ? '通过' : '未通过'}（含锁定段；锁定段永不改写）`,
              style: {
                fontSize: 11, padding: '2px 8px', borderRadius: 999, background: C.pill,
                color: (diag?.gateRewritable ?? d.style_gate_passed) ? C.low : C.high,
              },
            }, `语体门禁（可改写段） ${(diag?.gateRewritable ?? d.style_gate_passed) ? '通过' : '未通过'}`),
          ]),
          h('div', {
            key: 'grid',
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 4 },
          }, AIGC_DIMS.map(([key, label, fmt]) => {
            const v = d[key];
            if (!v) return null;
            const bad = Boolean(v.risk) || Boolean(v.gate_failed);
            return h('div', {
              key,
              style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '2px 0' },
            }, [
              h(Dot, { key: 'd', color: bad ? C.mid : C.pill, size: 6 }),
              h('span', { key: 'l', style: { color: C.dim, minWidth: 58 } }, label),
              h('span', { key: 'v', style: { color: bad ? 'inherit' : C.dim } }, fmt(v)),
            ]);
          })),
          (d.todo ?? []).length ? h('div', { key: 'todo', style: { marginTop: 8 } }, [
            h('div', { key: 'h', style: { fontSize: 11, color: C.dim, marginBottom: 3 } }, '改写作业清单'),
            ...d.todo.map((t, i) => h('div', {
              key: `t${i}`,
              style: { fontSize: 11.5, lineHeight: 1.75, paddingLeft: 11, textIndent: -11 },
            }, `· ${t}`)),
          ]) : null,
        ]) : null,
      ]);
    }

    // 「降 AIGC」：把 9 维痕迹诊断转成改写要求，跑完回填再用 diag/检测器复检
    function ReduceCard({ mode, plan, check, busy, onPlan, onCheck }) {
      const isBoth = mode === 'both';
      const d = check?.diag;
      const p = check?.prob;
      const delta = (a, b, unit = '') => {
        const v = a - b;
        const color = v > 0 ? C.low : v < 0 ? C.high : C.dim;
        return h('span', { style: { color } }, `${v > 0 ? '↓' : v < 0 ? '↑' : '='}${Math.abs(v)}${unit}`);
      };
      return h('div', {
        style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: 11, background: C.card },
      }, [
        h('div', {
          key: 'h', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
        }, [
          h('span', { key: 't', style: { fontSize: 12, fontWeight: 600 } },
            isBoth ? '双降：一次改写同时降重 + 降 AI' : '降 AIGC：痕迹 → 改写 → 复检'),
          h('span', { key: 's', style: { fontSize: 11, color: C.dim } },
            isBoth ? '痕迹要求与消重要求写进同一批提示词' : '把 9 维结论注入提示词再回填'),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h(Btn, { key: 'p', onClick: onPlan, primary: true, disabled: busy === 'reducePlan' },
            busy === 'reducePlan' ? '生成中…' : (isBoth ? '生成双降任务' : '生成降 AI 任务')),
          h(Btn, { key: 'c', onClick: onCheck, disabled: busy === 'reduceCheck' },
            busy === 'reduceCheck' ? '复检中…' : '复检痕迹'),
        ]),

        plan ? h('div', { key: 'plan', style: { marginBottom: 8 } }, [
          h('div', { key: 'meta', style: { fontSize: 11, color: C.dim, marginBottom: 4 } },
            `任务 ${plan.tasks} 段 ｜ 提示词 ${plan.prompts} 条 ｜ 要求 ${plan.hints.length} 条`
            + ` ｜ 诊断前：风险 ${plan.diagBefore.riskCount} 项 / 分数 ${plan.diagBefore.riskScore}`),
          (plan.opCount && Object.keys(plan.opCount).length) ? h('div', {
            key: 'ops', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
          }, [
            h('span', { key: 'l', style: { fontSize: 11, color: C.dim } }, '本批算子'),
            ...Object.entries(plan.opCount).map(([op, n]) => h('span', {
              key: op,
              style: {
                fontSize: 10.5, padding: '1px 7px', borderRadius: 999,
                background: C.pill, color: op === 'O9' ? C.low : C.dim,
              },
            }, `${op}×${n}`)),
          ]) : null,
          plan.scope === 'both' ? h('div', {
            key: 'bothnote', style: { fontSize: 10.5, color: C.subtle, lineHeight: 1.7, marginBottom: 6 },
          }, `双降前提：篇内重复率 ${(100 * (plan.repeatBefore ?? 0)).toFixed(1)}%。`
            + `引擎只在「单段重复占比 ≥ 45%」时才归因为内部重复并派 O9；`
            + (plan.opCount?.O9
              ? `本批含 O9×${plan.opCount.O9}，即重复段与 AI 痕迹段一起改。`
              : '本篇没有这样的段落，所以本批任务由 AIGC 侧驱动（没有可合并的重复段）。')) : null,
          (plan.focus ?? []).length ? h('div', {
            key: 'focus',
            style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
          }, [
            h('span', { key: 'l', style: { fontSize: 11, color: C.dim } }, '定向纳入'),
            ...plan.focus.map((f) => h('span', {
              key: f.pid,
              title: `命中：${f.tags.join(' / ')}`,
              style: {
                fontSize: 10.5, padding: '1px 7px', borderRadius: 999,
                background: C.pill, color: f.tags.includes('colloquial') || f.tags.includes('dash')
                  ? C.mid : C.dim,
              },
            }, `${f.pid} ${f.tags.join('/')}`)),
          ]) : null,
          plan.pacing && plan.pacing.targets ? h('div', {
            key: 'pacing',
            style: { fontSize: 10.5, color: C.subtle, marginBottom: 6 },
          }, `跨段编排：${plan.pacing.runs} 条对称段串 → ${plan.pacing.targets} 段拿到不同目标句数（破「结构对称」）`) : null,
          ...plan.hints.slice(0, 8).map((hint, i) => h('div', {
            key: `h${i}`,
            style: { fontSize: 11.5, lineHeight: 1.7, paddingLeft: 11, textIndent: -11, color: C.dim },
          }, `· ${hint}`)),
          h('div', { key: 'next', style: { fontSize: 10.5, color: C.subtle, marginTop: 4 } },
            '下一步：让模型按 prompts.jsonl 写 edits.jsonl → 点「预检」→「回填并复检」→「三栏对照」。'),
        ]) : null,

        d ? h('div', {
          key: 'check',
          style: { borderTop: `1px solid ${C.border}`, paddingTop: 7, fontSize: 11.5 },
        }, [
          h('div', { key: 'a', style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 3 } }, [
            h('span', { key: '1', style: { color: C.dim } }, '风险项'),
            h('span', { key: '2' }, `${d.before.riskCount} → ${d.after.riskCount}`),
            delta(d.before.riskCount, d.after.riskCount, ' 项'),
            h('span', { key: '3', style: { color: C.dim, marginLeft: 8 } }, '风险分'),
            h('span', { key: '4' }, `${d.before.riskScore} → ${d.after.riskScore}`),
            delta(d.before.riskScore, d.after.riskScore, ''),
          ]),
          h('div', { key: 'b', style: { display: 'flex', gap: 10, flexWrap: 'wrap', color: C.dim } }, [
            h('span', { key: '1' },
              `语体门禁（可改写段） ${d.before.gate ? '过' : '未过'} → ${d.after.gate ? '过' : '未过'}`),
            d.before.gateAll !== undefined
              ? h('span', { key: '1b', style: { opacity: 0.75 } },
                `｜ 全文 ${d.before.gateAll ? '过' : '未过'} → ${d.after.gateAll ? '过' : '未过'}`)
              : null,
            p ? h('span', {
              key: '2',
              style: { color: p.mode === 'model' ? 'inherit' : C.mid },
            }, `AIGC 概率 ${(100 * p.before).toFixed(1)}% → ${(100 * p.after).toFixed(1)}%`
              + (p.mode === 'model' ? '' : '（dry-run 占位值，不算数）')) : null,
          ]),
          (check.pacing && check.pacing.after != null) ? h('div', {
            key: 'pac', style: { display: 'flex', gap: 10, flexWrap: 'wrap', color: C.dim, marginTop: 3 },
          }, [
            h('span', { key: '1' }, '对称串'),
            h('span', { key: '2' },
              `原点 ${check.pacing.origin ?? '—'} → 当前 ${check.pacing.after}`),
            h('span', {
              key: '3',
              style: { color: (check.pacing.deltaBatch ?? 0) > 0 ? C.low : C.dim },
            }, (check.pacing.deltaBatch ?? 0) > 0
              ? `本批 ↓${check.pacing.deltaBatch}`
              : '本批未拆到串'),
            h('span', { key: '4', style: { opacity: 0.75 } },
              `累计 ↓${check.pacing.deltaTotal ?? 0}`),
          ]) : null,
          check.dup ? h('div', {            key: 'dup', style: { display: 'flex', gap: 10, flexWrap: 'wrap', color: C.dim, marginTop: 3 },
          }, [
            h('span', { key: '1' }, '篇内重复'),
            h('span', { key: '2' },
              `${(100 * (check.dup.before ?? 0)).toFixed(1)}% → ${(100 * check.dup.after).toFixed(1)}%`),
            check.dup.delta != null
              ? h('span', {
                key: '3',
                style: { color: check.dup.delta >= 0 ? C.low : C.high },
              }, `${check.dup.delta >= 0 ? '↓' : '↑'}${Math.abs(100 * check.dup.delta).toFixed(1)} 个百分点`)
              : null,
          ]) : null,
          d.todoAfter?.length ? h('div', {
            key: 'c', style: { marginTop: 4, fontSize: 11, color: C.dim },
          }, `剩余待改：${d.todoAfter.join('；')}`) : null,
        ]) : null,

        !plan && !d ? h('div', {
          key: 'empty', style: { fontSize: 11, color: C.dim, lineHeight: 1.7 },
        }, '点「生成降 AI 任务」：插件先跑 9 维诊断（离线可用），把结论写成改写要求注入每条提示词，'
          + '模型改完回填后，再点「复检痕迹」看风险项与分数是否下降。') : null,
      ]);
    }

    // ------------------------------------------------------------ 模式入口
    const MODES = [
      {
        id: 'dedupe', title: '降低篇内重复率', tag: '降重',
        desc: '只处理「自己抄自己」：13 字指纹找重复片段，合并/回指/概括，不动 AIGC 面。',
        bullets: ['离线可验：重复率前后对比', '不联网、不装模型', '改完 Word 格式零漂移'],
      },
      {
        id: 'aigc', title: '降低 AIGC 率', tag: '降 AI',
        desc: '9 维痕迹诊断（模板套话/被动/句长/对称/嵌套/冒号/标点/口语/破折号）→ 写进提示词 → 改写回填。',
        bullets: ['离线：9 维风险项与分数可验', '真机：检测器给概率前后对比', '语体门禁防改成大白话'],
      },
      {
        id: 'both', title: '双降', tag: '降重 + 降 AI',
        desc: '按设计顺序执行：先降重（稳定文本结构）→ 再降 AIGC（打磨语体），报告两者都含。',
        bullets: ['两个目标分开度量', '任一项恶化就回退', '报告含双降对比'],
      },
    ];

    function ModeHome({ docPath, onPath, onDiagnose, onHomeInput, busy, lastRun, mode, onMode }) {
      const ready = Boolean(lastRun);
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
        h('div', {
          key: 'intro', style: { fontSize: 12, color: C.dim, lineHeight: 1.8 },
        }, [
          h('div', { key: '1' }, '先填论文路径并诊断，再选一个模式进入对应工作流。'),
          h('div', { key: '2', style: { fontSize: 11 } },
            '三个模式共用同一条流水线（生成任务 → 模型写 edits.jsonl → 预检 → 回填 → 复检），只是关注点不同。'),
        ]),
        h('div', { key: 'input', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
          h('input', {
            key: 'p', value: docPath, placeholder: '论文 .docx 的绝对路径（只读，不改原文件）',
            onChange: (e) => onPath(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') onDiagnose(); },
            style: {
              flex: 1, padding: '8px 10px', fontSize: 12, borderRadius: 8,
              border: `1px solid ${C.border}`, background: 'transparent', color: 'inherit',
            },
          }),
          h(Btn, { key: 'run', onClick: onDiagnose, primary: true, disabled: busy === 'diagnose' },
            busy === 'diagnose' ? '诊断中…' : '诊断'),
        ]),
        lastRun ? h('div', {
          key: 'ready', style: { fontSize: 11, color: C.low },
        }, `已诊断：${(lastRun.docPath || '').split(/[\\/]/).pop()}（${lastRun.summary?.stats?.paragraphs ?? '—'} 段）`)
          : null,
        h('div', { key: 'cards', style: { display: 'grid', gap: 10 } },
        MODES.map((m) => h('div', {
          key: m.id,
          onClick: () => { if (ready) onMode(m.id); },
          style: {
            border: `1px solid ${ready ? C.border : C.pill}`, borderRadius: 10, padding: 12,
            cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.55,
            background: mode === m.id ? C.pill : C.card,
          },
        }, [
          h('div', {
            key: 'h', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
          }, [
            h('span', { key: 't', style: { fontSize: 13, fontWeight: 600 } }, m.title),
            h('span', {
              key: 'g', style: {
                fontSize: 10, padding: '1px 7px', borderRadius: 999, background: C.pill, color: C.dim,
              },
            }, m.tag),
            h('span', { key: 's', style: { flex: 1 } }),
            ready ? h('span', { key: 'go', style: { fontSize: 11, color: C.accent } }, '进入 →') : null,
          ]),
          h('div', { key: 'd', style: { fontSize: 11.5, color: C.dim, lineHeight: 1.7 } }, m.desc),
          h('div', { key: 'b', style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 } },
          m.bullets.map((b, i) => h('span', {
            key: i, style: { fontSize: 10.5, color: C.subtle },
          }, `· ${b}`))),
        ]))),
        !ready ? h('div', {
          key: 'hint', style: { fontSize: 11, color: C.subtle },
        }, '还没诊断：填路径后点「诊断」，三个模式会同时解锁。') : null,
      ]);
    }

    // 报告页里的「AIGC 复检」摘要（降重模式不需要）
    function buildAigcReport(mode, check, apply) {
      if (mode === 'dedupe') return '';
      const d = check?.diag;
      const p = check?.prob;
      const lines = [];
      if (d) {
        lines.push(
          '## AIGC 复检', '',
          '| 指标 | 改写前 | 改写后 |', '|---|---|---|',
          `| 风险项 | ${d.before.riskCount} | ${d.after.riskCount} |`,
          `| 风险分 | ${d.before.riskScore} | ${d.after.riskScore} |`,
          `| 语体门禁 | ${d.before.gate ? '通过' : '未通过'} | ${d.after.gate ? '通过' : '未通过'} |`,
        );
        if (p) {
          lines.push(`| AIGC 概率 | ${(100 * p.before).toFixed(1)}% | ${(100 * p.after).toFixed(1)}%`
            + `${p.mode === 'model' ? '' : '（dry-run 占位）'} |`);
        }
      }
      if (apply?.verdict) {
        lines.push('', `- 改写接受 ${apply.apply?.applied ?? '—'} 段 / 拒绝 ${apply.apply?.rejected ?? '—'} 段`);
        lines.push(`- 篇级复检：${apply.verdict.passed ? '通过' : '未通过（已整篇回退）'}｜字数 ${apply.verdict.chars[0]}→${apply.verdict.chars[1]}`);
      }
      return lines.join('\n');
    }

    // ------------------------------------------------------------ 报告页
    function ReportCard({ mode, metrics, report, extraMarkdown, onCopy, copied, onClose }) {
      const modeTitle = MODES.find((m) => m.id === mode)?.title || '报告';
      return h('div', {
        style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, background: C.card },
      }, [
        h('div', {
          key: 'h', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 },
        }, [
          h('span', { key: 't', style: { fontSize: 13, fontWeight: 650 } }, `${modeTitle} · 报告`),
          h('span', { key: 's', style: { flex: 1 } }),
          h(Btn, { key: 'c', onClick: () => onCopy?.('report', report || '') },
            copied === 'report' ? '已复制' : '复制 Markdown'),
          h(Btn, { key: 'x', onClick: onClose }, '收起'),
        ]),
        (metrics ?? []).length ? h('div', {
          key: 'm', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
        }, (metrics ?? []).map((x) => h('span', {
          key: x.label,
          style: {
            fontSize: 11, padding: '3px 9px', borderRadius: 999, background: C.pill,
            color: x.tone === 'bad' ? C.high : x.tone === 'warn' ? C.mid : x.tone === 'ok' ? C.low : C.dim,
          },
        }, `${x.label} ${x.value}`))) : null,
        extraMarkdown ? h('div', {
          key: 'extra', style: { marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${C.border}` },
        }, h(Markdown, { text: extraMarkdown })) : null,
        h('div', { key: 'body', style: { maxHeight: 440, overflow: 'auto', paddingRight: 4 } },
          h(Markdown, { text: report || '（报告为空）' })),
      ]);
    }

    function TopTable({ rows, open, onToggle }) {
      const grid = '58px 96px 52px 1fr 58px';
      const head = { display: 'grid', gridTemplateColumns: grid, gap: 6, padding: '6px 9px' };
      const cell = { display: 'grid', gridTemplateColumns: grid, gap: 6, alignItems: 'center' };
      return h('div', null, [
        h('div', {
          key: 'hd',
          style: {
            ...head, fontSize: 11, color: C.dim, background: C.pill,
            borderBottom: `1px solid ${C.border}`,
          },
        }, [
          h('span', { key: '1' }, '段落'),
          h('span', { key: '2', title: '篇内相对风险分（0~1），不是百分比' }, '风险分 0–1'),
          h('span', { key: '3' }, '等级'),
          h('span', { key: '4' }, '主因 · 算子'),
          h('span', { key: '5', style: { textAlign: 'right' } }, '字数'),
        ]),
        ...rows.map((row) => h('div', { key: row.pid }, [
          h('div', {
            key: 'r',
            onClick: () => onToggle(row.pid),
            style: {
              ...cell, padding: '7px 9px', cursor: 'pointer',
              borderBottom: `1px solid ${C.border}`, fontSize: 12,
            },
          }, [
            h('code', { key: '1', style: { fontSize: 11 } }, row.pid),
            h('span', { key: '2', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
              h(Bar, { key: 'b', risk: row.risk, level: row.level }),
              h('span', { key: 'n', style: { fontSize: 11, color: C.dim, minWidth: 26 } },
                Number(row.risk).toFixed(2)),
            ]),
            h('span', { key: '3', style: { color: LEVEL_COLOR[row.level] || C.dim } },
              LEVEL[row.level] || row.level),
            h('span', { key: '4', style: { color: C.dim } },
              `${row.cause}${row.op && row.op !== '—' ? ` · ${row.op}` : ''}`),
            h('span', {
              key: '5', style: { color: C.dim, textAlign: 'right', whiteSpace: 'nowrap' },
            }, `${row.chars} 字`),
          ]),
          open === row.pid ? h('div', {
            key: 'body',
            style: {
              padding: '8px 9px 10px', fontSize: 12, lineHeight: 1.7,
              background: C.card, borderBottom: `1px solid ${C.border}`,
            },
          }, row.text || '（原文缺失）') : null,
        ])),
      ]);
    }

    function PaperIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('path', { key: 'd', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }),
        h('path', { key: 'f', d: 'M14 3v5h5' }),
        h('path', { key: 'a', d: 'M8.5 12.5h7' }),
        h('path', { key: 'b', d: 'M8.5 15.5h4' }),
      ]);
    }

    // ------------------------------------------------------------ Panel

    function Panel() {
      const [status, setStatus] = useState(null);
      const [docPath, setDocPath] = useState('');
      const [busy, setBusy] = useState('');
      const [result, setResult] = useState(null);
      const [tasks, setTasks] = useState(null);
      const [lint, setLint] = useState(null);
      const [apply, setApply] = useState(null);
      const [rows, setRows] = useState(null);
      const [mode, setMode] = useState(null);
      const [report, setReport] = useState(null);
      const [aigc, setAigc] = useState(null);
      const [aigcTarget, setAigcTarget] = useState('original');
      const [aigcScoreRes, setAigcScoreRes] = useState(null);
      const [aigcDiagRes, setAigcDiagRes] = useState(null);
      const [aigcDeltaRes, setAigcDeltaRes] = useState(null);
      const [reducePlanRes, setReducePlanRes] = useState(null);
      const [reduceCheckRes, setReduceCheckRes] = useState(null);
      const [error, setError] = useState('');
      const [msg, setMsg] = useState('');
      const [copied, setCopied] = useState('');
      const [open, setOpen] = useState('');
      const [engineInput, setEngineInput] = useState('');
      const [pyInput, setPyInput] = useState('');
      const [showSetup, setShowSetup] = useState(false);
      const alive = useRef(true);

      useEffect(() => () => { alive.current = false; }, []);

      const applyStatus = useCallback((s) => {
        setStatus(s);
        if (s?.lastRun) {
          setResult((prev) => prev ?? {
            docPath: s.lastRun.docPath, at: s.lastRun.at, outdir: s.lastRun.outdir,
            summary: s.lastRun.summary,
          });
          setDocPath((p) => p || s.lastRun.docPath);
        }
        if (s?.lastTasks) setTasks((prev) => prev ?? s.lastTasks);
        if (s?.lastApply) setApply((prev) => prev ?? s.lastApply);
      }, []);

      const refresh = useCallback(async () => {
        try {
          const s = await getJson(`${PREFIX}/status`);
          if (alive.current) applyStatus(s);
        } catch (e) {
          if (alive.current) setError(`读状态失败：${e?.message ?? e}`);
        }
        try {
          const a = await getJson(`${PREFIX}/aigc/status`);
          if (alive.current && a?.ok) setAigc(a);
        } catch { /* 考官不可用不阻塞面板 */ }
      }, [applyStatus]);

      useEffect(() => {
        refresh();
        try {
          const saved = localStorage.getItem('dsh-paper-dual:doc');
          if (saved) setDocPath((p) => p || saved);
          const savedMode = localStorage.getItem('dsh-paper-dual:mode');
          if (savedMode) setMode((m) => m || savedMode);
        } catch { /* ignore */ }
      }, [refresh]);

      const copy = useCallback(async (key, text) => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(key);
          setTimeout(() => { if (alive.current) setCopied(''); }, 1400);
        } catch {
          setMsg('复制失败：浏览器拒绝了剪贴板权限');
        }
      }, []);

      const wrapBusy = useCallback(async (label, fn) => {
        setBusy(label);
        setError('');
        setMsg('');
        try { await fn(); } finally { if (alive.current) setBusy(''); }
      }, []);

      const enterMode = useCallback((m) => {
        setMode(m);
        setError('');
        setMsg('');
        try { localStorage.setItem('dsh-paper-dual:mode', m); } catch { /* ignore */ }
      }, []);

      const exitMode = useCallback(() => {
        setMode(null);
        setError('');
        setMsg('');
      }, []);

      const runDiagnose = useCallback(() => wrapBusy('diagnose', async () => {
        const p = String(docPath || '').trim();
        if (!p) { setError('先填论文 .docx 的绝对路径'); return; }
        const r = await postJson(`${PREFIX}/diagnose`, { path: p });
        if (!alive.current) return;
        if (!r.ok) { setError(`${r.error}${r.hint ? `（${r.hint}）` : ''}`); return; }
        setResult(r);
        setTasks(null); setLint(null); setApply(null); setRows(null); setReport(null);
        setMsg('诊断完成');
        try { localStorage.setItem('dsh-paper-dual:doc', p); } catch { /* ignore */ }
        refresh();
      }), [docPath, refresh, wrapBusy]);

      const runTasks = useCallback(() => wrapBusy('tasks', async () => {
        const r = await postJson(`${PREFIX}/rewrite`, {});
        if (!alive.current) return;
        if (!r.ok) { setError(r.error); return; }
        setTasks(r);
        setMsg(`已生成 ${r.tasks} 段任务 / ${r.prompts} 条提示词`);
      }), [wrapBusy]);

      const runLintNow = useCallback(() => wrapBusy('lint', async () => {
        const r = await postJson(`${PREFIX}/lint`, {});
        if (!alive.current) return;
        if (!r.ok) { setError(r.error); return; }
        setLint(r);
        setMsg(`预检：可通过 ${r.counts?.would_apply ?? 0} ｜ 会被拒 ${r.counts?.would_reject ?? 0}`);
      }), [wrapBusy]);

      const runApplyNow = useCallback(() => wrapBusy('apply', async () => {
        const r = await postJson(`${PREFIX}/apply`, {});
        if (!alive.current) return;
        if (!r.ok) { setError(r.error); return; }
        setApply(r);
        setLint(r.lint ? { counts: r.lint, rejected: lint?.rejected ?? [] } : lint);
        setMsg(r.verdict?.passed ? '回填并复检通过' : '复检未通过，已按规则处理');
        const cmp = await getJson(`${PREFIX}/compare`);
        if (alive.current && cmp?.ok) setRows(cmp.rows ?? []);
        refresh();
      }), [lint, refresh, wrapBusy]);

      const runAigcScore = useCallback(() => wrapBusy('aigcScore', async () => {
        const r = await postJson(`${PREFIX}/aigc/score`, { target: aigcTarget });
        if (!alive.current) return;
        if (!r.ok) { setError(r.error); return; }
        setAigcScoreRes(r);
        setMsg(r.mode === 'model' ? 'AIGC 打分完成（真机）' : 'AIGC 打分完成（dry-run 伪概率，仅验流程）');
      }), [aigcTarget, wrapBusy]);

      const runAigcDiag = useCallback(() => wrapBusy('aigcDiag', async () => {
        const r = await postJson(`${PREFIX}/aigc/diag`, { target: aigcTarget });
        if (!alive.current) return;
        if (!r.ok) { setError(r.error); return; }
        setAigcDiagRes(r);
        setMsg(`9 维诊断完成：风险 ${r.result?.risk_count ?? 0} 项 ｜ 等级 ${r.result?.level ?? '—'}`);
      }), [aigcTarget, wrapBusy]);

      const runSelftest = useCallback(() => wrapBusy('selftest', async () => {
        const r = await postJson(`${PREFIX}/aigc/selftest`, {});
        if (!alive.current) return;
        setMsg(r.ok ? `考官自检通过（${r.passed}/${r.total}）` : `考官自检失败：${r.log ?? ''}`);
      }), [wrapBusy]);

      const runCalibrate = useCallback(() => wrapBusy('aigcCalib', async () => {
        const r = await postJson(`${PREFIX}/aigc/calibrate`, {});
        if (!alive.current) return;
        if (!r.ok) {
          setError(`${r.error}${r.hint ? `（${r.hint}）` : ''}`);
          return;
        }
        setMsg(`校准完成：ai_index=${r.aiLabel}${r.trusted === false ? '（gap 偏小，可信度低）' : ''}`);
        refresh();
      }), [refresh, wrapBusy]);

      const runDelta = useCallback(() => wrapBusy('aigcDelta', async () => {
        const r = await postJson(`${PREFIX}/aigc/delta`, {});
        if (!alive.current) return;
        if (!r.ok) { setError(r.error); return; }
        setAigcDeltaRes(r);
        setMsg(`前后对比：${(100 * r.before).toFixed(1)}% → ${(100 * r.after).toFixed(1)}%`);
      }), [wrapBusy]);

      const runReducePlan = useCallback(() => wrapBusy('reducePlan', async () => {
        const r = await postJson(`${PREFIX}/reduce/plan`, { scope: mode === 'both' ? 'both' : 'aigc' });
        if (!alive.current) return;
        if (!r.ok) { setReducePlanRes(null); setError(r.error); return; }
        setReducePlanRes(r);
        const opText = Object.entries(r.opCount ?? {}).map(([k, v]) => `${k}×${v}`).join(' ');
        setMsg(`已生成${r.scope === 'both' ? '双降' : '降 AI'}任务：${r.tasks} 段 / ${r.prompts} 条提示词 ｜ 算子 ${opText}`);
        refresh();
      }), [mode, refresh, wrapBusy]);

      const runReduceCheck = useCallback(() => wrapBusy('reduceCheck', async () => {
        const r = await postJson(`${PREFIX}/reduce/check`, {});
        if (!alive.current) return;
        if (!r.ok) { setError(r.error); return; }
        setReduceCheckRes(r);
        setMsg(`复检：风险 ${r.diag.before.riskCount}→${r.diag.after.riskCount} ｜ `
          + `分数 ${r.diag.before.riskScore}→${r.diag.after.riskScore}`);
      }), [wrapBusy]);

      const loadCompare = useCallback(() => wrapBusy('cmp', async () => {
        const r = await getJson(`${PREFIX}/compare`);
        if (!alive.current) return;
        if (!r?.ok) { setError(r?.error ?? '读对照失败'); return; }
        setRows(r.rows ?? []);
        if (!r.rows?.length) setMsg('还没有通过的改写，暂无对照');
      }), [wrapBusy]);

      const loadReport = useCallback(() => wrapBusy('report', async () => {
        if (report) { setReport(null); return; }
        const r = await getJson(`${PREFIX}/report?which=report.md`);
        if (!alive.current) return;
        setReport(r.ok ? (r.text || '（报告为空）') : r.error);
      }), [report, wrapBusy]);

      const saveEngine = useCallback(() => wrapBusy('setup', async () => {
        const ed = String(engineInput || '').trim();
        const py = String(pyInput || '').trim();
        if (!ed && !py) { setShowSetup(false); return; }
        const r = await postJson(`${PREFIX}/config`, { engineDir: ed, pythonPath: py });
        if (!alive.current) return;
        setEngineInput('');
        setPyInput('');
        setShowSetup(false);
        setMsg(`已保存 ｜ 引擎 ${r.engineDir} ｜ 解释器 ${r.pythonPath || 'PATH 上的 python'}`);
        refresh();
      }), [engineInput, pyInput, refresh, wrapBusy]);

      const s = result?.summary;
      const top = useMemo(() => s?.top ?? [], [s]);
      const stats = s?.stats ?? {};
      const verdict = apply?.verdict;

      const wrap = {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        padding: 14, gap: 11, boxSizing: 'border-box', overflowY: 'auto', fontSize: 13,
      };
      const card = { border: `1px solid ${C.border}`, borderRadius: 10, padding: 11, background: C.card };
      const sectionLabel = { fontSize: 11.5, color: C.dim, marginBottom: 6 };

      return h('div', { style: wrap }, [
        // 顶栏
        h('div', {
          key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        }, [
          h(PaperIcon, { key: 'i', size: 18 }),
          h('div', { key: 't', style: { fontSize: 15, fontWeight: 600 } }, '论文双降'),
          h('span', { key: 'v', style: { fontSize: 11, color: C.dim } }, `v${VERSION}`),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h(Pill, {
            key: 'e', tone: status?.engineReady ? 'ok' : 'bad', title: status?.engineDir,
          }, status?.engineReady ? '引擎就绪' : '引擎缺失'),
          h(Pill, {
            key: 'p', tone: status?.hasEdits ? 'ok' : 'dim', title: 'out 目录里是否已有 edits.jsonl',
          }, status?.hasEdits ? '有改写清单' : '待改写'),
          h(Btn, { key: 's', onClick: () => setShowSetup((x) => !x), title: '设置引擎目录' }, '设置'),
        ]),

        showSetup ? h('div', { key: 'setup', style: card }, [
          h('div', { key: 'l', style: sectionLabel },
            `引擎目录（含 run.py）：当前 ${status?.engineDir || '—'}`),
          h('div', { key: 'r', style: { display: 'flex', gap: 8, marginBottom: 8 } }, [
            h('input', {
              key: 'in', value: engineInput, placeholder: 'E:\\path\\to\\paper-dual-reduce',
              onChange: (e) => setEngineInput(e.target.value),
              style: {
                flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 7,
                border: `1px solid ${C.border}`, background: 'transparent', color: 'inherit',
              },
            }),
          ]),
          h('div', { key: 'l2', style: sectionLabel },
            `python 解释器：当前 ${status?.python || '—'}（venv 装依赖后要指到这里）`),
          h('div', { key: 'r2', style: { display: 'flex', gap: 8 } }, [
            h('input', {
              key: 'in2', value: pyInput, placeholder: 'C:\\path\\to\\venv\\Scripts\\python.exe（留空 = PATH 上的 python）',
              onChange: (e) => setPyInput(e.target.value),
              style: {
                flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 7,
                border: `1px solid ${C.border}`, background: 'transparent', color: 'inherit',
              },
            }),
            h(Btn, { key: 'b', onClick: saveEngine, primary: true, disabled: busy === 'setup' }, '保存'),
          ]),
        ]) : null,

        // 入口：未选模式 → 首页三选一；已选模式 → 模式条（返回 + 切模式）
        mode ? h('div', {
          key: 'modebar',
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        }, [
          h(Btn, { key: 'back', onClick: exitMode, title: '回到模式选择' }, '← 模式'),
          h('span', { key: 't', style: { fontSize: 12.5, fontWeight: 600 } },
            MODES.find((m) => m.id === mode)?.title || mode),
          h('span', { key: 's', style: { flex: 1 } }),
          ...MODES.map((m) => h('button', {
            key: m.id, type: 'button', onClick: () => enterMode(m.id),
            style: {
              padding: '4px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 7,
              border: `1px solid ${m.id === mode ? 'transparent' : C.border}`,
              background: m.id === mode ? C.accent : 'transparent',
              color: m.id === mode ? '#fff' : C.dim,
            },
          }, m.tag)),
        ]) : null,
        !mode ? h(ModeHome, {
          key: 'home',
          docPath,
          onPath: setDocPath,
          onDiagnose: runDiagnose,
          busy,
          lastRun: result ? { docPath: result.docPath, summary: result.summary } : null,
          mode,
          onMode: enterMode,
        }) : null,

        error ? h('div', {
          key: 'err',
          style: {
            padding: '8px 10px', border: `1px solid ${C.high}`, borderRadius: 8,
            color: C.high, fontSize: 12, whiteSpace: 'pre-wrap',
          },
        }, error) : null,
        msg ? h('div', { key: 'msg', style: { fontSize: 12, color: C.dim } }, msg) : null,

        mode && s ? h('div', { key: 'result', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
          // 概览
          mode !== 'aigc' && h('div', { key: 'sum', style: card }, [
            h('div', {
              key: 'name', style: { fontSize: 13, fontWeight: 600, marginBottom: 2, wordBreak: 'break-all' },
            }, (result.docPath || '').split(/[\\/]/).pop()),
            h('div', {
              key: 'meta',
              style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 },
            }, [
              h('span', { key: 't', style: { fontSize: 11, color: C.dim } },
                new Date(result.at).toLocaleString()),
              h(PathChip, { key: 'p', label: '产物目录', path: result.outdir }),
            ]),
            h(DistBar, { key: 'dist', dist: s.dist }),
            h('div', { key: 'stats', style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } }, [
              h(Stat, { key: 'a', label: '段落', value: stats.paragraphs ?? '—' }),
              h(Stat, { key: 'b', label: '可改写', value: stats.rewritable ?? '—' }),
              h(Stat, { key: 'c', label: '锁定', value: stats.locked ?? '—' }),
              h(Stat, {
                key: 'd', label: '篇内重复', value: `${(100 * (s.repeatRate || 0)).toFixed(1)}%`,
                hint: '13 字指纹在本文内部的重复占比，不是查重率',
              }),
            ]),
          ]),

          // Top 段落（降 AI 模式看的是 9 维痕迹，不是六维段落表）
          mode !== 'aigc' && top.length ? h('div', { key: 'top' }, [
            h('div', { key: 'h', style: sectionLabel }, `高风险段落（前 ${top.length}，点开看原文）`),
            h('div', {
              key: 'tbl',
              style: { border: `1px solid ${C.border}`, borderRadius: 9, overflow: 'hidden' },
            }, h(TopTable, {
              rows: top, open,
              onToggle: (pid) => setOpen((x) => (x === pid ? '' : pid)),
            })),
            h('div', {
              key: 'legend',
              style: { fontSize: 11, color: C.dim, marginTop: 6, lineHeight: 1.7 },
            }, '风险分是篇内相对指标（0–1）：高 ≥ 0.62 ／ 中 ≥ 0.45 ／ 低 < 0.45；'
              + '不是百分比，也不是任何平台的检测概率。字数指该段中文字符数。'),
          ]) : null,

          // AIGC 考官（模型检测 + 9 维痕迹；降重模式不显示）
          mode !== 'dedupe' && h(AigcCard, {
            key: 'aigc',
            status: aigc,
            score: aigcScoreRes,
            diag: aigcDiagRes,
            delta: aigcDeltaRes,
            aiLabel: aigc?.aiLabel ?? null,
            target: aigcTarget,
            onTarget: setAigcTarget,
            onScore: runAigcScore,
            onDiag: runAigcDiag,
            onSelftest: runSelftest,
            onCalibrate: runCalibrate,
            onDelta: runDelta,
            onCopy: copy,
            copied,
            busy,
          }),

          // 降 AIGC：痕迹 → 改写 → 回填 → 复检（降重模式不显示）
          mode !== 'dedupe' && h(ReduceCard, {
            key: 'reduce',
            mode,
            plan: reducePlanRes,
            check: reduceCheckRes,
            busy,
            onPlan: runReducePlan,
            onCheck: runReduceCheck,
          }),

          // 闭环步骤（三模式共用同一条流水线，只是任务来源不同）
          h('div', { key: 'steps', style: card }, [
            h('div', { key: 'h', style: sectionLabel },
              mode === 'dedupe'
                ? '改写闭环（模型只写 edits.jsonl，脚本负责回填与复检）'
                : mode === 'both'
                  ? '双降闭环：一次改写同时降重 + 降 AI（模型只写 edits.jsonl）'
                  : '降 AI 闭环：痕迹要求 → 改写 → 回填 → 复检（模型只写 edits.jsonl）'),
            h('div', { key: 'row', style: { display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 9 } }, [
              h(Step, {
                key: '1', n: 1,
                title: mode === 'dedupe' ? '生成任务' : '生成降 AI 任务',
                active: true, done: Boolean(tasks) || Boolean(reducePlanRes),
              }),
              h(Step, { key: '2', n: 2, title: '预检', done: Boolean(lint) }),
              h(Step, { key: '3', n: 3, title: '回填复检', done: Boolean(verdict?.passed) }),
              h(Step, { key: '4', n: 4, title: '三栏对照', done: Boolean(rows?.length) }),
            ]),
            // 当前进度：回答「到底改过没有」
            h('div', {
              key: 'state',
              style: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: C.dim, marginBottom: 8 },
            }, [
              h('span', { key: '1' }, `任务 ${tasks?.tasks?.length ?? reducePlanRes?.tasks ?? '—'} 段`),
              h('span', { key: '2' }, `提示词 ${tasks?.prompts ?? reducePlanRes?.prompts ?? '—'} 条`),
              h('span', {
                key: '3', style: { color: status?.hasEdits ? C.low : C.dim },
              }, status?.hasEdits ? 'edits.jsonl 已写入' : 'edits.jsonl 未写入'),
              h('span', {
                key: '4',
                style: { color: verdict ? (verdict.passed ? C.low : C.high) : C.dim },
              }, verdict ? (verdict.passed ? '已回填，复检通过' : '复检未过，已整篇回退') : '尚未回填'),
            ]),
            h('div', { key: 'btns', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
              mode === 'dedupe' && h(Btn, {
                key: 't', onClick: runTasks, disabled: busy === 'tasks',
              }, busy === 'tasks' ? '生成中…' : '生成改写任务'),
              h(Btn, { key: 'l', onClick: runLintNow, disabled: busy === 'lint' || !status?.hasEdits },
                busy === 'lint' ? '预检中…' : '预检'),
              h(Btn, {
                key: 'a', onClick: runApplyNow, primary: true,
                disabled: busy === 'apply' || !status?.hasEdits,
              }, busy === 'apply' ? '回填中…' : '回填并复检'),
              h(Btn, { key: 'c', onClick: loadCompare, disabled: busy === 'cmp' }, '三栏对照'),
              h(Btn, { key: 'r', onClick: loadReport }, report ? '收起报告' : '查看报告'),
            ]),
            tasks ? h(InstructionCard, {
              key: 'instr', tasks, copied: copied === 'instr',
              onCopy: () => copy('instr', tasks.instruction),
            }) : null,
          ]),

          // 预检结果
          lint ? h('div', { key: 'lint', style: card }, [            h('div', { key: 'h', style: sectionLabel },
              `预检：可通过 ${lint.counts?.would_apply ?? 0} ｜ 会被拒 ${lint.counts?.would_reject ?? 0}`),
            ...(lint.rejected ?? []).slice(0, 8).map((it) => h('div', {
              key: `l-${it.pid}`,
              style: { fontSize: 11.5, color: C.dim, lineHeight: 1.65, wordBreak: 'break-word' },
            }, [
              h('code', { key: 'p', style: { marginRight: 6 } }, it.pid),
              h('span', { key: 'r', style: { color: C.mid } }, it.reason),
              h('div', { key: 'h2', style: { color: C.dim, opacity: 0.9 } }, it.hint),
            ])),
          ]) : null,

          // 复检结果
          verdict ? h('div', { key: 'verdict', style: card }, [
            h('div', { key: 'h', style: sectionLabel }, '复检结论'),
            h('div', {
              key: 'line',
              style: { fontSize: 12.5, color: verdict.passed ? C.low : C.high, marginBottom: 6 },
            }, verdict.passed
              ? `通过 ｜ 改写 ${verdict.changed} 段 ｜ 字数 ${verdict.chars[0]}→${verdict.chars[1]}`
              : `不通过 ｜ 已整篇回退（明细见报告）`),
            apply?.apply ? h('div', { key: 'cnt', style: { fontSize: 11.5, color: C.dim } },
              `接受 ${apply.apply.applied} ｜ 拒绝 ${apply.apply.rejected} ｜ 状态 ${apply.applyStatus}`) : null,
            apply?.output ? h(PathChip, {
              key: 'out', label: '改稿', path: apply.output,
            }) : null,
          ]) : null,

          // 三栏对照
          rows?.length ? h('div', { key: 'cmp' }, [
            h('div', { key: 'h', style: sectionLabel }, `三栏对照（${rows.length} 段）`),
            ...rows.map((r) => h('div', {
              key: r.pid, style: { ...card, marginBottom: 8 },
            }, [
              h('div', {
                key: 'hd', style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 },
              }, [
                h('code', { key: 'p', style: { fontSize: 11 } }, r.pid),
                h('span', { key: 'o', style: { fontSize: 11, color: C.dim } }, r.op),
                h('span', { key: 'd', style: { fontSize: 11, color: C.dim } },
                  `字数 ${r.chars[0]}→${r.chars[1]} ｜ 句数 ${r.sentences[0]}→${r.sentences[1]}`),
              ]),
              h('div', {
                key: 'b', style: { fontSize: 12, lineHeight: 1.7, color: C.dim, marginBottom: 4 },
              }, [h('span', { key: 'l', style: { fontWeight: 600, marginRight: 6 } }, '原文'), r.before]),
              h('div', { key: 'a', style: { fontSize: 12, lineHeight: 1.7 } },
                [h('span', { key: 'l', style: { fontWeight: 600, marginRight: 6 } }, '改文'), r.after]),
            ])),
          ]) : null,

          report ? h(ReportCard, {
            key: 'report',
            mode,
            metrics: [
              { label: '段落', value: `${stats.paragraphs ?? '—'}` },
              { label: '可改写', value: `${stats.rewritable ?? '—'}` },
              { label: '篇内重复', value: `${(100 * (s.repeatRate || 0)).toFixed(1)}%` },
              apply?.verdict
                ? {
                  label: '改写',
                  value: `${apply.verdict.changed} 段`,
                  tone: apply.verdict.passed ? 'ok' : 'bad',
                }
                : null,
              reduceCheckRes?.diag
                ? {
                  label: 'AIGC 风险',
                  value: `${reduceCheckRes.diag.before.riskCount}→${reduceCheckRes.diag.after.riskCount}`,
                  tone: reduceCheckRes.diag.after.riskCount < reduceCheckRes.diag.before.riskCount ? 'ok' : 'warn',
                }
                : null,
              reduceCheckRes?.prob
                ? {
                  label: 'AIGC 概率',
                  value: `${(100 * reduceCheckRes.prob.before).toFixed(1)}%→${(100 * reduceCheckRes.prob.after).toFixed(1)}%`,
                  tone: reduceCheckRes.prob.mode === 'model' ? undefined : 'warn',
                }
                : null,
              reduceCheckRes?.dup
                ? {
                  label: '重复率',
                  value: `${(100 * (reduceCheckRes.dup.before ?? 0)).toFixed(1)}%→${(100 * reduceCheckRes.dup.after).toFixed(1)}%`,
                  tone: (reduceCheckRes.dup.delta ?? 0) >= 0 ? 'ok' : 'bad',
                }
                : null,
            ].filter(Boolean),
            report,
            extraMarkdown: buildAigcReport(mode, reduceCheckRes, apply),
            onCopy: copy,
            copied,
            onClose: () => setReport(null),
          }) : null,

          h('div', { key: 'foot', style: { display: 'flex', gap: 8 } }, [
            h(Btn, { key: 'f', onClick: refresh }, '刷新状态'),
          ]),
        ]) : mode ? h('div', {
          key: 'empty', style: { fontSize: 12, color: C.dim, lineHeight: 1.85 },
        }, [
          h('div', { key: '1' }, '这个模式还没有诊断结果：回「← 模式」重新填路径并点「诊断」。'),
          h('div', { key: '2' },
            '输出是篇内相对风险分（同篇内排序）与 9 维痕迹，不是任何平台的检测概率；本工具不承诺通过率。'),
        ]) : null,
      ]);
    }

    // ------------------------------------------------------------ 注册

    const plugin = {
      inject: ['slots'],
      apply(ctx) {
        const offPanel = ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
        }, Panel));

        const offRow = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 43, label: () => '论文双降',
        }, (owner) => h(PaperIcon, { size: (owner && owner.size) || 16 })));

        return () => {
          try { if (typeof offRow === 'function') offRow(); } catch { /* ignore */ }
          try { if (typeof offPanel === 'function') offPanel(); } catch { /* ignore */ }
        };
      },
    };

    // 无浏览器环境下的渲染回归钩子（tools/render.mjs 用）
    if (typeof window !== 'undefined' && window.__PDR_TEST__) {
      plugin.__test = {
        parseBlocks, renderInline, Markdown, shortPath, TopTable, AigcCard,
        ModeHome, ReportCard, Panel, MODES, buildAigcReport,
      };
    }

    return plugin;
  },
});
