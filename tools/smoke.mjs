/**
 * Host-half smoke test for dsh-todo-board.
 *
 * Loads lib/index.js against a stubbed Cordis context and a throwaway DSH_HOME,
 * then exercises apply(), the todo_board tool, the HTTP route, persistence and
 * the top-to-bottom ordering rule.
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
      if (key === 'agents') return { list: () => [], get: () => undefined }
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

const DIR = 'D:\\smoke\\project'
const agent = { id: 'session-smoke', session: { header: { cwd: DIR } } }
const exec = { agent }

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
assert.equal(added.todos[0].aiDone, false)
assert.deepEqual(
  Object.keys(added.todos[0]).sort(),
  ['aiDone', 'dirLabel', 'id', 'mode', 'title', 'verified'],
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

rmSync(home, { recursive: true, force: true })
console.log('\nall host-half smoke checks passed')
