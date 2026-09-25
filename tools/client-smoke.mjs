/**
 * Browser-half smoke test for dsh-todo-board.
 *
 * The client module only reaches for `require('react')` and a few globals, so it
 * can be loaded in Node against a tiny hook runtime and a stub DOM. That is
 * enough to pin down the panel's folding behaviour — which sections exist, what
 * the parked one-line view shows, and that the title bar's drag handle does not
 * swallow a click meant for a button.
 *
 *   node tools/client-smoke.mjs
 */

import assert from 'node:assert/strict'

// ------------------------------------------------------------- React shim

let hooks = []
let cursor = 0
let rendering = false
let scheduled = false
const pendingEffects = []

function scheduleRender() {
  if (rendering) {
    scheduled = true
    return
  }
  let guard = 0
  do {
    scheduled = false
    render()
    guard += 1
  } while (scheduled && guard < 50)
}

function flushEffects() {
  if (pendingEffects.length === 0) return
  const running = pendingEffects.splice(0, pendingEffects.length)
  for (const effect of running) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
    const cleanup = effect.run()
    effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    effect.ran = true
  }
}

function slot(at) {
  if (hooks[at] === undefined) hooks[at] = {}
  return hooks[at]
}

const React = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (value) => {
      if (value === null || value === undefined || value === false || value === true) return
      if (Array.isArray(value)) {
        for (const item of value) push(item)
        return
      }
      flat.push(value)
    }
    for (const child of children) push(child)
    return { type, props: props === null || props === undefined ? {} : props, children: flat }
  },
  useState(initial) {
    const at = cursor
    cursor += 1
    const store = slot(at)
    if (!('value' in store)) store.value = typeof initial === 'function' ? initial() : initial
    return [
      store.value,
      (next) => {
        store.value = typeof next === 'function' ? next(store.value) : next
        scheduleRender()
      },
    ]
  },
  useRef(initial) {
    const at = cursor
    cursor += 1
    const store = slot(at)
    if (store.ref === undefined) store.ref = { current: initial }
    return store.ref
  },
  useEffect(run, deps) {
    const at = cursor
    cursor += 1
    const store = slot(at)
    const previous = store.deps
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.length ||
      deps.some((value, i) => !Object.is(value, previous[i]))
    if (!changed) return
    store.deps = deps
    // Cleanup belongs to the effect that installed it, not to the slot.
    const effect = { run }
    if (typeof store.cleanup === 'function') effect.cleanup = store.cleanup
    store.cleanup = undefined
    pendingEffects.push(effect)
    store.effect = effect
  },
}

// ------------------------------------------------------------- DOM stubs

const storage = new Map()
const listeners = []

// The interval the polling effect installs is never fired: this test drives
// renders through the controls, not through the clock.
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  setInterval: () => 1,
  clearInterval: () => {},
  addEventListener: (type, listener) => listeners.push({ type, listener }),
  removeEventListener: (type, listener) => {
    const at = listeners.findIndex((l) => l.type === type && l.listener === listener)
    if (at >= 0) listeners.splice(at, 1)
  },
  innerWidth: 1440,
  innerHeight: 900,
}

/** What the browser does on a viewport change: fire the resize listeners. */
function resizeTo(width, height) {
  globalThis.window.innerWidth = width
  globalThis.window.innerHeight = height
  const fired = listeners.filter((l) => l.type === 'resize')
  for (const l of fired) l.listener({ type: 'resize' })
  return fired.length
}

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ setAttribute() {}, remove() {}, style: {} }),
  head: { appendChild() {} },
}

// ------------------------------------------------------------ board data

const CWD = 'D:\\DSH\\plugin'
const DIR_KEY = CWD.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * A panel row as the host sends it. `state` is derived host-side (it depends on
 * live agent status), so the fixture spells it out rather than recomputing it —
 * a wrong default here would hide a real client bug.
 */
function todo(over) {
  const base = {
    id: 'x',
    title: 'x',
    dir: DIR_KEY,
    dirPath: CWD,
    dirLabel: 'plugin',
    mode: 'resume',
    aiDone: false,
    verified: false,
    note: '',
    images: [],
    schedule: '',
    dueAt: 0,
    remindedAt: 0,
    order: 0,
    sourceSessionId: 's1',
    sourceSessionTitle: '会话',
    dispatchedAt: 0,
    lostAt: 0,
    state: 'pending',
    targetAlive: true,
    runSessionId: '',
    createdAt: 1,
    updatedAt: 1,
  }
  const merged = { ...base, ...over }
  // Keep the derived fields honest for the common cases, so a test that only
  // wants "a finished row" does not have to restate them.
  if (over.state === undefined) {
    if (merged.verified || merged.aiDone) merged.state = 'done'
    else if (merged.lostAt > 0) merged.state = 'lost'
    else if (merged.dispatchedAt > 0) merged.state = 'dispatched'
  }
  return merged
}

const snapshot = {
  ok: true,
  storagePath: 'D:\\DSH\\dsh-home\\todo-board\\board.json',
  todos: [
    todo({ id: 'a', title: '下一条要做的', order: 0 }),
    todo({ id: 'b', title: 'AI 已做完的', order: 1, aiDone: true }),
    todo({ id: 'c', title: '已验收的', order: 2, verified: true }),
  ],
}

/** Every POST the panel makes, so a test can assert on the wire payload. */
const calls = []

globalThis.fetch = async (url, options) => {
  if (options !== undefined && typeof options.body === 'string') {
    try {
      calls.push(JSON.parse(options.body))
    } catch (err) {
      calls.push({ unparseable: options.body })
    }
  }
  return { ok: true, status: 200, json: async () => snapshot }
}

// ----------------------------------------------------- load the client half

let factory = null
globalThis.window.__ModuleLoader__ = {
  load(entry) {
    factory = entry.factory
  },
}

const clientUrl = new URL('../client/client.js', import.meta.url)
await import(clientUrl.href)
assert.ok(factory !== null, 'client.js registered itself with the module loader')

const exports_ = factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
assert.equal(exports_.name, 'dsh-todo-board')

// ------------------------------------------------------------ render tree

const TodoBoard = (() => {
  // The component is not exported; it is the slot target `apply()` registers.
  let captured = null
  exports_.apply({
    effect: (callback) => {
      callback()
      return () => {}
    },
    slots: {
      inject: (_name, register) => register(),
      register: (_options, component) => {
        captured = component
      },
    },
  })
  assert.ok(captured !== null, 'apply() registered the overlay component')
  return captured
})()

function findByClass(node, className) {
  const out = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    const cls = current.props?.className
    if (typeof cls === 'string' && cls.split(/\s+/).includes(className)) out.push(current)
    if (Array.isArray(current.children)) for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return node.children.map(textOf).join('')
}

function findByText(node, needle) {
  const out = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (textOf(current).includes(needle)) out.push(current)
    if (Array.isArray(current.children)) for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

function render() {
  cursor = 0
  rendering = true
  let tree
  try {
    tree = TodoBoard({
      useSessions: (select) => select({ current: 's1', byId: { s1: { cwd: CWD, title: '会话' } } }),
    })
  } finally {
    rendering = false
  }
  flushEffects()
  return tree
}

/**
 * Mount the component from scratch, as a page load would.
 *
 * `useState` initializers only run on a real first mount, and the shim's hook
 * store would otherwise carry state across renders — so a test that seeds
 * localStorage and expects the panel to pick it up must reset the store first.
 */
function remount() {
  hooks = []
  cursor = 0
  scheduled = false
  pendingEffects.length = 0
  return render()
}

function click(node) {
  assert.equal(typeof node.props.onClick, 'function', 'the node is clickable')
  node.props.onClick({ preventDefault() {}, stopPropagation() {} })
  return render()
}

function sectionButton(tree, label) {
  const found = findByClass(tree, 'dshtb-sect').filter((node) => textOf(node).includes(label))
  assert.equal(found.length, 1, 'exactly one section header reads ' + label)
  return found[0]
}

// ------------------------------------------------------------- assertions

let tree = render()
// Let the polling effect's fetch settle and re-render with real data.
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

assert.equal(findByClass(tree, 'dshtb-card').length, 1, 'the expanded panel renders')
assert.equal(
  findByClass(tree, 'dshtb-add').length,
  1,
  'the composer is visible by default',
)
assert.deepEqual(
  findByClass(tree, 'dshtb-sect').map((node) => textOf(node).replace(/[▾▸]/g, '')),
  ['新增待办', '待办列表 3', '面板'],
  'the three sections are labelled with their own state',
)
console.log('render  OK')

// -- folding a section away keeps its header as the way back ---------------

tree = click(sectionButton(tree, '新增待办'))
assert.equal(findByClass(tree, 'dshtb-add').length, 0, 'the folded composer is gone')
assert.equal(
  sectionButton(tree, '新增待办').props['aria-expanded'],
  'false',
  'the section header reports the folded state',
)
assert.ok(
  JSON.parse(storage.get('dsh.todoBoard.sections.v1')).compose === false,
  'the folded section is persisted',
)

// The list folds the same way, and its header carries the row count.
tree = click(sectionButton(tree, '待办列表'))
assert.equal(findByClass(tree, 'dshtb-list').length, 0, 'the folded list is gone')
assert.ok(
  textOf(sectionButton(tree, '待办列表')).includes('待办列表 3'),
  'the folded list header keeps its count',
)

// Unfolding restores it.
tree = click(sectionButton(tree, '待办列表'))
assert.equal(findByClass(tree, 'dshtb-list').length, 1, 'unfolding brings the list back')
console.log('sections OK')

// -- the title-bar button is not eaten by the drag handle -----------------

const head = findByClass(tree, 'dshtb-head')[0]
let captures = 0
head.props.onPointerDown({
  button: 0,
  pointerId: 1,
  clientX: 0,
  clientY: 0,
  target: { closest: () => ({}) },
  currentTarget: {
    closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 380, height: 500 }) }),
    setPointerCapture: () => {
      captures += 1
    },
  },
  preventDefault() {},
})
assert.equal(captures, 0, 'pressing a button in the title bar never starts a drag')

head.props.onPointerDown({
  button: 0,
  pointerId: 1,
  clientX: 0,
  clientY: 0,
  target: { closest: () => null },
  currentTarget: {
    closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 380, height: 500 }) }),
    setPointerCapture: () => {
      captures += 1
    },
  },
  preventDefault() {},
})
assert.equal(captures, 1, 'pressing the bar itself still starts a drag')
console.log('drag    OK')

// -- parking the panel as one line ----------------------------------------

const fold = findByClass(tree, 'dshtb-fold')[0]
assert.equal(textOf(fold), '\u2013', 'the header carries a fold control')
tree = click(fold)
assert.equal(findByClass(tree, 'dshtb-card').length, 0, 'the parked panel drops the card')

const pill = findByClass(tree, 'dshtb-pill')[0]
assert.ok(pill !== undefined, 'the parked panel is one line')
const pillText = textOf(pill)
assert.ok(pillText.includes('TODO'), 'the line names the board')
assert.ok(pillText.includes('2'), 'the line counts the 2 unfinished todos')
assert.ok(pillText.includes('待验 1'), 'the line counts the 1 todo awaiting verification')
assert.ok(pillText.includes('下一条 · 下一条要做的'), 'the line shows the next todo, not a finished one')

// The line itself is the way back.
tree = click(pill)
assert.equal(findByClass(tree, 'dshtb-card').length, 1, 'clicking the line unfolds the panel')
console.log('park    OK')

// -- the panel stays inside the viewport as the window changes -------------
//
// A stored position is absolute pixels, so a viewport that shrinks under it
// leaves the panel cropped and unusable — and clearing localStorage by hand was
// the only way back, because nothing re-clamped on a window resize. Dragging
// alone never fires on a window resize, which is how the panel went missing.

/** The live geometry the panel would paint, or null for CSS defaults. */
function geometry(tree) {
  const root = findByClass(tree, 'dshtb-root')[0]
  const style = root.props.style
  if (style === undefined || style.left === undefined) return null
  return {
    x: parseFloat(style.left),
    y: parseFloat(style.top),
    w: parseFloat(style.width),
    h: parseFloat(style.height),
  }
}

/** Is the panel reachable by a pointer at the given viewport? */
function onScreen(g, vw, vh) {
  if (g === null) return true
  return g.x < vw && g.x + g.w > 0 && g.y < vh && g.y + g.h > 0
}

// Park the panel near the right edge of a wide window, the way a drag would.
// The viewport is set before mounting: this is a reload in a window still big
// enough for the saved spot. PARKED_X is the rightmost x that fits 1440 wide.
const PARKED_X = 1040
resizeTo(1440, 900)
storage.set('dsh.todoBoard.layout.v1', JSON.stringify({ x: PARKED_X, y: 60, w: 380, h: 600 }))
tree = remount()
const wide = geometry(tree)
assert.ok(wide !== null, 'a stored layout is applied')
assert.equal(wide.x, PARKED_X, 'and applied as stored while there is room for it')
assert.equal(onScreen(wide, 1440, 900), true, 'it is on screen while the window is wide')

// The window narrows under the stored position.
const firedNow = resizeTo(900, 700)
tree = render()
const narrow = geometry(tree)
assert.ok(firedNow >= 1, 'the panel listens for viewport changes')
assert.equal(
  onScreen(narrow, 900, 700),
  true,
  'shrinking the window pulls the panel back into view instead of cropping it',
)
assert.ok(narrow.x + narrow.w <= 900, 'and its right edge is inside the viewport')

// Widening again puts it back exactly where it was left — the same result a
// reload gives — and must not have rewritten the stored geometry.
resizeTo(1440, 900)
tree = render()
assert.equal(geometry(tree).x, PARKED_X, 'widening restores the chosen spot, not the clamped one')
assert.equal(
  JSON.parse(storage.get('dsh.todoBoard.layout.v1')).x,
  PARKED_X,
  'the geometry on disk is left intact, not overwritten by the clamp',
)

// The round trip repeats: a one-way clamp would leave it stuck in the corner.
resizeTo(900, 700)
tree = render()
assert.equal(onScreen(geometry(tree), 900, 700), true, 'a second shrink clamps again')
resizeTo(1440, 900)
tree = render()
assert.equal(geometry(tree).x, PARKED_X, 'and a second widen restores it again')

// A viewport that can never be that wide again still shows the panel.
resizeTo(640, 480)
tree = render()
assert.equal(
  onScreen(geometry(tree), 640, 480),
  true,
  'a viewport that will never be wide again still shows the panel',
)

// A reload alone recovers a layout stored far off-screen by an older session or
// a bigger monitor — no localStorage surgery needed.
storage.set('dsh.todoBoard.layout.v1', JSON.stringify({ x: 5000, y: 4000, w: 380, h: 600 }))
resizeTo(1440, 900)
tree = remount()
const recovered = geometry(tree)
assert.equal(onScreen(recovered, 1440, 900), true, 'a layout stored far off-screen is clamped on load')
assert.ok(recovered.x + recovered.w <= 1440, 'with its right edge inside the viewport')
assert.ok(recovered.y + recovered.h <= 900, 'and its bottom edge inside the viewport')
console.log('clamp   OK')

// -- a dispatched / parked row cannot be dispatched by hand ----------------

/** The ▶ button of the row whose title matches. */
function runButton(tree, title) {
  const row = findByClass(tree, 'dshtb-item').filter((node) => textOf(node).includes(title))
  assert.equal(row.length, 1, 'exactly one row reads ' + title)
  const acts = findByClass(row[0], 'dshtb-acts')[0]
  const button = acts.children.find((child) => textOf(child) === '\u25B6')
  assert.ok(button !== undefined, 'the row carries a ▶ control')
  return button
}

snapshot.todos = [
  todo({ id: 'p', title: '还没派发的', order: 0 }),
  todo({ id: 'd', title: '已经派发的', order: 1, dispatchedAt: 1700000000000, state: 'dispatched' }),
  todo({ id: 'r', title: '正在跑的', order: 2, dispatchedAt: 1700000000000, state: 'running' }),
  todo({ id: 'l', title: '目标丢了的', order: 3, lostAt: 1700000000000, state: 'lost', targetAlive: false }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

assert.equal(runButton(tree, '还没派发的').props.disabled, false, 'an undispatched row can be sent by hand')
assert.equal(runButton(tree, '已经派发的').props.disabled, true, 'a dispatched row cannot be sent twice')
assert.equal(runButton(tree, '正在跑的').props.disabled, true, 'a running row cannot be sent again')
assert.equal(runButton(tree, '目标丢了的').props.disabled, true, 'a stranded row cannot be dispatched')
assert.ok(
  runButton(tree, '目标丢了的').props.title.includes('目标会话已丢失'),
  'the disabled ▶ explains why',
)

// EVERY row states its state, in words. An earlier version labelled only the
// states deemed to "need attention" and left 未派发 / 已完成 silent, which meant
// most rows showed no state at all — the question this chip exists to answer.
// findByClass matches whole class tokens, so ask for the modifier directly.
const STATE_WORDS = ['未派发', '已派发', '进行中', '已完成', '目标会话丢失']
const stateWords = (title) => {
  const row = findByClass(tree, 'dshtb-item').filter((node) => textOf(node).includes(title))[0]
  return findByClass(row, 'dshtb-chip').map(textOf).filter((t) => STATE_WORDS.includes(t))
}
assert.deepEqual(stateWords('还没派发的'), ['未派发'], 'an undispatched row says 未派发')
assert.deepEqual(stateWords('已经派发的'), ['已派发'], 'a dispatched row says 已派发')
assert.deepEqual(stateWords('正在跑的'), ['进行中'], 'a running row says 进行中')
assert.deepEqual(stateWords('目标丢了的'), ['目标会话丢失'], 'a stranded row says so')

// Exactly one state chip per row, so the row never contradicts itself.
for (const title of ['还没派发的', '已经派发的', '正在跑的', '目标丢了的']) {
  assert.equal(stateWords(title).length, 1, 'exactly one state chip on ' + title)
}

// A finished row is labelled too, not only implied by the strikethrough. The
// strikethrough itself stays tied to *verification* (the user's own tick), so an
// AI-finished row is labelled 已完成 while still reading at full strength.
snapshot.todos = [todo({ id: 'z', title: '做完的', order: 0, verified: true })]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.deepEqual(stateWords('做完的'), ['已完成'], 'a finished row says 已完成')
assert.ok(
  findByClass(tree, 'dshtb-item')[0].props.className.includes('done'),
  'a verified row keeps its struck-through styling',
)

snapshot.todos = [todo({ id: 'y', title: 'AI说做完了', order: 0, aiDone: true })]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.deepEqual(
  stateWords('AI说做完了'),
  ['已完成'],
  'an AI-finished row is labelled 已完成 before you verify it',
)
console.log('runlock OK')

// A row parked for a *different* reason must not claim the session vanished.
// (The host sends `lostKind`; the browser must trust it.)
snapshot.todos = [
  todo({
    id: 'i',
    title: '图片被拒的',
    order: 0,
    lostAt: 1700000000000,
    lostKind: 'image',
    lostReason: '目标会话的模型不接受图片输入',
    state: 'lost',
  }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
const imageRow = findByClass(tree, 'dshtb-item').filter((node) => textOf(node).includes('图片被拒的'))[0]
assert.ok(textOf(imageRow).includes('图片被拒'), 'an image refusal is labelled as such')
assert.ok(
  textOf(imageRow).includes('目标会话丢失') === false,
  'and does NOT claim the target session is gone',
)
assert.ok(
  findByClass(imageRow, 'bad')[0].props.title.includes('换一个支持图片的模型'),
  'its tooltip names the actual way out',
)
console.log('lostkind OK')

// -- the directory field says what an empty value means --------------------

// The composer was folded away by the section test above; bring it back.
tree = click(sectionButton(tree, '新增待办'))
assert.equal(findByClass(tree, 'dshtb-add').length, 1, 'the composer is back')

const dirBox = findByClass(tree, 'dshtb-dir')[0]
assert.ok(dirBox !== undefined, 'the composer carries a directory row')
const dirLabelNode = dirBox.children.find((child) => child.props.className === 'lbl')
assert.ok(dirLabelNode !== undefined, 'the directory field carries a visible label')
assert.equal(textOf(dirLabelNode), '目录', 'and it is not empty')
const dirField = dirBox.children.find((child) => child.type === 'input')
assert.ok(
  dirField.props.placeholder.includes('留空'),
  'the placeholder explains the empty case instead of impersonating a value: ' +
    dirField.props.placeholder,
)
assert.equal(dirField.props.value, '', 'and the field really is empty')
assert.ok(
  dirField.props.title.includes('留空 = 跟随当前会话的工作目录'),
  'the tooltip states what the value decides',
)
console.log('dirfield OK')

// -- each fact is stated once per row --------------------------------------
//
// The directory lives in the facts line in full, so it must NOT also be a chip
// repeating just the basename. The schedule is the mirror image: it lives in its
// own chip and must NOT also be repeated in the facts line.

snapshot.todos = [
  todo({ id: 's', title: '带定时的', order: 0, schedule: '2030-01-02T03:04', dirPath: CWD }),
  todo({ id: 'n', title: '不定时的', order: 1, schedule: '' }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

const rowFor = (title) =>
  findByClass(tree, 'dshtb-item').filter((node) => textOf(node).includes(title))[0]

const scheduledRow = rowFor('带定时的')
const factsText = textOf(findByClass(scheduledRow, 'dshtb-facts')[0])
assert.ok(factsText.includes('目录 ' + CWD), 'the facts line still names the directory in full')
assert.ok(
  factsText.includes('定时') === false,
  'the facts line no longer repeats the schedule: ' + factsText,
)
assert.ok(
  findByClass(scheduledRow, 'dshtb-chip').filter((c) => textOf(c).includes('01-02')).length === 1,
  'the schedule is carried by exactly one chip',
)

// The directory is not chipped anywhere on the row.
const chipTexts = findByClass(scheduledRow, 'dshtb-chip').map(textOf)
assert.ok(
  chipTexts.includes('plugin') === false,
  'no chip repeats the directory basename: ' + JSON.stringify(chipTexts),
)

// A row with no schedule still offers a way to set one.
const unscheduledRow = rowFor('不定时的')
const quiet = findByClass(unscheduledRow, 'quiet')
assert.equal(quiet.length, 1, 'an unscheduled row carries a way to add a time')
assert.equal(textOf(quiet[0]), '\u25F4 不定时', 'and it reads as unscheduled')
assert.equal(
  findByClass(unscheduledRow, 'dshtb-facts')[0] === undefined,
  false,
  'the facts line is still rendered',
)
console.log('rowfacts OK')

// -- an existing row can set, change, and clear its schedule ---------------

const quietButton = findByClass(unscheduledRow, 'quiet')[0]
assert.equal(typeof quietButton.props.onClick, 'function', 'the chip is clickable')
quietButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
tree = render()

// The picker replaces the chip in place, seeded with the current (empty) value.
const pickerRow = rowFor('不定时的')
const picker = findByClass(pickerRow, 'dshtb-whenedit')[0]
assert.ok(picker !== undefined, 'clicking the chip opens an inline time picker')
assert.equal(picker.props.value, '', 'seeded with the row’s current (absent) time')
assert.equal(picker.props.type, 'datetime-local', 'and it is a real time control')

// Typing a value and confirming patches the row through the same route the
// composer uses, rather than a second code path.
const beforePatch = calls.length
picker.props.onChange({ target: { value: '2031-05-06T07:08' } })
tree = render()
const confirmButton = findByClass(rowFor('不定时的'), 'dshtb-whenchip')[0].children.find(
  (child) => textOf(child) === '\u2713',
)
assert.ok(confirmButton !== undefined, 'the picker offers a confirm control')
confirmButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
const lastCall = calls[calls.length - 1]
assert.equal(calls.length, beforePatch + 1, 'confirming sends exactly one request')
assert.equal(lastCall.action, 'patch', 'through the panel’s patch action')
assert.equal(lastCall.id, 'n', 'for the row that was edited')
assert.equal(lastCall.patch.schedule, '2031-05-06T07:08', 'carrying the chosen time')

// Changing an existing time is the same control, seeded with what is set.
tree = render()
const timeChip = findByClass(rowFor('带定时的'), 'dshtb-chip').find((c) => textOf(c).includes('01-02'))
timeChip.props.onClick({ preventDefault() {}, stopPropagation() {} })
tree = render()
assert.equal(
  findByClass(rowFor('带定时的'), 'dshtb-whenedit')[0].props.value,
  '2030-01-02T03:04',
  're-opening the picker seeds it with the existing time, so it can be changed',
)

// Escape closes without touching the board.
const openRow = rowFor('带定时的')
findByClass(openRow, 'dshtb-whenedit')[0].props.onKeyDown({ key: 'Escape', preventDefault() {} })
tree = render()
assert.equal(findByClass(rowFor('带定时的'), 'dshtb-whenedit').length, 0, 'Escape closes the picker')

// The ✕ beside a set time clears it, and is a sibling so its click is unambiguous.
const clearX = findByClass(rowFor('带定时的'), 'x')[0]
assert.ok(clearX !== undefined, 'a set time carries its own clear control')
assert.equal(typeof clearX.props.onClick, 'function', 'which is clickable')
const beforeClear = calls.length
clearX.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls[calls.length - 1].patch.schedule, '', 'clearing sends an empty schedule')
assert.equal(calls.length, beforeClear + 1, 'and sends exactly one request')
console.log('rowsech OK')



snapshot.todos = [todo({ id: 'c', title: '已验收的', verified: true })]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
tree = click(findByClass(tree, 'dshtb-fold')[0])
assert.ok(
  textOf(findByClass(tree, 'dshtb-pill')[0]).includes('当前目录已清空'),
  'an empty board says so instead of naming a task',
)
console.log('empty   OK')

console.log('\nall browser-half smoke checks passed')
