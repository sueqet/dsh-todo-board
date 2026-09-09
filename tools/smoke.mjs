/**
 * Host-half smoke test for dsh-todo-board.
 *
 * Loads lib/index.js against a stubbed Cordis context and a throwaway DSH_HOME,
 * then exercises apply(), the todo_board tool, the HTTP route, persistence, the
 * top-to-bottom ordering rule, scheduled execution and newSession binding.
 *
 *   node tools/smoke.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshtb-smoke-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const registered = { tool: null, section: null, routes: [], listeners: [], effects: [] }

const DIR = 'D:\\smoke\\project'
const agent = {
  id: 'session-smoke',
  session: { header: { id: 'session-smoke', cwd: DIR } },
  sent: [],
  followup(message) {
    this.sent.push(message)
  },
  steer(message) {
    this.sent.push(message)
  },
}
const exec = { agent }

/** Live agents the stub registry knows about: the origin session plus spawned ones. */
const live = new Map([[agent.id, agent]])
const spawnedAgents = []

function spawnStubAgent(id) {
  const spawned = {
    id,
    status: 'idle',
    session: { header: { id, cwd: DIR } },
    sent: [],
    followup(message) {
      this.sent.push(message)
    },
    steer(message) {
      this.sent.push(message)
    },
  }
  live.set(spawned.id, spawned)
  spawnedAgents.push(spawned)
  return spawned
}

const agentsStub = {
  list: () => [...live.values()],
  get: (id) => live.get(id),
  async create(options) {
    // The factory is handed the caller's session id; honour it like the real one.
    const spawned = spawnStubAgent(options.sessionId)
    if (typeof options.setup === 'function') await options.setup({})
    return { agent: spawned, dispose: async () => {} }
  },
}

const presetsStub = {
  async resolve() {
    return { id: 'standard' }
  },
  async mount() {
    return { id: 'standard' }
  },
}

/** Records which sessions the plugin files under a workspace directory. */
const attached = []
const workspaces = new Map()

const workspaceStub = {
  async resolveByPath(path) {
    return workspaces.get(path)
  },
  async create(path) {
    const workspace = {
      id: 'ws-' + (workspaces.size + 1),
      path,
      async attachSession(sessionId) {
        attached.push({ workspaceId: this.id, path, sessionId })
      },
    }
    workspaces.set(path, workspace)
    return workspace
  },
}

function makeCtx() {
  // `inject(['webServer'], cb)` hands cb a context where the service is a
  // property, so the stub exposes it both ways.
  const webServer = {
    register(route) {
      registered.routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    root: undefined,
    webServer,
    get(key) {
      if (key === 'tools') {
        return {
          register(definition) {
            registered.tool = definition
            return () => {}
          },
        }
      }
      if (key === 'systemPrompt') {
        return {
          section(section) {
            registered.section = section
            return () => {}
          },
        }
      }
      if (key === 'agents') return agentsStub
      if (key === 'agentPresets') return presetsStub
      if (key === 'workspaceRegistry') return workspaceStub
      if (key === 'webServer') return webServer
      return undefined
    },
    on(event, listener) {
      registered.listeners.push({ event, listener })
      return () => {}
    },
    effect(callback, label) {
      registered.effects.push(label)
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(names, callback) {
      callback(ctx)
    },
    logger: { error() {} },
  }
  return ctx
}

function fakeResponse() {
  const box = { status: 0, body: '' }
  return {
    box,
    writeHead(status) {
      box.status = status
    },
    end(body) {
      box.body = body === undefined ? '' : String(body)
    },
  }
}

/** Local `YYYY-MM-DDTHH:mm`, the board's schedule format. */
function localStamp(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

function turnStopping() {
  for (const entry of registered.listeners) {
    if (entry.event === 'agent/turn-stopping') entry.listener({ agent })
  }
}

// ------------------------------------------------------------------ apply()

assert.equal(mod.name, 'dsh-todo-board')
mod.apply(makeCtx())

assert.equal(registered.tool?.name, 'todo_board', 'todo_board registered')
assert.equal(registered.tool.parameters.required[0], 'action')
assert.equal(registered.section?.name, 'todo-board', 'prompt section registered')
assert.equal(registered.section.order, 150)
assert.equal(registered.routes.length, 1, 'one HTTP route')
assert.equal(registered.routes[0].path, '/dsh-todo-board/api')
assert.ok(
  registered.listeners.some((entry) => entry.event === 'agent/turn-stopping'),
  'turn-stopping listener registered',
)
assert.ok(existsSync(join(home, 'todo-board', 'board.json')), 'board file created on first load')
console.log('apply()  OK')

// --------------------------------------------------------------- tool: add

const added = await registered.tool.execute(
  { action: 'add', title: '第二条', mode: 'resume' },
  exec,
)
assert.equal(added.todos.length, 1)
assert.equal(added.todos[0].title, '第二条')
assert.equal(added.todos[0].mode, 'resume')
assert.equal(added.todos[0].schedule, '', 'a plain add carries no schedule')
assert.equal(added.todos[0].aiDone, false)
assert.deepEqual(
  Object.keys(added.todos[0]).sort(),
  ['aiDone', 'dirLabel', 'id', 'mode', 'schedule', 'title', 'verified'],
  'tool rows carry exactly the declared schema keys',
)
const firstId = added.todos[0].id

await registered.tool.execute({ action: 'add', title: '第一条', mode: 'resume' }, exec)

// -------------------------------------------------------------- tool: list

const listed = await registered.tool.execute({ action: 'list' }, exec)
assert.equal(listed.todos.length, 2)
assert.equal(listed.todos[0].title, '第二条', 'appended rows keep insertion order first')
assert.ok(listed.message.includes('从上到下就是执行顺序'), 'list explains the order')

// ------------------------------------------------------ reorder via route

// The route reads the raw request stream, so drive it with an async iterable.
async function postJson(payload) {
  const response = fakeResponse()
  const chunks = [Buffer.from(JSON.stringify(payload), 'utf8')]
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  await registered.routes[0].handler(request, response)
  return JSON.parse(response.box.body)
}

const snapshot = await registered.tool.execute({ action: 'list' }, exec)
const ids = snapshot.todos.map((todo) => todo.id)
const reordered = await postJson({ action: 'reorder', ids: [ids[1], ids[0]] })
assert.equal(reordered.ok, true, 'reorder accepted')
assert.equal(reordered.count, 2)

const afterReorder = await registered.tool.execute({ action: 'list' }, exec)
assert.equal(afterReorder.todos[0].id, ids[1], 'top-to-bottom order persisted')
assert.equal(afterReorder.todos[1].id, ids[0])
console.log('order   OK')

// ------------------------------------------------------------ tool: done

const done = await registered.tool.execute({ action: 'done', id: firstId }, exec)
assert.equal(done.todos[0].aiDone, true)
assert.ok(done.message.includes('已标记 AI 完成'))

const notFound = await registered.tool.execute({ action: 'done', id: 'nope' }, exec)
assert.ok(notFound.message.includes('找不到'))

// -------------------------------------------------------- route: GET + patch

const getResponse = fakeResponse()
await registered.routes[0].handler({ method: 'GET' }, getResponse)
const snapshot2 = JSON.parse(getResponse.box.body)
assert.equal(snapshot2.ok, true)
assert.equal(snapshot2.todos.length, 2)
assert.ok(snapshot2.storagePath.endsWith('board.json'))
assert.ok(snapshot2.todos.every((todo) => typeof todo.order === 'number'))
assert.ok(snapshot2.todos.every((todo) => typeof todo.schedule === 'string'))
assert.ok(snapshot2.todos.every((todo) => typeof todo.dueAt === 'number'), 'panel rows expose dueAt')

const patched = await postJson({ action: 'patch', id: firstId, patch: { verified: true } })
assert.equal(patched.ok, true)
assert.equal(patched.todo.verified, true)

const bad = await postJson({ action: 'nonsense' })
assert.equal(bad.ok, false)
console.log('route   OK')

// ------------------------------------------------------------- persistence

const onDisk = JSON.parse(readFileSync(join(home, 'todo-board', 'board.json'), 'utf8'))
assert.equal(onDisk.todos.length, 2)
assert.equal(onDisk.todos[0].id, ids[1], 'disk order matches the reordered order')
assert.equal(onDisk.todos[0].order, 0)
assert.equal(onDisk.todos[1].order, 1)
console.log('persist OK')

// ---------------------------------------------------------------- schedule

// Created the way the panel creates it: bound to a session, so a scheduled
// `resume` row has somewhere to land when its time comes.
const startCount = agent.sent.length
const minuteStart = Math.floor(Date.now() / 60000) * 60000
const created = await postJson({
  action: 'create',
  title: '到点再干',
  mode: 'resume',
  dir: DIR,
  sessionId: agent.id,
  schedule: localStamp(minuteStart + 60000),
})
assert.equal(created.ok, true, 'create accepts a schedule')
const scheduledId = created.todo.id
assert.equal(created.todo.schedule, localStamp(minuteStart + 60000), 'a local stamp round-trips')
assert.equal(created.todo.dueAt, minuteStart + 60000, 'dueAt mirrors the stamp')
assert.equal(agent.sent.length, startCount, 'a future row does not fire on creation')

const rejected = await postJson({ action: 'create', title: '坏时间', dir: DIR, schedule: 'nonsense' })
assert.equal(rejected.ok, false, 'create refuses an unparseable schedule')

const byTool = await registered.tool.execute(
  { action: 'schedule', id: scheduledId, schedule: localStamp(minuteStart + 7200000) },
  exec,
)
assert.equal(byTool.todos[0].schedule, localStamp(minuteStart + 7200000), 'schedule action moves the time')
await registered.tool.execute({ action: 'schedule', id: scheduledId, schedule: '' }, exec)
assert.equal(
  (await registered.tool.execute({ action: 'list' }, exec)).todos.find((todo) => todo.id === scheduledId)
    .schedule,
  '',
  'an empty schedule clears the timer',
)
await registered.tool.execute({ action: 'schedule', id: scheduledId, schedule: 'not-a-date' }, exec)
assert.equal(
  (await registered.tool.execute({ action: 'list' }, exec)).todos.find((todo) => todo.id === scheduledId)
    .schedule,
  '',
  'an unparseable schedule never arms a wrong instant',
)

// A future time must hold the row back at turn end, even though it sits above
// every other pending row in this directory.
await registered.tool.execute(
  { action: 'schedule', id: scheduledId, schedule: localStamp(minuteStart + 7200000) },
  exec,
)
await registered.tool.execute({ action: 'done', id: ids[0] }, exec)
await registered.tool.execute({ action: 'done', id: ids[1] }, exec)
const gatedCount = agent.sent.length
await registered.tool.execute({ action: 'add', title: '没有定时的一条', mode: 'resume' }, exec)
const boardOrder = (await registered.tool.execute({ action: 'list' }, exec)).todos
assert.equal(
  boardOrder.findIndex((todo) => todo.id === scheduledId) <
    boardOrder.findIndex((todo) => todo.title === '没有定时的一条'),
  true,
  'the future row really is the topmost pending row',
)
turnStopping()
assert.equal(agent.sent.length, gatedCount + 1, 'turn end dispatches the next todo that is actually due')
assert.ok(
  agent.sent[gatedCount].content[0].text.includes('没有定时的一条'),
  'turn end steps over the not-yet-due row instead of running it',
)
assert.equal(
  (await registered.tool.execute({ action: 'list' }, exec)).todos.find((todo) => todo.id === scheduledId)
    .schedule,
  localStamp(minuteStart + 7200000),
  'the future row keeps its schedule',
)

// Moving the time into the past re-arms the timer, which dispatches the row and
// records it so nothing can fire twice.
await registered.tool.execute({ action: 'schedule', id: scheduledId, schedule: localStamp(minuteStart) }, exec)
assert.equal(agent.sent.length, gatedCount + 2, 'a due todo dispatches through the timer')
assert.ok(
  agent.sent[gatedCount + 1].content[0].text.includes('到点再干'),
  'the dispatched prompt carries the todo title',
)
assert.equal(
  JSON.parse(readFileSync(join(home, 'todo-board', 'board.json'), 'utf8')).todos.find(
    (todo) => todo.id === scheduledId,
  ).dispatchedAt > 0,
  true,
  'dispatch is persisted, so it can never fire twice',
)
console.log('schedule OK')

// ------------------------------------------------------- newSession binding

// The first run opens a session and binds it; the second run must reuse that
// binding instead of opening yet another session.
const spawnedTodo = await postJson({
  action: 'create',
  title: '新会话只开一次',
  mode: 'newSession',
  dir: DIR,
  sessionId: agent.id,
})
assert.equal(spawnedTodo.ok, true)
const boundId = spawnedTodo.todo.id
const firstRun = await postJson({ action: 'run', id: boundId, sessionId: agent.id })
assert.equal(firstRun.ok, true, 'the first run opens a session')
assert.equal(firstRun.target, 'new-session')
assert.equal(spawnedAgents.length, 1, 'exactly one session was created')
assert.equal(firstRun.sessionId, spawnedAgents[0].id)
assert.equal(spawnedAgents[0].sent.length, 1, 'the created session received the task')
assert.equal(attached.length, 1, 'the created session is filed under a workspace')
assert.equal(attached[0].sessionId, spawnedAgents[0].id)
assert.equal(attached[0].path, DIR, 'the workspace is the todo directory')

const snapshotResponse = fakeResponse()
await registered.routes[0].handler({ method: 'GET' }, snapshotResponse)
const panelRow = JSON.parse(snapshotResponse.box.body).todos.find((todo) => todo.id === boundId)
assert.equal(panelRow.runSessionId, spawnedAgents[0].id, 'the created session is bound on the row')

const secondRun = await postJson({ action: 'run', id: boundId, sessionId: agent.id })
assert.equal(secondRun.ok, true, 'the second run succeeds')
assert.equal(secondRun.target, 'session', 'the second run reuses the binding')
assert.equal(secondRun.sessionId, spawnedAgents[0].id)
assert.equal(spawnedAgents.length, 1, 'no second session is created')
assert.equal(spawnedAgents[0].sent.length, 2, 'the bound session got the task again')

// Unbinding is what re-enables opening a fresh session.
const unbound = await postJson({ action: 'patch', id: boundId, patch: { runSessionId: '' } })
assert.equal(unbound.ok, true)
assert.equal(unbound.todo.runSessionId, '', 'the panel can drop the binding')
const thirdRun = await postJson({ action: 'run', id: boundId, sessionId: agent.id })
assert.equal(thirdRun.target, 'new-session', 'after unbinding a new session is opened again')
assert.equal(spawnedAgents.length, 2, 'unbinding really allows a second session')
console.log('binding OK')

rmSync(home, { recursive: true, force: true })
console.log('\nall host-half smoke checks passed')
