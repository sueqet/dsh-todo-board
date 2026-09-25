/**
 * Mutation check for the row-facts and row-schedule tests.
 *
 * Confirms `client-smoke.mjs` really fails when each behaviour is reverted:
 *
 *   1. the directory chip comes back (a fact stated twice)
 *   2. the schedule is repeated in the facts line (same, other direction)
 *   3. an unscheduled row loses its way to add a time
 *   4. editing sends nothing (the picker is decorative)
 *
 * Patterns are matched against a normalized (LF) copy because the working tree
 * is checked out with CRLF on Windows, then the replacement is mapped back onto
 * the original text so line endings survive untouched.
 *
 * As with the clamp guard, the child's stdio is not piped — under a restricted
 * sandbox a piped spawn fails with EPERM, which would masquerade as a caught
 * mutation. `client/client.js` is restored on every exit path and verified
 * byte-for-byte, because the dev install is a junction onto this file.
 *
 *   node tools/check-row-guard.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, never hard-coded: the repo can live anywhere, and
// this package is published.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const p = join(ROOT, 'client', 'client.js')
const original = fs.readFileSync(p, 'utf8')

function restore() {
  try {
    if (fs.readFileSync(p, 'utf8') !== original) fs.writeFileSync(p, original, 'utf8')
  } catch (err) {
    console.error('RESTORE FAILED: ' + err.message)
  }
}

process.on('SIGINT', () => {
  restore()
  process.exit(130)
})
process.on('SIGTERM', () => {
  restore()
  process.exit(143)
})
process.on('uncaughtException', (err) => {
  restore()
  console.error(err)
  process.exit(2)
})

const mutants = [
  {
    name: 'directory chip reinstated (fact stated twice)',
    from: "    const meta = [\n      h(\n        'button',\n        {\n          className: 'dshtb-chip',\n          key: 'm',",
    to: "    const meta = [\n      h('span', { className: 'dshtb-chip', key: 'd' }, todo.dirLabel),\n      h(\n        'button',\n        {\n          className: 'dshtb-chip',\n          key: 'm',",
  },
  {
    name: 'schedule repeated in the facts line',
    from: "    facts.push('目录 ' + (todo.dirPath || todo.dir || '(未指定)'))",
    to: "    facts.push('目录 ' + (todo.dirPath || todo.dir || '(未指定)'))\n    facts.push(todo.schedule ? '定时 ' + todo.schedule : '不定时')",
  },
  {
    name: 'unscheduled row cannot add a time',
    from: "    } else {\n      meta.push(\n        h(\n          'button',\n          {\n            className: 'dshtb-chip quiet',",
    to: "    } else if (false) {\n      meta.push(\n        h(\n          'button',\n          {\n            className: 'dshtb-chip quiet',",
  },
  {
    name: 'editing sends nothing (picker is decorative)',
    from: "  function commitWhen(id) {\n    const value = whenDraft\n    setWhenId('')\n    setWhenDraft('')\n    patch(id, { schedule: value })\n  }",
    to: "  function commitWhen(id) {\n    setWhenId('')\n    setWhenDraft('')\n    void id\n  }",
  },
  {
    name: 'pending rows go silent again (state must be inferred)',
    from: "      meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))",
    to: "      if (state !== 'pending') meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))",
  },
  {
    name: 'done rows go silent again (state must be inferred)',
    from: "      meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))",
    to: "      if (state !== 'done') meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))",
  },
]

/** Apply one mutant to CRLF text by matching and replacing on the LF form. */
function mutate(source, mutant) {
  const lf = source.replace(/\r\n/g, '\n')
  if (!lf.includes(mutant.from)) return null
  const patched = lf.replace(mutant.from, mutant.to)
  // Map back to the original line endings so the file stays CRLF.
  return original.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched
}

function suitePasses() {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'client-smoke.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  return result.status === 0
}

if (!suitePasses()) {
  console.error('the unmutated suite does not pass — aborting before mutating anything')
  process.exit(2)
}

let allCaught = true
try {
  for (const mutant of mutants) {
    const mutated = mutate(original, mutant)
    if (mutated === null) {
      console.error('SKIP (pattern not found): ' + mutant.name)
      allCaught = false
      continue
    }
    fs.writeFileSync(p, mutated, 'utf8')
    const passed = suitePasses()
    restore()
    if (passed) {
      console.error('NOT CAUGHT: ' + mutant.name)
      allCaught = false
    } else {
      console.log('caught: ' + mutant.name)
    }
  }
} finally {
  restore()
}

if (fs.readFileSync(p, 'utf8') !== original) {
  console.error('RESTORE FAILED — client.js differs from the original!')
  process.exit(2)
}
if (!suitePasses()) {
  console.error('the restored suite does not pass')
  process.exit(2)
}

if (!allCaught) process.exit(1)
console.log('\nall ' + mutants.length + ' mutations caught; original restored and passing')
