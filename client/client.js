window.__ModuleLoader__.load({ id: "dsh-todo-board", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-todo-board — browser half.
 *
 * Floating board in `shell.overlay` (frame-wide layer, top-right). Design
 * direction: an engineering job ticket — hairline rules, tabular monospace
 * readouts, a square "auto" box versus a round "human" box, and motion used
 * only where it carries meaning (row arrival, a box being checked).
 *
 * Transport: GET/POST `/dsh-todo-board/api`.
 * Rows are drag-reorderable; on-screen top-to-bottom order IS the
 * auto-continue execution order.
 */

const React = require('react')
const h = React.createElement

const ROUTE = '/dsh-todo-board/api'
const MODES = ['remind', 'resume', 'newSession']
/** Must not exceed the host's MAX_IMAGES_PER_TODO. */
const MAX_IMAGES = 4
const MEDIA_TYPE_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
const MODE_LABEL = { remind: '提醒', resume: '自动续跑', newSession: '自动新会话' }
const MODE_SHORT = { remind: '提醒', resume: '续跑', newSession: '新会话' }
const MODE_HINT = {
  remind: '只在这里提醒你，不会自动发送任何消息。',
  resume: 'AI 一停就自动把这条注入当前会话继续跑。',
  newSession: 'AI 一停就自动新建一个同目录会话来执行。',
}
/**
 * Every row carries exactly one state chip, because a state you have to infer is
 * a state you cannot see. An earlier version labelled only the states that "need
 * attention" (已派发 / 进行中 / 悬住) and left 未派发 and 已完成 silent, on the
 * theory that an empty checkbox and a struck-through title already said it —
 * in practice that meant most rows showed no state at all, which is exactly the
 * question it was supposed to answer.
 *
 * Emphasis still varies, so a board of ordinary rows stays quiet: only 进行中 and
 * a stuck row shout, and `done` recedes.
 */
const STATE_CHIP = {
  pending: { label: '未派发', cls: 'idle', hint: '还没交给任何会话；点 ▶ 可以立即接续到当前会话。' },
  dispatched: { label: '已派发', cls: 'sent', hint: '已经派发过一次，目标会话还在。' },
  running: { label: '进行中', cls: 'run', hint: '目标会话正在执行这条待办。' },
  done: { label: '已完成', cls: 'ok', hint: 'AI 已勾选完成；等你验收。' },
  lost: { label: '目标会话丢失', cls: 'bad', hint: '派发失败，已停下等待处理。' },
}
/**
 * What a parked row is actually parked on. `lostKind` comes from the host, so a
 * refusal is labelled by its real cause rather than always blaming a missing
 * session. The hint is the way out, not a restatement of the problem.
 */
const LOST_CHIP = {
  'no-session': {
    label: STATE_CHIP.lost.label,
    hint: '改执行模式、换目录，或等到点自动重试（间隔会逐次拉长）。',
  },
  image: {
    label: '图片被拒',
    hint: '目标模型不接受图片输入：换一个支持图片的模型，或先移除待办上的图片。',
  },
  spawn: { label: '建会话失败', hint: '新建会话没有成功；修好后会按退避自动重试。' },
  preset: { label: '预设解析失败', hint: '解析 agent preset 失败；修好后会按退避自动重试。' },
  agents: { label: '服务不可用', hint: 'agents 服务不可用；恢复后会按退避自动重试。' },
}
const MONO = 'ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace'

/**
 * The three looks the panel can wear, in cycle order.
 *
 * `ticket` is the default and is deliberately NOT described by a block further
 * down: it *is* the base stylesheet, which stays unscoped, and each skin block
 * then states only what it changes. One description of the default look rather
 * than two that can drift apart.
 *
 * A skin is presentation only — it may move padding, borders, type and density,
 * but never which control exists, what a control means, or what goes on the
 * wire. The square 「AI 已完成」 box versus the round 「已验收」 box is meaning
 * rather than decoration, so it stays square-and-round in all three.
 */
const SKINS = [
  { id: 'ticket', name: '票据', glyph: '\u25A4', hint: '细线分隔、等宽数字、状态标签带框（默认）' },
  { id: 'plain', name: '素白', glyph: '\u25FB', hint: '去掉边框与分隔线，留白更多；状态收成一个色点' },
  { id: 'dense', name: '紧凑', glyph: '\u2263', hint: '同样极简，字号行距各降一档，一屏能看更多条' },
]

/**
 * The plugin build this browser half belongs to, printed in the footer.
 *
 * It tracks `package.json`'s version rather than "the last time this file
 * changed": the footer answers "which build am I actually looking at?", and the
 * host and browser halves of one release are one build. `client-smoke.mjs` pins
 * the two together, because a footer that lies is worse than no footer.
 */
const BUILD = '0.11.2'

/**
 * Severity filters in the log view, most severe first.
 *
 * `error` is the default because that is what the dot on the log button means:
 * opening the view to see why the dot lit should not first require narrowing a
 * list. `debug` is only ever present when the host captured it, and the host
 * keeps it in memory only — so a reader who sees debug lines is looking at
 * something that will not survive a restart, which the view says out loud.
 */
const LOG_LEVELS = ['error', 'warn', 'info', 'debug']
const LOG_SOURCE_KEY = 'dsh.todoBoard.logSource.v1'
/** Log lines the panel keeps client-side, so scrolling back costs no requests. */
const LOG_KEEP = 400

const CSS = `
.dshtb-root{position:fixed;top:56px;right:16px;z-index:2147482000;pointer-events:auto;
  --tb-line:var(--dsw-alias-border-l1);--tb-line2:var(--dsw-alias-border-l2);
  --tb-bg:var(--dsw-alias-bg-overlay);--tb-dim:var(--dsw-alias-label-secondary);
  --tb-ink:var(--dsw-alias-label-primary);--tb-accent:var(--dsw-alias-brand-primary);
  --tb-ok:var(--dsw-alias-state-success-primary);--tb-warn:var(--dsw-alias-state-warn-primary);
  display:flex;flex-direction:column;width:380px;max-width:calc(100vw - 32px);
  max-height:min(80vh,680px);font-size:13px;line-height:1.5;color:var(--tb-ink)}
.dshtb-root *{box-sizing:border-box}
.dshtb-card{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;border-radius:14px;
  background:var(--tb-bg);border:1px solid var(--tb-line);overflow:hidden;
  box-shadow:0 18px 50px -14px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.04);
  animation:dshtb-in .16s ease-out}
.dshtb-resize{position:absolute;right:1px;bottom:1px;width:16px;height:16px;cursor:nwse-resize;
  opacity:.55;background:
    linear-gradient(135deg,transparent 46%,currentColor 46%,currentColor 54%,transparent 54%),
    linear-gradient(135deg,transparent 68%,currentColor 68%,currentColor 76%,transparent 76%);
  color:var(--tb-dim)}
.dshtb-resize:hover{opacity:1;color:var(--tb-ink)}
@keyframes dshtb-in{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}
.dshtb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;
  border-bottom:1px solid var(--tb-line);cursor:move;user-select:none}
.dshtb-title{font-weight:700;letter-spacing:.02em;white-space:nowrap}
.dshtb-title b{color:var(--tb-accent)}
.dshtb-stats{display:flex;gap:9px;font:600 11px/1 ${MONO};font-variant-numeric:tabular-nums;
  color:var(--tb-dim);white-space:nowrap}
.dshtb-stats i{font-style:normal;display:inline-flex;align-items:center;gap:4px}
.dshtb-stats i::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.75}
.dshtb-sp{flex:1}
/* Two title-bar controls, one geometry: the fold control and the skin control.
   They stay separate classes because they are separate controls — the fold
   parks the panel, the skin changes how it looks — and nothing should be able
   to find one while looking for the other. */
/* Three title-bar controls, one geometry: the fold control, the skin control
   and the log control. They stay separate classes because they are separate
   controls — the fold parks the panel, the skin changes how it looks, the log
   swaps the page — and nothing should be able to find one while looking for
   another. Only the shared geometry lives in this rule. */
.dshtb-fold,.dshtb-skin,.dshtb-log{width:26px;height:26px;border:1px solid transparent;border-radius:7px;
  background:transparent;color:var(--tb-dim);cursor:pointer;font:600 14px/1 ${MONO};padding:0;
  display:grid;place-items:center;transition:background .12s,color .12s,border-color .12s}
.dshtb-fold:hover,.dshtb-skin:hover,.dshtb-log:hover{background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink);
  border-color:var(--tb-line2)}
.dshtb-fold:focus-visible,.dshtb-skin:focus-visible,.dshtb-log:focus-visible{outline:2px solid var(--tb-accent);outline-offset:1px}
/* Section label doubling as the fold/unfold control for what follows it. */
.dshtb-sect{display:flex;align-items:center;gap:6px;width:100%;padding:9px 12px 5px;
  border:0;background:transparent;cursor:pointer;user-select:none;text-align:left;
  font:600 10.5px/1 ${MONO};letter-spacing:.09em;text-transform:uppercase;color:var(--tb-dim);
  transition:color .12s}
.dshtb-sect:hover{color:var(--tb-ink)}
.dshtb-sect::after{content:'';flex:1;height:1px;background:var(--tb-line)}
.dshtb-sect .car{font:700 11px/1 ${MONO};color:var(--tb-accent)}
.dshtb-seg{display:flex;gap:2px;margin:9px 12px 0;padding:2px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--tb-line)}
.dshtb-seg button{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:5px 6px;
  border:0;border-radius:8px;background:transparent;color:var(--tb-dim);font:inherit;font-size:12px;
  cursor:pointer;transition:background .12s,color .12s,box-shadow .12s}
.dshtb-seg button:hover{color:var(--tb-ink)}
.dshtb-seg button.on{background:var(--tb-bg);color:var(--tb-ink);font-weight:600;
  box-shadow:0 1px 3px rgba(0,0,0,.2)}
.dshtb-seg em{font-style:normal;font:600 11px/1 ${MONO};font-variant-numeric:tabular-nums;opacity:.6}
.dshtb-compose{display:flex;flex-direction:column;gap:8px;padding:11px 12px;border-bottom:1px solid var(--tb-line)}
.dshtb-add{display:flex;gap:6px;align-items:flex-end}
.dshtb-add textarea{flex:1;min-width:0;min-height:66px;max-height:180px;resize:vertical;
  padding:8px 10px;border-radius:9px;border:1px solid var(--tb-line);
  background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink);font:inherit;font-size:13px;line-height:1.5;
  outline:none;transition:border-color .12s,box-shadow .12s}
.dshtb-add textarea::placeholder{color:var(--tb-dim)}
.dshtb-add textarea:focus{border-color:var(--tb-accent);box-shadow:0 0 0 3px rgba(128,128,128,.16)}
.dshtb-modes{display:flex;gap:4px}
.dshtb-modes button{flex:1;padding:6px 3px;border-radius:8px;border:1px solid var(--tb-line);
  background:transparent;color:var(--tb-dim);font:inherit;font-size:12px;line-height:1.2;cursor:pointer;
  white-space:nowrap;transition:border-color .12s,color .12s}
.dshtb-modes button:hover{color:var(--tb-ink);border-color:var(--tb-line2)}
.dshtb-modes button.on{border-color:var(--tb-accent);color:var(--tb-accent);font-weight:600}
.dshtb-hint{font-size:11.5px;color:var(--tb-dim);line-height:1.4}
.dshtb-dir input{flex:1;min-width:0;padding:6px 9px;border-radius:8px;border:1px dashed var(--tb-line);
  background:transparent;color:var(--tb-dim);font:inherit;font-size:12px;outline:none;
  transition:border-color .12s,color .12s}
.dshtb-when{display:flex;align-items:center;gap:7px;font:600 11px/1 ${MONO};color:var(--tb-dim)}
.dshtb-when .lbl{letter-spacing:.08em}
.dshtb-dir{display:flex;align-items:center;gap:7px;font:600 11px/1 ${MONO};color:var(--tb-dim)}
.dshtb-dir .lbl{letter-spacing:.08em;flex:0 0 auto}
.dshtb-when input{flex:1;min-width:0;padding:5px 8px;border-radius:8px;border:1px dashed var(--tb-line);
  background:transparent;color:var(--tb-dim);font:inherit;font-size:12px;outline:none;
  transition:border-color .12s,color .12s;color-scheme:dark light}
.dshtb-when input:focus{border-style:solid;border-color:var(--tb-accent);color:var(--tb-ink)}
/* The attachment area holds a hint and the pending thumbnails — no picker
   control, so no label styling belongs here any more. */
.dshtb-attach{display:flex;flex-direction:column;gap:6px}
.dshtb-thumbs{display:flex;flex-wrap:wrap;gap:6px}
.dshtb-thumb{position:relative;width:52px;height:52px;padding:0;border:1px solid var(--tb-line);
  border-radius:8px;background:transparent;cursor:pointer;overflow:hidden}
.dshtb-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dshtb-thumb .x{position:absolute;top:0;right:0;padding:0 3px;background:rgba(0,0,0,.6);color:#fff;
  font:700 10px/1.4 ${MONO};border-bottom-left-radius:6px}
.dshtb-imgs{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.dshtb-imgwrap{position:relative;display:inline-flex}
.dshtb-img{width:64px;height:64px;object-fit:cover;border-radius:7px;border:1px solid var(--tb-line);
  cursor:zoom-in;display:block}
.dshtb-imgx{position:absolute;top:-5px;right:-5px;width:16px;height:16px;padding:0;border:0;border-radius:50%;
  background:var(--dsw-alias-bg-overlay);color:var(--tb-dim);box-shadow:0 0 0 1px var(--tb-line);
  font:700 9px/1 ${MONO};cursor:pointer;display:grid;place-items:center}
.dshtb-imgx:hover{color:var(--tb-ink)}
.dshtb-light{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,.72);cursor:zoom-out;
  animation:dshtb-in .14s ease-out}
.dshtb-light img{max-width:88vw;max-height:82vh;border-radius:10px;box-shadow:0 20px 60px -18px rgba(0,0,0,.8);cursor:default}
.dshtb-lightcap{font:600 11px/1.4 ${MONO};color:#fff;opacity:.85}
.dshtb-dir input::placeholder{color:var(--tb-dim);opacity:.85}
.dshtb-dir input:focus{border-style:solid;border-color:var(--tb-accent);color:var(--tb-ink)}
.dshtb-list,.dshtb-donelist{overflow:auto;padding:2px 0 6px;scrollbar-width:thin}
.dshtb-list::-webkit-scrollbar,.dshtb-donelist::-webkit-scrollbar{width:9px}
.dshtb-list::-webkit-scrollbar-thumb,.dshtb-donelist::-webkit-scrollbar-thumb{background:var(--tb-line2);border-radius:5px;
  border:3px solid transparent;background-clip:content-box}
/* The one line that explains the mode chip, inside the list it applies to. Small
   and dim on purpose: it is read once, and it must never read as a control. */
.dshtb-listhint{padding:7px 12px 3px;font-size:11px;line-height:1.45;color:var(--tb-dim);opacity:.9}
.dshtb-group{display:flex;align-items:center;gap:7px;padding:10px 12px 4px;
  font:600 10.5px/1 ${MONO};letter-spacing:.09em;text-transform:uppercase;color:var(--tb-dim)}
.dshtb-group::after{content:'';flex:1;height:1px;background:var(--tb-line)}
.dshtb-item{display:flex;gap:7px;padding:7px 12px;align-items:flex-start;position:relative;
  border-top:2px solid transparent;animation:dshtb-row .2s ease-out both;transition:background .12s}
@keyframes dshtb-row{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:none}}
.dshtb-item::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:transparent;
  transition:background .12s}
.dshtb-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dshtb-item:hover::before{background:var(--tb-line2)}
.dshtb-item.done{opacity:.55}
.dshtb-item.done .dshtb-t{text-decoration:line-through}
.dshtb-item.dragging{opacity:.3}
.dshtb-item.over{border-top-color:var(--tb-accent)}
.dshtb-grip{flex:0 0 auto;width:9px;padding-top:3px;cursor:grab;user-select:none;opacity:0;
  color:var(--tb-dim);font:700 10px/1 ${MONO};letter-spacing:-1px;transition:opacity .12s}
.dshtb-item:hover .dshtb-grip,.dshtb-item.dragging .dshtb-grip{opacity:.8}
.dshtb-grip:active{cursor:grabbing}
.dshtb-checks{display:flex;flex-direction:column;gap:5px;padding-top:2px;flex:0 0 auto}
.dshtb-cb{width:18px;height:18px;padding:0;border:1.5px solid var(--tb-line2);background:transparent;
  cursor:pointer;display:grid;place-items:center;font:700 11px/1 ${MONO};color:transparent;
  transition:background .14s,border-color .14s,color .14s}
.dshtb-cb.ai{border-radius:4px}
.dshtb-cb.me{border-radius:50%}
.dshtb-cb:hover{border-color:var(--tb-accent)}
.dshtb-cb.ai.on{background:var(--tb-accent);border-color:var(--tb-accent);color:#fff}
.dshtb-cb.me.on{background:var(--tb-ok);border-color:var(--tb-ok);color:#fff}
.dshtb-cb.on{animation:dshtb-pop .18s ease-out}
@keyframes dshtb-pop{0%{transform:scale(.55)}60%{transform:scale(1.18)}100%{transform:scale(1)}}
.dshtb-body{flex:1;min-width:0}
.dshtb-t{font-size:13px;word-break:break-word;white-space:pre-wrap;line-height:1.45}
.dshtb-facts{margin-top:3px;font:400 11px/1.4 ${MONO};font-variant-numeric:tabular-nums;
  color:var(--tb-dim);word-break:break-all}
.dshtb-t input{width:100%;padding:2px 5px;border-radius:5px;border:1px solid var(--tb-accent);
  background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink);font:inherit;outline:none}
.dshtb-edit{display:block;width:100%;min-height:76px;max-height:220px;resize:vertical;
  padding:6px 8px;border-radius:7px;border:1px solid var(--tb-accent);
  background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink);font:inherit;font-size:13px;
  line-height:1.45;outline:none;box-shadow:0 0 0 3px rgba(128,128,128,.16)}
.dshtb-edit::placeholder{color:var(--tb-dim)}
/* The note: plain text, never a control, so it must not look like one — no
   border, no background, no pointer cursor. It sits directly under the title and
   is clamped to two lines (one in the dense skin); the clamp is visual only, the
   whole string stays in the DOM, so selecting a row still copies every character.
   overflow-wrap:anywhere is load-bearing: notes are pasted paths and logs, and a
   long unbroken token would otherwise widen the panel instead of wrapping. */
.dshtb-note{margin-top:3px;font-size:11.5px;line-height:1.45;color:var(--tb-dim);
  white-space:pre-wrap;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
/* The note editor is its own control (never folded into the title editor): a
   note is multi-line text, and the title editor's single-line commit rules would
   cut it in half. */
.dshtb-noteedit{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.dshtb-notearea{flex:1 0 100%;width:100%;min-height:54px;max-height:220px;resize:vertical;
  padding:6px 8px;border-radius:7px;border:1px solid var(--tb-accent);
  background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink);font:inherit;font-size:12.5px;
  line-height:1.45;outline:none;box-shadow:0 0 0 3px rgba(128,128,128,.16)}
.dshtb-notearea::placeholder{color:var(--tb-dim)}
.dshtb-notesave,.dshtb-notecancel{padding:2px 9px;border:1px solid var(--tb-line);border-radius:6px;
  background:transparent;color:var(--tb-dim);font:inherit;font-size:11.5px;cursor:pointer;
  transition:border-color .12s,color .12s}
.dshtb-notesave{color:var(--tb-accent);border-color:var(--tb-accent)}
.dshtb-notesave:hover{border-color:var(--tb-accent);color:var(--tb-ink)}
.dshtb-notecancel:hover{border-color:var(--tb-line2);color:var(--tb-ink)}
.dshtb-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;
  font:400 12px/1.5 ${MONO};color:var(--tb-dim)}
.dshtb-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--tb-line);white-space:nowrap;
  font:inherit;font-size:12px;color:var(--tb-dim)}
button.dshtb-chip{cursor:pointer;font:inherit;color:inherit;transition:border-color .12s,color .12s}
button.dshtb-chip:hover{border-color:var(--tb-line2);color:var(--tb-ink)}
.dshtb-chip.sent{color:var(--tb-ok);border-color:var(--tb-ok)}
.dshtb-chip.idle{opacity:.72}
.dshtb-chip.ok{color:var(--tb-ok);border-color:var(--tb-line)}
.dshtb-chip.due{color:var(--tb-warn);border-color:var(--tb-warn);font-weight:600}
.dshtb-chip.run{color:var(--tb-accent);border-color:var(--tb-accent);font-weight:600}
.dshtb-chip.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);
  font-weight:600;cursor:help}
.dshtb-chip.quiet{opacity:.62}
.dshtb-chip.quiet:hover{opacity:1}
/* The ✕ sits beside the time chip rather than inside it: a button may not nest
   another control, and keep it narrow so the pair reads as one chip. */
.dshtb-chip.x{padding:2px 5px;cursor:pointer}
.dshtb-whenchip{display:inline-flex;align-items:center;gap:2px;padding:1px 3px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--tb-accent)}
.dshtb-whenedit{padding:1px 4px;border:0;background:transparent;color:var(--tb-ink);
  font:inherit;font-size:11px;outline:none;color-scheme:dark light}
.dshtb-whenchip .dshtb-ic{width:18px;height:18px;font-size:10px}
.dshtb-acts{display:flex;gap:1px;flex:0 0 auto;opacity:0;transition:opacity .12s}
.dshtb-item:hover .dshtb-acts{opacity:1}
.dshtb-ic{width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;
  color:var(--tb-dim);cursor:pointer;display:grid;place-items:center;font-size:11px;
  transition:background .12s,color .12s}
.dshtb-ic:hover{background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink)}
.dshtb-ic:disabled{opacity:.4;cursor:default}
.dshtb-empty{padding:24px 16px;text-align:center;color:var(--tb-dim)}
.dshtb-empty b{display:block;font:700 24px/1 ${MONO};opacity:.3;margin-bottom:9px}
.dshtb-empty span{font-size:11px;opacity:.9}
/* One short line, not an empty box: an empty section should cost nothing. */
.dshtb-doneempty{padding:6px 12px 8px;font-size:11.5px;color:var(--tb-dim);opacity:.85}
.dshtb-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:8px 12px;
  border-top:1px solid var(--tb-line);margin-top:auto;
  font:600 11px/1 ${MONO};font-variant-numeric:tabular-nums;color:var(--tb-dim)}
.dshtb-link{padding:2px 6px;border:1px solid var(--tb-line);border-radius:6px;background:transparent;
  color:var(--tb-dim);font:inherit;cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.dshtb-link:hover{background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink);border-color:var(--tb-line2)}
.dshtb-link.off{opacity:.5;cursor:not-allowed}
/* Shipped Cordis popup: parked under this panel, right-aligned to it.
   !important beats the inline left/bottom the panel computes from its anchor. */
[data-dsh-todo-cordis]>div:first-child{left:auto !important;bottom:auto !important;
  right:var(--dsh-todo-cordis-right,16px) !important;
  top:var(--dsh-todo-cordis-top,120px) !important;
  max-height:var(--dsh-todo-cordis-maxh,60vh) !important}
.dshtb-err{padding:6px 12px;color:var(--dsw-alias-state-error-primary);font:400 10.5px/1.4 ${MONO};
  word-break:break-all;border-top:1px solid var(--tb-line)}
/* Parked as one line: label + counts + the next task, expandable by a click.
   align-self keeps it hugging its content instead of stretching to the card width. */
.dshtb-pill{align-self:flex-start;display:flex;align-items:center;gap:8px;min-width:0;
  max-width:calc(100vw - 32px);padding:6px 10px;border-radius:10px;
  background:var(--tb-bg);border:1px solid var(--tb-line);cursor:pointer;user-select:none;
  box-shadow:0 10px 30px -12px rgba(0,0,0,.5);transition:border-color .14s}
.dshtb-pill:hover{border-color:var(--tb-line2)}
.dshtb-pill .lbl{font:600 10px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:var(--tb-ink)}
.dshtb-pill .next{flex:1;min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px;color:var(--tb-dim)}
.dshtb-pill .next.q{font-style:italic;opacity:.7}
.dshtb-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--tb-accent);
  color:#fff;font:700 10px/1 ${MONO};font-variant-numeric:tabular-nums;display:inline-grid;place-items:center}
.dshtb-badge.warn{background:var(--tb-warn)}
/* The log button and its "something went wrong" dot. The dot rides the button
   instead of a separate node so it cannot drift away from the control it
   annotates, and it is absolutely positioned so lighting it never reflows the
   title bar. */
.dshtb-log{position:relative}
.dshtb-log.on{background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink);border-color:var(--tb-line2)}
.dshtb-dot{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;
  background:var(--tb-warn);box-shadow:0 0 0 1.5px var(--tb-bg)}
/* Developer view: monospace, dense, unabashedly plain. This is not a surface to
   make pretty — it is a surface to read a stack trace on. */
.dshtb-logview{display:flex;flex-direction:column;min-height:0;flex:1}
.dshtb-logbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 12px;
  border-bottom:1px solid var(--tb-line)}
.dshtb-logbar button{padding:3px 8px;border-radius:7px;border:1px solid var(--tb-line);
  background:transparent;color:var(--tb-dim);font:600 10.5px/1.4 ${MONO};cursor:pointer;
  transition:background .12s,color .12s,border-color .12s}
.dshtb-logbar button:hover{color:var(--tb-ink);border-color:var(--tb-line2)}
.dshtb-logbar button.on{background:var(--tb-accent);border-color:var(--tb-accent);color:#fff}
/* The source toggle is its own class rather than a reuse of the title-bar log
   button: same reason the three title-bar controls are separate — a class is
   how something finds exactly one control. */
.dshtb-logsrc{min-width:56px}
.dshtb-logfilter{flex:1;min-width:90px;padding:3px 8px;border-radius:7px;border:1px solid var(--tb-line);
  background:transparent;color:var(--tb-ink);font:400 11px/1.4 ${MONO};outline:none}
.dshtb-logfilter:focus{border-color:var(--tb-accent)}
.dshtb-logmeta{padding:5px 12px;border-bottom:1px solid var(--tb-line);
  font:400 10px/1.5 ${MONO};color:var(--tb-dim);word-break:break-all}
.dshtb-logmeta b{color:var(--tb-warn);font-weight:700}
.dshtb-loglist{flex:1;min-height:0;overflow:auto;padding:2px 0}
.dshtb-logrow{display:flex;gap:8px;padding:4px 12px;border-bottom:1px solid var(--tb-line);
  font:400 10.5px/1.5 ${MONO};align-items:flex-start}
.dshtb-logrow:hover{background:var(--dsw-alias-bg-layer-1)}
.dshtb-logrow .at{flex:0 0 auto;opacity:.6;font-variant-numeric:tabular-nums}
.dshtb-logrow .lv{flex:0 0 auto;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.dshtb-logrow.error .lv{color:var(--dsw-alias-state-error-primary)}
.dshtb-logrow.warn .lv{color:var(--tb-warn)}
.dshtb-logrow.info .lv{color:var(--tb-dim)}
.dshtb-logrow.debug .lv{opacity:.65}
.dshtb-logrow .body{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.dshtb-logrow .src{opacity:.6}
.dshtb-logempty{padding:20px 12px;text-align:center;color:var(--tb-dim);font:400 11.5px/1.6 ${MONO}}
`

/**
 * The two optional skins, each scoped by `[data-dshtb-skin]` on the panel root.
 *
 * They are additive on purpose: the base stylesheet above describes the default
 * `ticket` look, so disabling a declaration here restores the shipped panel
 * rather than an unstyled one. Everything is scoped under the root attribute,
 * so no skin can reach a node outside this panel — the GUI around it is never
 * affected by which skin is selected.
 *
 * `plain` is the information diet: no frames, no rules, no chips — a state
 * becomes a coloured dot, and the schedule becomes the only chip left, because
 * it is the one thing a row must stay able to change.
 */
const CSS_PLAIN = `
.dshtb-root[data-dshtb-skin="plain"] .dshtb-card{
  border-color:transparent;box-shadow:0 22px 60px -20px rgba(0,0,0,.42);border-radius:16px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-head{border-bottom:0;padding:12px 14px 8px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-title{font-weight:600;letter-spacing:0}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-stats i::before{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-stats{gap:12px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg{
  background:transparent;border:0;border-radius:0;padding:0 14px;margin:6px 0 2px;gap:16px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg button{
  flex:0 0 auto;padding:3px 0;border-radius:0;border-bottom:1.5px solid transparent;
  font-size:12.5px;color:var(--tb-dim)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg button:hover{color:var(--tb-ink)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg button.on{
  background:transparent;box-shadow:none;color:var(--tb-ink);border-bottom-color:var(--tb-ink);
  font-weight:600}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg em{font-size:10.5px;opacity:.5}
/* The section label stays legible and keeps saying what it hides — it just
   stops shouting. It is NOT hidden: the label is the only thing that says what
   a folded section is, which is the whole reason it doubles as the control. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-sect{
  letter-spacing:0;text-transform:none;padding:10px 14px 4px;gap:5px;
  font:600 11.5px/1 ${MONO}}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-sect .car{font-size:10px;color:var(--tb-dim)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-sect::after{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-compose{border-bottom:0;padding:8px 14px 12px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-add textarea{
  border-color:transparent;background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:10px 12px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-add textarea:focus{
  border-color:var(--tb-line2);box-shadow:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-modes{
  gap:0;padding:0;background:transparent;border:0;border-radius:0;align-self:flex-start}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-modes button{
  flex:0 0 auto;border:0;border-bottom:1.5px solid transparent;border-radius:0;padding:4px 10px;
  font-size:12.5px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-modes button:hover{border-bottom-color:var(--tb-line2)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-modes button.on{
  border-bottom-color:var(--tb-accent);color:var(--tb-accent)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-dir input,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-when input{border-style:solid;border-color:transparent;
  background:var(--dsw-alias-bg-layer-2)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-dir input:focus,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-when input:focus{border-color:var(--tb-line2)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-list,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-donelist{padding:0 0 8px}
/* The group heading is the directory a row belongs to, so it stays readable —
   it just loses its rule and its uppercase tracking. Keeping the text at a
   small size rather than at zero is deliberate: a zero font size here would
   erase the only on-screen statement of which directory you are looking at. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-group{
  letter-spacing:0;text-transform:none;padding:12px 14px 2px;font:600 10.5px/1 ${MONO};
  opacity:.85}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-group::after{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-item{padding:8px 14px;gap:9px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-item:hover{background:var(--dsw-alias-bg-layer-1)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-item::before{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-grip{opacity:.28}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-facts{font-size:10.5px;opacity:.8}
/* A state stops being a bordered chip and becomes its own colour: a dot for the
   quiet states, a tinted pill only where the row is actually asking for you. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip{
  border:0;background:transparent;padding:0;gap:5px;font-size:11.5px;border-radius:0}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip::before{
  content:'';width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45;flex:0 0 auto}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.idle{opacity:.55}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.sent::before,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.ok::before{opacity:.9}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.run,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.bad{
  padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.run::before,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.bad::before{opacity:1}
/* The schedule keeps a real frame: it is the one chip that must still look
   like something you can press. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.quiet,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.due{
  border:1px solid var(--tb-line);border-radius:999px;padding:2px 8px;background:transparent}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.quiet::before,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.due::before,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.x::before{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-whenchip{border-color:var(--tb-line);border-radius:999px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-img,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-thumb{border-color:transparent}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-foot{border-top:0}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-link{border-color:transparent}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-pill{
  border-color:transparent;border-radius:12px;box-shadow:0 14px 34px -16px rgba(0,0,0,.5)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-badge{background:var(--tb-ink);color:var(--tb-bg)}
`

/** `dense` keeps the ticket structure and removes its air. */
const CSS_DENSE = `
.dshtb-root[data-dshtb-skin="dense"]{font-size:12px;line-height:1.42}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-head{padding:7px 10px;gap:6px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-card{border-radius:10px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-stats{gap:7px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-fold{width:22px;height:22px;font-size:12px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-seg{margin:6px 9px 0;padding:1px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-seg button{padding:3px 5px;font-size:11.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-sect{padding:6px 10px 3px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-compose{padding:8px 10px;gap:6px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-add textarea{min-height:48px;padding:6px 8px;font-size:12.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-modes button{padding:4px 3px;font-size:11.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-item{padding:5px 10px;gap:6px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-group{padding:7px 10px 3px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-t{font-size:12.5px;line-height:1.4}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-facts{font-size:10.5px;margin-top:2px}
/* One line, not two: the dense skin exists to fit more rows on one screen. */
.dshtb-root[data-dshtb-skin="dense"] .dshtb-note{-webkit-line-clamp:1;font-size:11px;margin-top:2px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-notearea{font-size:12px;min-height:46px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-doneempty{padding:4px 10px 6px;font-size:11px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-meta{gap:4px;margin-top:3px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-chip{padding:1px 6px;font-size:11.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-cb{width:15px;height:15px;font-size:10px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-checks{gap:4px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-img{width:46px;height:46px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-thumb{width:40px;height:40px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-ic{width:19px;height:19px;font-size:10px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-foot{padding:6px 10px;gap:5px 7px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-pill{padding:4px 8px;gap:6px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-badge{min-width:16px;height:16px;font-size:9.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-empty{padding:16px 12px}
`

/** Skin id -> its block. `ticket` is absent: the base sheet is its definition. */
const SKIN_CSS = { plain: CSS_PLAIN, dense: CSS_DENSE }

const isSkin = (id) => SKINS.some((skin) => skin.id === id)

// ---------------------------------------------------------------------------
// Bridge to the shipped Cordis dynamic-plugin panel.
//
// That panel belongs to @deepseek-ai/dsh-client-ui-cordis and lives in the
// sidebar footer. No slot API can move another plugin's entry, so this is a
// DOM bridge with three parts:
//
//   1. locate the trigger by the `data-cordis-badge` attribute it renders
//      itself — stable across versions and locales, and still present when the
//      sidebar collapses to the 56px rail, where the text label is not
//      rendered at all (text matching is only a fallback);
//   2. hide its sidebar row, so the entry exists only inside this panel;
//   3. park the shipped popup UNDER this panel: the popup is a child of that
//      same layer, and a tagged, !important CSS rule overrides the inline
//      `left`/`bottom` the panel computes from the layer's rect. That makes the
//      placement independent of the collapsed anchor and guarantees the two
//      panels never overlap.
//
// The layer's inline styles and attribute are restored when this plugin
// unloads.
// ---------------------------------------------------------------------------
const CORDIS_TRIGGER = 'Cordis Plugin'
const CORDIS_BADGE_SELECTOR = 'button[data-cordis-badge]'
const CORDIS_LAYER_ATTR = 'data-dsh-todo-cordis'
let cordisSaved = null

function cordisBadge() {
  const direct = document.querySelector(CORDIS_BADGE_SELECTOR)
  if (direct !== null) return direct
  const buttons = document.querySelectorAll('button')
  for (const button of buttons) {
    // Never match this panel's own footer entry: it carries the same label.
    if (button.closest('.dshtb-root') !== null) continue
    const text = button.textContent === null ? '' : button.textContent.trim()
    // Prefix match: the shipped badge appends a running count.
    if (text.indexOf(CORDIS_TRIGGER) === 0) return button
  }
  return null
}

function collapseCordisFooter() {
  if (cordisSaved !== null && cordisSaved.button.isConnected) return
  const badge = cordisBadge()
  if (badge === null) return
  const row = badge.parentElement
  const layer = row === null ? null : row.parentElement
  // Refuse to touch any ancestor of this panel: collapsing our own card would
  // hide the entire board behind its own overflow:hidden.
  const owner = layer === null ? row : layer
  if (owner === null || owner.querySelector('.dshtb-root') !== null) return
  cordisSaved = {
    button: badge,
    row,
    layer,
    rowDisplay: row === null ? '' : row.style.display,
    layerHeight: layer === null ? '' : layer.style.height,
    layerMargin: layer === null ? '' : layer.style.margin,
    layerPadding: layer === null ? '' : layer.style.padding,
  }
  if (row !== null) row.style.display = 'none'
  if (layer !== null) {
    layer.style.height = '0px'
    layer.style.margin = '0px'
    layer.style.padding = '0px'
    layer.setAttribute(CORDIS_LAYER_ATTR, '')
  }
}

/**
 * Keep the shipped popup parked directly under this panel, right-aligned to
 * it, with a max-height that stops it running off the bottom of the viewport.
 * Recomputed on every poll so dragging or resizing this panel moves it too.
 */
function anchorCordisPanel() {
  const layer = cordisSaved === null ? null : cordisSaved.layer
  if (layer === null || !layer.isConnected) return
  const root = document.querySelector('.dshtb-root')
  if (root === null) return
  const rect = root.getBoundingClientRect()
  const gap = 8
  layer.style.setProperty('--dsh-todo-cordis-right', Math.max(8, Math.round(window.innerWidth - rect.right)) + 'px')
  layer.style.setProperty('--dsh-todo-cordis-top', Math.round(rect.bottom + gap) + 'px')
  layer.style.setProperty(
    '--dsh-todo-cordis-maxh',
    Math.max(160, Math.round(window.innerHeight - rect.bottom - gap * 3)) + 'px',
  )
}

function restoreCordisFooter() {
  if (cordisSaved === null) return
  const saved = cordisSaved
  cordisSaved = null
  if (saved.row !== null && saved.row.isConnected) saved.row.style.display = saved.rowDisplay
  if (saved.layer !== null && saved.layer.isConnected) {
    saved.layer.style.height = saved.layerHeight
    saved.layer.style.margin = saved.layerMargin
    saved.layer.style.padding = saved.layerPadding
    saved.layer.removeAttribute(CORDIS_LAYER_ATTR)
  }
}

/**
 * Open — never toggle — the shipped panel from this one.
 *
 * The badge sits inside a collapsed row, so a bare `.click()` races the
 * panel's own dismiss-on-outside-pointer hook: that hook sees a pointer
 * outside its root and closes whatever we just opened. Priming the interaction
 * with a pointerdown/mousedown dispatched ON the badge makes the target
 * "inside", so the click survives.
 *
 * @returns whether the shipped trigger was found at all.
 */
function openCordisPanel() {
  const badge = cordisBadge()
  if (badge === null) return false
  if (badge.getAttribute('aria-expanded') === 'true') return true
  try {
    const options = { bubbles: true, cancelable: true, view: window }
    badge.dispatchEvent(new PointerEvent('pointerdown', options))
    badge.dispatchEvent(new MouseEvent('mousedown', options))
  } catch (err) {
    /* no PointerEvent in this engine: the plain click below still tries */
  }
  badge.click()
  return true
}

// --------------------------------------------------------------- transport

async function request(method, body) {
  const response =
    body === undefined
      ? await fetch(ROUTE, { headers: { accept: 'application/json' } })
      : await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
  if (!response.ok) throw new Error(failureText(response.status))
  return response.json()
}

/**
 * Turn one refusal status into something the user can act on.
 *
 * 401 is the status v0.9.1 introduced: the board route now borrows the harness'
 * own gate, which wants the browser-session cookie DSH issues when you open the
 * URL `dsh web` prints. A bare "HTTP 401" would leave the panel looking broken
 * with no hint, and this is the one failure whose fix is a single action.
 */
function failureText(status) {
  if (status === 401) {
    return 'HTTP 401 —— 浏览器没有 DSH 会话凭据。请用 `dsh web` 打印的那条带 token 的地址重开页面'
  }
  return 'HTTP ' + status
}

const transport = {
  snapshot: () => request('GET'),
  call: (method, args) => request('POST', Object.assign({ action: method }, args)),
  /**
   * Fetch log records newer than `since`.
   *
   * Only ever called while the log view is open — that is the whole reason the
   * host gates log content behind a query flag, and it is what keeps the idle
   * poll byte-for-byte what it was before this feature existed.
   */
  logs: (since) =>
    fetch(ROUTE + '?logs=1&since=' + encodeURIComponent(String(since)), {
      headers: { accept: 'application/json' },
    }).then((response) => {
      if (!response.ok) throw new Error(failureText(response.status))
      return response.json()
    }),
}

function describe(failure) {
  if (failure === null || failure === undefined) return 'unknown error'
  if (typeof failure === 'string') return failure
  if (typeof failure.message === 'string') return failure.message
  return String(failure)
}

/** Durable attachment bytes, served by this plugin's own board-scoped route. */
function imageUrl(attachmentId) {
  return ROUTE.replace(/\/api$/, '/image') + '?id=' + encodeURIComponent(String(attachmentId))
}

// --------------------------------------------------------------- log view
//
// The developer log. Its content never rides the idle poll: the host withholds
// it unless the view is open, so these helpers only ever run on a panel where
// someone deliberately opened the log.

/** `HH:MM:SS.mmm` from an epoch stamp — enough to line a line up with an action. */
function logClock(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '--:--:--'
  const date = new Date(ts)
  const pad = (n, width) => String(n).padStart(width === undefined ? 2 : width, '0')
  return (
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    '.' + pad(date.getMilliseconds(), 3)
  )
}

/**
 * One record's filterable text, lowercased once per render pass rather than per
 * keystroke-range — the list is capped, so this stays cheap.
 */
function logHaystack(line) {
  return (String(line.detail) + ' ' + String(line.logger) + ' ' + String(line.source)).toLowerCase()
}

/** Which source bucket a record belongs to, for the 来源 toggle. */
function logSourceOf(line) {
  // The host names this plugin's own fiber, so a record from us is exactly the
  // one whose source matches. Anything else is another plugin's error (the
  // exporter scope keeps those at `error` only).
  return line.source === 'dsh-todo-board' ? 'self' : 'other'
}

/** Load the last-used source filter, defaulting to our own records. */
function loadLogSource() {
  try {
    const raw = window.localStorage.getItem(LOG_SOURCE_KEY)
    return raw === 'other' ? 'other' : 'self'
  } catch (err) {
    return 'self'
  }
}

function saveLogSource(value) {
  try {
    window.localStorage.setItem(LOG_SOURCE_KEY, value)
  } catch (err) {
    /* storage unavailable */
  }
}

/**
 * The whole log as plain text, for the clipboard and the download.
 *
 * Redaction already ran on every line at the host, but it runs AGAIN here on
 * the assembled text. That is deliberate rather than redundant: this string
 * leaves the machine — it is pasted into an issue or saved to a file and handed
 * to someone else — and the host's guarantee covers what it stored, not what a
 * future edit to this client might add.
 */
function logAsText(info) {
  const lines = info === undefined || info === null ? [] : info.render
  const head = [
    '# dsh-todo-board 日志',
    '# 导出时间：' + new Date().toISOString(),
    '# 面板构建：v' + BUILD,
    '# 记录数：' + (Array.isArray(lines) ? lines.length : 0),
    '# 说明：本文件可能包含本机路径与其他插件的错误上下文，贴出去前请自行确认。',
    '',
  ]
  const body = (Array.isArray(lines) ? lines : []).map(
    (line) =>
      logClock(line.ts) + ' ' + String(line.level).toUpperCase().padEnd(5) +
      ' [' + (line.source || line.logger || '?') + '] ' + line.detail,
  )
  return head.concat(body).join('\n')
}

/** Trigger a browser download of `text`, without a server round trip. */
function downloadText(filename, text) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Revoked on a later tick: revoking synchronously can cancel the download
    // in some engines before it has read the blob.
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
    return true
  } catch (err) {
    return false
  }
}

/** Copy `text`, falling back to a hidden textarea where the async API is absent. */
function copyText(text) {
  try {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => false,
      )
    }
  } catch (err) {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return Promise.resolve(ok)
  } catch (err) {
    return Promise.resolve(false)
  }
}

// ------------------------------------------------------------- panel layout

const LAYOUT_KEY = 'dsh.todoBoard.layout.v1'
const MIN_W = 300
const MIN_H = 260

function loadLayout() {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const x = Number(parsed.x)
    const y = Number(parsed.y)
    const w = Number(parsed.w)
    const h = Number(parsed.h)
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null
    return { x, y, w, h }
  } catch (err) {
    return null
  }
}

function saveLayout(layout) {
  try {
    if (layout === null) window.localStorage.removeItem(LAYOUT_KEY)
    else window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch (err) {
    /* storage unavailable */
  }
}

/**
 * Folded sections and the parked panel survive a reload: folding away the
 * composer is something you do once, not once per page load.
 */
const SECTIONS_KEY = 'dsh.todoBoard.sections.v1'
const SECTION_IDS = ['compose', 'list', 'done']

function loadSections() {
  const state = { compose: true, list: true, done: true }
  try {
    const raw = window.localStorage.getItem(SECTIONS_KEY)
    if (raw === null) return state
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return state
    for (const id of SECTION_IDS) if (typeof parsed[id] === 'boolean') state[id] = parsed[id]
  } catch (err) {
    /* keep the defaults */
  }
  return state
}

function saveSections(state) {
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(state))
  } catch (err) {
    /* storage unavailable */
  }
}

/**
 * Which skin the panel wears.
 *
 * Stored beside the layout and the folded sections, so it survives a reload the
 * same way they do — a look you chose once is a look you keep. A stored id that
 * is no longer in SKINS (a skin removed in an upgrade) falls back to the default
 * instead of leaving the panel wearing nothing.
 */
const SKIN_KEY = 'dsh.todoBoard.skin.v1'

function loadSkin() {
  try {
    const raw = window.localStorage.getItem(SKIN_KEY)
    return typeof raw === 'string' && isSkin(raw) ? raw : SKINS[0].id
  } catch (err) {
    return SKINS[0].id
  }
}

function saveSkin(id) {
  try {
    window.localStorage.setItem(SKIN_KEY, id)
  } catch (err) {
    /* storage unavailable */
  }
}

function clampLayout(layout) {
  const maxW = Math.max(MIN_W, window.innerWidth - 16)
  const maxH = Math.max(MIN_H, window.innerHeight - 16)
  const w = Math.min(Math.max(layout.w, MIN_W), maxW)
  const h = Math.min(Math.max(layout.h, MIN_H), maxH)
  const x = Math.min(Math.max(layout.x, 8), Math.max(8, window.innerWidth - w - 8))
  const y = Math.min(Math.max(layout.y, 8), Math.max(8, window.innerHeight - h - 8))
  return { x, y, w, h }
}

function sameLayout(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/**
 * The geometry the user actually chose, kept apart from the one being rendered.
 *
 * They differ whenever the viewport is too small for the choice: the rendered
 * geometry is clamped to fit right now, while the chosen one is remembered, so
 * widening the window again returns the panel to where it was put — the same
 * position a reload would produce from disk. Re-clamping stays repeatable
 * instead of being a one-way trip into the corner.
 */
function initialGeometry() {
  const stored = loadLayout()
  return { preferred: stored, clamped: stored === null ? null : clampLayout(stored) }
}

/**
 * A foldable section of the panel: its label doubles as the control that shows
 * and hides the body, so a folded panel still says what it is hiding.
 *
 * @param options.id - stable key, also handed back to `onToggle`.
 * @param options.name - section name, used in the tooltip.
 * @param options.note - optional count rendered after the name.
 * @param options.open - whether the body is currently visible.
 * @param options.onToggle - called with `id` when the header is clicked.
 * @param options.body - the single keyed element to hide when folded.
 * @returns header and body as siblings, ready to spread into a children list.
 */
function foldable(options) {
  const { id, name, note, open, onToggle, body } = options
  return [
    h(
      'button',
      {
        key: id,
        className: 'dshtb-sect',
        'aria-expanded': open ? 'true' : 'false',
        title: (open ? '折叠' : '展开') + '「' + name + '」',
        onClick: () => onToggle(id),
      },
      h('span', { className: 'car' }, open ? '\u25BE' : '\u25B8'),
      note === undefined ? name : name + ' ' + note,
    ),
    open ? body : null,
  ]
}

// --------------------------------------------------------------- component

function TodoBoard(props) {
  const currentId = props.useSessions((s) => s.current)
  const currentSummary = props.useSessions((s) => (s.current === undefined ? undefined : s.byId[s.current]))
  const cwd =
    currentSummary !== undefined && currentSummary !== null && typeof currentSummary.cwd === 'string'
      ? currentSummary.cwd
      : ''
  const currentTitle =
    currentSummary !== undefined && currentSummary !== null && typeof currentSummary.title === 'string'
      ? currentSummary.title
      : ''

  const [open, setOpen] = React.useState(true)
  const [data, setData] = React.useState(null)
  const [err, setErr] = React.useState('')
  const [draft, setDraft] = React.useState('')
  const [mode, setMode] = React.useState('remind')
  const [dirInput, setDirInput] = React.useState('')
  const [when, setWhen] = React.useState('')
  const [pending, setPending] = React.useState([])
  const [noteId, setNoteId] = React.useState('')
  const [noteDraft, setNoteDraft] = React.useState('')
  const [viewing, setViewing] = React.useState(null)
  const [filter, setFilter] = React.useState('dir')
  const [busy, setBusy] = React.useState(false)
  const [dragId, setDragId] = React.useState('')
  const [overId, setOverId] = React.useState('')
  const [editId, setEditId] = React.useState('')
  const [editText, setEditText] = React.useState('')
  /** Row whose schedule is being edited inline, and the draft time for it. */
  const [whenId, setWhenId] = React.useState('')
  const [whenDraft, setWhenDraft] = React.useState('')
  // Geometry is read once per mount, lazily: `initialGeometry` touches
  // localStorage, and the panel re-renders on every 2.5s poll, so calling it in
  // a ref initializer (which evaluates its argument each render) would re-read
  // storage forever.
  const initial = React.useState(initialGeometry)[0]
  const [layout, setLayout] = React.useState(initial.clamped)
  const [cordisFound, setCordisFound] = React.useState(true)
  const [sections, setSections] = React.useState(loadSections)
  const [skin, setSkin] = React.useState(loadSkin)
  /**
   * Whether the panel is showing the log instead of the board.
   *
   * Not persisted on purpose: this is a diagnostic view, and reopening the GUI
   * into a log page would be a worse default than reopening into the board. The
   * cost is that a reload closes it, which for a debugging trip is fine.
   */
  const [logOpen, setLogOpen] = React.useState(false)
  const [logLevels, setLogLevels] = React.useState({ error: true, warn: true, info: false, debug: false })
  const [logSource, setLogSource] = React.useState(loadLogSource)
  const [logQuery, setLogQuery] = React.useState('')
  const [logLines, setLogLines] = React.useState([])
  /** Newest `sn` collected, so each poll asks only for what it lacks. */
  const logCursorRef = React.useRef(0)
  /** Newest error/warn `sn` the user has already looked at. */
  const logSeenRef = React.useRef(0)
  /**
   * `logOpen`, readable from the polling closure.
   *
   * The interval effect runs ONCE (empty deps), so it captures the first
   * render's `refresh` — where `logOpen` is `false` forever. Reading the state
   * variable there would leave the log view frozen at whatever the open-effect
   * fetched, with the 2.5s poll silently never updating it. A ref is the only
   * way that once-installed interval can see the current value.
   */
  const logOpenRef = React.useRef(false)
  const [logNote, setLogNote] = React.useState('')
  const [logCopied, setLogCopied] = React.useState('')
  const preferredRef = React.useRef(initial.preferred)
  const layoutRef = React.useRef(null)
  const dragRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const editRef = React.useRef(null)
  /** id -> remindedAt already surfaced, so a reminder notifies exactly once. */
  const seenReminders = React.useRef({})

  function applyLayout(next) {
    const clamped = clampLayout(next)
    // A drag is an explicit choice, so record it as the preferred geometry too.
    preferredRef.current = clamped
    layoutRef.current = clamped
    setLayout(clamped)
  }

  /** Seed a concrete geometry from the live rect, so CSS defaults stop applying. */
  function seedFrom(event, mode) {
    if (event.button !== 0) return null
    const root = event.currentTarget.closest('.dshtb-root')
    if (root === null) return null
    const rect = root.getBoundingClientRect()
    const origin = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    layoutRef.current = clampLayout(origin)
    setLayout(layoutRef.current)
    dragRef.current = { mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    return origin
  }

  function beginDrag(event) {
    // A pointerdown on a control inside the title bar must not start a drag:
    // setPointerCapture retargets the following click to the captured element,
    // so the button underneath would never see it.
    const target = event.target
    if (target !== null && typeof target.closest === 'function' && target.closest('button') !== null) {
      return
    }
    seedFrom(event, 'move')
  }

  function beginResize(event) {
    if (seedFrom(event, 'size') === null) return
    event.stopPropagation()
  }

  function movePointer(event) {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (drag.mode === 'move') {
      applyLayout({ x: drag.origin.x + dx, y: drag.origin.y + dy, w: drag.origin.w, h: drag.origin.h })
    } else {
      applyLayout({ x: drag.origin.x, y: drag.origin.y, w: drag.origin.w + dx, h: drag.origin.h + dy })
    }
  }

  function endPointer() {
    if (dragRef.current === null) return
    dragRef.current = null
    saveLayout(layoutRef.current)
  }

  function resetLayout() {
    // Clearing the preferred geometry too, or the resize effect would clamp it
    // straight back and the double-click restore would appear to do nothing.
    preferredRef.current = null
    layoutRef.current = null
    setLayout(null)
    saveLayout(null)
  }

  /**
   * Keep the panel inside the viewport as the viewport changes.
   *
   * Dragging and resizing clamp already, but neither runs when the *window*
   * changes size — so a panel parked at an absolute x is silently cropped once
   * the window narrows, and a viewport that can never be that wide again (a
   * smaller monitor, a permanent zoom) strands it for good. Re-clamping here is
   * what makes the panel follow the viewport instead of leaving it behind.
   *
   * It re-derives from `preferredRef` rather than from what is currently
   * rendered, so the clamp is repeatable: narrowing fits the panel on screen,
   * and widening puts it back exactly where the user left it — the same result
   * a reload would give. Nothing here is written to disk; the chosen geometry is
   * only persisted by an actual drag or resize.
   */
  React.useEffect(() => {
    const reclamp = () => {
      setLayout((current) => {
        if (current === null) return current
        const preferred = preferredRef.current
        const next = clampLayout(preferred === null ? current : preferred)
        // Returning the same object lets React bail out, so a resize that
        // changes nothing does not re-render the panel.
        return sameLayout(next, current) ? current : next
      })
    }

    window.addEventListener('resize', reclamp)
    // `visualViewport` fires for browser zoom, which does not always resize.
    if (window.visualViewport !== undefined && window.visualViewport !== null) {
      window.visualViewport.addEventListener('resize', reclamp)
    }
    // Catch a viewport that changed before this effect attached (or while the
    // tab was hidden and events were coalesced).
    reclamp()

    return () => {
      window.removeEventListener('resize', reclamp)
      if (window.visualViewport !== undefined && window.visualViewport !== null) {
        window.visualViewport.removeEventListener('resize', reclamp)
      }
    }
  }, [open])

  // Keep the drag-time ref equal to the rendered geometry, so a reclamp (or any
  // other state change) can never leave it pointing at a stale rect.
  React.useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  /** Fold one section of the panel away, or bring it back. */
  function toggleSection(id) {
    setSections((current) => {
      const next = { ...current, [id]: !current[id] }
      saveSections(next)
      return next
    })
  }

  /** Park the whole panel as a single line, or unfold it again. */
  function togglePanel() {
    setOpen((current) => !current)
  }

  /**
   * Step to the next skin and remember it.
   *
   * A cycle rather than a picker: with three looks, a cycle needs no menu, no
   * chrome and no room — and the one place it lives (the title bar) is the one
   * place you are already looking when you want the panel to look different.
   */
  function cycleSkin() {
    setSkin((current) => {
      const at = SKINS.findIndex((entry) => entry.id === current)
      const next = SKINS[(at + 1) % SKINS.length].id
      saveSkin(next)
      return next
    })
  }

  // Grow the composer with its content, up to the CSS max-height.
  React.useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [draft])

  // The rename field grows with the text the same way, so a long todo stays
  // readable while it is being edited.
  React.useEffect(() => {
    const el = editRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [editText, editId])

  /**
   * Fetch log records newer than what we hold.
   *
   * Runs on the SAME 2.5s cadence as the board poll and only while the view is
   * open — diagnostics do not need to be live, and reusing the existing poll
   * means no second transport to keep working. Errors are contained: a failing
   * log fetch must not disturb the board, which is the panel's actual job.
   */
  function refreshLogs() {
    transport.logs(logCursorRef.current).then(
      (result) => {
        const info = result === null || result === undefined ? undefined : result.logs
        if (info === undefined) {
          // A blank page reads as "nothing was ever logged", which is the one
          // wrong answer here. Say what actually happened instead: the host
          // answered without any log payload, which means an older host build
          // (pre-0.9.0) or a route that refused the request.
          setLogNote('主机没有返回日志内容 —— 可能是插件主机半边未更新（本页需要 0.9.0 及以上）')
          return
        }
        if (typeof info.cursor === 'number' && info.cursor > logCursorRef.current) {
          logCursorRef.current = info.cursor
        }
        // Everything the view is now showing counts as read, so closing it
        // leaves no dot behind for records the user just looked at.
        logSeenRef.current = Math.max(logSeenRef.current, logCursorRef.current)
        const fresh = Array.isArray(info.lines) ? info.lines : []
        if (fresh.length > 0) {
          setLogLines((current) => {
            const merged = current.concat(fresh)
            // Trim from the FRONT: the newest records are the ones a reader is
            // looking at, and a capped list that dropped them would be useless.
            return merged.length > LOG_KEEP ? merged.slice(merged.length - LOG_KEEP) : merged
          })
        }
        // The ring may have recycled past our cursor while the view was closed,
        // which reads as "nothing happened" unless we say so. The host's ring
        // size is not named here: this client does not know it, and inventing a
        // number would be worse than saying what actually happened.
        const notes = []
        if (info.truncated === true) notes.push('更早的记录已被内存环回收，完整历史在落盘文件里')
        if (info.dropped > 0) notes.push('进程启动以来已丢弃 ' + info.dropped + ' 条')
        if (info.fileOff === true) {
          notes.push('日志文件写入已停用（' + (info.fileError || '未知原因') + '），内存日志仍在')
        } else if (typeof info.file === 'string' && info.file !== '') {
          notes.push('落盘：' + info.file)
        }
        setLogNote(notes.join(' · '))
      },
      (failure) => setLogNote('读取日志失败：' + describe(failure)),
    )
  }

  function refresh() {
    transport.snapshot().then(
      (result) => {
        setData(result)
        setErr('')
        if (result !== null && result !== undefined && Array.isArray(result.todos)) {
          notifyDue(result.todos)
        }
      },
      (failure) => setErr(describe(failure)),
    )
    // `logOpenRef`, not `logOpen`: `refresh` is captured by an interval
    // installed once (empty deps), so the state variable would be frozen at its
    // first value (`false`) and the open log view would never update again.
    if (logOpenRef.current) refreshLogs()
    collapseCordisFooter()
    anchorCordisPanel()
    setCordisFound(cordisBadge() !== null)
  }

  React.useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 2500)
    return () => window.clearInterval(id)
  }, [])

  /**
   * Fetch as soon as the view opens.
   *
   * The 2.5s interval alone would leave a blank panel for up to one tick after
   * a click, which reads as "the button did nothing" — the one moment this
   * feature must not look broken.
   */
  React.useEffect(() => {
    logOpenRef.current = logOpen
    if (logOpen) refreshLogs()
  }, [logOpen])

  // Ask once for desktop-notification permission, so a due 「提醒」待办 can
  // surface even while the panel is collapsed.
  React.useEffect(() => {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {})
      }
    } catch (err) {
      /* no Notification API in this engine */
    }
  }, [])

  const todos = data !== null && data !== undefined && Array.isArray(data.todos) ? data.todos : []
  const cwdKey = cwd === '' ? '' : cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

  const byDir = todos.filter((t) => t.dir === cwdKey)
  const bySession = todos.filter((t) => t.sourceSessionId === currentId)
  const scope = filter === 'dir' ? byDir : filter === 'session' ? bySession : todos
  // The open list and the completed list are two halves of one scope: a row is in
  // exactly one of them, which is what makes ticking the round box a MOVE rather
  // than a copy. Only the open half is draggable, and `dropOn` reads exactly this
  // array — so a finished row can never be dragged into the queue's order.
  const visible = scope
    .filter((t) => !t.verified)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  // Newest first: the row you just ticked has to land at the top of the section
  // you are looking at, otherwise the move is invisible and looks like a deletion.
  const completed = scope
    .filter((t) => t.verified)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.order - a.order)

  const awaitingVerify = todos.filter((t) => t.aiDone && !t.verified).length
  const verifiedCount = todos.filter((t) => t.verified).length
  const openCount = todos.filter((t) => !t.verified).length

  /** Group rows by directory, preserving the order they arrive in. */
  function dirGroups(list) {
    const out = []
    const index = {}
    for (const todo of list) {
      const key = todo.dirLabel || '(未指定目录)'
      if (index[key] === undefined) {
        index[key] = out.length
        out.push({ key, items: [] })
      }
      out[index[key]].items.push(todo)
    }
    return out
  }

  const groups = dirGroups(visible)
  const doneGroups = dirGroups(completed)

  // ------------------------------------------------------------ log view data

  /**
   * The dot on the log button: lit when an error/warn arrived that the user has
   * not looked at yet.
   *
   * `!logOpen` is part of the condition, not an optimisation. An error that
   * arrives WHILE the view is open must not light a dot on the page the user is
   * already reading — and it would, because the cursor that clears the dot is
   * only ever compared against records the user has actually been shown. The
   * effect below keeps the cursor level with what the open view has displayed.
   *
   * It is fed by `data.logAlert`, which the host sends on EVERY poll even with
   * the view closed. That is the deliberate exception to "no log leaves the
   * host": one number, no text, and without it the dot could only appear after
   * the user opened the view it is supposed to be pointing at.
   */
  const alertSn =
    data !== null && data !== undefined && data.logAlert !== undefined && data.logAlert !== null &&
    typeof data.logAlert.sn === 'number'
      ? data.logAlert.sn
      : 0
  const logAlert = !logOpen && alertSn > logSeenRef.current && alertSn > 0

  const activeLevels = LOG_LEVELS.filter((level) => logLevels[level] === true)
  const query = logQuery.trim().toLowerCase()
  const logRender = logLines.filter((line) => {
    if (activeLevels.indexOf(String(line.level)) < 0) return false
    const source = logSourceOf(line)
    if (logSource === 'self' && source !== 'self') return false
    // "全部" shows everything the exporter delivered; "其他插件" narrows to
    // records the exporter only ever admits at `error`, so the label says so.
    if (logSource === 'other' && source !== 'other') return false
    if (query !== '' && !logHaystack(line).includes(query)) return false
    return true
  })
  // Newest first: the reason someone opens this view is the thing that just
  // broke, and the newest record is always at the top without scrolling.
  const logShown = logRender.slice().reverse()
  const latestError = logLines.filter((line) => line.level === 'error').length

  function toggleLog() {
    setLogOpen((current) => !current)
  }

  function toggleLogLevel(level) {
    setLogLevels((current) => {
      const next = { ...current, [level]: !current[level] }
      // Never leave every filter off: an empty list would be indistinguishable
      // from "nothing was logged", which is the one wrong answer here.
      if (!LOG_LEVELS.some((id) => next[id] === true)) return current
      return next
    })
  }

  function cycleLogSource() {
    setLogSource((current) => {
      const next = current === 'self' ? 'other' : current === 'other' ? 'all' : 'self'
      saveLogSource(next)
      return next
    })
  }

  function copyLog() {
    const text = logAsText({ render: logShown })
    copyText(text).then((ok) => {
      setLogCopied(ok ? '已复制 ' + logShown.length + ' 条' : '复制失败')
      window.setTimeout(() => setLogCopied(''), 2000)
    })
  }

  function exportLog() {
    const text = logAsText({ render: logShown })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const ok = downloadText('dsh-todo-board-log-' + stamp + '.txt', text)
    setLogCopied(ok ? '已导出' : '导出失败')
    window.setTimeout(() => setLogCopied(''), 2000)
  }

  function clearLogView() {
    // Local only, and deliberately so: this drops the panel's copy, not the
    // host's records. A "clear" that deleted evidence on the host would be a
    // trap on a diagnostic surface.
    setLogLines([])
    setLogCopied('已清空本面板显示')
    window.setTimeout(() => setLogCopied(''), 2000)
  }

  async function call(method, args) {
    setBusy(true)
    try {
      const result = await transport.call(method, args)
      if (result !== null && result !== undefined && result.ok === false && typeof result.error === 'string') {
        setErr(result.error)
      } else {
        setErr('')
      }
    } catch (failure) {
      setErr(describe(failure))
    }
    setBusy(false)
    refresh()
  }

  function add() {
    const title = draft.trim()
    if (title === '') return
    const targetDir = dirInput.trim() !== '' ? dirInput.trim() : cwd
    const images = pending
    setDraft('')
    setWhen('')
    setPending([])
    call('create', {
      title,
      mode,
      dir: targetDir,
      schedule: when,
      images,
      sessionId: currentId === undefined ? '' : currentId,
      sessionTitle: currentTitle,
    })
  }

  /** Read one image file into the wire shape the host admits. */
  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('读取失败：' + (file.name || '剪贴板图片')))
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : ''
        const comma = result.indexOf(',')
        if (comma < 0) {
          reject(new Error('无法编码：' + (file.name || '剪贴板图片')))
          return
        }
        resolve({
          data: result.slice(comma + 1),
          // A clipboard image does not always carry a MIME type — a screenshot
          // from some tools arrives with an empty `type`. The host validates the
          // media type strictly and would reject it as 「(未声明)」, so fall back
          // to the filename's extension, which is what the host itself would do.
          mediaType: imageMediaType(file),
          name: file.name || 'clipboard.png',
        })
      }
      reader.readAsDataURL(file)
    })
  }

  /**
   * The MIME type to send for one picked or pasted image.
   *
   * `file.type` first, because that is the browser's own answer and it is right
   * for every normal paste. The extension is the fallback for the clipboard
   * cases that arrive without one.
   */
  function imageMediaType(file) {
    if (typeof file.type === 'string' && file.type !== '') return file.type
    const name = typeof file.name === 'string' ? file.name : ''
    const dot = name.lastIndexOf('.')
    if (dot < 0) return ''
    return MEDIA_TYPE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || ''
  }

  /** Whether one clipboard entry is an image this panel can carry. */
  function isImageFile(file) {
    if (file === null || file === undefined) return false
    if (typeof file.type === 'string' && file.type.indexOf('image/') === 0) return true
    // No type at all: accept it only if the name says it is one of the four
    // formats the host admits, so an unknown extension cannot ride along.
    return typeof file.type === 'string' && file.type === '' && imageMediaType(file) !== ''
  }

  /**
   * The image files on one clipboard payload, in clipboard order.
   *
   * Both faces are read because they disagree about what pasting a file means:
   * `files` is the flat list, `items` distinguishes an image from the text you
   * copied alongside it. Either alone misses real pastes.
   */
  function clipboardImages(clipboard) {
    if (clipboard === null || clipboard === undefined) return []
    const out = []
    const files = clipboard.files
    if (files !== undefined && files !== null && files.length > 0) {
      for (const file of Array.from(files)) if (isImageFile(file)) out.push(file)
      if (out.length > 0) return out
    }
    const items = clipboard.items
    if (items === undefined || items === null) return out
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
      if (isImageFile(file)) out.push(file)
    }
    return out
  }

  /**
   * Attach whatever images a paste carried.
   *
   * `preventDefault` fires **only** when there really are images on the
   * clipboard: pasting text into the composer is the ordinary way to write a
   * task, and swallowing that would break the main input to support a side one.
   * The paste is left entirely alone when it is text.
   */
  function pasteImages(event) {
    const files = clipboardImages(event.clipboardData)
    if (files.length === 0) return
    // An image paste never also means "insert this text", so the default is
    // suppressed from here on — including the over-limit case, where the point
    // is to say why nothing was attached rather than to paste a filename.
    event.preventDefault()
    if (pending.length >= MAX_IMAGES) {
      setErr('一条待办最多带 ' + MAX_IMAGES + ' 张图片，先移除一张再粘贴')
      return
    }
    const room = MAX_IMAGES - pending.length
    const wanted = files.slice(0, room)
    setBusy(true)
    Promise.all(wanted.map(readImageFile)).then(
      (encoded) => {
        setPending((current) => current.concat(encoded).slice(0, MAX_IMAGES))
        setErr(
          files.length > room
            ? '只粘贴了前 ' + room + ' 张（上限 ' + MAX_IMAGES + ' 张），其余已忽略'
            : '',
        )
        setBusy(false)
      },
      (failure) => {
        setErr(describe(failure))
        setBusy(false)
      },
    )
  }

  function setSchedule(todo, value) {
    patch(todo.id, { schedule: value })
  }

  /** Open the inline picker for one row, seeded with its current time. */
  function beginWhen(todo) {
    setWhenId(todo.id)
    setWhenDraft(todo.schedule || '')
  }

  /** Commit the picker: an empty value clears the schedule, as it does at add. */
  function commitWhen(id) {
    const value = whenDraft
    setWhenId('')
    setWhenDraft('')
    patch(id, { schedule: value })
  }

  /** One desktop notification per reminder the host has stamped as due. */
  function notifyDue(list) {
    for (const todo of list) {
      const stamp = typeof todo.remindedAt === 'number' ? todo.remindedAt : 0
      if (stamp === 0) {
        delete seenReminders.current[todo.id]
        continue
      }
      if (seenReminders.current[todo.id] === stamp) continue
      seenReminders.current[todo.id] = stamp
      if (todo.verified) continue
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('TODO 到时间了', { body: todo.title, tag: 'dshtb-' + todo.id })
        }
      } catch (err) {
        /* notification blocked: the row chip still shows 已到时间 */
      }
    }
  }

  function patch(id, p) {
    call('patch', { id, patch: p })
  }

  function cycleMode(todo) {
    const next = MODES[(MODES.indexOf(todo.mode) + 1) % MODES.length]
    patch(todo.id, { mode: next })
  }

  function beginEdit(todo) {
    setEditId(todo.id)
    setEditText(todo.title)
  }

  function commitEdit() {
    const id = editId
    const text = editText.trim()
    setEditId('')
    if (id === '' || text === '') return
    patch(id, { title: text })
  }

  function beginNote(todo) {
    setNoteId(todo.id)
    setNoteDraft(typeof todo.note === 'string' ? todo.note : '')
  }

  function cancelNote() {
    setNoteId('')
    setNoteDraft('')
  }

  /**
   * Save the note exactly as typed.
   *
   * Not trimmed, not capped. The note is the context the model reads before it
   * starts, and it is free text: a character this function silently dropped
   * would be a lie in the one place the panel has to be a faithful view of the
   * board. If a limit is ever wanted it belongs in the host, as a refusal.
   */
  function commitNote(id) {
    const text = noteDraft
    cancelNote()
    patch(id, { note: text })
  }

  function dropOn(targetId) {
    const from = dragId
    setDragId('')
    setOverId('')
    if (from === '' || from === targetId) return
    const ids = []
    for (const t of visible) ids.push(t.id)
    const fromIndex = ids.indexOf(from)
    const toIndex = ids.indexOf(targetId)
    if (fromIndex < 0 || toIndex < 0) return
    ids.splice(fromIndex, 1)
    ids.splice(toIndex, 0, from)
    call('reorder', { ids })
  }

  /**
   * One row of either list.
   *
   * @param completed - true inside the 已完成 section. A finished row is no
   *   longer part of the queue: it carries no drag handle and no drop target,
   *   because `dropOn` reorders the OPEN list and the row no longer sits in it.
   */
  function item(todo, rowIndex, completed) {
    const finished = completed === true
    let cls = 'dshtb-item'
    if (todo.verified) cls += ' done'
    if (dragId === todo.id) cls += ' dragging'
    if (overId === todo.id && dragId !== '' && dragId !== todo.id) cls += ' over'

    // Only a row that has never been handed over can be dispatched by hand.
    // Everything else is either already sent, already finished, or stuck on a
    // session that no longer exists. If `state` is missing entirely (a browser
    // half newer than its host, e.g. a half-applied update) fall back to the raw
    // stamp, so the button degrades instead of locking every row.
    const state = typeof todo.state === 'string' ? todo.state : (todo.dispatchedAt > 0 ? 'dispatched' : 'pending')
    const runnable = state === 'pending'

    // Read once, here, because both the chip row and the body use it. The note is
    // plain text: it is never trimmed, never capped, and never parsed.
    const noteText = typeof todo.note === 'string' ? todo.note : ''

    // The directory is NOT a chip: the facts line under the title already names
    // it in full, and the chip only repeated the basename. The schedule is the
    // mirror image — it lives here as a chip and is deliberately absent from the
    // facts line, so neither fact is stated twice on one row.
    const meta = [
      h(
        'button',
        {
          className: 'dshtb-chip',
          key: 'm',
          title: '点击切换执行模式（当前：' + MODE_LABEL[todo.mode] + '）',
          onClick: () => cycleMode(todo),
        },
        MODE_SHORT[todo.mode],
      ),
    ]
    if (state === 'lost') {
      const attempts = typeof todo.lostAttempts === 'number' && todo.lostAttempts > 1
        ? '（已自动重试 ' + todo.lostAttempts + ' 次）'
        : ''
      // A parked row is not always a *missing session*: the target model can
      // refuse images, and spawning can fail. Name the actual cause and fix.
      const lost = LOST_CHIP[todo.lostKind] || LOST_CHIP['no-session']
      meta.push(
        h(
          'span',
          {
            className: 'dshtb-chip bad',
            key: 's',
            title:
              (todo.lostReason || '目标会话已不存在') + '，无法自动接续' + attempts + '。\n' + lost.hint,
          },
          lost.label,
        ),
      )
    } else {
      // Every other state gets its chip, always. `dispatched` additionally warns
      // when the session it went to has since closed: that is *not* the same as
      // 目标会话丢失 (a dispatch that never landed), and it is deliberately not
      // auto-retried, because the work may already have been done once.
      const chip = STATE_CHIP[state] || STATE_CHIP.pending
      const title =
        state === 'dispatched' && todo.targetAlive === false
          ? chip.hint +
            '\n但目标会话已经不在了。不确定它是否跑完，所以不会自动重试；想重跑就改执行模式或换目录。'
          : chip.hint
      meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))
    }
    // The schedule chip is always rendered, not only when a time is set: a row
    // added without one must still be able to get it later, which is the whole
    // point of editing the board rather than only composing into it.
    if (whenId === todo.id) {
      meta.push(
        h(
          'span',
          { className: 'dshtb-whenchip', key: 'w' },
          h('input', {
            type: 'datetime-local',
            className: 'dshtb-whenedit',
            value: whenDraft,
            autoFocus: true,
            title: '选择到点执行的时间（留空 = 不定时）',
            onChange: (e) => setWhenDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitWhen(todo.id)
              }
              if (e.key === 'Escape') {
                setWhenId('')
                setWhenDraft('')
              }
            },
          }),
          h(
            'button',
            {
              className: 'dshtb-ic',
              title: '保存定时',
              onClick: () => commitWhen(todo.id),
            },
            '\u2713',
          ),
          h(
            'button',
            {
              className: 'dshtb-ic',
              title: '取消',
              onClick: () => {
                setWhenId('')
                setWhenDraft('')
              },
            },
            '\u2715',
          ),
        ),
      )
    } else if (todo.schedule) {
      const due = typeof todo.dueAt === 'number' && todo.dueAt > 0 && todo.dueAt <= Date.now()
      meta.push(
        h(
          'button',
          {
            className: 'dshtb-chip' + (due ? ' due' : ''),
            key: 'w',
            title:
              (due ? '已到时间：' : '定时执行：') + todo.schedule + '\n点这里改时间',
            onClick: () => beginWhen(todo),
          },
          (due ? '\u23F0 ' : '\u25F4 ') + todo.schedule.slice(5).replace('T', ' ') + ' \u270E',
        ),
        // A sibling, not a nested control: an interactive element inside a
        // button is invalid and its clicks are ambiguous.
        h(
          'button',
          {
            className: 'dshtb-chip x',
            key: 'wx',
            title: '取消定时',
            onClick: () => setSchedule(todo, ''),
          },
          '\u2715',
        ),
      )
    } else {
      meta.push(
        h(
          'button',
          {
            className: 'dshtb-chip quiet',
            key: 'w',
            title: '点这里给这条待办设置定时执行时间',
            onClick: () => beginWhen(todo),
          },
          '\u25F4 不定时',
        ),
      )
    }
    // The note's own control, and the only one: `dshtb-chip` gives it the panel's
    // shared chip geometry (what the mode / schedule chips wear), while
    // `dshtb-notebtn` is the unique hook — a test looking for the note control can
    // never land on a mode chip or a time chip by accident.
    meta.push(
      h(
        'button',
        {
          className: 'dshtb-chip dshtb-notebtn',
          key: 'n',
          title:
            noteText === ''
              ? '给这条待办加备注：写给模型的上下文，派发时会一起发过去'
              : '编辑备注（当前 ' + noteText.length + ' 字）',
          onClick: () => beginNote(todo),
        },
        noteText === '' ? '\uFF0B 备注' : '\u270E 备注',
      ),
    )
    if (todo.sourceSessionTitle) {
      meta.push(h('span', { className: 'dshtb-chip', key: 't' }, todo.sourceSessionTitle))
    }
    // The bound run session is deliberately NOT shown on the row: it is an
    // internal detail, and the panel stays readable without it. The binding is
    // still what ▶ reuses; `todo_board list` and the host API expose it when
    // it actually matters.

    // Renaming happens inline and to the full width of the row: a long todo
    // needs to be readable while you edit it, not squeezed into one line.
    const editNode =
      editId === todo.id
        ? h('textarea', {
            className: 'dshtb-edit',
            ref: editRef,
            autoFocus: true,
            rows: 2,
            value: editText,
            onChange: (e) => setEditText(e.target.value),
            onBlur: commitEdit,
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                commitEdit()
              }
              if (e.key === 'Escape') setEditId('')
            },
          })
        : null

    const titleNode = editNode === null
      ? h('div', { className: 'dshtb-t', title: '双击编辑', onDoubleClick: () => beginEdit(todo) }, todo.title)
      : editNode

    // The note lives under the title as plain text — never a control, and never
    // inside the single-line title editor, which would cut a multi-line note in
    // half. While it is being edited the preview gives way to its own textarea;
    // `title` carries the full text so a clamped note is still readable on hover.
    const noteNode =
      noteId === todo.id
        ? h(
            'div',
            { className: 'dshtb-noteedit' },
            h('textarea', {
              className: 'dshtb-notearea',
              autoFocus: true,
              rows: 3,
              placeholder: '备注：写给这条待办的上下文（派发时会和标题一起发给模型）',
              value: noteDraft,
              onChange: (e) => setNoteDraft(e.target.value),
              onKeyDown: (e) => {
                // Enter saves, Shift+Enter makes a line: a note is multi-line, so
                // the newline key has to be the one that keeps typing.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitNote(todo.id)
                }
                if (e.key === 'Escape') cancelNote()
              },
            }),
            h(
              'button',
              { className: 'dshtb-notesave', title: '保存备注（Enter）', onClick: () => commitNote(todo.id) },
              '保存',
            ),
            h('button', { className: 'dshtb-notecancel', title: '取消（Esc）', onClick: cancelNote }, '取消'),
          )
        : noteText === ''
          ? null
          : h('div', { className: 'dshtb-note', title: '备注：\n' + noteText }, noteText)

    // A plain monospace readout under the title: the directory in full, which a
    // long path would otherwise bury in a narrow panel, plus the bound session.
    // The schedule is deliberately NOT repeated here — its own chip carries it —
    // so no single fact is stated twice on one row.
    const facts = []
    facts.push('目录 ' + (todo.dirPath || todo.dir || '(未指定)'))
    if (todo.runSessionId && todo.mode !== 'newSession') {
      facts.push('会话 ' + todo.runSessionId.slice(-6))
    }
    const detailNode = h('div', { className: 'dshtb-facts' }, facts.join('  ·  '))

    // Attached images: thumbnails on the row, click to enlarge, ✕ to drop.
    const images = Array.isArray(todo.images) ? todo.images : []
    const imagesNode =
      images.length === 0
        ? null
        : h(
            'div',
            { className: 'dshtb-imgs' },
            images.map((image, at) =>
              h(
                'span',
                { className: 'dshtb-imgwrap', key: 'i' + at },
                h('img', {
                  className: 'dshtb-img',
                  src: imageUrl(image.attachmentId),
                  alt: image.name || '附图',
                  title: (image.name || '附图') + ' · ' + image.width + '×' + image.height + '（点击放大）',
                  onClick: () => setViewing(image),
                  onError: (e) => {
                    e.currentTarget.style.opacity = '0.25'
                  },
                }),
                h(
                  'button',
                  {
                    className: 'dshtb-imgx',
                    title: '移除这张图片',
                    onClick: () => patch(todo.id, {
                      images: images.filter((_, i) => i !== at),
                      clearImages: images.length === 1,
                    }),
                  },
                  '\u2715',
                ),
              ),
            ),
          )

    // A finished row belongs to no queue, so it is neither draggable nor a drop
    // target: `dropOn` reorders the OPEN list, and this row is not in it any more.
    const dragProps = finished
      ? {}
      : {
          onDragStart: (e) => {
            setDragId(todo.id)
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', todo.id)
            }
          },
          onDragOver: (e) => {
            e.preventDefault()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
            if (overId !== todo.id) setOverId(todo.id)
          },
          onDragLeave: () => {
            if (overId === todo.id) setOverId('')
          },
          onDrop: (e) => {
            e.preventDefault()
            dropOn(todo.id)
          },
          onDragEnd: () => {
            setDragId('')
            setOverId('')
          },
        }

    return h(
      'div',
      {
        className: cls,
        key: todo.id,
        style: { animationDelay: Math.min(rowIndex, 12) * 18 + 'ms' },
        draggable: finished ? false : editId !== todo.id,
        ...dragProps,
      },
      // No handle on a finished row: an inert grip would still read as "drag me".
      // The row simply starts a little further left, which is what "not in the
      // queue any more" looks like.
      finished ? null : h('span', { className: 'dshtb-grip', title: '拖动调整执行顺序' }, '\u283F'),
      h(
        'div',
        { className: 'dshtb-checks' },
        h(
          'button',
          {
            className: 'dshtb-cb ai' + (todo.aiDone ? ' on' : ''),
            'aria-label': 'AI 已完成',
            title: todo.aiDone ? 'AI 已完成 — 点击撤销' : 'AI 已完成（由 AI 自动勾选，也可手点）',
            onClick: () => patch(todo.id, { aiDone: !todo.aiDone }),
          },
          todo.aiDone ? '\u2713' : '',
        ),
        h(
          'button',
          {
            className: 'dshtb-cb me' + (todo.verified ? ' on' : ''),
            'aria-label': '用户已验收',
            title: todo.verified ? '已验收 — 点击撤销' : '用户已验收（只有你能勾）',
            onClick: () => patch(todo.id, { verified: !todo.verified }),
          },
          todo.verified ? '\u2713' : '',
        ),
      ),
      h(
        'div',
        { className: 'dshtb-body' },
        titleNode,
        noteNode,
        detailNode,
        imagesNode,
        h('div', { className: 'dshtb-meta' }, meta),
      ),
      h(
        'div',
        { className: 'dshtb-acts' },
        h(
          'button',
          {
            className: 'dshtb-ic',
            // Once a row has been handed to a session, sending it again just
            // duplicates work — the automatic paths decide when it runs next.
            // A row whose target is gone is also locked, because ▶ would send it
            // to whatever session happens to be open, not the one it belongs to.
            title: runnable
              ? '立即接续到当前会话'
              : state === 'lost'
                ? '目标会话已丢失，不能手动派发；改模式/换目录或等到点自动重试'
                : '已派发，不能重复派发',
            disabled: busy || !runnable,
            onClick: () =>
              call('run', { id: todo.id, sessionId: currentId === undefined ? '' : currentId }),
          },
          '\u25B6',
        ),
        h(
          'button',
          {
            className: 'dshtb-ic',
            title: '删除',
            disabled: busy,
            onClick: () => call('remove', { id: todo.id }),
          },
          '\u2715',
        ),
      ),
    )
  }

  if (!open) {
    const next = visible.filter((t) => !t.verified && !t.aiDone)[0]
    return h(
      'div',
      {
        className: 'dshtb-root',
        // The skin travels with the parked line too: it is the same panel.
        'data-dshtb-skin': skin,
        style:
          layout === null
            ? {}
            : {
                left: layout.x + 'px',
                top: layout.y + 'px',
                right: 'auto',
                width: 'auto',
                height: 'auto',
                maxWidth: 'none',
                maxHeight: 'none',
              },
      },
      h(
        'div',
        {
          className: 'dshtb-pill',
          role: 'button',
          tabIndex: 0,
          title:
            'TODO 板 · 点击展开' +
            (next === undefined ? '（没有未完成待办）' : '：' + next.title) +
            (data !== null && data !== undefined && data.storagePath ? '\n存储：' + data.storagePath : ''),
          onClick: () => setOpen(true),
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setOpen(true)
            }
          },
        },
        h('span', { className: 'lbl' }, 'TODO'),
        h(
          'span',
          { className: 'dshtb-badge' + (awaitingVerify > 0 ? ' warn' : '') },
          String(openCount),
        ),
        next === undefined
          ? h('span', { className: 'next q' }, filter === 'dir' ? '当前目录已清空' : '没有未完成待办')
          : h('span', { className: 'next' }, '下一条 · ' + next.title),
        awaitingVerify > 0 ? h('span', { className: 'dshtb-badge warn' }, '待验 ' + awaitingVerify) : null,
      ),
    )
  }

  const segments = [
    { id: 'dir', label: '当前目录', count: byDir.filter((t) => !t.verified).length },
    { id: 'session', label: '当前会话', count: bySession.filter((t) => !t.verified).length },
    { id: 'all', label: '全部', count: openCount },
  ].map((seg) =>
    h(
      'button',
      {
        key: seg.id,
        className: filter === seg.id ? 'on' : '',
        onClick: () => setFilter(seg.id),
      },
      seg.label,
      h('em', null, String(seg.count)),
    ),
  )

  let rowIndex = 0
  const rows = groups.map((group) =>
    h(
      'div',
      { key: group.key },
      h('div', { className: 'dshtb-group' }, group.key),
      group.items.map((todo) => item(todo, rowIndex++)),
    ),
  )

  // The title-bar control doubles as the readout of which skin is on: its glyph
  // is the skin, and its tooltip names that skin and what it changes. Resolved
  // from the same table the cycle walks, so the label can never describe a
  // different skin than the one being applied.
  const activeSkin = SKINS.find((entry) => entry.id === skin) || SKINS[0]
  const skinName = activeSkin.name
  const skinHint = activeSkin.hint
  const skinGlyph = activeSkin.glyph

  const rootStyle =
    layout === null
      ? {}
      : {
          left: layout.x + 'px',
          top: layout.y + 'px',
          right: 'auto',
          width: layout.w + 'px',
          height: layout.h + 'px',
          maxWidth: 'none',
          maxHeight: 'none',
        }

  /**
   * The log page, rendered in place of the board inside the same floating
   * window — same frame, same drag and resize, no second window. Deliberately
   * plain: it is a developer surface, so it uses monospace, wraps long text and
   * spends no effort on decoration.
   */
  const logView = h(
    'div',
    { className: 'dshtb-logview' },
    h(
      'div',
      { className: 'dshtb-logbar' },
      LOG_LEVELS.map((level) =>
        h(
          'button',
          {
            key: level,
            className: logLevels[level] === true ? 'on' : '',
            title: '显示 ' + level + ' 级别的记录',
            onClick: () => toggleLogLevel(level),
          },
          level,
        ),
      ),
      h(
        'button',
        {
          className: 'dshtb-logsrc',
          title:
            logSource === 'self'
              ? '当前只显示本插件的记录；点击切到「其他插件」（只会有 error）'
              : logSource === 'other'
                ? '当前只显示其他插件的 error；点击切到「全部」'
                : '当前显示全部来源；点击切回「本插件」',
          onClick: cycleLogSource,
        },
        logSource === 'self' ? '本插件' : logSource === 'other' ? '其他插件' : '全部',
      ),
      h('input', {
        className: 'dshtb-logfilter',
        placeholder: '过滤关键字…',
        value: logQuery,
        onChange: (e) => setLogQuery(e.target.value),
      }),
    ),
    h(
      'div',
      { className: 'dshtb-logbar' },
      h('button', { title: '把当前筛选出的记录复制到剪贴板', onClick: copyLog }, '复制'),
      h('button', { title: '导出为 .txt（已再次脱敏）', onClick: exportLog }, '导出'),
      h('button', { title: '只清空本面板的显示，不影响主机上的记录', onClick: clearLogView }, '清空显示'),
      logCopied !== '' ? h('span', { className: 'dshtb-logmeta' }, logCopied) : null,
    ),
    h(
      'div',
      { className: 'dshtb-logmeta' },
      '显示 ' + logShown.length + ' / ' + logLines.length + ' 条（错误 ' + latestError + '）',
      logNote === '' ? null : ' · ' + logNote,
    ),
    logShown.length === 0
      ? h(
          'div',
          { className: 'dshtb-logempty' },
          logLines.length === 0
            ? '还没有日志。这里记录本插件的失败路径（派发失败、建会话失败、读写板失败等）。'
            : '当前筛选下没有记录。试试放宽级别，或把来源切到「全部」。',
        )
      : h(
          'div',
          { className: 'dshtb-loglist' },
          logShown.map((line, at) =>
            h(
              'div',
              { key: String(line.sn) + '-' + at, className: 'dshtb-logrow ' + String(line.level) },
              h('span', { className: 'at' }, logClock(line.ts)),
              h('span', { className: 'lv' }, String(line.level)),
              h(
                'span',
                { className: 'body' },
                line.detail,
                line.source === '' || line.source === 'dsh-todo-board'
                  ? null
                  : h('span', { className: 'src' }, '  ← ' + line.source),
              ),
            ),
          ),
        ),
  )

  return h(
    'div',
    { className: 'dshtb-root', 'data-dshtb-skin': skin, style: rootStyle },
    h(
      'div',
      { className: 'dshtb-card' },
      h(
        'div',
        {
          className: 'dshtb-head',
          title: '拖动移动 · 双击还原位置',
          onPointerDown: beginDrag,
          onPointerMove: movePointer,
          onPointerUp: endPointer,
          onPointerCancel: endPointer,
          onDoubleClick: resetLayout,
        },
        h(
          'span',
          {
            className: 'dshtb-title',
            title:
              (data !== null && data !== undefined && data.storagePath
                ? '存储：' + data.storagePath + '\n'
                : '') +
              '拖动标题栏移动 · 右下角 \u25E2 缩放 · 双击还原 · 拖动 \u283F 调整执行顺序 · 双击标题改名',
          },
          h('b', null, '\u2611'),
          ' TODO',
        ),
        h('span', { className: 'dshtb-sp' }),
        h(
          'span',
          { className: 'dshtb-stats' },
          h('i', { title: '未验收' }, String(openCount)),
          awaitingVerify > 0 ? h('i', { title: 'AI 已完成，等你验收' }, '待验 ' + awaitingVerify) : null,
        ),
        h(
          'button',
          {
            className: 'dshtb-skin',
            title:
              '界面：' + skinName + '\n' + skinHint + '\n点击切换下一套（共 ' + SKINS.length + ' 套）',
            'aria-label': '切换界面风格（当前：' + skinName + '）',
            onClick: cycleSkin,
          },
          skinGlyph,
        ),
        h(
          'button',
          {
            // The dot is the whole "tell the developer without bothering the
            // user" mechanism: the log itself stays out of the way until this
            // button is clicked, and this button only advertises itself when
            // something actually went wrong.
            className: 'dshtb-log' + (logOpen ? ' on' : ''),
            title: logOpen
              ? '回到待办面板'
              : '开发者日志' +
                (logAlert ? '（有新的错误）' : '') +
                '\n平时用不到；出问题时把这里的内容复制给开发者看。',
            'aria-label': logOpen ? '回到待办面板' : '打开开发者日志',
            'aria-pressed': logOpen ? 'true' : 'false',
            onClick: toggleLog,
          },
          logOpen ? '\u2190' : '\u2699',
          logAlert ? h('span', { className: 'dshtb-dot' }) : null,
        ),
        h(
          'button',
          {
            className: 'dshtb-fold',
            title: '收起为一行（只留计数与下一条待办）',
            'aria-label': '收起为一行',
            onClick: togglePanel,
          },
          '\u2013',
        ),
      ),
      logOpen ? logView : null,
      logOpen ? null : h('div', { className: 'dshtb-seg' }, segments),
      // `foldable` returns an ARRAY of [header, body], so it is always spread
      // rather than passed as one child. Nesting the array as a child works in
      // React but hides the subtree from anything that walks `children`
      // directly, which is what the browser-half suite does.
      ...(logOpen
        ? []
        : foldable({
            id: 'compose',
            name: '新增待办',
            open: sections.compose,
            onToggle: toggleSection,
            body: h(
              'div',
              { className: 'dshtb-compose', key: 'compose-body' },
              h(
                'div',
                { className: 'dshtb-add' },
                h('textarea', {
                  ref: inputRef,
                  rows: 3,
                  placeholder:
                    '新增待办…（Enter 添加，Shift+Enter 换行，Ctrl+V 粘贴截图）',
                  value: draft,
                  onChange: (e) => setDraft(e.target.value),
                  onPaste: pasteImages,
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      add()
                    }
                  },
                }),
                h(
                  'button',
                  { className: 'dshtb-ic', title: '添加', disabled: busy || draft.trim() === '', onClick: add },
                  '\uFF0B',
                ),
              ),
              // No picker button and no standing hint: images arrive by pasting into
              // the composer above, and the composer's own placeholder already names
              // Ctrl+V. The attachment area therefore renders NOTHING while empty —
              // the counter appears only once something is attached, which is when
              // it carries information. Format support and the per-todo limit are
              // unchanged: both are enforced on paste and reported when they bite.
              pending.length === 0
                ? null
                : h(
                    'div',
                    { className: 'dshtb-attach' },
                    h(
                      'div',
                      { className: 'dshtb-hint' },
                      '已附 ' + pending.length + ' / ' + MAX_IMAGES + ' 张 · 点缩略图移除',
                    ),
                    h(
                      'div',
                      { className: 'dshtb-thumbs' },
                      pending.map((image, at) =>
                        h(
                          'button',
                          {
                            key: 'p' + at,
                            className: 'dshtb-thumb',
                            title: (image.name || '图片') + '（点击移除）',
                            onClick: () => setPending((current) => current.filter((_, i) => i !== at)),
                          },
                          h('img', { src: 'data:' + image.mediaType + ';base64,' + image.data, alt: image.name || '' }),
                          h('span', { className: 'x' }, '\u2715'),
                        ),
                      ),
                    ),
                  ),
              h(
                'div',
                { className: 'dshtb-modes' },
                MODES.map((id) =>
                  h(
                    'button',
                    { key: id, className: mode === id ? 'on' : '', title: MODE_LABEL[id], onClick: () => setMode(id) },
                    MODE_SHORT[id],
                  ),
                ),
              ),
              h('div', { className: 'dshtb-hint' }, MODE_HINT[mode]),
              h(
                'div',
                { className: 'dshtb-when' },
                h('span', { className: 'lbl' }, '定时'),
                h('input', {
                  type: 'datetime-local',
                  value: when,
                  title: '到点后才执行（留空 = 立即可以执行）',
                  onChange: (e) => setWhen(e.target.value),
                }),
                when !== ''
                  ? h(
                      'button',
                      {
                        className: 'dshtb-ic',
                        title: '取消定时',
                        onClick: () => setWhen(''),
                      },
                      '\u2715',
                    )
                  : h('span', { className: 'dshtb-hint' }, '不填'),
              ),
              h(
                'div',
                { className: 'dshtb-dir' },
                h('span', { className: 'lbl' }, '目录'),
                h('input', {
                  // Empty means 「跟随当前会话」, not 「no directory」, and the old
                  // placeholder ("目录：<cwd>") read like a value that was already
                  // filled in. Say what an empty field will actually do instead.
                  placeholder: cwd === '' ? '留空 = 用当前会话的工作目录' : '留空 = ' + cwd,
                  title:
                    '这条待办归到哪个目录：它决定分组、决定「当前目录」筛选，' +
                    '也决定回合结束后由哪个会话来接续。留空 = 跟随当前会话的工作目录。',
                  value: dirInput,
                  onChange: (e) => setDirInput(e.target.value),
                }),
              ),
            ),
          })),
      ...(logOpen
        ? []
        : foldable({
            id: 'list',
            name: '待办列表',
            note: visible.length,
            open: sections.list,
            onToggle: toggleSection,
            body:
              rows.length === 0
                ? h(
                    'div',
                    { className: 'dshtb-empty', key: 'list-body' },
                    h('b', null, '\u2610'),
                    h(
                      'span',
                      null,
                      completed.length > 0
                        ? '未完成的都清空了（已完成的在下面）'
                        : filter === 'dir'
                          ? '当前目录还没有待办'
                          : '这里还没有待办',
                    ),
                  )
                : h(
                    'div',
                    { className: 'dshtb-list', key: 'list-body' },
                    // The note explains the mode chip the rows carry, so it lives
                    // with them — and only when there ARE rows: with nothing on the
                    // board there is no mode to change and no advice worth giving.
                    h(
                      'div',
                      { className: 'dshtb-listhint' },
                      '你可以通过点击更改任务执行模式，但不建议任务开始执行后更改',
                    ),
                    rows,
                  ),
          })),
      // The other half of the list, between the queue and the panel footer. It is
      // a separate section rather than a filter on the list: ticking the round box
      // has to LOOK like the row left the queue, and a filter would silently keep
      // finished rows one click away from the work you are doing.
      ...(logOpen
        ? []
        : foldable({
            id: 'done',
            name: '已完成',
            note: completed.length,
            open: sections.done,
            onToggle: toggleSection,
            body:
              doneGroups.length === 0
                ? h(
                    'div',
                    { className: 'dshtb-doneempty', key: 'done-body' },
                    '还没有已验收的待办。勾上每行右边的圆勾，条目就会移到这里。',
                  )
                : h(
                    'div',
                    { className: 'dshtb-donelist', key: 'done-body' },
                    doneGroups.map((group) =>
                      h(
                        'div',
                        { key: 'done-' + group.key },
                        h('div', { className: 'dshtb-group' }, group.key),
                        group.items.map((todo) => item(todo, 0, true)),
                      ),
                    ),
                  ),
          })),
      err !== '' ? h('div', { className: 'dshtb-err' }, err) : null,
      data !== null && data !== undefined && data.storageError
        ? h('div', { className: 'dshtb-err' }, data.storageError)
        : null,
      // The status line is NOT a section any more. It carries exactly two facts —
      // which build is live and how much is still open — and a fact you have to
      // unfold to read is worse than useless: it can be folded away and then lie
      // by omission. So it has no header, no fold, and no stored state; the
      // `.dshtb-sp` keeps the two facts on the left and the two functional
      // entries (empty the 已完成 list, open the Cordis panel) on the right.
      logOpen
        ? null
        : h(
            'div',
            { className: 'dshtb-foot', key: 'foot' },
            h('span', { title: '客户端构建标记，用来确认浏览器加载的是哪一版' }, 'v' + BUILD),
            h('span', { title: '还没验收的条数' }, '未验收 ' + openCount),
            awaitingVerify > 0 ? h('span', { title: 'AI 已完成、等你验收' }, '· 待验 ' + awaitingVerify) : null,
            h('span', { className: 'dshtb-sp' }),
            verifiedCount > 0
              ? h(
                  'button',
                  {
                    className: 'dshtb-link',
                    title: '删除所有已验收的条目（共 ' + verifiedCount + ' 条）',
                    onClick: () => call('clearVerified'),
                  },
                  '清理已验收 ' + verifiedCount,
                )
              : null,
            h(
              'button',
              {
                className: 'dshtb-link' + (cordisFound ? '' : ' off'),
                title: cordisFound
                  ? '打开 Cordis 动态插件面板（显示在本面板正下方）'
                  : '找不到 Cordis 入口，暂时打不开',
                onClick: openCordisPanel,
              },
              'Cordis Plugin',
            ),
          ),
      h('div', {
        className: 'dshtb-resize',
        title: '拖动缩放 · 双击还原',
        onPointerDown: beginResize,
        onPointerMove: movePointer,
        onPointerUp: endPointer,
        onPointerCancel: endPointer,
        onDoubleClick: resetLayout,
      }),
      viewing === null
        ? null
        : h(
            'div',
            { className: 'dshtb-light', onClick: () => setViewing(null) },
            h('img', {
              src: imageUrl(viewing.attachmentId),
              alt: viewing.name || '附图',
              onClick: (e) => e.stopPropagation(),
            }),
            h('div', { className: 'dshtb-lightcap' }, viewing.name || '附图', ' · ', viewing.width + '×' + viewing.height, ' · 点空白处关闭'),
          ),
    ),
  )
}

// ------------------------------------------------------------ plugin entry

exports.name = 'dsh-todo-board'
exports.inject = ['slots']
exports.apply = function apply(ctx) {
  ctx.effect(
    () => {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-todo-board', '')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    },
    'dsh-todo-board: styles',
  )

  // One tag per skin, all live at once and scoped under the root's
  // `data-dshtb-skin`, so switching is an attribute write on one node: no
  // re-injection, no flash of unstyled panel, and unregistering the default
  // skin stays impossible because its rules are never removed.
  for (const id of Object.keys(SKIN_CSS)) {
    ctx.effect(
      () => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-todo-board', '')
        style.setAttribute('data-dsh-todo-board-skin', id)
        style.textContent = SKIN_CSS[id]
        document.head.appendChild(style)
        return () => style.remove()
      },
      'dsh-todo-board: skin ' + id,
    )
  }

  ctx.effect(() => () => restoreCordisFooter(), 'dsh-todo-board: cordis bridge')

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'todo-board', order: 40, label: 'TODO 板' },
      TodoBoard,
    ),
  )
}

return module.exports;
} });
