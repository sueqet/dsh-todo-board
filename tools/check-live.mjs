/**
 * Host-half integration check against the REAL cordis runtime.
 *
 * The other suites stub the context, which leaves four things unproven:
 *
 *   1. **`ctx.inject(['systemPrompt' | 'tools'], …)`.** The stub calls the
 *      callback directly, but real cordis waits until the service is *provided*
 *      through the reflection layer — and the plugin row is applied before those
 *      services exist. An eager `ctx.get` there lost the registration SILENTLY
 *      and permanently (the model had no tool at all while the panel kept
 *      working). This provides both services strictly AFTER the plugin row, so
 *      the ordering that used to break is the ordering under test.
 *   2. **`ctx.logger.exporter()`.** The stub's logger re-implements the `levels`
 *      gate from memory; this runs the real `LoggerService`, so the gate that
 *      decides what gets stored is the genuine article.
 *   3. **The approval gate.** `tools/pre-execute` is only a decision in the
 *      context of the real pipeline that consumes it, so the gate is exercised
 *      through a real `ToolRuntime`: read passes, write fails closed with no
 *      approval channel, a grant lets it through, and a rejection denies — the
 *      harness's own verdict wording, not a stub of it.
 *   4. **Channel convergence.** The route prefers the harness's `connection`
 *      gate and falls back to the local restatement only without it, so both
 *      branches are driven here against the really-injected route.
 *
 * Everything else (agents, attachments, …) is a stub, because those are harness
 * capabilities rather than the runtime under test.
 *
 *   node tools/check-live.mjs
 *
 * Requires the DSH install; skipped loudly if cordis or dsh-tools is missing.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DSH = 'C:/Users/XIAO/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const CORDIS = process.env.DSHTB_CORDIS ?? 'file:///' + DSH + 'cordis/lib/index.js'
const TOOLS = process.env.DSHTB_TOOLS ?? 'file:///' + DSH + 'dsh-tools/lib/index.js'

let Context
let ToolRuntime
try {
  ;({ Context } = await import(CORDIS))
  ;({ ToolRuntime } = await import(TOOLS))
} catch (err) {
  console.error('SKIP: the real cordis / dsh-tools runtime is not reachable at ' + CORDIS)
  console.error('      set DSHTB_CORDIS / DSHTB_TOOLS to their lib/index.js to run this check.')
  process.exit(0)
}

const home = mkdtempSync(join(tmpdir(), 'dshtb-live-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const routes = []
const sections = []
const logged = []
const root = new Context()

// Watch what the PLUGIN's exporter admits, by observing alongside it.
root.logger.exporter({
  levels: { default: 3 },
  export: (m) => logged.push({ name: m.name, type: m.type, detail: m.args.map(String).join(' ') }),
})

const webServerStub = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}

/** The two services ToolRuntime itself needs before it can be constructed. */
const promptStub = {
  section(s) {
    sections.push(s)
    return () => {}
  },
  tools() {
    return () => {}
  },
}

/**
 * The approval channel, as `dsh-user-approval` presents it: one `request()` per
 * gated call, answering with a verdict. Swapped per assertion below.
 */
const approvalCalls = []
let approvalVerdict = 'unavailable'
const approvalStub = {
  async request(request) {
    approvalCalls.push({ toolName: request.toolName, reason: request.reason })
    return approvalVerdict
  },
}

root.plugin({
  name: 'dsh-todo-board',
  apply(ctx) {
    // `agents` is a harness capability, not the runtime under test.
    const services = new Map([['agents', { list: () => [], get: () => undefined }]])
    const realGet = ctx.get.bind(ctx)
    ctx.get = (key) => (services.has(key) ? services.get(key) : realGet(key))
    ctx.reflect.provide('webServer', webServerStub, undefined)
    mod.apply(ctx)
  },
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await sleep(150)

// -- activation -------------------------------------------------------------

assert.deepEqual(
  routes.map((r) => r.path).sort(),
  ['/dsh-todo-board/api', '/dsh-todo-board/image'],
  'both routes register through real service injection, not just a direct callback',
)
assert.equal(
  sections.length,
  0,
  'nothing model-facing is registered yet: systemPrompt/tools do not exist at apply time',
)
console.log('live    OK — plugin activates against real cordis')

// -- the late service, which is the whole point of the inject rewrite ---------

root.reflect.provide('systemPrompt', promptStub, undefined)
await sleep(80)
assert.equal(
  sections.length,
  1,
  'the prompt section registers when systemPrompt arrives AFTER the plugin row',
)

root.plugin({
  name: 'tools',
  apply(ctx) {
    // Constructing the runtime IS how `tools` is provided (Service base class).
    new ToolRuntime(ctx, {})
  },
})
await sleep(120)

const tools = root.get('tools')
assert.equal(typeof tools?.get, 'function', 'the real ToolRuntime is up')
assert.ok(
  tools.get('todo_board') !== undefined,
  'the model tool registers even though the tools service arrived after the plugin',
)
console.log('live    OK — late-arriving services still register (the ctx.inject race stays fixed)')

// -- the log sink, gated by the REAL exporter levels ------------------------

const logPath = join(home, 'todo-board', 'log.ndjson')
root.logger('dsh-todo-board').warn('live probe %s', 'value')
root.logger('dsh-todo-board').debug('our debug line')
root.logger('some-other-plugin').debug('sibling debug')
root.logger('some-other-plugin').error('sibling error')
await sleep(80)

assert.ok(existsSync(logPath), 'mounting creates the log file')
const fileText = readFileSync(logPath, 'utf8')

assert.ok(fileText.includes('live probe value'), 'our own warn reaches the file')
assert.ok(
  fileText.includes('our debug line'),
  "our own debug reaches the file — the levels map keys on OUR logger name, which is the whole reason this works",
)
assert.ok(
  !fileText.includes('sibling debug'),
  "another plugin's debug is gated out (the default:error scope)",
)
assert.ok(
  fileText.includes('sibling error'),
  "another plugin's error still arrives — default:0 is a scope choice, not a safety boundary",
)
assert.ok(
  fileText.includes('live probe value') && !fileText.includes('%s'),
  'placeholders are resolved by our own formatter (Message.args arrives raw)',
)
assert.ok(
  fileText
    .trim()
    .split('\n')
    .every((line) => {
      try {
        JSON.parse(line)
        return true
      } catch (err) {
        return false
      }
    }),
  'every stored line is independently parseable NDJSON',
)
console.log('live-log OK — real logger gate honours our levels map, siblings scoped out')

// -- the approval gate, through the REAL tool pipeline ----------------------

const cancel = () => new AbortController().signal
const caller = {
  id: 'session-live',
  session: { header: { id: 'session-live', cwd: 'D:\\live\\project' } },
  followup() {},
  steer() {},
}

async function callTool(args) {
  return await root.get('tools').execute({
    name: 'todo_board',
    callId: 'call-' + Math.random().toString(36).slice(2),
    arguments: args,
    signal: cancel(),
    agent: caller,
  })
}

const read = await callTool({ action: 'list' })
assert.equal(read.isError, false, 'a read is not gated: ' + JSON.stringify(read).slice(0, 200))

const denied = await callTool({ action: 'add', title: '审批门的探针' })
assert.equal(
  denied.isError,
  true,
  'with no approval service the write FAILS CLOSED instead of landing',
)
assert.ok(
  String(denied.error?.message ?? '').includes('AI 要修改待办板'),
  'and the model sees OUR reason, naming what it tried to change: ' + denied.error?.message,
)
assert.ok(
  String(denied.error?.message ?? '').includes('新增待办'),
  'the reason carries the detail the approval dialog shows',
)

// A channel that grants: the write now goes through, so the gate is a gate and
// not a wall. This is the half a fail-closed-only test cannot tell apart.
root.reflect.provide('approval', approvalStub, undefined)
approvalVerdict = 'allowed-once'
const granted = await callTool({ action: 'add', title: '审批门的探针' })
assert.equal(
  granted.isError,
  false,
  'a grant lets the write through: ' + JSON.stringify(granted).slice(0, 200),
)
assert.equal(approvalCalls.length, 1, 'the channel was asked exactly once for it')
assert.equal(approvalCalls[0].toolName, 'todo_board', 'and the request names our tool')

// The model's own checkbox stays free: `done` is part of the auto-continue loop
// the user asked to keep automatic, and `ask` there would break it under a
// `danger-full-access` (policy `never`) deployment.
const listed = await callTool({ action: 'list' })
const firstId = listed.value.todos[0]?.id
assert.ok(typeof firstId === 'string' && firstId !== '', 'the granted row is on the board')
const done = await callTool({ action: 'done', id: firstId })
assert.equal(done.isError, false, 'action=done is NOT gated — the continue loop needs it')
assert.equal(approvalCalls.length, 1, 'and it did not ask')

// A rejection is the harness's own verdict wording, which is how the model can
// tell "the human said no" from "there is no approval channel at all".
approvalVerdict = 'rejected'
const rejected = await callTool({ action: 'note', id: firstId, note: 'x' })
assert.equal(rejected.isError, true, 'a rejection denies the write')
assert.ok(
  String(rejected.error?.message ?? '').includes('rejected'),
  'with the user-rejection wording, not ours: ' + rejected.error?.message,
)
console.log('live-gate OK — reads and the AI checkbox pass, writes ask, deny/grant both honoured')

// -- the fence on a really-injected route ------------------------------------

const api = routes.find((r) => r.path === '/dsh-todo-board/api')
async function call(request) {
  const box = { status: 0, body: '' }
  await api.handler(request, {
    writeHead(status) {
      box.status = status
    },
    end(body) {
      box.body = body === undefined ? '' : String(body)
    },
  })
  return box
}

assert.equal((await call({ method: 'GET', headers: {} })).status, 403, 'no Host is refused')
assert.equal(
  (await call({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).status,
  200,
  'a loopback Host is served',
)
assert.equal(
  (await call({ method: 'GET', headers: { host: 'evil.example' } })).status,
  403,
  'a rebound Host is refused',
)
console.log('live-fence OK — the local fence is live on the really-injected route')

// -- channel convergence: the harness gate wins once it exists ---------------

const sees = []
let gateStatus = 401
const connectionStub = {
  requestRejection(request) {
    sees.push(request.headers.host)
    return gateStatus
  },
}

// The local fence would serve this request; the harness gate refuses it. Which
// answer comes back is the difference between "the panel is authorized by a
// browser session" and "any local process may write the board".
root.reflect.provide('connection', connectionStub, undefined)
await sleep(60)

assert.equal(
  (await call({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).status,
  401,
  'a request the local fence would allow is refused by the harness gate',
)
assert.equal(sees.length, 1, 'and the harness gate is the one that was asked')

gateStatus = undefined
assert.equal(
  (await call({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).status,
  200,
  'the harness gate still decides when it allows (this is how the panel keeps working)',
)

// A gate that throws must refuse, not take the route down.
connectionStub.requestRejection = () => {
  throw new Error('gate exploded')
}
assert.equal(
  (await call({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).status,
  403,
  'a throwing gate fails closed',
)
console.log('live-conn OK — the route borrows the harness connection gate, not a restatement')

rmSync(home, { recursive: true, force: true })
console.log('\nall live-runtime checks passed')
