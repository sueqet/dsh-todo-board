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
const MODE_LABEL = { remind: '提醒', resume: '自动续跑', newSession: '自动新会话' }
const MODE_SHORT = { remind: '提醒', resume: '续跑', newSession: '新会话' }
const MODE_HINT = {
  remind: '只在这里提醒你，不会自动发送任何消息。',
  resume: 'AI 一停就自动把这条注入当前会话继续跑。',
  newSession: 'AI 一停就自动新建一个同目录会话来执行。',
}
const MONO = 'ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace'
/** Bumped whenever the browser half changes, so the footer proves which build is live. */
const BUILD = '0.3.1'

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
.dshtb-fold{width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--tb-dim);
  cursor:pointer;font:600 13px/1 ${MONO};padding:0;transition:background .12s,color .12s}
.dshtb-fold:hover{background:var(--dsw-alias-bg-layer-1);color:var(--tb-ink)}
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
.dshtb-dir input{width:100%;padding:6px 9px;border-radius:8px;border:1px dashed var(--tb-line);
  background:transparent;color:var(--tb-dim);font:inherit;font-size:12px;outline:none;
  transition:border-color .12s,color .12s}
.dshtb-when{display:flex;align-items:center;gap:7px;font:600 11px/1 ${MONO};color:var(--tb-dim)}
.dshtb-when .lbl{letter-spacing:.08em}
.dshtb-when input{flex:1;min-width:0;padding:5px 8px;border-radius:8px;border:1px dashed var(--tb-line);
  background:transparent;color:var(--tb-dim);font:inherit;font-size:12px;outline:none;
  transition:border-color .12s,color .12s;color-scheme:dark light}
.dshtb-when input:focus{border-style:solid;border-color:var(--tb-accent);color:var(--tb-ink)}
.dshtb-dir input::placeholder{color:var(--tb-dim);opacity:.85}
.dshtb-dir input:focus{border-style:solid;border-color:var(--tb-accent);color:var(--tb-ink)}
.dshtb-list{overflow:auto;padding:2px 0 6px;scrollbar-width:thin}
.dshtb-list::-webkit-scrollbar{width:9px}
.dshtb-list::-webkit-scrollbar-thumb{background:var(--tb-line2);border-radius:5px;
  border:3px solid transparent;background-clip:content-box}
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
.dshtb-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;
  font:400 12px/1.5 ${MONO};color:var(--tb-dim)}
.dshtb-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--tb-line);white-space:nowrap;
  font:inherit;font-size:12px;color:var(--tb-dim)}
button.dshtb-chip{cursor:pointer;font:inherit;color:inherit;transition:border-color .12s,color .12s}
button.dshtb-chip:hover{border-color:var(--tb-line2);color:var(--tb-ink)}
.dshtb-chip.sent{color:var(--tb-ok);border-color:var(--tb-ok)}
.dshtb-chip.due{color:var(--tb-warn);border-color:var(--tb-warn);font-weight:600}
.dshtb-chip.bound{color:var(--tb-accent);border-color:var(--tb-accent)}
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
.dshtb-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:8px 12px;
  border-top:1px solid var(--tb-line);
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
.dshtb-pill{display:inline-flex;align-items:center;gap:7px;padding:7px 12px 7px 10px;border-radius:999px;
  background:var(--tb-bg);border:1px solid var(--tb-line);cursor:pointer;user-select:none;
  box-shadow:0 8px 26px -10px rgba(0,0,0,.5);transition:transform .14s,border-color .14s}
.dshtb-pill:hover{transform:translateY(-1px);border-color:var(--tb-line2)}
.dshtb-pill .lbl{font:600 10px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase}
.dshtb-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--tb-accent);
  color:#fff;font:700 10px/1 ${MONO};font-variant-numeric:tabular-nums;display:inline-grid;place-items:center}
.dshtb-badge.warn{background:var(--tb-warn)}
`

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
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return response.json()
}

const transport = {
  snapshot: () => request('GET'),
  call: (method, args) => request('POST', Object.assign({ action: method }, args)),
}

function describe(failure) {
  if (failure === null || failure === undefined) return 'unknown error'
  if (typeof failure === 'string') return failure
  if (typeof failure.message === 'string') return failure.message
  return String(failure)
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

function clampLayout(layout) {
  const maxW = Math.max(MIN_W, window.innerWidth - 16)
  const maxH = Math.max(MIN_H, window.innerHeight - 16)
  const w = Math.min(Math.max(layout.w, MIN_W), maxW)
  const h = Math.min(Math.max(layout.h, MIN_H), maxH)
  const x = Math.min(Math.max(layout.x, 8), Math.max(8, window.innerWidth - w - 8))
  const y = Math.min(Math.max(layout.y, 8), Math.max(8, window.innerHeight - h - 8))
  return { x, y, w, h }
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
  const [filter, setFilter] = React.useState('dir')
  const [busy, setBusy] = React.useState(false)
  const [dragId, setDragId] = React.useState('')
  const [overId, setOverId] = React.useState('')
  const [editId, setEditId] = React.useState('')
  const [editText, setEditText] = React.useState('')
  const [layout, setLayout] = React.useState(loadLayout)
  const [cordisFound, setCordisFound] = React.useState(true)
  const layoutRef = React.useRef(null)
  const dragRef = React.useRef(null)
  const inputRef = React.useRef(null)
  /** id -> remindedAt already surfaced, so a reminder notifies exactly once. */
  const seenReminders = React.useRef({})

  function applyLayout(next) {
    const clamped = clampLayout(next)
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
    layoutRef.current = null
    setLayout(null)
    saveLayout(null)
  }

  // Grow the composer with its content, up to the CSS max-height.
  React.useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [draft])

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
    collapseCordisFooter()
    anchorCordisPanel()
    setCordisFound(cordisBadge() !== null)
  }

  React.useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 2500)
    return () => window.clearInterval(id)
  }, [])

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
  const visible = scope.slice().sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)

  const awaitingVerify = todos.filter((t) => t.aiDone && !t.verified).length
  const verifiedCount = todos.filter((t) => t.verified).length
  const openCount = todos.filter((t) => !t.verified).length

  const groups = []
  const index = {}
  for (const todo of visible) {
    const key = todo.dirLabel || '(未指定目录)'
    if (index[key] === undefined) {
      index[key] = groups.length
      groups.push({ key, items: [] })
    }
    groups[index[key]].items.push(todo)
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
    setDraft('')
    setWhen('')
    call('create', {
      title,
      mode,
      dir: targetDir,
      schedule: when,
      sessionId: currentId === undefined ? '' : currentId,
      sessionTitle: currentTitle,
    })
  }

  function setSchedule(todo, value) {
    patch(todo.id, { schedule: value })
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

  function item(todo, rowIndex) {
    let cls = 'dshtb-item'
    if (todo.verified) cls += ' done'
    if (dragId === todo.id) cls += ' dragging'
    if (overId === todo.id && dragId !== '' && dragId !== todo.id) cls += ' over'

    const meta = [
      h(
        'span',
        {
          className: 'dshtb-chip',
          key: 'd',
          title: todo.dirPath
            ? '工作目录：' + todo.dirPath
            : '这条待办没有绑定目录（新增时目录留空且当前会话没有工作区）',
        },
        todo.dirLabel,
      ),
    ]
    meta.push(
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
    )
    if (todo.dispatchedAt > 0 && !todo.aiDone) {
      meta.push(h('span', { className: 'dshtb-chip sent', key: 's', title: '已经派发过一次' }, '已派发'))
    }
    if (todo.schedule) {
      const due = typeof todo.dueAt === 'number' && todo.dueAt > 0 && todo.dueAt <= Date.now()
      meta.push(
        h(
          'button',
          {
            className: 'dshtb-chip' + (due ? ' due' : ''),
            key: 'w',
            title: due
              ? '已到时间：' + todo.schedule + '（点 ✕ 取消定时）'
              : '定时执行：' + todo.schedule + '（点 ✕ 取消定时）',
            onClick: () => setSchedule(todo, ''),
          },
          (due ? '\u23F0 ' : '\u25F4 ') + todo.schedule.slice(5).replace('T', ' ') + ' ✕',
        ),
      )
    }
    if (todo.sourceSessionTitle) {
      meta.push(h('span', { className: 'dshtb-chip', key: 't' }, todo.sourceSessionTitle))
    }
    // A `newSession` row owns the session it opened. Showing the binding makes
    // it obvious that pressing ▶ again reuses that session instead of opening
    // yet another one; ✕ drops the binding so the next run opens a fresh one.
    if (todo.mode === 'newSession' && todo.runSessionId) {
      meta.push(
        h(
          'button',
          {
            className: 'dshtb-chip bound',
            key: 'b',
            title:
              '已绑定会话：' + todo.runSessionId +
              '\n▶ 会把待办发到这个会话，不会新开；点 ✕ 解绑，下次重新开一个新会话',
            onClick: () => patch(todo.id, { runSessionId: '' }),
          },
          '会话 ' + todo.runSessionId.slice(-6) + ' ✕',
        ),
      )
    }

    const titleNode =
      editId === todo.id
        ? h('input', {
            className: 'dshtb-edit',
            autoFocus: true,
            value: editText,
            onChange: (e) => setEditText(e.target.value),
            onBlur: commitEdit,
            onKeyDown: (e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') setEditId('')
            },
          })
        : h('div', { className: 'dshtb-t', title: '双击编辑', onDoubleClick: () => beginEdit(todo) }, todo.title)

    // A plain monospace readout under the title: the two facts the chips can
    // bury in a narrow panel are always visible here — the working directory
    // this task runs in, and the time it is scheduled for.
    const facts = []
    facts.push('目录 ' + (todo.dirPath || todo.dir || '(未指定)'))
    facts.push(todo.schedule ? '定时 ' + todo.schedule : '不定时')
    if (todo.runSessionId && todo.mode !== 'newSession') {
      facts.push('会话 ' + todo.runSessionId.slice(-6))
    }
    const detailNode = h('div', { className: 'dshtb-facts' }, facts.join('  ·  '))

    return h(
      'div',
      {
        className: cls,
        key: todo.id,
        style: { animationDelay: Math.min(rowIndex, 12) * 18 + 'ms' },
        draggable: editId !== todo.id,
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
      },
      h('span', { className: 'dshtb-grip', title: '拖动调整执行顺序' }, '\u283F'),
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
      h('div', { className: 'dshtb-body' }, titleNode, detailNode, h('div', { className: 'dshtb-meta' }, meta)),
      h(
        'div',
        { className: 'dshtb-acts' },
        h(
          'button',
          {
            className: 'dshtb-ic',
            title: todo.dispatchedAt > 0 ? '重新接续到当前会话' : '立即接续到当前会话',
            disabled: busy,
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
    return h(
      'div',
      {
        className: 'dshtb-root',
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
          title:
            'TODO 板 · 点击展开' +
            (data !== null && data !== undefined && data.storagePath ? '\n存储：' + data.storagePath : ''),
          onClick: () => setOpen(true),
        },
        h('span', { className: 'lbl' }, 'TODO'),
        h(
          'span',
          { className: 'dshtb-badge' + (awaitingVerify > 0 ? ' warn' : '') },
          String(openCount),
        ),
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

  return h(
    'div',
    { className: 'dshtb-root', style: rootStyle },
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
        h('button', { className: 'dshtb-fold', title: '收起', onClick: () => setOpen(false) }, '\u2013'),
      ),
      h('div', { className: 'dshtb-seg' }, segments),
      h(
        'div',
        { className: 'dshtb-compose' },
        h(
          'div',
          { className: 'dshtb-add' },
          h('textarea', {
            ref: inputRef,
            rows: 3,
            placeholder: '新增待办…（Enter 添加，Shift+Enter 换行）',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
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
          h('input', {
            placeholder: cwd === '' ? '目录（绝对路径）' : '目录：' + cwd,
            value: dirInput,
            onChange: (e) => setDirInput(e.target.value),
          }),
        ),
      ),
      rows.length === 0
        ? h(
            'div',
            { className: 'dshtb-empty' },
            h('b', null, '\u2610'),
            h(
              'span',
              null,
              filter === 'dir' ? '当前目录还没有待办' : '这里还没有待办',
            ),
          )
        : h('div', { className: 'dshtb-list' }, rows),
      err !== '' ? h('div', { className: 'dshtb-err' }, err) : null,
      data !== null && data !== undefined && data.storageError
        ? h('div', { className: 'dshtb-err' }, data.storageError)
        : null,
      h(
        'div',
        { className: 'dshtb-foot' },
        h('span', { title: '客户端构建标记，用来确认浏览器加载的是哪一版' }, 'v' + BUILD),
        h('span', null, '未验收 ' + openCount),
        awaitingVerify > 0 ? h('span', null, '· 待验 ' + awaitingVerify) : null,
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
