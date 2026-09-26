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

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-todo-board'

const MODES = ['remind', 'resume', 'newSession']
const ROUTE = '/dsh-todo-board/api'
const IMAGE_ROUTE = '/dsh-todo-board/image'
const TOOL_NAME = 'todo_board'

/** Scheduled todos fire at minute precision, in the host machine's local time. */
const SCHEDULE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
/** Safety net beside the exact timer: a suspended machine never delivers a timeout. */
const SCHEDULE_TICK_MS = 30000
/** Attachments one todo may carry; keeps a prompt from becoming an image dump. */
const MAX_IMAGES_PER_TODO = 4
const MEDIA_TYPE_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const MEDIA_TYPES = Object.values(MEDIA_TYPE_BY_EXTENSION)

/**
 * A row whose target session is gone stays pending (it is *not* stamped as
 * dispatched), so the scheduler and the turn-end hook would both keep picking
 * it. These bound that retry: the first re-attempt waits a minute, each further
 * failure doubles it, and a row that stays stuck settles at one attempt every
 * half hour instead of one every tick.
 */
const LOST_RETRY_BASE_MS = 60_000
const LOST_RETRY_MAX_MS = 30 * 60_000

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

/**
 * Keep only durable-shaped image references, so a corrupt or hand-edited board
 * can never smuggle an arbitrary object into a user message.
 */
function normalizeImages(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.attachmentId !== 'string' || entry.attachmentId === '') continue
    if (MEDIA_TYPES.indexOf(entry.mediaType) < 0) continue
    const ref = {
      attachmentId: entry.attachmentId,
      mediaType: entry.mediaType,
      bytes: typeof entry.bytes === 'number' ? entry.bytes : 0,
      width: typeof entry.width === 'number' ? entry.width : 0,
      height: typeof entry.height === 'number' ? entry.height : 0,
    }
    if (typeof entry.name === 'string' && entry.name !== '') ref.name = entry.name
    out.push(ref)
    if (out.length >= MAX_IMAGES_PER_TODO) break
  }
  return out
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

// ------------------------------------------------------------- request trust
//
// The harness fences its own `/api` channel against the two confused-deputy
// paths a browser opens against a local HTTP server — DNS rebinding, and a
// malicious page firing cross-site requests. That fence is registered PER
// CHANNEL (`dsh-client-connection` `register(owner, channel, ...)`), so a
// plugin route outside `/api` is not covered by it; ours is not. Restated here
// because this plugin owns a board that can spawn sessions and burn tokens, and
// (once the log view exists) a route that can return process-wide diagnostics.
//
// `Host` is the load-bearing check, and that is not an implementation detail:
// over plain HTTP a browser attaches neither `Origin` nor Fetch-Metadata to
// reads (images, navigations — those headers go only to trustworthy
// destinations), so an unmarked request may still be a rebound browser read,
// and `Host` is the one header rebinding cannot forge. The marker checks are
// the second half: they catch the cross-site request a rebound-name Host
// cannot.

/** Whether a WHATWG hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Normalized URL of a `Host`-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch (err) {
    return undefined
  }
}

/** Canonical `hostname[:port]` of a parsed authority, default ports stripped. */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

/**
 * Whether the request authority matches a declared trusted entry.
 *
 * Mirrors the harness rule: an entry carrying an explicit port matches that
 * exact authority, a port-less entry matches the hostname on any port (the
 * shape the CLI derives for LAN serving, where the port may be OS-assigned).
 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** One header by lowercased name, from Node's headers object or a Fetch Headers. */
function headerValue(headers, wanted) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const got = headers.get(wanted)
    return typeof got === 'string' ? got : undefined
  }
  const found = headers[wanted]
  return typeof found === 'string' ? found : undefined
}

/**
 * Decide whether one request may reach a plugin route.
 *
 * @returns the HTTP status to refuse with, or `undefined` to allow — the same
 *   shape the harness uses, so both fences read alike.
 */
function requestRejection(request, trustedHosts) {
  const headers = request === undefined || request === null ? undefined : request.headers
  const host = headerValue(headers, 'host')
  if (host === undefined) return 403
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return 403
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return 403
  if (headerValue(headers, 'sec-fetch-site') === 'cross-site') return 403
  const origin = headerValue(headers, 'origin')
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === hostUrl.host ? undefined : 403
  } catch (err) {
    return 403
  }
}

// -------------------------------------------------------------- diagnostics
//
// Pure helpers for the developer log the panel can show behind a button. They
// live at module scope so the Node suite can exercise them directly — the
// formatting and redaction rules are the part worth testing, and neither needs
// a context.

const LOG_NAME = 'dsh-todo-board'
/** Numeric severity, matching cordis' own scale (lower is more severe). */
const LOG_LEVEL_NUMBER = { error: 0, info: 1, warn: 2, debug: 3 }
const LOG_LEVEL_BY_NUMBER = ['error', 'info', 'warn', 'debug']
/** Records kept in memory for the panel; the file keeps its own, larger tail. */
const LOG_RING_MAX = 500
/** One record's rendered detail is capped so a single dump cannot fill the ring. */
const LOG_DETAIL_MAX = 4000
const LOG_FILE_MAX_BYTES = 256 * 1024

function boardLogFile() {
  return join(dshHome(), 'todo-board', 'log.ndjson')
}

/** JSON that never throws on cycles or BigInt, unlike a bare `JSON.stringify`. */
function safeJson(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (key, entry) => {
      if (typeof entry === 'bigint') return String(entry)
      if (entry !== null && typeof entry === 'object') {
        if (seen.has(entry)) return '[circular]'
        seen.add(entry)
      }
      return entry
    }) ?? String(value)
  } catch (err) {
    return String(value)
  }
}

function describeValue(value) {
  if (value instanceof Error) return errorDetail(value)
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') return safeJson(value)
  return String(value)
}

/**
 * Render an `Error` for a log line.
 *
 * `stack` first — a diagnostic log without a stack loses half its value. The
 * cause and own enumerable properties are folded in beside it: cordis delivers
 * a non-`Error` `cause` as its OWN record (verified), and on its own that
 * record is an unattributed object dump, so naming it here is what makes the
 * pair readable.
 */
function errorDetail(err) {
  const head = typeof err.stack === 'string' && err.stack !== '' ? err.stack : String(err.message ?? err)
  const extra = []
  if (err.cause !== undefined && err.cause !== null) extra.push('cause=' + describeValue(err.cause))
  for (const key of Object.keys(err)) extra.push(key + '=' + describeValue(err[key]))
  return extra.length === 0 ? head : head + '\n  (' + extra.join(', ') + ')'
}

/**
 * Format raw logger arguments into one readable line.
 *
 * Required because `Message.args` is UNFORMATTED (verified: `%s`/`%d`/`%o`
 * arrive verbatim) and cordis' own `Logger.format` is a static method on the
 * `Logger` class, which a plugin cannot reach — `LoggerService` exposes no
 * formatter. So this reproduces the parts that matter, and nothing else.
 */
function formatLogArgs(args) {
  const list = Array.isArray(args) ? args.slice() : []
  if (list.length === 0) return ''
  if (list[0] instanceof Error) {
    list[0] = errorDetail(list[0])
    list.unshift('%s')
  } else if (typeof list[0] !== 'string') {
    // A bare object/`Error`-free first argument would otherwise be lost.
    list.unshift('%o')
  }
  let format = String(list.shift())
  format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
    if (match === '%%') return '%'
    if (list.length === 0) return match
    const value = list.shift()
    if (char === 's') return String(value)
    if (char === 'd' || char === 'i') return String(Math.trunc(Number(value)))
    if (char === 'f') return String(Number(value))
    if (char === 'o' || char === 'O') return safeJson(value)
    // `%c`/`%C` are colour directives: they carry no text.
    if (char === 'c' || char === 'C') return ''
    return match
  })
  for (const value of list) format += ' ' + describeValue(value)
  return format
}

/**
 * Mask credentials before a line is stored or shown. **Load-bearing, not
 * hardening** — see `docs/design-log-view.md` §3.2, where four leak paths were
 * reproduced. The lesson from that spike is that a leaked key never arrives
 * from a careless `logger.warn(secret)`: it arrives inside a message someone
 * else composed, usually an `Error.message` from a config-validation failure,
 * so this must run on EVERY record's write path rather than once per error.
 *
 * Coverage is deliberately stated rather than implied:
 *   * known credential shapes (`sk-`, GitHub, npm, bearer);
 *   * values under a secret-looking KEY in a JSON dump — this is the
 *     `dsh-mcp-client` union case, which dumps the whole config including
 *     `env` and `headers`;
 *   * `key: value` pairs in plain text;
 *   * schemastery's "value position" echoes (`credential ref "…"`, `but got …`),
 *     which carry whatever the user pasted and therefore need no prefix at all —
 *     `ctx7sk-…` is the reproduced example.
 *
 * NOT covered, and worth knowing: a secret with no recognizable prefix sitting
 * under a non-secret-looking key in a JSON dump. The set of leak shapes is
 * concrete and enumerable rather than "all logs are dangerous", and this is the
 * edge that stays open.
 */
function redact(text) {
  let out = typeof text === 'string' ? text : String(text)
  try {
    out = out.split(homedir()).join('~')
  } catch (err) {
    /* no home directory to collapse */
  }
  return (
    out
      // Control characters would let a logged payload forge extra visual lines
      // in the panel. Newlines and tabs are kept: they carry stack traces, and
      // this file is NDJSON, so a newline inside a value is escaped by
      // `JSON.stringify` and can never become a real record separator.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
      .replace(/\bnpm_[A-Za-z0-9]{16,}/g, 'npm_***')
      // The value class excludes quotes: `Authorization":"Bearer sk-…"` must
      // keep its closing quote, or the surrounding JSON stops parsing and the
      // dump we kept for diagnosis becomes unreadable.
      .replace(/\bbearer\s+[^\s"']+/gi, 'Bearer ***')
      // This MUST run before the generic `key: value` rule below. That rule
      // treats `credential` as a key and then eats the very next token — which
      // here is the word `ref`, leaving the quoted secret untouched. Caught by
      // the redaction test rather than by review.
      .replace(/(credential ref\s+)"[^"]*"/gi, '$1"***"')
      .replace(
        /("(?:[A-Za-z0-9_-]*(?:token|secret|key|password|authorization|credential)[A-Za-z0-9_-]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
        '$1"***"',
      )
      .replace(
        // Requires a real ASSIGNMENT separator (`:` or `=`), never bare
        // whitespace. The reference implementation accepts any whitespace,
        // which turns ordinary diagnostics into mush: `apiKey expected string
        // but got X` becomes `apiKey ***string but got X`, losing the sentence
        // that made the record worth keeping. Caught by the redaction test.
        /((?:authorization|token|apikey|api-key|password|secret|credential)\b["']?\s*[:=]\s*)("(?:[^"]*)"|'(?:[^']*)'|[^\s,;)}\]]+)/gi,
        // Quote characters are preserved in the replacement. A log line is not
        // parsed, but a mangled dump is harder to read than a masked one, and
        // the whole point of keeping the dump is that a person reads it.
        (match, prefix, value) =>
          prefix + (value.startsWith('"') ? '"***"' : value.startsWith("'") ? "'***'" : '***'),
      )
      // schemastery echoes the received value here, which can be an arbitrary
      // user-pasted string (the reproduced `Config(SECRET)` bare-scalar case).
      // Two constraints learned from the actual output rather than from review,
      // both about not destroying the record we are trying to make safe:
      //   * the lookahead keeps the diagnostic value of the common non-secret
      //     answers (`[object Object]`, type words, numbers);
      //   * the value must not START with JSON punctuation, or the whole config
      //     dump behind it is swallowed and `dsh-mcp-client`'s union failure —
      //     the case worth diagnosing — becomes one unreadable `***`.
      .replace(
        /\bbut got\s+(?![\[{"'])(?!\[object Object\]|undefined|null|true\b|false\b|-?\d)[^\s,;)}\]]+/gi,
        'but got ***',
      )
  )
}

/** Clamp one rendered detail, marking that it was cut. */
function clampDetail(text) {
  return text.length > LOG_DETAIL_MAX ? text.slice(0, LOG_DETAIL_MAX) + '…(截断)' : text
}

/** The panel's record shape for one captured log message. */
function logRecord(message, detail) {
  const type = typeof message.type === 'string' ? message.type : LOG_LEVEL_BY_NUMBER[message.level] ?? 'info'
  let source = ''
  try {
    const fiber = message.fiber === undefined || message.fiber === null ? undefined : message.fiber.deref()
    const runtimeName = fiber === undefined || fiber === null ? undefined : fiber.runtime?.name
    if (typeof runtimeName === 'string') source = runtimeName
  } catch (err) {
    /* a dead fiber reference just means no attribution */
  }
  return {
    sn: message.sn,
    ts: message.ts,
    level: type,
    source,
    logger: typeof message.name === 'string' ? message.name : '',
    detail: clampDetail(redact(detail)),
  }
}

// ------------------------------------------------------------- tool schemas
// Raw JSON Schema (not the author-facing `defineTool` spec), because a
// profile-installed plugin cannot import `@deepseek-ai/dsh-tools`.

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'done', 'reopen', 'note', 'schedule', 'update', 'reorder', 'dispatch'],
      description: '要执行的操作。',
    },
    title: { type: 'string', description: 'add 时的待办内容（一句话）；update 时改标题。' },
    id: { type: 'string', description: 'done / reopen / note / schedule / update / dispatch 时的待办 id。' },
    dir: {
      type: 'string',
      description: 'list / add 时的目标目录，update 时改目录；省略则使用当前会话的工作目录。',
    },
    mode: {
      type: 'string',
      enum: MODES,
      description:
        'add / update 时的执行模式：remind=只提醒，resume=AI 停下后自动在同一会话续跑，newSession=自动新开会话执行。add 时默认 remind。',
    },
    note: { type: 'string', description: 'add / note 时的备注文本；update 时同样改备注（空字符串即清空）。' },
    ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        'reorder 时新的从上到下顺序（待办 id 数组）。只接受同一个目录内的待办；未列出的待办保持原有相对顺序跟在后面。',
    },
    schedule: {
      type: 'string',
      description:
        'add / schedule 时的定时执行时间，本地时间格式 YYYY-MM-DDTHH:mm（也接受带偏移量的 ISO 8601）。到点后该待办才可被派发；空字符串表示取消定时。',
    },
    all: { type: 'boolean', description: 'list 时是否列出所有目录的待办，默认 false。' },
    images: {
      type: 'array',
      items: { type: 'string' },
      description:
        'add 时的图片：每项是主机上的图片文件绝对路径（png / jpg / webp / gif）。最多 ' +
        MAX_IMAGES_PER_TODO + ' 张；文件会被存进附件库，派发时作为真正的图片一起发给模型。',
    },
  },
  required: ['action'],
}

const TOOL_STATES = ['pending', 'dispatched', 'running', 'done', 'lost']
/** Human-facing names for the same states, used in the list readout. */
const STATE_LABEL = {
  pending: '未派发',
  dispatched: '已派发',
  running: '进行中',
  done: '已完成',
  lost: '目标会话丢失',
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
          imageCount: { type: 'number' },
          aiDone: { type: 'boolean' },
          verified: { type: 'boolean' },
          state: { type: 'string', enum: TOOL_STATES },
        },
        required: [
          'id', 'title', 'dirLabel', 'mode', 'schedule', 'imageCount', 'aiDone', 'verified', 'state',
        ],
      },
    },
  },
  required: ['message', 'todos'],
}

// -------------------------------------------------------------------- plugin

export function apply(ctx) {
  const board = { version: 1, seq: 0, todos: [] }
  let storageError = ''

  // ------------------------------------------------------------ log storage
  //
  // The built-in `ctx.logger.buffer` CANNOT be the source here: cordis
  // registers its buffer exporter without a `levels` map, so the gate falls
  // back to `INFO` and every `warn`/`debug` is dropped before it is stored
  // (verified against `cordis/src/logger.ts:213-221` and `:155`). That is
  // exactly the level where this plugin's dispatch failures live, so the ring
  // is fed by our own exporter instead.
  //
  // Only ONE exporter is ever registered, and it is never removed by hand: the
  // disposer `ctx.logger.exporter()` returns is buggy when two exporters exist
  // (`:232-237` deletes `this._snExporter`, the LATEST id, not the one it
  // captured), so removal rides the fiber teardown instead — the path that was
  // verified correct.

  /** Newest-last records for the panel; `sn` is the process-wide cursor. */
  const logRing = []
  let logDropped = 0
  /** Highest `sn` seen, so the panel can ask for "everything after this". */
  let logSeq = 0
  /** Newest error/warn, for the button dot the panel shows without opening the view. */
  let logAlertSn = 0
  let logAlertAt = 0
  /** Set once writing the file has failed (read-only or full disk). */
  let logFileOff = false
  let logFileBytes = 0
  let logWriteError = ''

  function logLine(record) {
    return (
      JSON.stringify({
        ts: record.ts,
        level: record.level,
        source: record.source,
        logger: record.logger,
        detail: record.detail,
      }) + '\n'
    )
  }

  /**
   * Rewrite the log file keeping its newest half.
   *
   * Called after an append crosses the ceiling, never only on mount: a
   * long-lived process that trims once still grows without bound (the
   * reference implementation measured 3.2 MB after 20k events).
   */
  function trimLogFile(file) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    const kept = []
    let bytes = 0
    for (let i = lines.length - 1; i >= 0 && bytes <= LOG_FILE_MAX_BYTES / 2; i--) {
      kept.unshift(lines[i] + '\n')
      bytes += lines[i].length + 1
    }
    writeFileSync(file, kept.join(''), { encoding: 'utf8', mode: 0o600 })
    logFileBytes = bytes
  }

  /**
   * Append one record, or stop trying.
   *
   * A write failure disables persistence for the rest of the process but leaves
   * the in-memory log working — one bad write must not break every later
   * record, and a read-only disk is a reason to lose the file, not the view.
   */
  function persistLog(record) {
    if (logFileOff) return
    try {
      const file = boardLogFile()
      mkdirSync(dirname(file), { recursive: true })
      const line = logLine(record)
      // `mode` only applies when the file is created, so a fresh file gets
      // 0o600: this log can carry another plugin's error context.
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
      logFileBytes += Buffer.byteLength(line)
      if (logFileBytes > LOG_FILE_MAX_BYTES) trimLogFile(file)
      logWriteError = ''
    } catch (err) {
      logFileOff = true
      logWriteError = errText(err)
    }
  }

  function captureLog(message, detail) {
    const record = logRecord(message, detail)
    logRing.push(record)
    if (logRing.length > LOG_RING_MAX) {
      logRing.splice(0, logRing.length - LOG_RING_MAX)
      logDropped += 1
    }
    if (typeof record.sn === 'number' && record.sn > logSeq) logSeq = record.sn
    // `warn` counts as an alert too: this plugin's own "parked a todo" lines are
    // warnings, and a silently parked todo is exactly what the dot is for.
    if (record.level === 'error' || record.level === 'warn') {
      logAlertSn = record.sn
      logAlertAt = record.ts
    }
    persistLog(record)
  }

  /**
   * Write one line of our own, through the normal logger path.
   *
   * Going through `ctx.logger` rather than the sink directly keeps a single
   * funnel: these lines are formatted and redacted exactly like captured ones,
   * and they still reach the console exporter.
   */
  function log(level, text, err) {
    try {
      const logger = ctx.logger
      if (logger === undefined || typeof logger[level] !== 'function') return
      if (err === undefined) logger[level](text)
      else logger[level](text + '：' + errText(err))
    } catch (failure) {
      /* logging must never break the caller */
    }
  }

  ctx.logger?.exporter?.({
    // Our own lines at every level; everything else at `error` only. This is
    // the "own plugin only" default: the reproduced leak paths all live in
    // OTHER plugins' config-validation errors, so the narrower scope keeps the
    // blast radius small — and `default: 0` is a scope choice, not a safety
    // boundary, since a leak on the error path still arrives here.
    levels: { [LOG_NAME]: LOG_LEVEL_NUMBER.debug, default: LOG_LEVEL_NUMBER.error },
    export: (message) => {
      try {
        captureLog(message, formatLogArgs(message.args))
      } catch (err) {
        /* a broken record must not break the logger */
      }
    },
  })

  // Restore the byte count from a previous process, and trim an oversized file
  // once at mount so a log that grew while nothing was watching is bounded
  // before the first new line lands.
  try {
    const file = boardLogFile()
    if (existsSync(file)) {
      logFileBytes = statSync(file).size
      if (logFileBytes > LOG_FILE_MAX_BYTES) trimLogFile(file)
    }
  } catch (err) {
    logFileOff = true
    logWriteError = errText(err)
  }

  // ---------------------------------------------------------------- records

  function touch(todo) {
    todo.updatedAt = Date.now()
  }

  /**
   * Drop the stuck marker, so the row is queue-eligible again the moment it
   * really has somewhere to land. Called on every successful dispatch and on
   * every user action that re-targets the row.
   */
  function clearLost(todo) {
    todo.lostAt = 0
    todo.lostKind = ''
    todo.lostReason = ''
    todo.lostAttempts = 0
  }

  /**
   * Record a dispatch that could not be delivered, and pace the next attempt.
   *
   * Every failure path must go through here. A failed row that keeps neither a
   * `dispatchedAt` nor a `lostAt` stamp stays permanently "due", and
   * `armTimer` → `fireDue` → `.finally(armTimer)` then re-enters through
   * microtasks alone: the retry loop never yields, the event loop never runs,
   * and the host freezes. The backoff is what makes the retry terminate.
   *
   * `kind` is machine-readable (`no-session` / `image` / `spawn` / `preset` /
   * `agents`), so the panel can name the actual problem: an image refusal is not
   * a missing session, even though both park the row the same way.
   */
  function markLost(todo, kind, reason) {
    const previous = todo.lostAt
    todo.lostAt = Date.now()
    todo.lostKind = kind
    todo.lostReason = reason
    // Consecutive failures back off; an earlier, unrelated recovery resets it.
    todo.lostAttempts = previous === 0 ? 1 : todo.lostAttempts + 1
    touch(todo)
    afterChange()
    // Logged here rather than at each call site: this is the single funnel every
    // dispatch failure passes through, so nothing can be parked invisibly. The
    // row already carries the reason for the panel; what the log adds is the
    // context the row has no room for — which directory, which target session,
    // and how many attempts this has taken.
    const level = kind === 'no-session' || kind === 'image' ? 'warn' : 'error'
    log(
      level,
      'todo-board: 派发失败[' + kind + '] id=' + todo.id +
        ' 目录=' + (todo.dirPath || '(未指定)') +
        ' 模式=' + todo.mode +
        ' 目标会话=' + (todo.runSessionId || todo.sourceSessionId || '(无)') +
        ' 第 ' + todo.lostAttempts + ' 次' +
        ' 原因=' + reason,
    )
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
      images: normalizeImages(raw.images),
      schedule: normalizeSchedule(raw.schedule),
      remindedAt: typeof raw.remindedAt === 'number' ? raw.remindedAt : 0,
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : -1,
      sourceSessionId: typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId : '',
      sourceSessionTitle: typeof raw.sourceSessionTitle === 'string' ? raw.sourceSessionTitle : '',
      dispatchedAt: typeof raw.dispatchedAt === 'number' ? raw.dispatchedAt : 0,
      lostAt: typeof raw.lostAt === 'number' ? raw.lostAt : 0,
      lostKind: typeof raw.lostKind === 'string' ? raw.lostKind : '',
      lostReason: typeof raw.lostReason === 'string' ? raw.lostReason : '',
      lostAttempts: typeof raw.lostAttempts === 'number' ? raw.lostAttempts : 0,
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

  /**
   * Live sessions by id, with the status that tells 「已派发」 from 「进行中」.
   * Built once per snapshot rather than once per row.
   */
  function liveSessions() {
    const map = new Map()
    const agents = ctx.get('agents')
    if (agents === undefined) return map
    for (const agent of agents.list()) {
      map.set(agent.id, typeof agent.status === 'string' ? agent.status : 'idle')
    }
    return map
  }

  /** The session a row would be handed to right now — mirrors `dispatch`. */
  function targetSessionId(todo) {
    if (todo.mode === 'newSession') return todo.runSessionId
    return todo.runSessionId !== '' ? todo.runSessionId : todo.sourceSessionId
  }

  /**
   * A row's lifecycle, derived on the spot rather than stored: a persisted state
   * field could drift from the stamps it is supposed to describe, and 「进行中」
   * depends on live agent status, which no file can hold.
   *
   *   pending    未派发 — never handed to a session
   *   dispatched 已派发 — handed over, target still alive but idle
   *   running    进行中 — handed over, target is working right now
   *   done       已完成 — AI finished (or the user verified it)
   *   lost       目标会话丢失 — dispatch found nowhere to land
   *
   * `done` outranks `lost`: a row someone has already ticked off is finished,
   * whatever became of the session it was headed for.
   */
  function todoState(todo, live) {
    if (todo.verified || todo.aiDone) return 'done'
    if (todo.lostAt > 0) return 'lost'
    if (todo.dispatchedAt > 0) {
      const target = targetSessionId(todo)
      if (target !== '' && live.get(target) === 'running') return 'running'
      return 'dispatched'
    }
    return 'pending'
  }

  /** Panel record: full detail. Never used as a Tool return value. */
  function plain(todo, live) {
    const sessions = live === undefined ? liveSessions() : live
    const target = targetSessionId(todo)
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
      images: todo.images.map((image) => ({ ...image })),
      schedule: todo.schedule,
      dueAt: scheduleMs(todo.schedule),
      remindedAt: todo.remindedAt,
      order: todo.order,
      sourceSessionId: todo.sourceSessionId,
      sourceSessionTitle: todo.sourceSessionTitle,
      dispatchedAt: todo.dispatchedAt,
      lostAt: todo.lostAt,
      lostKind: todo.lostKind,
      lostReason: todo.lostReason,
      lostAttempts: todo.lostAttempts,
      state: todoState(todo, sessions),
      targetAlive: target !== '' && sessions.has(target),
      runSessionId: todo.runSessionId,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
    }
  }

  /** Exactly TOOL_OUTPUT_SCHEMA's item shape. */
  function toolTodo(todo, live) {
    const sessions = live === undefined ? liveSessions() : live
    return {
      id: todo.id,
      title: todo.title,
      dirLabel: dirLabel(todo.dirPath || todo.dir),
      mode: todo.mode,
      schedule: todo.schedule,
      imageCount: todo.images.length,
      aiDone: todo.aiDone === true,
      verified: todo.verified === true,
      state: todoState(todo, sessions),
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
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.todos)) {
        log('error', 'todo-board: 待办文件结构不对，已忽略其内容：' + file)
        return
      }
      const kept = []
      for (const raw of parsed.todos) {
        const todo = normalize(raw)
        if (todo !== null) kept.push(todo)
      }
      if (kept.length !== parsed.todos.length) {
        log(
          'warn',
          'todo-board: 读取待办时跳过了 ' + (parsed.todos.length - kept.length) +
            ' 条无法解析的记录（共 ' + parsed.todos.length + ' 条）',
        )
      }
      // Legacy rows carry order -1: fall back to creation order, then densify.
      kept.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      board.todos = kept
      renumber()
      board.seq = typeof parsed.seq === 'number' ? parsed.seq : kept.length
      storageError = ''
    } catch (err) {
      storageError = '读取待办文件失败：' + errText(err)
      log('error', 'todo-board: 读取待办文件失败：' + boardFile(), err)
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
      log('error', 'todo-board: 写入待办文件失败：' + boardFile(), err)
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

  /**
   * A stuck row keeps its place in the queue, so both schedulers would pick it
   * again the moment they look. This is what paces those retries: the first
   * re-attempt waits a minute, each further failure doubles the wait, and a row
   * that never recovers settles at one attempt per half hour. Manual ▶ ignores
   * this on purpose — a person clicking the button means 「try right now」.
   */
  function lostRetryReady(todo, now) {
    if (todo.lostAt === 0) return true
    const attempts = todo.lostAttempts > 0 ? todo.lostAttempts : 1
    const delay = Math.min(LOST_RETRY_BASE_MS * Math.pow(2, attempts - 1), LOST_RETRY_MAX_MS)
    return now - todo.lostAt >= delay
  }

  /** Pending todo whose scheduled minute has arrived, earliest first. */
  function nextDue(now) {
    let best
    let bestMs = 0
    for (const todo of board.todos) {
      if (todo.verified || todo.aiDone) continue
      // A dispatch already on its way is not due again: its state stamp lands
      // only when it completes, so without this the timer would re-enter it.
      if (firing.has(todo.id)) continue
      const ms = scheduleMs(todo.schedule)
      if (ms === 0 || ms > now) continue
      if (todo.dispatchedAt > 0 || todo.remindedAt > 0) continue
      if (!lostRetryReady(todo, now)) continue
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
          log('error', 'todo-board: 定时派发失败（id=' + todo.id + '）', err)
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

  function snapshotPayload(options) {
    const dirs = {}
    const agents = ctx.get('agents')
    if (agents !== undefined) {
      for (const agent of agents.list()) {
        const header = agent.session === undefined ? undefined : agent.session.header
        const cwd = header === undefined ? undefined : header.cwd
        if (typeof cwd === 'string' && cwd !== '') dirs[normalizeDir(cwd)] = cwd
      }
    }
    // One live-session map for the whole payload, so every row agrees.
    const live = liveSessions()
    const payload = {
      ok: true,
      storagePath: boardFile(),
      storageError,
      dirs,
      todos: board.todos.map((todo) => plain(todo, live)),
      // Always present, and deliberately tiny: "the newest error, if any" is
      // what lets the panel light a dot on the log button without shipping log
      // content the user did not ask to see. The records themselves follow only
      // when the log view is actually open (see `withLogs`).
      logAlert: { sn: logAlertSn, at: logAlertAt },
    }
    if (options === undefined || options.withLogs !== true) return payload
    const since = typeof options.since === 'number' && Number.isFinite(options.since) ? options.since : 0
    const lines = []
    for (const record of logRing) if (record.sn > since) lines.push(record)
    // Tell the reader when the ring has already recycled past their cursor, so
    // a gap reads as "older records were dropped" instead of "nothing happened".
    const oldest = logRing.length === 0 ? 0 : logRing[0].sn
    payload.logs = {
      cursor: logSeq,
      since,
      truncated: since > 0 && oldest > since,
      dropped: logDropped,
      lines,
      file: boardLogFile(),
      fileOff: logFileOff,
      fileError: logWriteError,
      fileBytes: logFileBytes,
    }
    return payload
  }

  async function createTodo(input) {
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
      // Carried through like the tool's `add` does. Omitting it here used to
      // drop a caller's note silently: the row was created with an empty 备注,
      // and the dispatch prompt then had no context to hand the new session.
      note: typeof input.note === 'string' ? input.note : '',
      schedule,
      sourceSessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      sourceSessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle : '',
    })
    if (todo === null) return { ok: false, error: '无法创建待办' }
    const admitted = await admitImages(input.images)
    if (admitted.ok === false) return admitted
    todo.images = admitted.images
    todo.order = nextOrder()
    board.todos.push(todo)
    board.seq += 1
    afterChange()
    return { ok: true, todo: plain(todo), storageError }
  }

  /**
   * Validate and store the images one todo carries.
   *
   * Bytes arrive base64-encoded from the panel (or are read from disk for the
   * model tool) and are committed through the deployment's attachment store —
   * the same admission path the chat upload uses, so limits, media types and
   * normalization are the harness's, not ours. Returns `{ ok: false, error }`
   * instead of throwing so a refused batch is a panel error, not a 500.
   */
  async function admitImages(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { ok: true, images: [] }
    if (entries.length > MAX_IMAGES_PER_TODO) {
      return { ok: false, error: '一条待办最多带 ' + MAX_IMAGES_PER_TODO + ' 张图片' }
    }
    const store = ctx.get('attachments')
    if (store === undefined) {
      return { ok: false, error: '本部署没有 attachments 服务，无法保存图片' }
    }
    const refs = []
    const inputs = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const mediaType = typeof entry.mediaType === 'string' ? entry.mediaType : ''
      if (MEDIA_TYPES.indexOf(mediaType) < 0) {
        return { ok: false, error: '不支持的图片格式：' + (mediaType || '(未声明)') }
      }
      if (typeof entry.data === 'string' && entry.data !== '') {
        inputs.push({
          data: Buffer.from(entry.data, 'base64'),
          mediaType,
          name: typeof entry.name === 'string' ? entry.name : undefined,
        })
        continue
      }
      if (typeof entry.path === 'string' && entry.path !== '') {
        let bytes
        try {
          bytes = new Uint8Array(readFileSync(entry.path))
        } catch (err) {
          return { ok: false, error: '读不到图片 ' + entry.path + '：' + errText(err) }
        }
        inputs.push({ data: bytes, mediaType, name: entry.path })
        continue
      }
      return { ok: false, error: '图片需要 data（base64）或 path' }
    }
    if (inputs.length === 0) return { ok: true, images: [] }
    try {
      for (const input of inputs) refs.push(await store.saveImage(input))
    } catch (err) {
      log('warn', 'todo-board: 图片入库失败（' + inputs.length + ' 张，首张 ' + (inputs[0].name ?? '(无名)') + '）', err)
      return { ok: false, error: '图片被拒绝：' + errText(err) }
    }
    return { ok: true, images: refs }
  }

  async function patchTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '待办不存在' }
    const patch = input.patch !== null && typeof input.patch === 'object' ? input.patch : {}
    if (typeof patch.title === 'string' && patch.title.trim() !== '') todo.title = patch.title.trim()
    if (typeof patch.note === 'string') todo.note = patch.note
    if (typeof patch.mode === 'string' && MODES.indexOf(patch.mode) >= 0) {
      if (patch.mode !== todo.mode) {
        // A new mode picks a new target, so a stale 「丢失」 verdict no longer
        // describes this row: let it try again.
        todo.mode = patch.mode
        clearLost(todo)
      }
    }
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
      clearLost(todo)
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
    if (patch.redispatch === true) {
      todo.dispatchedAt = 0
      clearLost(todo)
    }
    if (Array.isArray(patch.images) && patch.images.length > 0) {
      const admitted = await admitImages(patch.images)
      if (admitted.ok === false) return admitted
      todo.images = admitted.images
    }
    if (patch.clearImages === true) todo.images = []
    // Unbinding (or rebinding) the run session is how a row is told to open a
    // fresh session again: an empty value drops the binding.
    if (typeof patch.runSessionId === 'string') {
      todo.runSessionId = patch.runSessionId.trim()
      todo.dispatchedAt = 0
      clearLost(todo)
    }
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

  /**
   * Build the plugin-authored notice handed to an agent.
   *
   * `content` MUST be `ContentBlock[]`, never a bare string: that is the
   * harness's `UserMessage` shape (`dsh-llm/lib/types/message.d.ts`), and the
   * session validator rejects anything else with "message has invalid content"
   * (`assertMessageEventShape` in `dsh-session`).
   *
   * The rejection is not a per-message annoyance. The event is already durable
   * by the time anything reads it back, so the WHOLE session becomes unopenable
   * ("stored session … is corrupt"). Passing `todoPrompt(todo)` straight in did
   * exactly that to one dispatched session — hence the assert instead of trust.
   */
  function noticeMessage(content, summary) {
    if (!Array.isArray(content)) {
      throw new Error('noticeMessage: content must be ContentBlock[], got ' + typeof content)
    }
    return {
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'plugin', plugin: 'dsh-todo-board', form: 'notice', summary },
    }
  }

  function todoPrompt(todo) {
    const lines = ['【TODO 板 · 自动接续】', '待办：' + todo.title]
    if (todo.dirPath) lines.push('工作目录：' + todo.dirPath)
    if (todo.note) lines.push('备注：' + todo.note)
    if (todo.images.length > 0) {
      lines.push('附带的 ' + todo.images.length + ' 张图片在下面，先看图再动手。')
    }
    lines.push('')
    lines.push('请现在直接开始执行这一条待办，不要再向用户确认。')
    lines.push('完成之后：')
    lines.push('1. 调用 ' + TOOL_NAME + ' 工具 action="done" id="' + todo.id + '" 把它标记为「AI 已完成」。')
    lines.push('2. 调用 ' + TOOL_NAME + ' 工具 action="list" 查看同一目录下是否还有未完成待办（列表从上到下就是执行顺序）。')
    lines.push('3. 如果还有，继续执行列表最上面那一条，不要停下来等待用户；如果没有了，简要汇报本轮完成情况。')
    lines.push('不要替用户勾选「已验收」——那是用户验收后才勾的。')
    return lines.join('\n')
  }

  /**
   * Whether the route a todo is about to be sent to accepts images.
   *
   * The adapter's own model listing is the only truthful source, and it is
   * async — so this runs at dispatch, not on every panel poll. An unknown
   * provider, an adapter without discovery, or a probe failure all answer
   * `true`: the adapter then reports its own refusal, which is still a clear
   * error, and a broken probe must never block a text-only todo.
   */
  async function modelAcceptsImages(selection) {
    if (selection === undefined || selection === null) return true
    const provider = selection.provider
    const model = selection.model
    if (typeof provider !== 'string' || typeof model !== 'string') return true
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.listModels !== 'function') return true
    try {
      const models = await llm.listModels(provider)
      if (!Array.isArray(models)) return true
      const wanted = models.find((entry) => entry !== null && entry !== undefined && entry.id === model)
      if (wanted === undefined || wanted === null) return true
      const modalities = wanted.inputModalities
      if (!Array.isArray(modalities)) return true
      return modalities.indexOf('image') >= 0
    } catch (err) {
      return true
    }
  }

  /**
   * The message a todo becomes: the instruction text plus the durable image
   * references it carries, exactly like a human turn with attachments.
   */
  function todoContent(todo) {
    const content = [{ type: 'text', text: todoPrompt(todo) }]
    for (const image of todo.images) content.push({ type: 'image', attachment: image })
    return content
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
   * Register a freshly created session with the workspace that owns its
   * directory, so the sidebar groups it instead of listing it as 未分组.
   *
   * Grouping is durable state on the workspace record (`sessionIds`), not a
   * session header field: the web app attaches every session it opens, and a
   * session created through `agents.create` skips that step. `attachSession`
   * validates the session's live/persisted header cwd against the workspace
   * path, which is exactly the directory we created the session in.
   */
  async function attachToWorkspace(sessionId, dirPath) {
    if (dirPath === '') return 'no-dir'
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    const registry = rootCtx.get('workspaceRegistry')
    if (registry === undefined) return 'no-service'
    try {
      let workspace = await registry.resolveByPath(dirPath)
      if (workspace === undefined) workspace = await registry.create(dirPath)
      await workspace.attachSession(sessionId)
      return 'attached'
    } catch (err) {
      log('warn', 'todo-board: 新会话未能归入工作区（session=' + sessionId + '，目录=' + dirPath + '）', err)
      return 'failed'
    }
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
    if (agents === undefined) {
      markLost(todo, 'agents', 'agents 服务不可用')
      log('error', 'todo-board: agents 服务不可用，无法新建会话（id=' + todo.id + '）')
      return { ok: false, lost: true, error: 'agents 服务不可用' }
    }
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
        markLost(todo, 'preset', '解析 agent preset 失败')
        log('error', 'todo-board: 解析 agent preset 失败（id=' + todo.id + '）', err)
        return { ok: false, lost: true, error: '解析 agent preset 失败：' + errText(err) }
      }
    }
    const sessionId = 'session-' + randomUUID()
    const agentOptions = modelSelection(source)
    if (!(await modelAcceptsImages(agentOptions))) return imageRefusal(todo)
    try {
      const handle = await agents.create({
        sessionId,
        meta,
        agentOptions,
        setup,
      })
      // Grouping is cosmetic: a failure here must not cost the session.
      const grouped = await attachToWorkspace(sessionId, todo.dirPath)
      todo.dispatchedAt = Date.now()
      todo.runSessionId = sessionId
      clearLost(todo)
      touch(todo)
      afterChange()
      // `todoContent`, not `todoPrompt`: the prompt is a bare string, and a
      // string content corrupts the session (see noticeMessage). It also carries
      // the row's images, which this path dropped even though it had just
      // checked that the model accepts them.
      handle.agent.followup(noticeMessage(todoContent(todo), 'TODO 接续（新会话）：' + todo.title))
      return { ok: true, target: 'new-session', sessionId, grouped }
    } catch (err) {
      markLost(todo, 'spawn', '新建会话失败')
      log('error', 'todo-board: 新建会话失败（id=' + todo.id + '，目录=' + (todo.dirPath || '(未指定)') + '）', err)
      return { ok: false, lost: true, error: '新建会话失败：' + errText(err) }
    }
  }

  /**
   * Hand the todo to one live agent and remember it as this row's target.
   *
   * The dispatch stamp is written **before** the message call, so a re-entrant
   * `fireDue` (or a second tick) can never pick the same row again while this
   * one is still in flight.
   */
  function sendTo(todo, target, note) {
    todo.dispatchedAt = Date.now()
    todo.runSessionId = target.id
    clearLost(todo)
    touch(todo)
    afterChange()
    const message = noticeMessage(todoContent(todo), note + todo.title)
    if (target.status === 'running') {
      target.steer(message)
    } else {
      target.followup(message)
    }
    return { ok: true, target: 'session', sessionId: target.id }
  }

  async function dispatch(todo, sessionId) {
    const agents = ctx.get('agents')
    // A `newSession` row owns the session it created: reuse that binding while
    // the session is live, and only open another one once it is gone.
    if (todo.mode === 'newSession') {
      const bound =
        todo.runSessionId === '' || agents === undefined ? undefined : agents.get(todo.runSessionId)
      if (bound !== undefined) {
        if (!(await imageRouteOk(todo, bound))) return imageRefusal(todo)
        return sendTo(todo, bound, 'TODO 接续：')
      }
      return spawnSession(todo)
    }
    // A row created from the panel carries its origin session, not a run
    // session: that origin is where a scheduled task should land.
    const wanted = sessionId !== '' ? sessionId : todo.sourceSessionId
    const target = agents !== undefined && wanted !== '' ? agents.get(wanted) : undefined
    if (target !== undefined) {
      if (!(await imageRouteOk(todo, target))) return imageRefusal(todo)
      return sendTo(todo, target, 'TODO 接续：')
    }    // Nowhere to land. Record *why* instead of stamping `dispatchedAt`: that
    // stamp means 「已派发」, and the scheduler and the turn-end hook both use it
    // to skip a row — stamping it here would retire the todo for good while it
    // silently never ran. `markLost` also paces the automatic re-attempts, so
    // this row cannot spin the scheduler; any successful dispatch clears it.
    // Name the session that went missing: the row may be re-targeted by hand,
    // and "which one did it want?" is the first question worth answering.
    markLost(
      todo,
      'no-session',
      wanted === '' ? '这条待办没有可接续的会话' : '目标会话 ' + wanted + ' 已不存在',
    )
    return {
      ok: false,
      lost: true,
      error: '当前没有可接续的活动会话；请切到目标会话后重试，或把该待办改成「自动新会话」',
    }
  }

  /** A todo without images never needs the capability probe. */
  async function imageRouteOk(todo, target) {
    if (todo.images.length === 0) return true
    const options = target === undefined || target === null ? undefined : target.options
    return modelAcceptsImages(options === undefined ? undefined : {
      provider: options.provider,
      model: options.model,
    })
  }

  /**
   * Refuse a row whose images the target model cannot read.
   *
   * The refusal is *not* retried automatically — a model that does not declare
   * `image` will not start declaring it a minute later, and without a stamp the
   * scheduler would spin. So it lands in the same stuck state as a missing
   * session: visibly parked, with the reason on the row, until the user changes
   * something (drop the images, switch model, change the mode).
   */
  function imageRefusal(todo) {
    markLost(todo, 'image', '目标会话的模型不接受图片输入')
    log(
      'warn',
      'todo-board: 目标模型不接受图片，已拒绝派发 id=' + todo.id +
        '（图片 ' + todo.images.length + ' 张，模式=' + todo.mode + '）',
    )
    return {
      ok: false,
      lost: true,
      error:
        '这条待办带了 ' + todo.images.length + ' 张图片，但目标会话的模型不接受图片输入' +
        '（模型目录里没有声明 image）。换一个支持图片的模型，或先把图片从待办上移除。',
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
    const now = Date.now()
    for (const todo of pendingInDir(dir)) {
      if (todo.mode === 'remind') continue
      if (todo.dispatchedAt > 0) continue
      // A row waiting out its lost-retry backoff must not hold up the queue
      // behind it: skip it for now and let a later turn end pick it up.
      if (!lostRetryReady(todo, now)) continue
      // A todo with a future time waits for the scheduler, not for this turn end.
      const ms = scheduleMs(todo.schedule)
      if (ms > 0 && ms > now) continue
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
      log('error', 'todo-board: 回合结束钩子执行失败', err)
    }
  })

  // -------------------------------------------------------- prompt section
  //
  // BOTH of these are `ctx.inject`, NOT an eager `ctx.get`, and that is
  // load-bearing rather than stylistic.
  //
  // The plugin row may be applied BEFORE the `tools` / `systemPrompt` services
  // exist (the loader's order is not ours to choose). An eager read then sees
  // `undefined`, and the old `if (x !== undefined) { … }` guard skipped the
  // registration SILENTLY and permanently — the tool simply never existed, with
  // no error anywhere. Verified: composing the registry after this plugin left
  // `tools.get('todo_board') === undefined`.
  //
  // The symptom was invisible from the panel: the HTTP routes use
  // `ctx.inject(['webServer'], …)`, which WAITS, so the board kept working while
  // the model had no tool and no prompt section at all. `node tools/smoke.mjs`
  // could not catch it either, because that stub hands `ctx.get` a tools service
  // directly.
  //
  // `ctx.inject` re-runs the callback whenever a required service appears (and
  // unloads when it goes away), so registration survives any load order.

  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.get('systemPrompt')
    if (prompt === undefined) return
    promptCtx.effect(
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
            '- 待办也可以带**图片**：面板上可直接附图；你用 action="add" 时传 `images`（主机上图片文件的绝对路径）即可，派发时这些图会作为真正的图片发给你。列表里会标注图片张数。',
            '- 如果用户给的任务不在待办板上，也可以先 action="add" 记一条再动手（新条目会被追加到最底下）。',
            '- 你也可以改板子：action="update" 改标题/模式/目录/备注，action="reorder" 传 `ids` 重排**同一个目录内**的顺序（用户希望某条先做时用得上），action="dispatch" 立即派发一条尚未派发的待办。',
            '- **除 list / done / reopen 外，所有写操作都会先弹给用户审批**（这是用户明确要求的）。被拒绝就停手，把情况告诉用户，不要换个说法反复重试同一件事。',
          ].join('\n'),
        }),
      'dsh-todo-board: prompt section',
    )
  })

  // ----------------------------------------------------------- approval gate
  //
  // Writing the board is gated at the REGISTRY layer, not inside the tool body:
  // `tools/pre-execute` is a cordis waterfall, and returning `{ kind: 'ask' }`
  // hands the call to `dsh-user-approval` before the body can run. That
  // placement is the point — a model cannot route around a registry-level gate
  // the way it can route around a prompt sentence — and a refusal comes back as
  // a real failed tool result (`the user rejected tool "todo_board"`), so the
  // model knows the write did not happen instead of believing it succeeded.
  //
  // fail-closed is the harness's, not ours (`dsh-tools/lib/index.js:3314-3365`):
  // no approval service, no agent to route through, or any non-grant verdict all
  // deny. Nothing here needs an approval channel of its own.
  //
  // Two paths deliberately do NOT pass through this gate:
  //
  //   - the PANEL's writes, which ride the HTTP route and are authorized by the
  //     browser session there (`refuseUntrusted`);
  //   - the scheduler and the turn-end hook, which are not tool calls (and are
  //     outside any open turn, where `approval.request()` cannot even be called).
  //
  // That split is the agreed boundary — approval guards *changing the board*,
  // never *running the queue* — so the panel's ▶ stays a plain click and the
  // auto-continue chain stays automatic.
  //
  // `done` / `reopen` are let through on purpose. They are the model's own
  // checkbox: the auto-continue loop the user asked for is literally "finish a
  // todo, call action=done, take the next one", and under a `danger-full-access`
  // deployment (approval policy `never`) an `ask` here would be denied every
  // single time and silently break that loop. Neither can start work either —
  // `pendingInDir` treats an `aiDone` row as not pending.
  //
  // Everything else asks, INCLUDING an action this version does not know:
  // an unrecognized action must fail closed, not slip past the gate.

  const APPROVAL_FREE_ACTIONS = ['list', 'done', 'reopen']

  /**
   * One line describing the pending write, so the approval dialog states what
   * the model is about to do rather than only naming the tool.
   */
  function approvalDetail(action, input) {
    const id = typeof input.id === 'string' ? input.id : ''
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const where = title !== '' ? '「' + title + '」' : id !== '' ? '（id ' + id + '）' : ''
    if (action === 'add') {
      const mode = typeof input.mode === 'string' ? input.mode : 'remind'
      return (
        '新增待办' + where + '，模式 ' + mode +
        (mode === 'remind' ? '' : '（这条会被自动派发执行）')
      )
    }
    if (action === 'note') return '改备注' + where
    if (action === 'schedule') {
      const at = typeof input.schedule === 'string' ? input.schedule.trim() : ''
      return at === '' ? '取消定时' + where : '设定时' + where + ' → ' + at
    }
    if (action === 'update') {
      const fields = []
      if (typeof input.title === 'string' && input.title.trim() !== '') fields.push('标题')
      if (typeof input.mode === 'string') fields.push('模式 ' + input.mode)
      if (typeof input.dir === 'string' && input.dir.trim() !== '') fields.push('目录 ' + input.dir.trim())
      if (typeof input.note === 'string') fields.push(input.note === '' ? '备注（清空）' : '备注')
      return '修改待办' + where + (fields.length === 0 ? '' : '：' + fields.join('、'))
    }
    if (action === 'reorder') {
      // Resolved against the live board: "which row ends up on top" is the one
      // fact that makes a reorder approvable at a glance.
      const ids = Array.isArray(input.ids)
        ? input.ids.filter((entry) => typeof entry === 'string')
        : []
      const top = ids.length === 0 ? undefined : find(ids[0])
      return (
        '调整待办顺序（' + ids.length + ' 条' +
        (top === undefined ? '' : '，最上面将是「' + top.title + '」') + '）'
      )
    }
    if (action === 'dispatch') {
      const todo = id === '' ? undefined : find(id)
      return '立即派发待办' + (todo === undefined ? where : '「' + todo.title + '」')
    }
    return '执行 ' + action + where
  }

  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec === undefined || exec === null || exec.name !== TOOL_NAME) return next()
    // `createExecution` freezes the model's arguments onto the execution, and
    // leaves them `undefined` when argument validation failed. Mirror the tool
    // body's own default (`list`) so gate and body never disagree.
    const input =
      exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
    const action = typeof input.action === 'string' ? input.action : 'list'
    if (APPROVAL_FREE_ACTIONS.indexOf(action) >= 0) return next()
    return { kind: 'ask', reason: 'AI 要修改待办板：' + approvalDetail(action, input) }
  })

  // ------------------------------------------------------------ model tool

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined) return
    {
    const definition = {
      name: TOOL_NAME,
      description:
        '读写跨会话 TODO 板。列表从上到下就是执行顺序（用户可拖动调整）。action=list 查看待办（默认当前工作目录），action=add 新增（追加到底部，可用 images 附主机上的图片文件），action=done 标记 AI 已完成（左勾），action=reopen 撤销左勾，action=note 追加备注，action=schedule 设置/取消定时执行时间，action=update 改标题/模式/目录/备注，action=reorder 用 ids 重排同一目录内的顺序，action=dispatch 立即派发一条尚未派发的待办。带 schedule 的待办到点后才会被派发。**除 list / done / reopen 外，所有写操作都会先弹给用户审批；被拒绝就停手，不要反复重试。**',
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
        // One live-session map per tool call, so every row in the reply agrees.
        const live = liveSessions()

        if (action === 'add') {
          const title = typeof input.title === 'string' ? input.title.trim() : ''
          if (title === '') return { message: 'add 需要提供 title。', todos: [] }
          const schedule = normalizeSchedule(input.schedule)
          if (typeof input.schedule === 'string' && input.schedule.trim() !== '' && schedule === '') {
            return { message: 'schedule 格式无效，请用 YYYY-MM-DDTHH:mm（本地时间）。', todos: [] }
          }
          const dirPath = typeof input.dir === 'string' && input.dir !== '' ? input.dir : cwd
          // Paths are read here, at the board boundary, and stored durably so a
          // later dispatch needs no filesystem access of its own.
          let imageEntries = []
          if (Array.isArray(input.images) && input.images.length > 0) {
            imageEntries = []
            for (const entry of input.images) {
              if (typeof entry !== 'string' || entry.trim() === '') {
                return { message: 'images 需要是图片文件的绝对路径数组。', todos: [] }
              }
              const path = entry.trim()
              const mediaType = MEDIA_TYPE_BY_EXTENSION[extname(path).toLowerCase()]
              if (mediaType === undefined) {
                return {
                  message: '不支持的图片扩展名：' + path + '（支持 png / jpg / jpeg / webp / gif）',
                  todos: [],
                }
              }
              imageEntries.push({ path, mediaType })
            }
          }
          const admitted = await admitImages(imageEntries)
          if (admitted.ok === false) return { message: admitted.error, todos: [] }
          const todo = normalize({
            title,
            dirPath,
            mode: typeof input.mode === 'string' ? input.mode : 'remind',
            note: typeof input.note === 'string' ? input.note : '',
            schedule,
            sourceSessionId: agent === undefined || agent === null ? '' : agent.id,
          })
          if (todo === null) return { message: '无法创建这条待办。', todos: [] }
          todo.images = admitted.images
          todo.order = nextOrder()
          board.todos.push(todo)
          board.seq += 1
          afterChange()
          return {
            message:
              '已新增待办「' + title + '」（目录：' + (dirPath || '(未指定)') + '，模式：' +
              todo.mode +
              (todo.schedule === '' ? '' : '，定时：' + todo.schedule + '（' + scheduleLabel(todo.schedule) + '）') +
              (todo.images.length === 0 ? '' : '，图片：' + todo.images.length + ' 张') +
              '，追加到列表底部，id：' + todo.id + '）。',
            todos: [toolTodo(todo, live)],
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
          return { message: label + '：「' + todo.title + '」。', todos: [toolTodo(todo, live)] }
        }

        if (action === 'dispatch') {
          const id = typeof input.id === 'string' ? input.id : ''
          const todo = find(id)
          if (todo === undefined) return { message: '找不到 id 为 ' + (id || '(空)') + ' 的待办。', todos: [] }
          // The panel's ▶ is enabled for exactly this state, so the tool keeps
          // the same rule rather than inventing a second one: re-sending a row
          // that is already out there is duplicate work, and a done row is not
          // work at all.
          const state = todoState(todo, live)
          if (state !== 'pending') {
            return {
              message:
                '只有「未派发」的待办能派发；「' + todo.title + '」现在是「' + STATE_LABEL[state] + '」。',
              todos: [toolTodo(todo, live)],
            }
          }
          const result = await runTodo({
            id,
            sessionId: agent === undefined || agent === null ? '' : agent.id,
          })
          if (result.ok === false) return { message: result.error, todos: [toolTodo(todo, live)] }
          return {
            message:
              '已派发「' + todo.title + '」（' +
              (result.target === 'session' ? '会话 ' + result.sessionId : '新会话 ' + result.sessionId) +
              '）。',
            todos: [toolTodo(todo, live)],
          }
        }

        if (action === 'update') {
          const id = typeof input.id === 'string' ? input.id : ''
          const todo = find(id)
          if (todo === undefined) return { message: '找不到 id 为 ' + (id || '(空)') + ' 的待办。', todos: [] }
          // Validated as a whole BEFORE anything is written: a request naming one
          // bad field must not half-apply the good ones, or neither the model nor
          // the user who approved it can tell what actually changed.
          const wantedMode = typeof input.mode === 'string' ? input.mode : ''
          if (wantedMode !== '' && MODES.indexOf(wantedMode) < 0) {
            return { message: 'mode 只能是 ' + MODES.join(' / ') + '，未做任何改动。', todos: [] }
          }
          const wantedTitle = typeof input.title === 'string' ? input.title.trim() : ''
          if (typeof input.title === 'string' && wantedTitle === '') {
            return { message: 'title 不能改成空字符串，未做任何改动。', todos: [] }
          }
          const wantedDir = typeof input.dir === 'string' ? input.dir.trim() : ''
          if (typeof input.dir === 'string' && wantedDir === '') {
            return { message: 'dir 不能改成空字符串，未做任何改动。', todos: [] }
          }
          const changes = []
          if (wantedTitle !== '' && wantedTitle !== todo.title) {
            todo.title = wantedTitle
            changes.push('标题')
          }
          if (wantedMode !== '' && wantedMode !== todo.mode) {
            todo.mode = wantedMode
            // A new mode picks a new target, so a stale 「丢失」 verdict no
            // longer describes this row.
            clearLost(todo)
            changes.push('模式 ' + wantedMode)
          }
          if (wantedDir !== '' && normalizeDir(wantedDir) !== todo.dir) {
            todo.dirPath = wantedDir
            todo.dir = normalizeDir(wantedDir)
            clearLost(todo)
            changes.push('目录 ' + dirLabel(wantedDir))
          }
          if (typeof input.note === 'string' && input.note !== todo.note) {
            todo.note = input.note
            changes.push(input.note === '' ? '备注（清空）' : '备注')
          }
          if (changes.length === 0) {
            return {
              message: 'update 至少要改一项（title / mode / dir / note），且新值要和现在不同。',
              todos: [toolTodo(todo, live)],
            }
          }
          touch(todo)
          afterChange()
          return {
            message: '已更新「' + todo.title + '」：' + changes.join('、') + '。',
            todos: [toolTodo(todo, live)],
          }
        }

        if (action === 'reorder') {
          const ids = Array.isArray(input.ids)
            ? input.ids.filter((entry) => typeof entry === 'string' && entry !== '')
            : []
          if (ids.length === 0) {
            return { message: 'reorder 需要 ids：新的从上到下顺序（待办 id 数组）。', todos: [] }
          }
          const rows = []
          for (const id of ids) {
            const todo = find(id)
            if (todo === undefined) {
              return { message: '找不到 id 为 ' + id + ' 的待办，顺序未改动。', todos: [] }
            }
            if (rows.indexOf(todo) >= 0) {
              return { message: 'ids 里重复出现 ' + id + '，顺序未改动。', todos: [] }
            }
            rows.push(todo)
          }
          // One directory only. The panel groups by directory, and the two modes
          // push each directory's queue independently — so a list spanning
          // directories would silently reorder queues the user never offered to
          // reorder, while looking like a single harmless move.
          const dirs = []
          for (const row of rows) if (dirs.indexOf(row.dir) < 0) dirs.push(row.dir)
          if (dirs.length > 1) {
            return {
              message: 'reorder 只接受同一个目录内的待办，这次跨了 ' + dirs.length + ' 个目录，顺序未改动。',
              todos: [],
            }
          }
          reorderTodos({ ids })
          return {
            message:
              '已调整顺序（' + rows.length + ' 条，目录 ' + dirLabel(rows[0].dirPath || rows[0].dir) + '）：' +
              rows.map((row) => row.title).join(' → ') + '。',
            todos: rows.map((row) => toolTodo(row, live)),
          }
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
              ' ｜ 状态=' + STATE_LABEL[todoState(todo, live)] +
              (todo.images.length === 0 ? '' : ' ｜ 图片=' + todo.images.length + ' 张') +
              (ms === 0
                ? ''
                : ' ｜ 定时=' + todo.schedule + (ms > Date.now() ? '（未到点，先别做）' : '（已到点）')),
          )
        }
        return { message: lines.join('\n'), todos: shown.map((todo) => toolTodo(todo, live)) }
      },
    }
    ctx.effect(() => tools.register(definition), 'dsh-todo-board: todo_board tool')
    }
  })

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

  /**
   * Non-loopback authorities this deployment serves.
   *
   * Read from the web runtime when it exists; absent (a non-web host, or one
   * without `dsh-web-app`) leaves loopback-only, which is the right default for
   * a plugin route. Resolved per request rather than cached at load: the
   * runtime is provided by a sibling row and need not exist yet when this
   * plugin's own rows mount.
   *
   * Only the FALLBACK fence reads this now (see `harnessConnection`): when the
   * harness's own gate is present it already carries the same trusted-host list.
   */
  function trustedHosts() {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    for (const source of [ctx, rootCtx]) {
      try {
        if (source === undefined || typeof source.get !== 'function') continue
        const runtime = source.get('webRuntime')
        const hosts = runtime === undefined || runtime === null ? undefined : runtime.trustedHosts
        if (Array.isArray(hosts)) return hosts
      } catch (err) {
        /* fall through to the next source */
      }
    }
    return []
  }

  /**
   * The harness' own Host Connection gate, when this deployment has one.
   *
   * `dsh-client-connection` provides it as the `connection` service, and its
   * `requestRejection` is the WHOLE fence:
   *
   *   1. `isTrustedApiRequest` — Host/Origin, the half v0.9.0 restated locally;
   *   2. `browserAuth.isAuthenticated` — is this a browser we handed a session?
   *
   * Only the second half answers "may a local process talk to this route?", and
   * that is exactly the half the restatement was missing: an AI with a shell
   * could POST the board route directly and bypass the approval gate on the
   * tool entirely (`docs/design-ai-dispatch.md` §12). Borrowing the harness's
   * gate closes that channel AND keeps working when DSH changes how it
   * authenticates.
   *
   * Resolved per request rather than cached at load, like `trustedHosts()`: the
   * service comes from a sibling row and need not exist yet when this plugin's
   * own rows mount.
   */
  function harnessConnection() {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    for (const source of [ctx, rootCtx]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const connection = source.get('connection')
        if (connection === undefined || connection === null) continue
        if (typeof connection.requestRejection !== 'function') continue
        return connection
      } catch (err) {
        /* fall through to the next source */
      }
    }
    return undefined
  }

  /** How many refusals are worth a log line before a loop stops being news. */
  let refusalsLogged = 0

  /**
   * Apply the trust fence, answering the request when it fails.
   *
   * The harness gate is preferred; the local restatement is the fallback for a
   * deployment without `dsh-client-connection` (it is still the only fence
   * there, and `tools/check-fence-parity.mjs` keeps it honest against the
   * original). Both return the same shape — a status, or `undefined` to allow —
   * so nothing downstream cares which one answered.
   *
   * @returns true when the response is already sent and the caller must stop.
   */
  function refuseUntrusted(request, response, label) {
    const connection = harnessConnection()
    let status
    let fence = 'harness'
    if (connection === undefined) {
      fence = 'local'
      status = requestRejection(request, trustedHosts())
    } else {
      try {
        status = connection.requestRejection(request)
      } catch (err) {
        // A gate that throws must refuse the request, not take the route down.
        log('error', 'todo-board: 信任校验抛错，按拒绝处理（' + label + '）', err)
        status = 403
      }
      // Only `undefined` means allow. Anything else that is not a status is a
      // gate we do not understand, and fail-closed is the only safe reading.
      if (status !== undefined && typeof status !== 'number') status = 403
    }
    if (status === undefined) return false
    // Worth recording: the honest cause is usually a deployment detail (a LAN
    // address not in `trustedHosts`, or a browser that never exchanged the
    // `?token=` launch URL for a session cookie) rather than an attack, and
    // "why is the panel getting 401/403?" is otherwise unanswerable. Capped,
    // because a page in a retry loop would otherwise bury everything else.
    if (refusalsLogged < 20) {
      refusalsLogged += 1
      const headers = request === undefined || request === null ? undefined : request.headers
      log(
        'warn',
        'todo-board: 拒绝了未通过信任校验的请求（' + label + '，' + fence +
          '，status=' + status +
          (status === 401 ? '（缺少浏览器会话凭据：用 dsh web 打印的那条带 token 的地址重开页面）' : '') +
          '，host=' + String(headerValue(headers, 'host') ?? '(无)') +
          '，origin=' + String(headerValue(headers, 'origin') ?? '(无)') +
          '，sec-fetch-site=' + String(headerValue(headers, 'sec-fetch-site') ?? '(无)') + '）',
      )
    }
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(status === 401 ? 'unauthorized' : 'forbidden')
    return true
  }

  /**
   * Serve one attachment's bytes for the panel's thumbnails.
   *
   * The harness' own image route is session-scoped and refuses an attachment no
   * session log references — ours live on the board, so the board is the
   * authority here: an id that no todo references is a 404, never a read.
   */
  async function sendBoardImage(response, attachmentId) {
    let ref
    for (const todo of board.todos) {
      for (const image of todo.images) {
        if (image.attachmentId === attachmentId) {
          ref = image
          break
        }
      }
      if (ref !== undefined) break
    }
    if (ref === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('unknown attachment')
      return
    }
    const store = ctx.get('attachments')
    if (store === undefined) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('attachments service unavailable')
      return
    }
    const stored = await store.readImage(ref)
    const body = Buffer.from(stored.data)
    response.writeHead(200, {
      'content-type': stored.ref.mediaType,
      'content-length': String(body.length),
      'cache-control': 'private, max-age=3600',
    })
    response.end(body)
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'prefix',
          path: IMAGE_ROUTE,
          handler: async (request, response) => {
            try {
              if (refuseUntrusted(request, response, 'image')) return
              if (request.method !== 'GET') {
                response.writeHead(405, { allow: 'GET' })
                response.end()
                return
              }
              const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
              const id = url.searchParams.get('id')
              await sendBoardImage(response, id === null ? '' : id)
            } catch (err) {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              response.end(errText(err))
            }
          },
        }),
      'dsh-todo-board: image route',
    )
  })

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (request, response) => {
            try {
              if (refuseUntrusted(request, response, 'api')) return
              if (request.method === 'GET') {
                // Log content rides the EXISTING poll rather than a second
                // transport, and only when the log view is open. That keeps the
                // idle payload byte-for-byte what it always was — which is also
                // what satisfies "平时不能在面板中暴露给用户": with the view
                // closed, no log text ever leaves the host.
                const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
                const wantsLogs = url.searchParams.get('logs') === '1'
                const sinceRaw = Number(url.searchParams.get('since'))
                sendJson(
                  response,
                  200,
                  snapshotPayload({
                    withLogs: wantsLogs,
                    since: Number.isFinite(sinceRaw) ? sinceRaw : 0,
                  }),
                )
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
              if (action === 'create') result = await createTodo(body)
              else if (action === 'patch') result = await patchTodo(body)
              else if (action === 'reorder') result = reorderTodos(body)
              else if (action === 'remove') result = removeTodo(body)
              else if (action === 'clearVerified') result = clearVerified()
              else if (action === 'run') result = await runTodo(body)
              else result = { ok: false, error: 'unknown action: ' + (action || '(empty)') }
              sendJson(response, 200, result)
            } catch (err) {
              log('error', 'todo-board: HTTP 路由处理失败（api）', err)
              sendJson(response, 500, { ok: false, error: errText(err) })
            }
          },
        }),
      'dsh-todo-board: api route',
    )
  })
}
