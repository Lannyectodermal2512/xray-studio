/**
 * Indentation round-trip for the per-node JSON editor.
 *
 * Run with Node's own type stripping — no test framework, no new dependency:
 *
 *   npm run test:app
 *
 * What is being pinned is a property, not an example: a node extracted from the file,
 * dedented for display and re-indented on the way back must reproduce the original
 * text BYTE FOR BYTE. That is what makes "open the editor, change nothing, press Apply"
 * a no-op on someone's real config, and what keeps an edit from arriving at a different
 * indentation than the lines around it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sliceAt, dedent, reindent, replaceSlice } from '../src/renderer/src/graph/edit.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', '..', 'examples', 'demo-leastload.json')
const src = readFileSync(fixture, 'utf8')

let failed = 0
function ok(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

const outbounds = (JSON.parse(src) as { outbounds: unknown[] }).outbounds
ok('fixture has outbounds', outbounds.length > 0, String(outbounds.length))

for (let i = 0; i < outbounds.length; i++) {
  const s = sliceAt(src, ['outbounds', i])
  if (!s) {
    ok(`outbounds[${i}] resolves`, false)
    continue
  }
  const shown = dedent(s.text, s.indent)
  const rest = shown.split('\n').slice(1).filter((l) => l.trim() !== '')

  ok(`outbounds[${i}] indent detected`, s.indent.length > 0, JSON.stringify(s.indent))
  // Displayed text must not start deeper than the box: the closing brace lands at
  // column 0, which is only true once the file's own indentation is removed.
  ok(
    `outbounds[${i}] dedented to column 0`,
    rest.length === 0 || Math.min(...rest.map((l) => l.match(/^ */)![0].length)) === 0,
  )
  ok(`outbounds[${i}] reindent(dedent(x)) === x`, reindent(shown, s.indent) === s.text)
  // The one that matters most in practice.
  ok(
    `outbounds[${i}] applying an unchanged block does not touch the file`,
    replaceSlice(src, ['outbounds', i], reindent(shown, s.indent)) === src,
  )
}

// A real edit must land at the same indentation as the lines it sits between.
const first = sliceAt(src, ['outbounds', 0])!
const tagLine = /"tag":\s*"([^"]*)"/.exec(first.text)
if (tagLine) {
  const edited = dedent(first.text, first.indent).replace(/"tag":\s*"[^"]*"/, '"tag": "EDITED"')
  const doc = replaceSlice(src, ['outbounds', 0], reindent(edited, first.indent))
  const after = doc.split('\n').find((l) => l.includes('"EDITED"'))!
  const before = src.split('\n').find((l) => l.includes(`"${tagLine[1]}"`) && l.includes('"tag"'))!
  ok(
    'an edited line keeps the file indentation',
    after.match(/^\s*/)![0] === before.match(/^\s*/)![0],
    JSON.stringify({ after, before }),
  )
  ok('the document still parses', ((): boolean => {
    try {
      JSON.parse(doc)
      return true
    } catch {
      return false
    }
  })())
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed ? 1 : 0)
