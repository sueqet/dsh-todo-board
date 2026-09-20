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
  innerWidth: 1440,
  innerHeight: 900,
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

function todo(over) {
  return {
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
    runSessionId: '',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
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

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => snapshot })

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

// -- an empty board still parks as one line -------------------------------

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
