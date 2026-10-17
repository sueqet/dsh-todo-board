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
/**
 * Cap on the container walk in {@link effectiveTarget}.
 *
 * A user can drag A under B and then B under A, so the walk is bounded twice
 * over: a visited set catches direct cycles and this cap catches the deep
 * chains that would otherwise be legal but pointless. A real plan nests one or
 * two deep, so anything past this is a hand-made knot, not a plan.
 */
const MAX_OWNER_DEPTH = 16
/**
 * How many sessions one turn end may open — the DEFAULT of a user setting.
 *
 * A spawn used to end the chain — the fresh session then found the rest of the
 * directory's rows by itself. Now it only owns its own children, so the
 * originating session has to come back for more. Ten is generous for a real
 * plan and still bounded: an unbounded loop here would open sessions in a
 * tight `await` chain while the turn boundary waits on this listener.
 *
 * 0.13.4 made this adjustable (`settings.maxTurnSessions`). The cap matters
 * because `MAX_PLAN_ITEMS` allows a 20-step plan: with the old hardcoded 10, a
 * twenty-step plan of `newSession` rows could only half-dispatch at one turn
 * end, and nothing guaranteed a "next time". The constant stays as the default.
 */
const MAX_TURN_SESSIONS = 10
const ROUTE = '/dsh-todo-board/api'
const IMAGE_ROUTE = '/dsh-todo-board/image'
const TOOL_NAME = 'todo_board'

/** Scheduled todos fire at minute precision, in the host machine's local time. */
const SCHEDULE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
/** Safety net beside the exact timer: a suspended machine never delivers a timeout. */
const SCHEDULE_TICK_MS = 30000
/** Attachments one todo may carry; keeps a prompt from becoming an image dump. */
const MAX_IMAGES_PER_TODO = 4
/**
 * Rows one `add` may create at once.
 *
 * A plan costs ONE approval, which is the whole point of batch creation — but an
 * approval nobody can read is not consent either, so there is a ceiling. Twenty
 * steps is already a long plan; beyond that the honest answer is "two batches",
 * not a wall of text in a dialog.
 */
const MAX_PLAN_ITEMS = 20
/**
 * When the deterministic "this looks multi-stage" nudge fires.
 *
 * BOTH thresholds must hold: a message shorter than this is never a plan, and
 * fewer than this many staged markers is not a staged job. Conservative on
 * purpose — a false positive costs the user one pointless question, but a noisy
 * plugin is one people turn off, which costs them the feature entirely.
 */
const PLAN_NUDGE_MIN_CHARS = 200
const PLAN_NUDGE_MIN_MARKERS = 2

/**
 * The planning nudge's user-facing knobs, and their defaults.
 *
 * These used to be two module constants, which meant "this looks multi-stage"
 * was decided by whoever last edited the source. The thresholds are subjective
 * — a user who writes long briefs gets a false positive every time, one who
 * writes short terse requests never gets the offer at all — and the cost of
 * getting them wrong is not "one extra question": the nudge fires at most ONCE
 * per session (`planningNudged`), so a single bad call spends the session's one
 * chance.
 *
 * So they live on the board now, next to the rows they govern, with the module
 * constants as the defaults. `nudge: false` turns the offer off entirely.
 */
const DEFAULT_SETTINGS = {
  nudge: true,
  minChars: PLAN_NUDGE_MIN_CHARS,
  minEntries: PLAN_NUDGE_MIN_MARKERS,
  maxTurnSessions: MAX_TURN_SESSIONS,
}

/**
 * One stored panel geometry, or `null` when nothing usable was written.
 *
 * Where the user parked the floating card is a PREFERENCE, not session state,
 * so it belongs beside the board rather than in the browser. `localStorage`
 * looked fine until the deployment moved between ports: storage is keyed by
 * ORIGIN, so `127.0.0.1:41012` and `127.0.0.1:25005` are different sites and
 * every restart looked like a first run.
 *
 * `w`/`h` may be `null` — that is the parked line, whose size is decided by CSS
 * (it hugs its own text), not by a stored number.
 */
function normalizeLayout(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const x = finite(raw.x)
  const y = finite(raw.y)
  if (x === null || y === null) return null
  const size = (value) => {
    const n = finite(value)
    return n !== null && n > 0 ? n : null
  }
  return { x, y, w: size(raw.w), h: size(raw.h) }
}
/** Bounds accepted by both the loader and the settings write path. */
const MIN_CHARS_RANGE = { min: 10, max: 10_000 }
const MIN_ENTRIES_RANGE = { min: 1, max: 100 }
/**
 * How many `newSession` containers one turn end may open.
 *
 * `MAX_TURN_SESSIONS` is the default; this is the range a user may set. The
 * lower bound is 1 because 0 would mean "never spawn", which is what mode
 * `remind` already expresses — two ways to say the same thing is one too many.
 * The upper bound is deliberately modest: this loop runs inside the
 * turn-stopping hook that the harness awaits, so a large value turns one turn
 * end into a long stall, and the queue is re-scanned after every spawn anyway.
 */
const MAX_TURN_SESSIONS_RANGE = { min: 1, max: 50 }

/**
 * Coerce one settings field into range, falling back to its default.
 *
 * Every field is independent: one bad value must not discard the ones the user
 * did get right, and a hand-edited `settings` object must never make the whole
 * board unreadable. Returns a fresh object; never mutates its input.
 */
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const clampInt = (value, range, fallback) =>
    Number.isInteger(value) && value >= range.min && value <= range.max ? value : fallback
  return {
    nudge: typeof source.nudge === 'boolean' ? source.nudge : DEFAULT_SETTINGS.nudge,
    minChars: clampInt(source.minChars, MIN_CHARS_RANGE, DEFAULT_SETTINGS.minChars),
    minEntries: clampInt(source.minEntries, MIN_ENTRIES_RANGE, DEFAULT_SETTINGS.minEntries),
    maxTurnSessions: clampInt(
      source.maxTurnSessions,
      MAX_TURN_SESSIONS_RANGE,
      DEFAULT_SETTINGS.maxTurnSessions,
    ),
  }
}
const MEDIA_TYPE_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const MEDIA_TYPES = Object.values(MEDIA_TYPE_BY_EXTENSION)

/**
 * The prompt a user can paste to make the model plan a long task onto the board.
 *
 * ONE definition, three places it is shown: the `/todo` command, the runtime
 * skill's body, and the README. A template that exists twice drifts, and the copy
 * a user pastes is the one nobody tests — so `tools/check-template-parity.mjs`
 * compares this string against the README's fenced block, exactly.
 *
 * It is written as instructions TO THE MODEL, because that is what gets injected.
 */
const PLAN_TEMPLATE = [
  '用 TODO 板把这件事拆成可执行的步骤，然后按顺序做。',
  '',
  '【目标】<一句话说清最终要什么>',
  '【边界】<不要做什么、必须遵守什么>',
  '【完成标准】<怎么算做完；能跑命令/看结果最好>',
  '',
  '拆分要求：',
  '1. 每条一句话、彼此有顺序、能独立验收；一条只交付一件事，别把两件事塞一条；',
  '2. 先给我看拆分结果，我确认后再写进板子；我说改就改；',
  '3. 每条待办的备注（note）里写清：验收标准 + 已知的坑/前置条件；',
  '4. 定好顺序后，用一次 action="add" 的 items 把整份计划写进去（一次审批），不要一条一条建。',
  '',
  '执行要求：',
  '5. 开始后每做完一条，立刻 action="done" 勾成「AI 已完成」，再取同目录下一条继续，不要停下来问我；',
  '6. 中途要加步骤就告诉我，别自己闷着改范围。',
  '',
  '（我没特别说的话：默认拆 3–8 步；建好后用 ask_user_question 问我「就按这个做（立刻开始）／只建清单不开始／我再改改」。）',
].join('\n')

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
    items: {
      type: 'array',
      description:
        'add 时一次创建多条（**拆分长任务/多阶段任务时用这个**）：一次调用、一次审批就写入整份计划，' +
        '顺序即数组顺序。每条可带自己的 title / note / mode / schedule / images / parent；' +
        'parent 填本批次里更靠前那条的下标，用来把后续步骤挂到某个「自动新会话」条目下，' +
        '让它们跟着进入那个新会话。给 items 时外层的 title 等字段被忽略，dir 仍然生效。最多 ' +
        MAX_PLAN_ITEMS + ' 条，**任意一条不合法则整批不写入**。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '这一条待办的内容（一句话，可独立验收）。' },
          note: {
            type: 'string',
            description: '这一条的备注：写给执行会话的上下文，建议写清验收标准与前置条件。',
          },
          mode: { type: 'string', enum: MODES, description: '这一条的执行模式，默认 remind。' },
          parent: {
            type: 'number',
            description:
              '可选：挂到本批次里更靠前的那一条下面，填它的下标（0 起）。父条目是「自动新会话」时，' +
              '它会在父条目开出的新会话里执行；父条目是别的模式时，只作为分组，子条目仍留在当前会话。' +
              '只能指向前面的条目，不能指向自己或后面的条目。',
          },
          schedule: {
            type: 'string',
            description: '这一条的定时执行时间（本地 YYYY-MM-DDTHH:mm），不填即不定时。',
          },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '这一条的图片：主机上图片文件的绝对路径，最多 ' + MAX_IMAGES_PER_TODO + ' 张。',
          },
        },
        required: ['title'],
      },
    },
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
          // Where this row runs. `after` names a container row, so the model can
          // see the tree it just built — and see which container to flip later.
          parentId: { type: 'string' },
        },
        required: [
          'id', 'title', 'dirLabel', 'mode', 'schedule', 'imageCount', 'aiDone', 'verified', 'state',
          'parentId',
        ],
      },
    },
  },
  required: ['message', 'todos'],
}

// -------------------------------------------------------------------- plugin

export function apply(ctx) {
  const board = { version: 1, seq: 0, todos: [], settings: { ...DEFAULT_SETTINGS }, layout: null }
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

  /**
   * Which session runs a row.
   *
   * `session` names a live session outright; an empty id is legitimate and
   * means 「no owner yet」 — a row planned outside any session carries it.
   *
   * `after` names a CONTAINER row and deliberately stores no resolved target.
   * The target is resolved at dispatch time by {@link effectiveTarget}, so
   * flipping a container's mode — the remind planning state becoming
   * newSession — moves its children along with zero cascade rewrites. Storing
   * a resolved target instead would turn every later mode edit, cross-box drag
   * and reparent into a correctness risk in exactly the one place that cannot
   * see the whole subtree.
   *
   * @param raw - the persisted `runIn`, if any.
   * @param sourceSessionId - the row's planner, used only to migrate.
   * @returns A detached, well-formed ownership record.
   */
  function normalizeRunIn(raw, sourceSessionId) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const id = typeof raw.id === 'string' ? raw.id : ''
      if (raw.kind === 'after' && id !== '') return { kind: 'after', id }
      if (raw.kind === 'session') return { kind: 'session', id }
    }
    // Forward migration: a row written before ownership existed ran in the
    // session that planned it. Deriving that here keeps an old board file
    // honest instead of leaving every legacy row unowned. A row that already
    // carries a well-formed `runIn` never reaches this fallback.
    return { kind: 'session', id: sourceSessionId }
  }

  function normalize(raw) {
    if (raw === null || typeof raw !== 'object') return null
    const title = typeof raw.title === 'string' ? raw.title : ''
    if (title === '') return null
    const dirPath =
      typeof raw.dirPath === 'string' ? raw.dirPath : typeof raw.dir === 'string' ? raw.dir : ''
    const sourceSessionId = typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId : ''
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
      sourceSessionId,
      runIn: normalizeRunIn(raw.runIn, sourceSessionId),
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
   * The session that will actually run a row, resolving container ownership.
   *
   * `runIn.kind === 'session'` answers outright. `runIn.kind === 'after'`
   * names a container, and what the answer IS depends on what that container
   * does:
   *
   *   - a `newSession` container opens its own future session, so its children
   *     belong to that session — this is the chain's handoff;
   *   - any other container creates no session. A `remind` container is the
   *     planning state (the shape is settled, nothing runs yet), and a
   *     `resume` row is only grouping. Both simply inherit where the
   *     container itself runs, so they can never orphan their children.
   *
   * Resolving here rather than at write time is the whole point: flipping a
   * container from `remind` to `newSession` moves its entire subtree with no
   * cascade, because no resolved target was ever written down.
   *
   * A container that has not spawned yet answers '' — its children are not
   * eligible anywhere until it does, which is correct rather than pending.
   *
   * @param todo - the row to resolve.
   * @param seen - visited ids, for cycle detection.
   * @param depth - remaining walk budget.
   * @returns The owning session id, or '' when there is none yet.
   */
  /**
 * Whether making `todo` a child of `parentId` would put it inside its own
 * subtree.
 *
 * The walk mirrors {@link effectiveTarget}'s bound: a visited set for direct
 * knots and a depth cap for the deep-but-legal chains. This is checked at the
 * moment of the edit rather than at dispatch, because a cycle the panel lets
 * you build is one the user only discovers when nothing runs.
 */
function wouldCycle(todo, parentId) {
  const guard = new Set([todo.id])
  let cursor = parentId
  for (let depth = 0; depth <= MAX_OWNER_DEPTH; depth++) {
    if (cursor === todo.id) return true
    if (guard.has(cursor)) return false
    guard.add(cursor)
    const parent = find(cursor)
    if (parent === undefined || parent.runIn.kind !== 'after') return false
    cursor = parent.runIn.id
  }
  return true
}

  function effectiveTarget(todo, seen, depth) {
    const guard = seen === undefined ? new Set() : seen
    const level = depth === undefined ? 0 : depth
    if (guard.has(todo.id) || level > MAX_OWNER_DEPTH) return ''
    guard.add(todo.id)
    if (todo.runIn.kind === 'session') return todo.runIn.id
    const parent = find(todo.runIn.id)
    // A container that no longer exists leaves the row with no owner rather
    // than silently reattaching it to whoever happens to be running.
    if (parent === undefined) return ''
    if (parent.mode === 'newSession') {
      return parent.runSessionId !== ''
        ? parent.runSessionId
        : effectiveTarget(parent, guard, level + 1)
    }
    return effectiveTarget(parent, guard, level + 1)
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

  /**
   * The session a row would be handed to right now — mirrors `dispatch`.
   *
   * A row that has already run once still reports where it ran, so the panel can
   * show 「已派发」 against a live session. Before it has run, the answer is its
   * resolved owner — which is NOT always the planner, once the row has been
   * re-parented or its container has spawned.
   */
  function targetSessionId(todo) {
    if (todo.mode === 'newSession') return todo.runSessionId
    if (todo.runSessionId !== '') return todo.runSessionId
    return effectiveTarget(todo)
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
      runIn: { kind: todo.runIn.kind, id: todo.runIn.id },
      // Where the row runs (or has run): a spawned container and a dispatched
      // row report their runSessionId so the session that executes them owns
      // them on the panel. Before a newSession container has spawned the
      // answer is '' (nowhere yet), so fall back to the container walk — the
      // planning session keeps the row until the session it opens exists.
      // pendingOwned/dispatch keep effectiveTarget directly.
      ownerSessionId: target !== '' ? target : effectiveTarget(todo),
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
      // Flattened on purpose: the model reads this far more often than the panel
      // does, and `''` is the honest answer for a row that hangs off nothing.
      parentId: todo.runIn.kind === 'after' ? todo.runIn.id : '',
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
      // Settings arrived after the first boards were written, so an older file
      // simply has no `settings` key — that is a DEFAULT, not an error. A
      // hand-edited or corrupt one degrades per field (see normalizeSettings):
      // one bad number must never cost the user their whole board.
      board.settings = normalizeSettings(parsed.settings)
      // Absent for a board written before the panel had host-side geometry,
      // and that is a DEFAULT (no preference yet), not an error.
      board.layout = normalizeLayout(parsed.layout)
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
   *
   * The destination is the row's RESOLVED owner, not the session that planned
   * it. Once a chain has been handed to a fresh session, a scheduled row in
   * that chain belongs where the rest of it went; sending it back to the
   * planner would be the one route that contradicted the handoff.
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
      void dispatch(todo, effectiveTarget(todo))
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
      // The planning-nudge knobs ride every snapshot: three primitives, far
      // smaller than one row, and the panel needs them on the very first
      // render to draw the settings page without a second request. Unlike the
      // log records (which follow only when the view is open), there is nothing
      // here to withhold — these are the user's own settings, not session text.
      settings: { ...board.settings },
      // The floating card's last-known geometry, so a restart lands it back
      // where the user parked it — including across ports, which localStorage
      // could not do (it is keyed by origin).
      layout: board.layout === null ? null : { ...board.layout },
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
    // Reparenting. The dragged row's OWN `runIn` changes and nothing else: a new
    // owner clears a stale 「丢失」 verdict, and — because the target is resolved
    // at dispatch time rather than written down here — the row's own children
    // follow it with no cascade.
    if (patch.runIn !== undefined && patch.runIn !== null) {
      const wanted = normalizeRunIn(patch.runIn, todo.sourceSessionId)
      // Dropping into your own subtree would orphan the whole branch, so it is
      // refused before anything is written rather than parked as a broken tree.
      if (wanted.kind === 'after' && wouldCycle(todo, wanted.id)) {
        return {
          ok: false,
          error: '这条待办不能挂到自己的子级下面：那会让整棵子树无处可去。请先把它移到别处，或换一个容器。',
        }
      }
      if (wanted.kind !== todo.runIn.kind || wanted.id !== todo.runIn.id) {
        todo.runIn = wanted
        clearLost(todo)
      }
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

  /**
   * Persist the planning-nudge settings from the panel.
   *
   * Validate the WHOLE request first, then write — the same rule `update`
   * follows for a row. A half-applied settings object is worse than a rejected
   * one: the panel would show values the loader will silently clamp on the next
   * start, so the user's screen and the behaviour would disagree with no way to
   * tell which is true.
   *
   * Omitting a field leaves it alone (a partial patch is the normal case: the
   * panel sends all three, a script may send one). An explicitly invalid value
   * is a rejection rather than a silent clamp — the caller asked for something
   * impossible, and quietly substituting a default would hide that.
   */
  function saveSettings(input) {
    const raw = input.settings !== null && typeof input.settings === 'object' ? input.settings : input
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'settings 必须是一个对象' }
    }
    const next = { ...board.settings }
    if (Object.prototype.hasOwnProperty.call(raw, 'nudge')) {
      if (typeof raw.nudge !== 'boolean') return { ok: false, error: 'nudge 必须是 true 或 false' }
      next.nudge = raw.nudge
    }
    const numeric = [
      ['minChars', MIN_CHARS_RANGE, '字数'],
      ['minEntries', MIN_ENTRIES_RANGE, '条目数'],
      ['maxTurnSessions', MAX_TURN_SESSIONS_RANGE, '单次回合最多新开会话数'],
    ]
    for (const [field, range, label] of numeric) {
      if (!Object.prototype.hasOwnProperty.call(raw, field)) continue
      const value = raw[field]
      if (!Number.isInteger(value)) return { ok: false, error: label + '必须是整数' }
      if (value < range.min || value > range.max) {
        return { ok: false, error: label + '必须在 ' + range.min + '–' + range.max + ' 之间' }
      }
      next[field] = value
    }
    board.settings = next
    afterChange()
    return { ok: true, settings: { ...board.settings }, storageError }
  }

  /**
   * Persist the floating panel's geometry.
   *
   * Deliberately its own action rather than a field on `settings`: a drag and a
   * form submit are different gestures with different frequencies, and folding
   * them together would mean a geometry update carrying (and risking) the
   * user's thresholds. `null` clears it, which is what "reset to the default
   * position" does.
   *
   * No validation beyond shape: the panel clamps to the live viewport on every
   * load anyway, and a position that is merely off-screen after a window shrank
   * is fixed by that clamp — refusing it would lose the preference for good.
   */
  function saveLayout(input) {
    if (input.layout === null || input.layout === undefined) {
      board.layout = null
      afterChange()
      return { ok: true, layout: null, storageError }
    }
    const next = normalizeLayout(input.layout)
    if (next === null) return { ok: false, error: 'layout 必须是 { x, y, w?, h? }' }
    board.layout = next
    afterChange()
    return { ok: true, layout: { ...board.layout }, storageError }
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
      source: { kind: 'plugin:dsh-todo-board', form: 'notice', summary },
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
  /**
 * Marker written above an auto-generated handoff summary.
 *
 * It is part of the note on purpose: the note is the only thing that crosses
 * into the new session, and it is already user-editable on the panel. The marker
 * exists so a reader can tell at a glance which paragraphs a machine wrote from
 * memory — a summary is a retelling, and a retelling can be wrong.
 */
const HANDOFF_MARK = '【自动交接摘要 · 可直接编辑或删除】'
/**
 * Bounds on the handoff summary.
 *
 * The turn-stopping listener is awaited by the harness, so anything that runs
 * inside it delays the turn closing — hence a hard timeout. The event cap and
 * the token cap are the same instinct from the other side: a summary of a long
 * session is itself a large prompt, and letting it grow would make the handoff
 * a second version of the context problem it is meant to solve.
 */
const HANDOFF_TIMEOUT_MS = 45000
const HANDOFF_MAX_EVENTS = 40
const HANDOFF_MAX_TOKENS = 1200

const HANDOFF_SYSTEM =
  '你在为一次「换会话继续」写交接摘要。写给接手的人看，要具体、可执行，不要客套。'

const HANDOFF_PROMPT =
  '下面是一条会话最近的记录。请为「即将新开的那个会话」写一段交接摘要，让它不读原会话也能接着做。\n' +
  '只写这几部分，每部分一行，缺了就省掉：\n' +
  '- 目标：这件事最终要什么；\n' +
  '- 已完成：已经做完并验证过的（带上关键文件路径或命令）；\n' +
  '- 当前卡点：正在做什么、下一步具体是什么；\n' +
  '- 关键决策：已经定下的取舍，改动前必须知道的约束。\n' +
  '不要复述过程，不要写鼓励的话，总共不超过 12 行。\n\n' +
  '=== 会话记录 ===\n'

/**
 * Plain text of one surface event.
 *
 * `extractSessionEventText` lives in `@deepseek-ai/dsh-session-query`, which this
 * file deliberately does not import: a profile-installed plugin resolves modules
 * from its own directory and cannot reach the harness packages. So the same
 * shallow walk the nudge hook already does is repeated here, reading `message`
 * when the event wraps one.
 *
 * @param event - one observed surface event.
 * @returns Concatenated text blocks, or ''.
 */
function handoffEventText(event) {
  if (event === null || typeof event !== 'object') return ''
  const message = event.message !== undefined && event.message !== null ? event.message : event
  if (typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text + '\n'
    }
  }
  return out
}

/**
 * Write an auto-generated handoff summary into an empty note.
 *
 * ONLY when the note is empty: a note the user wrote is theirs, and a summary is
 * a lossy retelling of a conversation — letting one overwrite the other would
 * trade the user's own words for a model's memory of them. The caller has
 * already decided this row is being handed off; this only decides whether the
 * handoff carries any context of its own.
 *
 * Every failure here is non-fatal by design. A missing service, an unreadable
 * log, a timed-out or refused model call all end the same way: log, skip, and
 * open the session anyway. A handoff that stalls is worse than a bare one.
 *
 * @param todo - the row about to spawn its session.
 * @param source - the live agent that planned it, used for its model route.
 * @returns The summary, or '' when none was written.
 */
async function maybeWriteHandoffSummary(todo, source) {
  if (todo.note.trim() !== '') return ''
  const llm = ctx.get('llm')
  const query = ctx.get('sessionQuery')
  if (llm === undefined || query === undefined) return ''
  if (todo.sourceSessionId === '') return ''
  const selection = modelSelection(source)
  if (selection === undefined) return ''

  let history = ''
  try {
    const snapshot = await query.readSurface(todo.sourceSessionId)
    const events = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.events)
      ? snapshot.events
      : []
    const parts = []
    for (let at = events.length - 1; at >= 0 && parts.length < HANDOFF_MAX_EVENTS; at--) {
      const text = handoffEventText(events[at]).trim()
      if (text !== '') parts.push(text)
    }
    history = parts.reverse().join('\n\n')
  } catch (err) {
    log('warn', 'todo-board: 读取源会话内容失败，跳过自动交接摘要（id=' + todo.id + '）', err)
    return ''
  }
  if (history === '') return ''

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS)
  let text = ''
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: HANDOFF_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: HANDOFF_PROMPT + history }] }],
      maxTokens: HANDOFF_MAX_TOKENS,
      signal: controller.signal,
    })) {
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') text += chunk.text
    }
  } catch (err) {
    log('warn', 'todo-board: 自动交接摘要生成失败，仍照常开新会话（id=' + todo.id + '）', err)
    return ''
  } finally {
    clearTimeout(timer)
  }
  const body = text.trim()
  if (body === '') return ''
  todo.note = HANDOFF_MARK + '\n' + body
  touch(todo)
  afterChange()
  return body
}

  async function spawnSession(todo) {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    const agents = rootCtx.get('agents')
    if (agents === undefined) {
      markLost(todo, 'agents', 'agents 服务不可用')
      log('error', 'todo-board: agents 服务不可用，无法新建会话（id=' + todo.id + '）')
      return { ok: false, lost: true, error: 'agents 服务不可用' }
    }
    const source = todo.sourceSessionId === '' ? undefined : agents.get(todo.sourceSessionId)
    // Before anything reads the row: `todoContent` below ships the note, so the
    // summary has to exist by then. Only fires on an empty note, and only when
    // the row is actually being handed off right now.
    await maybeWriteHandoffSummary(todo, source)
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
    // An explicit destination wins — that is the panel's ▶ and the turn-end
    // hook naming the session they are standing in. Otherwise the row goes
    // where it is OWNED, which is not necessarily where it was planned: a
    // re-parented row and a row whose container has since spawned both resolve
    // somewhere other than `sourceSessionId`.
    const wanted = sessionId !== '' ? sessionId : effectiveTarget(todo)
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
    // and "which one did it want?" is the first question worth answering. A row
    // with no owner at all is a different failure from a row whose owner died,
    // and the two need different fixes — a missing container is not something
    // waiting for the session to come back.
    const ownerGone = wanted !== ''
    const noOwnerYet = todo.runIn.kind === 'after'
    markLost(
      todo,
      'no-session',
      ownerGone
        ? '目标会话 ' + wanted + ' 已不存在'
        : noOwnerYet
          ? '它挂在一个容器待办下面，而那个容器还没有开出新的会话'
          : '这条待办没有归属任何会话',
    )
    return {
      ok: false,
      lost: true,
      error: ownerGone || noOwnerYet
        ? '当前没有可接续的活动会话；请切到目标会话后重试，或把该待办改成「自动新会话」'
        : '这条待办没有归属任何会话；先给它指定一个会话，或改成「自动新会话」',
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

  /**
   * Rows `sessionId` owns and has not finished — that session's own queue.
   *
   * Ownership replaces the directory as the selection scope: a session takes
   * only what resolves to it, which is what stops two sessions working in the
   * same directory from silently stealing each other's rows. A row's own
   * directory is deliberately no longer part of this test — from here on it is
   * grouping metadata and the cwd a new session opens with, nothing more.
   */
  function pendingOwned(sessionId) {
    const out = []
    for (const todo of board.todos) {
      if (todo.aiDone || todo.verified) continue
      if (effectiveTarget(todo) !== sessionId) continue
      out.push(todo)
    }
    return out
  }

  /**
   * Topmost still-undispatched row this session owns.
   *
   * `remind` is deliberately NOT skipped. A remind row is the planning state a
   * user parks a row in — shape settled, nothing running — and reaching one
   * ends the chain: neither the resume nor the newSession branch handles it,
   * so the caller falls through and this session stops handing out work. The
   * old code skipped remind and kept walking, so a chain ran straight through a
   * plan the user had deliberately not started.
   */
  function nextUndispatched(sessionId) {
    const now = Date.now()
    for (const todo of pendingOwned(sessionId)) {
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

  // ------------------------------------------- planning: the deterministic nudge
  //
  // The prompt section asks the model to offer planning, and that is a *request*:
  // a model in a hurry reads past it. This makes the offer dependable by judging
  // the user's own message the moment it arrives.
  //
  // It is deliberately conservative and one-shot, because the cost of a false
  // positive is a model asking a pointless question:
  //
  //   - only a real user message counts (not tool results, not injected notices);
  //   - only when this directory has NO open todo (a finished plan needs no offer);
  //   - only for messages that actually look multi-stage: long AND with repeated
  //     enumeration markers, not merely long;
  //   - at most once per session, so "no thanks" is answered by silence.

  /** Sessions already nudged. Weak so a closed agent can still be collected. */
  const planningNudged = new WeakSet()

  /** Repeated signs that a message is a staged job rather than one request. */
  const STAGED_MARKERS = [
    /(^|\n)\s*\d+[.、)]\s*\S/g,
    /(^|\n)\s*[-*•]\s+\S/g,
    /(^|\n)\s*第[一二三四五六七八九十\d]+步/g,
    /首先|其次|再次|然后|接着|最后/g,
    /阶段|步骤|流程|里程碑/g,
  ]

  /**
   * Whether one user message looks like a multi-stage task.
   *
   * Both halves are load-bearing. Length alone would fire on any pasted stack
   * trace; markers alone would fire on "1. 改个错别字". Requiring BOTH, plus two
   * occurrences, is what keeps the offer from becoming noise.
   *
   * The thresholds come from the BOARD, not from module constants: they are
   * subjective, they differ per person, and — because the offer fires at most
   * once per session — a wrong pair silently spends the session's only chance.
   * `settings.nudge === false` is handled by the caller, which skips this
   * function entirely rather than paying for a scan it will ignore.
   */
  function looksStaged(text, thresholds) {
    const body = typeof text === 'string' ? text : ''
    const settings = thresholds === undefined ? board.settings : thresholds
    if (body.length < settings.minChars) return false
    let hits = 0
    for (const pattern of STAGED_MARKERS) {
      const matches = body.match(pattern)
      hits += matches === null ? 0 : matches.length
    }
    return hits >= settings.minEntries
  }

  /** All text blocks of one message, joined; '' for anything not a user message. */
  function userTextOf(message) {
    if (message === null || typeof message !== 'object') return ''
    if (message.role !== 'user') return ''
    const source = message.source
    // Only a human's own message: an injected notice or a tool result must never
    // trigger the offer (the plugin would be talking to itself).
    if (source !== undefined && source !== null && source.kind !== 'user') return ''
    if (!Array.isArray(message.content)) return ''
    let text = ''
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        text += block.text + '\n'
      }
    }
    return text
  }

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      const messages = payload === undefined || payload === null ? undefined : payload.messages
      if (agent === undefined || agent === null || !Array.isArray(messages) || messages.length === 0) {
        return next()
      }
      // The off switch, checked BEFORE anything else. A user who turned the
      // offer off should not pay for the scan, the directory walk or the
      // pending query that would only be thrown away — and the WeakSet must
      // stay untouched, or turning it back on later would find the session
      // already claimed.
      const settings = board.settings
      if (settings.nudge !== true) return next()
      if (planningNudged.has(agent)) return next()
      const header = agent.session === undefined || agent.session === null ? undefined : agent.session.header
      const dir = normalizeDir(header === undefined ? undefined : header.cwd)
      if (dir === '') return next()
      // A directory with work already on the board is mid-plan, not a new request.
      if (pendingInDir(dir).length > 0) return next()
      let staged = false
      for (const message of messages) {
        if (looksStaged(userTextOf(message), settings)) {
          staged = true
          break
        }
      }
      if (!staged) return next()
      planningNudged.add(agent)
      return Promise.resolve(next()).then((downstream) => {
        if (downstream === null || typeof downstream !== 'object' || downstream.kind !== 'enter') {
          return downstream
        }
        return {
          ...downstream,
          messages: [
            ...downstream.messages,
            noticeMessage(
              [{
                type: 'text',
                text:
                  '【TODO 板 · 规划提示】这条请求看起来不止一步。如果确实要分多步做：' +
                  '先用一句话问用户要不要用 TODO 板拆成步骤、按顺序执行（可以用 ask_user_question 给出' +
                  '「拆成步骤并开始」「不用，直接做」两个选项），不要闷头开干。' +
                  '本轮已经问过或用户说不用，就不要再提。',
              }],
              'TODO 板规划提示',
            ),
          ],
        }
      })
    } catch (err) {
      log('error', 'todo-board: 规划提示失败', err)
      return next()
    }
  })

  // ----------------------------------------------- turn end: auto-continue

  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent === undefined || agent === null) return
      if (agent.id === '') return
      const signal = payload.signal
      let spawned = 0
      for (;;) {
        // Selection is by ownership, not by cwd: this session takes only the
        // rows that resolve to it. The row's own directory no longer scopes the
        // queue, which is what stops two sessions in one directory from taking
        // each other's work.
        const next = nextUndispatched(agent.id)
        if (next === undefined) return
        if (next.mode === 'resume') {
          // Deliberately NOT looped. Dispatching into this same agent opens a
          // new turn, and that turn's own stop boundary hands out the row
          // after it; looping here would push the next row into a turn that
          // has not started yet.
          void dispatch(next, agent.id)
          return
        }
        // `remind` matches neither branch on purpose: it is the user's
        // 「planned but not started」 marker, and the chain stops here rather
        // than carrying on past a plan that was never begun.
        if (next.mode !== 'newSession') return
        if (spawned >= board.settings.maxTurnSessions) {
          log(
            'warn',
            'todo-board: 单次回合结束新开会话已达上限 ' + board.settings.maxTurnSessions +
              ' 条，其余留待下一次（可在设置页调整）',
          )
          return
        }
        if (signal !== undefined && signal !== null && signal.aborted === true) return
        next.dispatchedAt = Date.now()
        touch(next)
        afterChange()
        const result = await spawnSession(next)
        if (result === undefined || result === null || result.ok !== true) return
        spawned += 1
        // The spawn took this session's children with it, so the loop MUST
        // come back for more. Before ownership existed the following row was
        // found by directory and the fresh session picked it up on our behalf;
        // now it only owns its own subtree, so without this the rest of this
        // session's queue would stall with nobody left to hand it out.
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
            '- **用户给的是多阶段/长任务时，先问一句再动手**：如果这件事明显要分几步做，而**当前目录下还没有**待办，先用一句话（或 ask_user_question）问用户：要不要用 TODO 板把它拆成步骤、按顺序执行？不要闷头开干。要拆就用一次 action="add" 的 `items` 把整份计划写进去（一次审批），每条 note 写清验收标准。',
            '- **当前目录下已经有待办时，不要再问**：直接按上面的顺序继续做即可。这一条是防唠叨的开关 —— 板子非空就问，会变成每一轮都问。',
            '- **续跑按归属走，不按目录走**：每条待办属于一条会话（`runIn`），只会被那条会话接走；' +
              '同目录的另一条会话不会顺手把你的活干了。子条目（`parent`）归到父容器开的那个会话去。',
            '- **`remind` 是链条断点**：列表里读到 `remind` 就停下，不要越过它继续往下执行 —— ' +
              '它表示用户想先把计划摆出来、还没开始。',
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

  // `note` joined this list in 0.13.4. The reasoning is the same one that put
  // `done` here: a note is prose on a row the user already owns — it deletes
  // nothing, dispatches nothing, re-parents nothing, and cannot start work
  // (`pendingInDir` ignores it). Asking for it puts a dialog in the middle of
  // the one loop the board exists for, "do a step, write down what the next one
  // needs", and under `approval: 'never'` that dialog fails closed every time,
  // so the loop simply breaks.
  //
  // `schedule` deliberately STAYS gated: a schedule makes the row run later
  // without anyone watching, which is the one thing a note cannot do.
  const APPROVAL_FREE_ACTIONS = ['list', 'done', 'reopen', 'note']

  /**
   * One line describing the pending write, so the approval dialog states what
   * the model is about to do rather than only naming the tool.
   */
  function approvalDetail(action, input) {
    const id = typeof input.id === 'string' ? input.id : ''
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const where = title !== '' ? '「' + title + '」' : id !== '' ? '（id ' + id + '）' : ''
    if (action === 'add') {
      // A plan shows up IN THE DIALOG, step by step. One approval for a batch is
      // only honest if the approver can read what the batch is — otherwise the
      // gate degenerates into a single "yes" for an unread list.
      if (Array.isArray(input.items) && input.items.length > 0) {
        const titles = input.items.map((entry, at) => {
          const one = entry !== null && typeof entry === 'object' ? entry : {}
          const text = typeof one.title === 'string' ? one.title.trim() : ''
          return at + 1 + '. ' + (text === '' ? '(缺 title)' : text)
        })
        const modes = new Set()
        for (const entry of input.items) {
          const one = entry !== null && typeof entry === 'object' ? entry : {}
          if (typeof one.mode === 'string') modes.add(one.mode)
        }
        const auto = [...modes].some((mode) => mode !== 'remind')
        return (
          '新增计划（' + input.items.length + ' 步' +
          (auto ? '，含会自动派发的步骤' : '') + '）：\n' + titles.join('\n')
        )
      }
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
        '读写跨会话 TODO 板。列表从上到下就是执行顺序（用户可拖动调整）。action=list 查看待办（默认当前工作目录），action=add 新增（追加到底部，可用 images 附主机上的图片文件），action=done 标记 AI 已完成（左勾），action=reopen 撤销左勾，action=note 追加备注，action=schedule 设置/取消定时执行时间，action=update 改标题/模式/目录/备注，action=reorder 用 ids 重排同一目录内的顺序，action=dispatch 立即派发一条尚未派发的待办。带 schedule 的待办到点后才会被派发。**除 list / done / reopen / note 外，所有写操作都会先弹给用户审批；被拒绝就停手，不要反复重试。** ' +
        // `done` / `reopen` say what they DO, in effect terms. Under an
        // LLM-backed review preset (`dsh-experimental-auto-review`), the
        // reviewer sees this description and classifies the call by its actual
        // effects; a checkbox flip that deletes nothing and rewrites no
        // content is low risk, and saying so here is the one lever this plugin
        // has over that classification. It is deliberately NOT a promise about
        // approval — the reviewer decides, and the "高风险/中风险动作要拒绝"
        // rules still apply to everything else.
        '动作效果：done 只把该行标记为「AI 已完成」（翻转一个布尔），reopen 只撤销这个标记 —— 两者都不删除任何行、不改写标题或备注、不新建会话、不派发任务。',
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
          // One entry point for a single todo and for a whole plan: a plan is the
          // same rows, created in one call so they cost ONE approval instead of
          // one per step. `items` wins when both are given.
          const requested = Array.isArray(input.items) && input.items.length > 0
            ? input.items
            : [{ title: input.title, note: input.note, mode: input.mode, schedule: input.schedule, images: input.images }]
          if (Array.isArray(input.items) && input.items.length > MAX_PLAN_ITEMS) {
            return {
              message:
                '一次最多创建 ' + MAX_PLAN_ITEMS + ' 条（收到 ' + input.items.length +
                ' 条）。请拆成两批：这样每次审批框里的计划都还是人读得完的。',
              todos: [],
            }
          }
          const dirPath = typeof input.dir === 'string' && input.dir !== '' ? input.dir : cwd

          // -- stage 1: validate the WHOLE plan, touching nothing -----------------
          //
          // All-or-nothing is the contract, and it is not decoration: a half-built
          // plan is worse than none, because the user approved a list and would get
          // a different one. So every item is checked before the first row lands.
          const staged = []
          for (let at = 0; at < requested.length; at++) {
            const entry = requested[at] !== null && typeof requested[at] === 'object' ? requested[at] : {}
            const where = requested.length === 1 ? '' : '第 ' + (at + 1) + ' 条：'
            const title = typeof entry.title === 'string' ? entry.title.trim() : ''
            if (title === '') {
              return { message: where + 'add 需要提供 title，整批未创建（一条都没落库）。', todos: [] }
            }
            if (typeof entry.mode === 'string' && MODES.indexOf(entry.mode) < 0) {
              return {
                message: where + 'mode 只能是 ' + MODES.join(' / ') + '，整批未创建（一条都没落库）。',
                todos: [],
              }
            }
            const schedule = normalizeSchedule(entry.schedule)
            if (typeof entry.schedule === 'string' && entry.schedule.trim() !== '' && schedule === '') {
              return {
                message: where + 'schedule 格式无效，请用 YYYY-MM-DDTHH:mm（本地时间）；整批未创建（一条都没落库）。',
                todos: [],
              }
            }
            // Paths are read here, at the board boundary, and stored durably so a
            // later dispatch needs no filesystem access of its own.
            const imageEntries = []
            if (Array.isArray(entry.images) && entry.images.length > 0) {
              for (const path of entry.images) {
                if (typeof path !== 'string' || path.trim() === '') {
                  return { message: where + 'images 需要是图片文件的绝对路径数组；整批未创建（一条都没落库）。', todos: [] }
                }
                const trimmed = path.trim()
                const mediaType = MEDIA_TYPE_BY_EXTENSION[extname(trimmed).toLowerCase()]
                if (mediaType === undefined) {
                  return {
                    message: where + '不支持的图片扩展名：' + trimmed +
                      '（支持 png / jpg / jpeg / webp / gif）；整批未创建（一条都没落库）。',
                    todos: [],
                  }
                }
                imageEntries.push({ path: trimmed, mediaType })
              }
            }
            // `parent` is the index, WITHIN THIS SAME BATCH, of the row this one hangs
            // under. It must point strictly BACKWARDS, which makes a cycle
            // impossible to express rather than something to detect later, and
            // guarantees the container is committed before its child needs it.
            let parentAt = -1
            if (entry.parent !== undefined && entry.parent !== null) {
              parentAt = typeof entry.parent === 'number' ? entry.parent : Number.NaN
              if (!Number.isInteger(parentAt) || parentAt < 0 || parentAt >= at) {
                return {
                  message: where + 'parent 只能是本批次里更靠前的一条的下标（0 到 ' + (at - 1) +
                    ' 之间，不能指向自己或后面的条目）；整批未创建（一条都没落库）。',
                  todos: [],
                }
              }
            }
            staged.push({ title, schedule, imageEntries, parentAt, entry })
          }

          // -- stage 2: admit every image, still touching no row -----------------
          const admitted = []
          for (let at = 0; at < staged.length; at++) {
            const images = await admitImages(staged[at].imageEntries)
            if (images.ok === false) {
              return {
                message:
                  (staged.length === 1 ? '' : '第 ' + (at + 1) + ' 条：') + images.error +
                  '；整批未创建（一条都没落库）。',
                todos: [],
              }
            }
            admitted.push(images)
          }

          // -- stage 3: commit, in order -----------------------------------------
          const created = []
          for (let at = 0; at < staged.length; at++) {
            const item = staged[at]
            const todo = normalize({
              title: item.title,
              dirPath,
              mode: typeof item.entry.mode === 'string' ? item.entry.mode : 'remind',
              note: typeof item.entry.note === 'string' ? item.entry.note : '',
              schedule: item.schedule,
              sourceSessionId: agent === undefined || agent === null ? '' : agent.id,
            })
            if (todo === null) {
              return { message: '无法创建这条待办。', todos: created.map((row) => toolTodo(row, live)) }
            }
            todo.images = admitted[at].images
            todo.order = nextOrder()
            board.todos.push(todo)
            board.seq += 1
            // The container is always an EARLIER row in this batch, so it is
            // already in `created` and its id is stable.
            if (item.parentAt >= 0) todo.runIn = { kind: 'after', id: created[item.parentAt].id }
            created.push(todo)
          }
          if (created.length > 0) afterChange()

          if (created.length === 1) {
            const todo = created[0]
            return {
              message:
                '已新增待办「' + todo.title + '」（目录：' + (dirPath || '(未指定)') + '，模式：' +
                todo.mode +
                (todo.schedule === '' ? '' : '，定时：' + todo.schedule + '（' + scheduleLabel(todo.schedule) + '）') +
                (todo.images.length === 0 ? '' : '，图片：' + todo.images.length + ' 张') +
                '，追加到列表底部，id：' + todo.id + '）。',
              todos: [toolTodo(todo, live)],
            }
          }
          return {
            message:
              '已新增计划：' + created.length + ' 条，按顺序追加到列表底部（目录：' +
              (dirPath || '(未指定)') + '，模式：' + created[0].mode + '）。\n' +
              created.map((todo, at) => at + 1 + '. ' + todo.title + ' ｜ id=' + todo.id).join('\n') +
              '\n现在把这份列表复述给用户，然后按上面说的确认方式问一句是否开始。',
            todos: created.map((todo) => toolTodo(todo, live)),
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

  // ------------------------------------------------- planning: skill + command
  //
  // Two halves of the same feature, and they are deliberately separate:
  //
  //   - `/todo <目标>` is the USER's entry point: it injects the template into
  //     the current session, so "拆一下这件事" is one line away.
  //   - the runtime skill is the MODEL's manual: when to split, how to size the
  //     steps, what belongs in a note. It loads on demand, so none of it costs
  //     context until a task actually needs planning.
  //
  // Both are `ctx.inject` + effect, for the same load-order reason as the tool
  // (the services may be provided after this row is applied), and both degrade
  // quietly: a deployment without `skills`/`commands` keeps working.

  /** The skill body: the manual. Assembled from the same constants the tool uses. */
  function planningSkillBody() {
    return [
      '# 用 TODO 板规划并按步执行长任务',
      '',
      '## 什么时候该拆',
      '',
      '- 用户给的任务明显分几步、或一句话说不完（多文件、多阶段、要跑好几轮验证）；',
      '- 用户明确说「拆一下 / 规划一下 / 用 TODO 板做 / 按步来」。',
      '',
      '**如果当前工作目录下已经有待办，就不要拆也不要问** —— 继续按既有顺序做即可。',
      '重复拆分会把一份计划变成两份互不相干的清单。',
      '',
      '## 怎么拆',
      '',
      '- 一条只交付一件事，能独立验收；把「改 A 再跑 B 验证」里真正可验收的那件事写成一条；',
      '- 顺序写进列表顺序（列表从上到下就是执行顺序），不要靠 note 描述顺序；',
      '- 3–8 步是常见区间。一步能做完的事不需要板子；二十步以上请分批，`add` 的 `items` 上限是 ' +
        MAX_PLAN_ITEMS + ' 条；',
      '- **每条都用 note 写清验收标准与前置条件**：note 会和标题一起发给执行它的会话，' +
        '是唯一能跨会话传递上下文的地方（面板上用户也能看到它）。',
      '',
      '## 怎么建（一次调用、一次审批）',
      '',
      '用一次 `action="add"`，把整份计划放进 `items`：',
      '',
      '```json',
      '{"action":"add","dir":"<工作目录>","items":[',
      '  {"title":"第一步…","note":"验收标准：…","mode":"resume"},',
      '  {"title":"第二步…","note":"验收标准：…","mode":"resume"}',
      ']}',
      '```',
      '',
      '- 一次调用 = 一次审批框，框里会列出每一步的标题供用户过目；',
      '- **任意一条不合法，整批都不会写入**，修好再交一次；',
      '- 先给用户看拆分结果、得到确认，再调用 —— 别把「先写板子再解释」当成默认流程。',
      '',
      '## 怎么把后续步骤放进一个新会话',
      '',
      '在 `items` 里给某一条填 `"mode":"newSession"`，再给后面的条目填 `"parent":<它的下标>`，' +
      '它们就会被带走，在那个新会话里按顺序执行：',
      '',
      '```json',
      '{"action":"add","dir":"<工作目录>","items":[',
      '  {"title":"调研…","note":"…","mode":"resume"},',
      '  {"title":"开新会话做实现","note":"…","mode":"newSession"},',
      '  {"title":"实现主体","note":"…","mode":"resume","parent":1},',
      '  {"title":"补测试","note":"…","mode":"resume","parent":1}',
      ']}',
      '```',
      '',
      '- `parent` 只能指向**本批次里更靠前**的条目（0 起），不能指向自己或后面的条目；',
      '- 父条目是 `newSession` 时子条目跟着进新会话；父条目是别的模式时只作分组，子条目仍留在当前会话；',
      '- 用户之后在面板上拖动就能改归属 —— 你现在写死的只是起点。',
      '',
      '## 模式怎么选',
      '',
      '- `resume`：同一条会话连跑，上下文连续。**大部分步骤用它**；',
      '- `newSession`：这一步起一条新会话。适合「上下文已经很长、换个干净会话接着做」，' +
      '或者这一步之后的活会被别的步骤带偏；',
      '- `remind`：只建清单、由用户点面板 ▶ 逐个开始 —— 用户明确说「只列个清单」时用这个。' +
      '**读到 `remind` 时链条会停**：它是「先规划、暂不开始」的标记，所以它后面同会话的待办不会自动接着跑。',
      '',
      '## 建完之后',
      '',
      '1. 把这份列表复述给用户（标题 + 顺序即可，不要把 note 全文倒出来）；',
      '2. 用 `ask_user_question` 问一句，三个选项：',
      '   - `就按这个做（立刻开始）` —— 用户选它，就等于授权了第一步；',
      '   - `只建清单不开始` —— 不要派发，等用户自己点 ▶；',
      '   - `我再改改` —— 按用户说的改（`update` / `reorder`），改完再问。',
      '3. 开始之后：每做完一条立刻 `action="done"`（左勾），再 `action="list"` 取同目录下一条继续，' +
        '不要停下来问用户 —— 这正是这个板子的用途。',
      '',
      '## 可粘贴给用户的模板',
      '',
      '```',
      PLAN_TEMPLATE,
      '```',
      '',
      '用户想主动让模型拆的时候，把上面这段（或 `/todo <目标>`）给他即可。',
    ].join('\n')
  }

  ctx.inject(['skills'], (skillCtx) => {
    const skills = skillCtx.get('skills')
    if (skills === undefined || typeof skills.register !== 'function') return
    skillCtx.effect(
      () =>
        skills.register({
          name: 'todo-board-planning',
          description:
            '把长任务/多阶段任务拆成 TODO 板的步骤并按顺序执行：拆分粒度、note 写什么、如何一次写入整份计划、' +
            '执行模式怎么选、建完怎么问用户。当用户给的任务分多步、或说「拆一下/规划一下/用 TODO 板做」时使用。',
          whenToUse:
            '用户交来明显可分步的长任务时；或用户提到 TODO 板、待办、按步执行、拆任务时。' +
            '当前目录下已经有待办时不要用（那说明计划已经建好了）。',
          content: planningSkillBody(),
          source: 'dsh-todo-board',
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      'dsh-todo-board: planning skill',
    )
  })

  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.get('commands')
    if (commands === undefined || typeof commands.register !== 'function') return
    commandCtx.effect(
      () =>
        commands.register({
          name: 'todo',
          description: '把一件事交给 TODO 板来规划和按步执行（注入拆分模板）',
          input: {
            hint: '[<目标>]',
            // The user's own attachments ride along, so "/todo 修好这个" on top of
            // a screenshot hands the model both without a second step.
            attachments: true,
          },
          handler: (invocation) => {
            const goal = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
            const agent = invocation.agent
            if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
              return { kind: 'error', text: '这个会话暂时不能接收消息，无法注入拆分模板。' }
            }
            // `/todo` with no goal is a usage error, NOT an injection. Injecting the
            // template alone would make the model plan "<一句话说清最终要什么>"
            // literally — a command that silently does the wrong thing is worse
            // than one that asks for its argument.
            if (goal === '') {
              return {
                kind: 'error',
                text: '用法：/todo <目标>。例如 /todo 把日志模块拆成可验收的几步并做完。',
              }
            }
            const text = PLAN_TEMPLATE.replace('【目标】<一句话说清最终要什么>', '【目标】' + goal)
            const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : []
            agent.followup(
              noticeMessage(
                [{ type: 'text', text }, ...attachments],
                'TODO 板拆分模板：' + goal,
              ),
            )
            return { kind: 'success', text: '已把「' + goal + '」交给模型拆分，稍等它给出计划。' }
          },
        }),
      'dsh-todo-board: /todo command',
    )
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

  /**
   * Refusals already seen, per requesting host.
   *
   * Replaces a plain "log the first 20" counter. That cap assumed noise comes
   * from many DISTINCT requests; in practice one caller (the plugin market,
   * probing every local route) retries forever, so the log filled with twenty
   * identical lines per process start and everything else was buried. Keying by
   * host makes the first one verbose and the rest silent, which is the shape
   * the noise actually has.
   */
  const refusalCounts = new Map()

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
    // "why is the panel getting 401/403?" is otherwise unanswerable.
    //
    // NOISE CONTROL, learned the hard way: a cap of "20 entries" per process
    // looked sufficient, but one known caller (the plugin market probing every
    // local route) retries constantly, so a restart produced twenty fresh
    // warnings and buried everything else in the log. The cap counted LOG LINES
    // when what repeats is the CALLER.
    //
    // So refusals are aggregated per host: the first refusal from a host is
    // logged in full (that is the one a human needs to read), and every later
    // one from that same host only bumps a counter that rides the next line.
    // A genuinely new host still gets its own full message, and the totals are
    // flushed when the process ends, so nothing is lost — just folded.
    const headers = request === undefined || request === null ? undefined : request.headers
    const host = String(headerValue(headers, 'host') ?? '(无)')
    const seenRefusal = refusalCounts.get(host)
    if (seenRefusal === undefined) {
      refusalCounts.set(host, 1)
      log(
        'warn',
        'todo-board: 拒绝了未通过信任校验的请求（' + label + '，' + fence +
          '，status=' + status +
          (status === 401 ? '（缺少浏览器会话凭据：用 dsh web 打印的那条带 token 的地址重开页面）' : '') +
          '，host=' + host +
          '，origin=' + String(headerValue(headers, 'origin') ?? '(无)') +
          '，sec-fetch-site=' + String(headerValue(headers, 'sec-fetch-site') ?? '(无)') +
          '。同一来源的后续拒绝只累计，不再逐条记录）',
      )
    } else {
      refusalCounts.set(host, seenRefusal + 1)
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
              else if (action === 'settings') result = saveSettings(body)
              else if (action === 'layout') result = saveLayout(body)
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
