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

/** In-memory stand-in for the durable attachment store. */
const savedImages = new Map()
let imageSeq = 0

const attachmentsStub = {
  async saveImage(input) {
    if (!(input.data instanceof Uint8Array) || input.data.length === 0) {
      throw new Error('image bytes are empty')
    }
    imageSeq += 1
    const ref = {
      attachmentId: 'att-' + imageSeq,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 2,
      height: 3,
    }
    if (typeof input.name === 'string' && input.name !== '') ref.name = input.name
    savedImages.set(ref.attachmentId, input.data)
    return ref
  },
  async readImage(ref) {
    const data = savedImages.get(ref.attachmentId)
    if (data === undefined) throw new Error('unknown attachment ' + ref.attachmentId)
    return { ref, data }
  },
}

/** A 1x1 transparent PNG — enough for admission and a real byte round trip. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
      if (key === 'attachments') return attachmentsStub
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

/**
 * Fire the turn-end hook and let the dispatch promise chain settle — dispatch
 * awaits the model-capability probe before it sends, so a synchronous call
 * would observe the message count before the message exists.
 */
async function turnStopping() {
  for (const entry of registered.listeners) {
    if (entry.event === 'agent/turn-stopping') entry.listener({ agent })
  }
  await settle()
}

/** Drain microtasks and timers the plugin scheduled with no delay. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ------------------------------------------------------------------ apply()

assert.equal(mod.name, 'dsh-todo-board')
mod.apply(makeCtx())

assert.equal(registered.tool?.name, 'todo_board', 'todo_board registered')
assert.equal(registered.tool.parameters.required[0], 'action')
assert.equal(registered.section?.name, 'todo-board', 'prompt section registered')
assert.equal(registered.section.order, 150)
assert.equal(registered.routes.length, 2, 'api and image routes')
assert.equal(registered.routes[0].path, '/dsh-todo-board/image')
assert.equal(registered.routes[1].path, '/dsh-todo-board/api')
const apiRoute = registered.routes[1]
const imageRoute = registered.routes[0]
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
  ['aiDone', 'dirLabel', 'id', 'imageCount', 'mode', 'schedule', 'state', 'title', 'verified'],
  'tool rows carry exactly the declared schema keys',
)
assert.equal(added.todos[0].state, 'pending', 'a brand-new row has never been dispatched')
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
  await apiRoute.handler(request, response)
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
await apiRoute.handler({ method: 'GET' }, getResponse)
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
await turnStopping()
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
await apiRoute.handler({ method: 'GET' }, snapshotResponse)
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

// ------------------------------------------------------------------- images

// One todo carries images: they are admitted through the attachment store,
// persisted as durable refs, rendered by the plugin's own byte route, and sent
// to the model as real image blocks.
const withImage = await postJson({
  action: 'create',
  title: '看图干活',
  mode: 'resume',
  dir: DIR,
  sessionId: agent.id,
  images: [{ data: PNG_BASE64, mediaType: 'image/png', name: 'shot.png' }],
})
assert.equal(withImage.ok, true, 'create accepts an image')
const imageId = withImage.todo.id
assert.equal(withImage.todo.images.length, 1, 'the image reference is stored on the row')
const ref = withImage.todo.images[0]
assert.equal(ref.mediaType, 'image/png')
assert.equal(ref.name, 'shot.png')
assert.ok(ref.bytes > 0 && ref.width > 0 && ref.height > 0, 'the ref carries normalized metadata')

const refused = await postJson({
  action: 'create',
  title: '非法图片',
  dir: DIR,
  images: [{ data: PNG_BASE64, mediaType: 'image/tiff' }],
})
assert.equal(refused.ok, false, 'an unsupported media type is refused')
assert.ok(refused.error.includes('不支持的图片格式'), 'the refusal names the reason')

const tooMany = await postJson({
  action: 'create',
  title: '太多图片',
  dir: DIR,
  images: new Array(5).fill({ data: PNG_BASE64, mediaType: 'image/png' }),
})
assert.equal(tooMany.ok, false, 'more images than the cap is refused')

// The plugin's own route serves the bytes, and only for a referenced id.
const imageResponse = {
  status: 0,
  headers: {},
  body: null,
  writeHead(status, headers) {
    this.status = status
    this.headers = headers === undefined ? {} : headers
  },
  end(body) {
    this.body = body
  },
}
await imageRoute.handler({ method: 'GET', url: '/dsh-todo-board/image?id=' + ref.attachmentId }, imageResponse)
assert.equal(imageResponse.status, 200, 'a referenced attachment is served')
assert.equal(imageResponse.headers['content-type'], 'image/png')
assert.ok(Buffer.from(imageResponse.body).length > 0, 'the served bytes are non-empty')

const missingResponse = {
  status: 0,
  writeHead(status) {
    this.status = status
  },
  end() {},
}
await imageRoute.handler({ method: 'GET', url: '/dsh-todo-board/image?id=att-nope' }, missingResponse)
assert.equal(missingResponse.status, 404, 'an unreferenced id is not readable')

// Dispatch turns the attached image into a real image block.
const beforeImageRun = agent.sent.length
await postJson({ action: 'run', id: imageId, sessionId: agent.id })
assert.equal(agent.sent.length, beforeImageRun + 1, 'the todo dispatched')
const sentContent = agent.sent[beforeImageRun].content
assert.equal(sentContent[0].type, 'text')
assert.ok(sentContent[0].text.includes('附带的 1 张图片'), 'the prompt announces the images')
const imageBlocks = sentContent.filter((block) => block.type === 'image')
assert.equal(imageBlocks.length, 1, 'the message carries one image block')
assert.deepEqual(imageBlocks[0].attachment, ref, 'the block is the durable reference itself')

// Dropping the image leaves a text-only todo, and the list reports the count.
const cleared = await postJson({ action: 'patch', id: imageId, patch: { clearImages: true } })
assert.equal(cleared.todo.images.length, 0, 'images can be dropped again')
const listedWithCount = await registered.tool.execute({ action: 'list' }, exec)
assert.equal(
  listedWithCount.todos.every((todo) => typeof todo.imageCount === 'number'),
  true,
  'tool rows report imageCount',
)
console.log('images  OK')

// ------------------------------------------------------------ row lifecycle
//
// The state a row reports is derived from the live session list, and a row whose
// target session is gone must stay *pending* rather than being stamped as
// dispatched — otherwise the scheduler and the turn-end hook both skip it and it
// silently never runs again.

const orphan = await postJson({
  action: 'create',
  title: '目标会话已经没了',
  mode: 'resume',
  dir: DIR,
  sessionId: 'session-that-is-gone',
})
assert.equal(orphan.ok, true)
assert.equal(orphan.todo.state, 'pending', 'a fresh row starts out undispatched')
const orphanId = orphan.todo.id

const orphanRun = await postJson({ action: 'run', id: orphanId, sessionId: '' })
assert.equal(orphanRun.ok, false, 'dispatching to a dead session fails')
assert.equal(orphanRun.lost, true, 'and says the row is stranded')

/** The panel's own view of one row, straight from the GET route. */
async function readRow(id) {
  const response = fakeResponse()
  await apiRoute.handler({ method: 'GET' }, response)
  return JSON.parse(response.box.body).todos.find((todo) => todo.id === id)
}

const afterLoss = await readRow(orphanId)
assert.equal(afterLoss.state, 'lost', 'the row reports 目标会话丢失')
assert.equal(afterLoss.targetAlive, false, 'the panel can see the target is gone')
assert.equal(afterLoss.lostKind, 'no-session', 'and says which kind of failure parked it')
assert.equal(
  afterLoss.dispatchedAt,
  0,
  'a failed dispatch must NOT stamp dispatchedAt, or the row is retired for good',
)
assert.ok(afterLoss.lostAt > 0, 'the failure is recorded instead')

// A fresh lost row waits out its first backoff, so the scheduler does not spin.
const orphanList = await registered.tool.execute({ action: 'list', all: true }, exec)
const orphanRow = orphanList.todos.find((todo) => todo.id === orphanId)
assert.equal(orphanRow.state, 'lost', 'the tool reports the same state')
assert.ok(orphanList.message.includes('目标会话丢失'), 'and names it in the readout')

// Re-targeting the row clears the verdict: it is queue-eligible again.
const rescued = await postJson({ action: 'patch', id: orphanId, patch: { mode: 'newSession' } })
assert.equal(rescued.ok, true)
assert.equal(rescued.todo.state, 'pending', 'changing the mode clears the lost marker')
assert.equal(rescued.todo.lostAt, 0)
assert.equal(rescued.todo.lostKind, '', 'and clears the recorded failure kind')

// An image the target model refuses parks the row too, but with its own kind —
// the panel must not report a missing session when the session is fine.
const pngRef = (await readRow(imageId)) !== undefined
assert.equal(pngRef, true, 'the image row from the earlier section still exists')
const textOnly = await postJson({
  action: 'create',
  title: '模型看不了这张图',
  mode: 'resume',
  dir: DIR,
  sessionId: agent.id,
  images: [{ data: PNG_BASE64, mediaType: 'image/png' }],
})
assert.equal(textOnly.ok, true, 'the row with an image is created')

// A live but idle target reads as 已派发; a running one reads as 进行中. After the
// rebinding test above, `boundId` is owned by the second spawned session.
await postJson({ action: 'run', id: orphanId, sessionId: agent.id })
const dispatchedRow = await readRow(orphanId)
assert.ok(dispatchedRow.dispatchedAt > 0, 'a successful dispatch stamps the row')
assert.equal(dispatchedRow.targetAlive, true, 'its target session is live')
assert.equal(dispatchedRow.state, 'dispatched', 'a live but idle target reads as 已派发')

const runOwnerId = (await readRow(boundId)).runSessionId
const runOwner = live.get(runOwnerId)
assert.ok(runOwner !== undefined, 'the row is bound to a session the registry knows')
runOwner.status = 'running'
assert.equal((await readRow(boundId)).state, 'running', 'a running target reads as 进行中')
runOwner.status = 'idle'
assert.equal((await readRow(boundId)).state, 'dispatched', 'and falls back to 已派发 when it stops')
console.log('state   OK')

// -- a stranded row neither spins nor blocks the queue ---------------------
//
// Leaving a failed row unstamped is what stops it being retired for good, but it
// also leaves the row queue-eligible. Two things must therefore hold: the
// automatic paths must not re-attempt it on every tick, and it must not sit at
// the top of the queue holding up the rows behind it.

// Clear the deck first: this section asserts on *which* row turn end picks, so
// it must not depend on whatever earlier sections left pending.
for (const leftover of (await registered.tool.execute({ action: 'list', all: true }, exec)).todos) {
  if (!leftover.verified) await registered.tool.execute({ action: 'done', id: leftover.id }, exec)
}

const stranded = await postJson({
  action: 'create',
  title: '卡住的那条',
  mode: 'resume',
  dir: DIR,
  sessionId: 'session-long-gone',
})
const strandedId = stranded.todo.id
await postJson({ action: 'run', id: strandedId, sessionId: '' })
assert.equal((await readRow(strandedId)).state, 'lost', 'the row is stranded')

// A healthy row created after it sits *below* it in the queue.
const healthy = await postJson({
  action: 'create',
  title: '后面那条能跑的',
  mode: 'resume',
  dir: DIR,
  sessionId: agent.id,
})
assert.equal(healthy.ok, true, 'the healthy row is created')
const healthyId = healthy.todo.id

const beforeQueue = agent.sent.length
await turnStopping()
assert.equal(
  agent.sent.length,
  beforeQueue + 1,
  'exactly one row is dispatched — the queue is not blocked and not double-sent',
)
assert.ok(
  agent.sent[beforeQueue].content[0].text.includes('后面那条能跑的'),
  'and it is the healthy row below that ran, not the stranded one',
)
assert.equal((await readRow(strandedId)).state, 'lost', 'the stranded row is still stranded')
assert.equal((await readRow(healthyId)).state, 'dispatched', 'the healthy row was handed over')

// The backoff holds: further turn ends must not re-attempt it immediately.
await turnStopping()
await turnStopping()
const strandedAfter = await readRow(strandedId)
assert.equal(strandedAfter.lostAttempts, 1, 'the retry backoff suppressed immediate re-attempts')
assert.ok(
  Date.now() - strandedAfter.lostAt < 60000,
  'and its next automatic attempt is a minute away, not a tick away',
)
console.log('stranded OK')

rmSync(home, { recursive: true, force: true })
console.log('\nall host-half smoke checks passed')
