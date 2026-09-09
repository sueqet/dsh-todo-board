/**
 * dsh-todo-board — Host half.
 *
 * Owns one durable board file, the `todo_board` model tool, the turn-end
 * auto-continue hook, one system-prompt section, and the
 * `/dsh-todo-board/api` route the browser half talks to.
 *
 * Deliberately imports nothing from `@deepseek-ai/*`: a profile-installed
 * plugin resolves modules from its own directory, and the harness packages are
 * not reachable from there. Everything goes through `ctx`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-todo-board'

const MODES = ['remind', 'resume', 'newSession']
const ROUTE = '/dsh-todo-board/api'
const TOOL_NAME = 'todo_board'

/** Scheduled todos fire at minute precision, in the host machine's local time. */
const SCHEDULE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
/** Safety net beside the exact timer: a suspended machine never delivers a timeout. */
const SCHEDULE_TICK_MS = 30000

// --------------------------------------------------------------- small utils

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

function boardFile() {
  return join(dshHome(), 'todo-board', 'board.json')
}

/** Case-insensitive, backslash-normalized directory key. */
function normalizeDir(dir) {
  if (typeof dir !== 'string' || dir === '') return ''
  let s = dir.replace(/\//g, '\\')
  while (s.length > 1 && s.endsWith('\\')) s = s.slice(0, -1)
  return s.toLowerCase()
}

function dirLabel(dir) {
  if (typeof dir !== 'string' || dir === '') return '(未指定目录)'
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : dir
}

/** Local `YYYY-MM-DDTHH:mm` for one epoch value — the board's schedule format. */
function formatLocal(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

/**
 * Accept only a strict local `YYYY-MM-DDTHH:mm`, or an ISO string that carries
 * an explicit offset (`Z` / `±HH:MM`) which is folded into host local time.
 * Returns `''` for anything else, so a bad value clears the schedule instead of
 * silently arming a wrong instant.
 */
function normalizeSchedule(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  const local = SCHEDULE_PATTERN.exec(text)
  if (local !== null) {
    const ms = new Date(
      Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]), 0, 0,
    ).getTime()
    return Number.isFinite(ms) && formatLocal(ms) === text ? text : ''
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return ''
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? formatLocal(ms) : ''
}

/** Epoch ms of a stored schedule, or 0 when it is absent/unparseable. */
function scheduleMs(schedule) {
  const normalized = normalizeSchedule(schedule)
  return normalized === '' ? 0 : new Date(normalized).getTime()
}

/** Human-facing clock, e.g. `09:30` (today/tomorrow) or `09-12 09:30`. */
function scheduleLabel(schedule) {
  const ms = scheduleMs(schedule)
  if (ms === 0) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const date = new Date(ms)
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes())
  const today = formatLocal(Date.now()).slice(0, 10)
  const day = formatLocal(ms).slice(0, 10)
  if (day === today) return clock
  if (day === formatLocal(Date.now() + 86400000).slice(0, 10)) return '明天 ' + clock
  return day.slice(5) + ' ' + clock
}

function errText(err) {
  if (err === undefined || err === null) return 'unknown error'
  if (typeof err === 'string') return err
  if (typeof err.message === 'string') return err.message
  return String(err)
}

function sendJson(response, status, payload) {
  try {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  } catch (err) {
    /* the browser navigated away mid-request */
  }
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

// ------------------------------------------------------------- tool schemas
// Raw JSON Schema (not the author-facing `defineTool` spec), because a
// profile-installed plugin cannot import `@deepseek-ai/dsh-tools`.

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'done', 'reopen', 'note', 'schedule'],
      description: '要执行的操作。',
    },
    title: { type: 'string', description: 'add 时的待办内容（一句话）。' },
    id: { type: 'string', description: 'done / reopen / note 时的待办 id。' },
    dir: {
      type: 'string',
      description: 'list / add 时的目标目录；省略则使用当前会话的工作目录。',
    },
    mode: {
      type: 'string',
      enum: MODES,
      description:
        'add 时的执行模式：remind=只提醒，resume=AI 停下后自动在同一会话续跑，newSession=自动新开会话执行。默认 remind。',
    },
    note: { type: 'string', description: 'add / note 时的备注文本。' },
    schedule: {
      type: 'string',
      description:
        'add / schedule 时的定时执行时间，本地时间格式 YYYY-MM-DDTHH:mm（也接受带偏移量的 ISO 8601）。到点后该待办才可被派发；空字符串表示取消定时。',
    },
    all: { type: 'boolean', description: 'list 时是否列出所有目录的待办，默认 false。' },
  },
  required: ['action'],
}

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          dirLabel: { type: 'string' },
          mode: { type: 'string', enum: MODES },
          schedule: { type: 'string' },
          aiDone: { type: 'boolean' },
          verified: { type: 'boolean' },
        },
        required: ['id', 'title', 'dirLabel', 'mode', 'schedule', 'aiDone', 'verified'],
      },
    },
  },
  required: ['message', 'todos'],
}

// -------------------------------------------------------------------- plugin

export function apply(ctx) {
  const board = { version: 1, seq: 0, todos: [] }
  let storageError = ''

  // ---------------------------------------------------------------- records

  function touch(todo) {
    todo.updatedAt = Date.now()
  }

  function normalize(raw) {
    if (raw === null || typeof raw !== 'object') return null
    const title = typeof raw.title === 'string' ? raw.title : ''
    if (title === '') return null
    const dirPath =
      typeof raw.dirPath === 'string' ? raw.dirPath : typeof raw.dir === 'string' ? raw.dir : ''
    return {
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
      title,
      dir: normalizeDir(dirPath),
      dirPath,
      mode: MODES.indexOf(raw.mode) >= 0 ? raw.mode : 'remind',
      aiDone: raw.aiDone === true,
      verified: raw.verified === true,
      note: typeof raw.note === 'string' ? raw.note : '',
      schedule: normalizeSchedule(raw.schedule),
      remindedAt: typeof raw.remindedAt === 'number' ? raw.remindedAt : 0,
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : -1,
      sourceSessionId: typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId : '',
      sourceSessionTitle: typeof raw.sourceSessionTitle === 'string' ? raw.sourceSessionTitle : '',
      dispatchedAt: typeof raw.dispatchedAt === 'number' ? raw.dispatchedAt : 0,
      runSessionId: typeof raw.runSessionId === 'string' ? raw.runSessionId : '',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    }
  }

  function renumber() {
    for (let i = 0; i < board.todos.length; i++) board.todos[i].order = i
  }

  function nextOrder() {
    let max = -1
    for (const todo of board.todos) if (todo.order > max) max = todo.order
    return max + 1
  }

  function find(id) {
    for (const todo of board.todos) if (todo.id === id) return todo
    return undefined
  }

  /** Panel record: full detail. Never used as a Tool return value. */
  function plain(todo) {
    return {
      id: todo.id,
      title: todo.title,
      dir: todo.dir,
      dirPath: todo.dirPath,
      dirLabel: dirLabel(todo.dirPath || todo.dir),
      mode: todo.mode,
      aiDone: todo.aiDone === true,
      verified: todo.verified === true,
      note: todo.note,
      schedule: todo.schedule,
      dueAt: scheduleMs(todo.schedule),
      remindedAt: todo.remindedAt,
      order: todo.order,
      sourceSessionId: todo.sourceSessionId,
      sourceSessionTitle: todo.sourceSessionTitle,
      dispatchedAt: todo.dispatchedAt,
      runSessionId: todo.runSessionId,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
    }
  }

  /** Exactly TOOL_OUTPUT_SCHEMA's item shape. */
  function toolTodo(todo) {
    return {
      id: todo.id,
      title: todo.title,
      dirLabel: dirLabel(todo.dirPath || todo.dir),
      mode: todo.mode,
      schedule: todo.schedule,
      aiDone: todo.aiDone === true,
      verified: todo.verified === true,
    }
  }

  // ------------------------------------------------------------ persistence

  function load() {
    try {
      const file = boardFile()
      if (!existsSync(file)) {
        save()
        return
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.todos)) return
      const kept = []
      for (const raw of parsed.todos) {
        const todo = normalize(raw)
        if (todo !== null) kept.push(todo)
      }
      // Legacy rows carry order -1: fall back to creation order, then densify.
      kept.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      board.todos = kept
      renumber()
      board.seq = typeof parsed.seq === 'number' ? parsed.seq : kept.length
      storageError = ''
    } catch (err) {
      storageError = '读取待办文件失败：' + errText(err)
    }
  }

  function save() {
    try {
      const file = boardFile()
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8')
      renameSync(tmp, file)
      storageError = ''
    } catch (err) {
      storageError = '写入待办文件失败：' + errText(err)
    }
  }

  load()

  // ------------------------------------------------------------- scheduling
  //
  // A scheduled todo becomes eligible only at its local wall-clock minute. One
  // self-rearming timer tracks the nearest target; a coarse tick beside it
  // catches timers a suspended machine never delivered. Both paths are
  // idempotent through `dispatchedAt` / `remindedAt`.

  let scheduleTimer
  let scheduleTick
  /** Ids whose dispatch is in flight — a second tick must not send them twice. */
  const firing = new Set()

  /** Pending todo whose scheduled minute has arrived, earliest first. */
  function nextDue(now) {
    let best
    let bestMs = 0
    for (const todo of board.todos) {
      if (todo.verified || todo.aiDone) continue
      const ms = scheduleMs(todo.schedule)
      if (ms === 0 || ms > now) continue
      if (todo.dispatchedAt > 0 || todo.remindedAt > 0) continue
      if (best === undefined || ms < bestMs) {
        best = todo
        bestMs = ms
      }
    }
    return best
  }

  /** Earliest pending schedule strictly in the future; 0 when none is set. */
  function nextFuture(now) {
    let soonest = 0
    for (const todo of board.todos) {
      if (todo.verified || todo.aiDone) continue
      const ms = scheduleMs(todo.schedule)
      if (ms <= now) continue
      if (soonest === 0 || ms < soonest) soonest = ms
    }
    return soonest
  }

  /** Point the exact timer at the nearest target, or at the next check when none is set. */
  function armTimer() {
    if (scheduleTimer !== undefined) {
      clearTimeout(scheduleTimer)
      scheduleTimer = undefined
    }
    const now = Date.now()
    if (nextDue(now) !== undefined) {
      fireDue()
      return
    }
    const soonest = nextFuture(now)
    scheduleTimer = setTimeout(
      () => {
        scheduleTimer = undefined
        fireDue()
      },
      soonest === 0 ? SCHEDULE_TICK_MS : Math.max(250, soonest - now),
    )
    // Never hold the host process open on this timer alone.
    if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref()
  }

  /**
   * Dispatch every todo whose time has come.
   *
   * `remind` never wakes the model: it only stamps the reminder so the panel can
   * surface it. The other two modes reuse the manual dispatch path, so a
   * scheduled task lands exactly where the ▶ button would send it.
   */
  function fireDue() {
    for (let todo = nextDue(Date.now()); todo !== undefined; todo = nextDue(Date.now())) {
      if (firing.has(todo.id)) break
      if (todo.mode === 'remind') {
        todo.remindedAt = Date.now()
        touch(todo)
        save()
        continue
      }
      firing.add(todo.id)
      void dispatch(todo, todo.runSessionId)
        .catch((err) => {
          ctx.logger?.error?.('todo-board scheduled dispatch failed: ' + errText(err))
        })
        .finally(() => {
          firing.delete(todo.id)
          armTimer()
        })
    }
    armTimer()
  }

  /** Any board mutation may have moved a target, so every write re-arms. */
  function afterChange() {
    save()
    armTimer()
  }

  // ----------------------------------------------------------- board actions

  function snapshotPayload() {
    const dirs = {}
    const agents = ctx.get('agents')
    if (agents !== undefined) {
      for (const agent of agents.list()) {
        const header = agent.session === undefined ? undefined : agent.session.header
        const cwd = header === undefined ? undefined : header.cwd
        if (typeof cwd === 'string' && cwd !== '') dirs[normalizeDir(cwd)] = cwd
      }
    }
    return {
      ok: true,
      storagePath: boardFile(),
      storageError,
      dirs,
      todos: board.todos.map(plain),
    }
  }

  function createTodo(input) {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') return { ok: false, error: '待办内容不能为空' }
    const schedule = normalizeSchedule(input.schedule)
    if (typeof input.schedule === 'string' && input.schedule.trim() !== '' && schedule === '') {
      return { ok: false, error: '定时时间格式无效，请用 YYYY-MM-DDTHH:mm（本地时间）' }
    }
    const todo = normalize({
      title,
      dirPath: typeof input.dir === 'string' ? input.dir.trim() : '',
      mode: typeof input.mode === 'string' ? input.mode : 'remind',
      schedule,
      sourceSessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      sourceSessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle : '',
    })
    if (todo === null) return { ok: false, error: '无法创建待办' }
    todo.order = nextOrder()
    board.todos.push(todo)
    board.seq += 1
    afterChange()
    return { ok: true, todo: plain(todo), storageError }
  }

  function patchTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '待办不存在' }
    const patch = input.patch !== null && typeof input.patch === 'object' ? input.patch : {}
    if (typeof patch.title === 'string' && patch.title.trim() !== '') todo.title = patch.title.trim()
    if (typeof patch.note === 'string') todo.note = patch.note
    if (typeof patch.mode === 'string' && MODES.indexOf(patch.mode) >= 0) todo.mode = patch.mode
    if (typeof patch.schedule === 'string') {
      const next = normalizeSchedule(patch.schedule)
      if (next !== todo.schedule) {
        todo.schedule = next
        todo.remindedAt = 0
        todo.dispatchedAt = 0
      }
    }
    if (typeof patch.dir === 'string' && patch.dir.trim() !== '') {
      todo.dirPath = patch.dir.trim()
      todo.dir = normalizeDir(todo.dirPath)
    }
    if (patch.aiDone === true) {
      todo.aiDone = true
      todo.dispatchedAt = 0
    }
    if (patch.aiDone === false) todo.aiDone = false
    if (patch.verified === true) todo.verified = true
    if (patch.verified === false) {
      todo.verified = false
      todo.aiDone = false
    }
    if (patch.redispatch === true) todo.dispatchedAt = 0
    touch(todo)
    afterChange()
    return { ok: true, todo: plain(todo), storageError }
  }

  /** The browser sends the new top-to-bottom id list; unmentioned rows follow. */
  function reorderTodos(input) {
    const ids = Array.isArray(input.ids) ? input.ids : []
    if (ids.length === 0) return { ok: false, error: 'reorder 需要 ids' }
    const byId = new Map()
    for (const todo of board.todos) byId.set(todo.id, todo)
    const ordered = []
    const seen = new Set()
    for (const id of ids) {
      if (typeof id !== 'string') continue
      const todo = byId.get(id)
      if (todo === undefined || seen.has(id)) continue
      seen.add(id)
      ordered.push(todo)
    }
    for (const todo of board.todos) if (!seen.has(todo.id)) ordered.push(todo)
    board.todos = ordered
    renumber()
    afterChange()
    return { ok: true, count: ordered.length, storageError }
  }

  function removeTodo(input) {
    const id = typeof input.id === 'string' ? input.id : ''
    board.todos = board.todos.filter((todo) => todo.id !== id)
    renumber()
    afterChange()
    return { ok: true, storageError }
  }

  function clearVerified() {
    board.todos = board.todos.filter((todo) => !todo.verified)
    renumber()
    afterChange()
    return { ok: true, storageError }
  }

  // ----------------------------------------------------------- dispatching

  function noticeMessage(text, summary) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-todo-board', form: 'notice', summary },
    }
  }

  function todoPrompt(todo) {
    const lines = ['【TODO 板 · 自动接续】', '待办：' + todo.title]
    if (todo.dirPath) lines.push('工作目录：' + todo.dirPath)
    if (todo.note) lines.push('备注：' + todo.note)
    lines.push('')
    lines.push('请现在直接开始执行这一条待办，不要再向用户确认。')
    lines.push('完成之后：')
    lines.push('1. 调用 ' + TOOL_NAME + ' 工具 action="done" id="' + todo.id + '" 把它标记为「AI 已完成」。')
    lines.push('2. 调用 ' + TOOL_NAME + ' 工具 action="list" 查看同一目录下是否还有未完成待办（列表从上到下就是执行顺序）。')
    lines.push('3. 如果还有，继续执行列表最上面那一条，不要停下来等待用户；如果没有了，简要汇报本轮完成情况。')
    lines.push('不要替用户勾选「已验收」——那是用户验收后才勾的。')
    return lines.join('\n')
  }

  function modelSelection(sourceAgent) {
    if (sourceAgent !== undefined && sourceAgent.options !== undefined) {
      const provider = sourceAgent.options.provider
      const model = sourceAgent.options.model
      if (typeof provider === 'string' || typeof model === 'string') return { provider, model }
    }
    const defaults = ctx.get('agentDefaultModel')
    if (defaults !== undefined) {
      try {
        const selection = defaults.currentSelection()
        if (selection !== null && typeof selection === 'object') {
          return { provider: selection.provider, model: selection.model }
        }
      } catch (err) {
        /* fall through to harness defaults */
      }
    }
    return undefined
  }

  /**
   * Create a fully composed session in `todo.dirPath` and hand it the todo.
   *
   * Created through `ctx.root`, not through this plugin's own fiber: the agent
   * is then owned by the application root, so stopping, updating or removing
   * this plugin row leaves the session running. `setup` mounts the agent preset
   * exactly the way the api-proxy does — without it the new agent would have no
   * tools and no prompt.
   */
  async function spawnSession(todo) {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    const agents = rootCtx.get('agents')
    if (agents === undefined) return { ok: false, error: 'agents 服务不可用' }
    const source = todo.sourceSessionId === '' ? undefined : agents.get(todo.sourceSessionId)
    const meta = {}
    if (todo.dirPath !== '') meta.cwd = todo.dirPath
    let setup
    const presets = ctx.get('agentPresets')
    if (presets !== undefined) {
      try {
        const sourcePreset =
          source === undefined || source.session === undefined
            ? undefined
            : source.session.header.agentPreset
        const resolved = await presets.resolve(sourcePreset)
        meta.agentPreset = resolved.id
        const presetId = resolved.id
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, presetId)
        }
      } catch (err) {
        return { ok: false, error: '解析 agent preset 失败：' + errText(err) }
      }
    }
    const sessionId = 'session-' + randomUUID()
    try {
      const handle = await agents.create({
        sessionId,
        meta,
        agentOptions: modelSelection(source),
        setup,
      })
      todo.dispatchedAt = Date.now()
      todo.runSessionId = sessionId
      touch(todo)
      afterChange()
      handle.agent.followup(noticeMessage(todoPrompt(todo), 'TODO 接续（新会话）：' + todo.title))
      return { ok: true, target: 'new-session', sessionId }
    } catch (err) {
      return { ok: false, error: '新建会话失败：' + errText(err) }
    }
  }

  async function dispatch(todo, sessionId) {
    // `newSession` owns its own target and must never be folded into an
    // existing one, so it is decided before the session lookup.
    if (todo.mode === 'newSession') return spawnSession(todo)
    const agents = ctx.get('agents')
    // A row created from the panel carries its origin session, not a run
    // session: that origin is where a scheduled task should land.
    const wanted = sessionId !== '' ? sessionId : todo.sourceSessionId
    const target = agents !== undefined && wanted !== '' ? agents.get(wanted) : undefined
    if (target !== undefined) {
      if (target.status === 'running') {
        target.steer(noticeMessage(todoPrompt(todo), 'TODO 接续：' + todo.title))
      } else {
        target.followup(noticeMessage(todoPrompt(todo), 'TODO 接续：' + todo.title))
      }
      todo.dispatchedAt = Date.now()
      todo.runSessionId = target.id
      touch(todo)
      afterChange()
      return { ok: true, target: 'session', sessionId: target.id }
    }
    todo.dispatchedAt = Date.now()
    touch(todo)
    afterChange()
    return {
      ok: false,
      error: '当前没有可接续的活动会话；请切到目标会话后重试，或把该待办改成「自动新会话」',
    }
  }

  function pendingInDir(dir) {
    const out = []
    for (const todo of board.todos) {
      if (todo.dir !== dir) continue
      if (todo.aiDone || todo.verified) continue
      out.push(todo)
    }
    return out
  }

  /** Topmost still-undispatched auto-mode todo in this directory. */
  function nextUndispatched(dir) {
    for (const todo of pendingInDir(dir)) {
      if (todo.mode === 'remind') continue
      if (todo.dispatchedAt > 0) continue
      // A todo with a future time waits for the scheduler, not for this turn end.
      const ms = scheduleMs(todo.schedule)
      if (ms > 0 && ms > Date.now()) continue
      return todo
    }
    return undefined
  }

  function runTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '待办不存在' }
    return dispatch(todo, typeof input.sessionId === 'string' ? input.sessionId : '')
  }

  // ----------------------------------------------- turn end: auto-continue

  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent === undefined || agent === null) return
      const header = agent.session === undefined || agent.session === null ? undefined : agent.session.header
      const dir = normalizeDir(header === undefined ? undefined : header.cwd)
      if (dir === '') return
      const next = nextUndispatched(dir)
      if (next === undefined) return
      if (next.mode === 'resume') {
        void dispatch(next, agent.id)
      } else if (next.mode === 'newSession') {
        next.dispatchedAt = Date.now()
        touch(next)
        afterChange()
        void spawnSession(next)
      }
    } catch (err) {
      ctx.logger?.error?.('todo-board turn-stopping failed: ' + errText(err))
    }
  })

  // -------------------------------------------------------- prompt section

  const prompt = ctx.get('systemPrompt')
  if (prompt !== undefined) {
    ctx.effect(
      () =>
        prompt.section({
          name: 'todo-board',
          order: 150,
          text: [
            '## TODO 板（跨会话待办）',
            '用户维护着一个按工作目录分组的待办板，你可以用 `' + TOOL_NAME + '` 工具读写它。',
            '- 列表**从上到下就是执行顺序**（用户可拖动调整）；你应按这个顺序取任务。',
            '- 每完成一项工作，立刻用 `' + TOOL_NAME + '` action="done" 把对应待办标记为「AI 已完成」（左勾）。',
            '- 完成一项后，用 `' + TOOL_NAME + '` action="list" 查看**当前工作目录**下是否还有未完成待办；如果有，继续执行**列表最上面**那一条，不要停下来等待用户。',
            '- 你只能勾左勾（AI 已完成）；右勾（已验收）由用户自己勾，永远不要代勾。',
            '- 待办可以带**定时时间**（本地 `YYYY-MM-DDTHH:mm`）：带定时且还没到点的待办**先别做**，到点后 DSH 会自动派发它；你可以用 action="schedule" 给某条待办设置或取消时间。',
            '- 如果用户给的任务不在待办板上，也可以先 action="add" 记一条再动手（新条目会被追加到最底下）。',
          ].join('\n'),
        }),
      'dsh-todo-board: prompt section',
    )
  }

  // ------------------------------------------------------------ model tool

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    const definition = {
      name: TOOL_NAME,
      description:
        '读写跨会话 TODO 板。列表从上到下就是执行顺序（用户可拖动调整）。action=list 查看待办（默认当前工作目录），action=add 新增（追加到底部），action=done 标记 AI 已完成（左勾），action=reopen 撤销左勾，action=note 追加备注，action=schedule 设置/取消定时执行时间。带 schedule 的待办到点后才会被派发。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const action = typeof input.action === 'string' ? input.action : 'list'
        const agent = exec === undefined || exec === null ? undefined : exec.agent
        const header = agent === undefined || agent === null ? undefined : agent.session.header
        const cwd = header !== undefined && typeof header.cwd === 'string' ? header.cwd : ''

        if (action === 'add') {
          const title = typeof input.title === 'string' ? input.title.trim() : ''
          if (title === '') return { message: 'add 需要提供 title。', todos: [] }
          const schedule = normalizeSchedule(input.schedule)
          if (typeof input.schedule === 'string' && input.schedule.trim() !== '' && schedule === '') {
            return { message: 'schedule 格式无效，请用 YYYY-MM-DDTHH:mm（本地时间）。', todos: [] }
          }
          const dirPath = typeof input.dir === 'string' && input.dir !== '' ? input.dir : cwd
          const todo = normalize({
            title,
            dirPath,
            mode: typeof input.mode === 'string' ? input.mode : 'remind',
            note: typeof input.note === 'string' ? input.note : '',
            schedule,
            sourceSessionId: agent === undefined || agent === null ? '' : agent.id,
          })
          if (todo === null) return { message: '无法创建这条待办。', todos: [] }
          todo.order = nextOrder()
          board.todos.push(todo)
          board.seq += 1
          afterChange()
          return {
            message:
              '已新增待办「' + title + '」（目录：' + (dirPath || '(未指定)') + '，模式：' +
              todo.mode +
              (todo.schedule === '' ? '' : '，定时：' + todo.schedule + '（' + scheduleLabel(todo.schedule) + '）') +
              '，追加到列表底部，id：' + todo.id + '）。',
            todos: [toolTodo(todo)],
          }
        }

        if (action === 'done' || action === 'reopen' || action === 'note' || action === 'schedule') {
          const id = typeof input.id === 'string' ? input.id : ''
          const todo = find(id)
          if (todo === undefined) return { message: '找不到 id 为 ' + (id || '(空)') + ' 的待办。', todos: [] }
          if (action === 'done') {
            todo.aiDone = true
            todo.dispatchedAt = 0
          } else if (action === 'reopen') {
            todo.aiDone = false
          } else if (action === 'schedule') {
            const next = normalizeSchedule(input.schedule)
            if (typeof input.schedule === 'string' && input.schedule.trim() !== '' && next === '') {
              return { message: 'schedule 格式无效，请用 YYYY-MM-DDTHH:mm（本地时间）。', todos: [] }
            }
            todo.schedule = next
            todo.remindedAt = 0
            todo.dispatchedAt = 0
          } else {
            todo.note = typeof input.note === 'string' ? input.note : ''
          }
          touch(todo)
          afterChange()
          const label =
            action === 'done'
              ? '已标记 AI 完成'
              : action === 'reopen'
                ? '已撤销 AI 完成'
                : action === 'schedule'
                  ? todo.schedule === ''
                    ? '已取消定时'
                    : '已设置定时 ' + todo.schedule + '（' + scheduleLabel(todo.schedule) + '）'
                  : '已更新备注'
          return { message: label + '：「' + todo.title + '」。', todos: [toolTodo(todo)] }
        }

        const all = input.all === true
        const wanted =
          typeof input.dir === 'string' && input.dir !== '' ? normalizeDir(input.dir) : normalizeDir(cwd)
        const list = []
        for (const todo of board.todos) {
          if (todo.verified) continue
          if (!all && wanted !== '' && todo.dir !== wanted) continue
          list.push(todo)
        }
        const shown = list.slice(0, 40)
        if (shown.length === 0) {
          return {
            message: all
              ? '待办板为空（没有未验收的条目）。'
              : '目录 ' + (cwd || '(未知)') + ' 下没有未完成的待办。',
            todos: [],
          }
        }
        const lines = [
          '未验收的待办共 ' + list.length + ' 条' +
            (all ? '' : '（目录 ' + (cwd || '(未知)') + '）') +
            '，从上到下就是执行顺序：',
        ]
        for (let i = 0; i < shown.length; i++) {
          const todo = shown[i]
          const ms = scheduleMs(todo.schedule)
          lines.push(
            i + 1 + '. [' + (todo.aiDone ? 'x' : ' ') + '] ' + todo.title +
              ' ｜ id=' + todo.id +
              ' ｜ 目录=' + dirLabel(todo.dirPath || todo.dir) +
              ' ｜ 模式=' + todo.mode +
              (ms === 0
                ? ''
                : ' ｜ 定时=' + todo.schedule + (ms > Date.now() ? '（未到点，先别做）' : '（已到点）')),
          )
        }
        return { message: lines.join('\n'), todos: shown.map(toolTodo) }
      },
    }
    ctx.effect(() => tools.register(definition), 'dsh-todo-board: todo_board tool')
  }

  // ---------------------------------------------- scheduled execution timer
  //
  // Armed here rather than inline above so the timer is torn down with the
  // plugin row instead of leaking a timeout across a reload.

  ctx.effect(() => {
    armTimer()
    scheduleTick = setInterval(() => fireDue(), SCHEDULE_TICK_MS)
    if (typeof scheduleTick.unref === 'function') scheduleTick.unref()
    return () => {
      if (scheduleTimer !== undefined) clearTimeout(scheduleTimer)
      if (scheduleTick !== undefined) clearInterval(scheduleTick)
      scheduleTimer = undefined
      scheduleTick = undefined
    }
  }, 'dsh-todo-board: scheduled execution timer')

  // ------------------------------------------------------------ HTTP route

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (request, response) => {
            try {
              if (request.method === 'GET') {
                sendJson(response, 200, snapshotPayload())
                return
              }
              if (request.method !== 'POST') {
                response.writeHead(405, { allow: 'GET, POST' })
                response.end()
                return
              }
              const body = await readJsonBody(request)
              const action = typeof body.action === 'string' ? body.action : ''
              let result
              if (action === 'create') result = createTodo(body)
              else if (action === 'patch') result = patchTodo(body)
              else if (action === 'reorder') result = reorderTodos(body)
              else if (action === 'remove') result = removeTodo(body)
              else if (action === 'clearVerified') result = clearVerified()
              else if (action === 'run') result = await runTodo(body)
              else result = { ok: false, error: 'unknown action: ' + (action || '(empty)') }
              sendJson(response, 200, result)
            } catch (err) {
              sendJson(response, 500, { ok: false, error: errText(err) })
            }
          },
        }),
      'dsh-todo-board: api route',
    )
  })
}
