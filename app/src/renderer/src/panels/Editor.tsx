import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as jsonc from 'jsonc-parser'
import { createScanner, getLocation, type JSONPath } from 'jsonc-parser'

import type { Diagnostic } from '@shared/events'
import { effectiveConfigPath, useApp } from '../store/app'
import { fragmentErrors } from '../graph/edit'
import { lookup, useDocs } from '../lib/docs'
import { Prose } from '../components/Prose'
import { AiChat } from './AiChat'

/**
 * jsonc-parser declares SyntaxKind as an ambient `const enum`, which
 * `verbatimModuleSyntax` refuses to inline, but it also ships the enum as a real object
 * at runtime. Reading it from the module is better than hardcoding the numbers anyway:
 * the values then come from the same copy of the library that produced the tokens, so a
 * renumbering upstream cannot silently mis-colour the document.
 */
const K = (jsonc as unknown as { SyntaxKind: Record<string, number> }).SyntaxKind

/**
 * The whole config as text, with a hint for whatever your pointer is over.
 *
 * The Graph tab edits structure and the inspector edits one node at a time; neither is
 * how anyone actually maintains a config they already know. This is: the real file, in
 * one piece, with the reference material attached to it rather than in another tab.
 *
 * Not Monaco. Monaco is ~5 MB, needs web workers — which the renderer's
 * `script-src 'self'` CSP would have to be widened for — and brings its own JSON
 * language service that knows nothing about Xray. What is actually wanted here is
 * narrow: highlight the JSON, point at the error, and answer "what is this key?".
 * That is a few hundred lines against jsonc-parser, which the app already uses for
 * every surgical edit, and it cannot drift from the parser the rest of the tool uses.
 *
 * Hover resolution is exact rather than heuristic: the text is monospace, so a pointer
 * position maps arithmetically to a character offset, and `getLocation` turns that
 * offset into the JSON path the docs are keyed by. No token hit-testing, no per-span
 * event handlers on a file that can run to thousands of lines.
 */
export function Editor(): React.JSX.Element {
  const configPath = useApp(effectiveConfigPath)
  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [diags, setDiags] = useState<Diagnostic[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<Hint | null>(null)

  const docs = useDocs()
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const preRef = useRef<HTMLPreElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const metricsRef = useRef<HTMLSpanElement | null>(null)
  const debounce = useRef<number | null>(null)

  const load = useCallback(() => {
    if (!configPath) return
    void window.xraystudio.readConfig(configPath).then((t) => {
      setOriginal(t)
      // Never clobber unsaved work when the file changes underneath — same rule as the
      // Graph tab. The reload prompt in the header is the way back to disk.
      setDraft((d) => (d === null ? t : d))
    })
  }, [configPath])

  useEffect(load, [load])

  const dirty = draft !== null && original !== null && draft !== original
  const text = draft ?? ''
  const lines = useMemo(() => text.split('\n'), [text])
  const tokens = useMemo(() => highlight(text), [text])
  const syntax = useMemo(() => (text.trim() ? fragmentErrors(text) : []), [text])

  // Line start offsets, for turning a (row, col) back into an absolute offset.
  const lineStarts = useMemo(() => {
    const out = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1)
    return out
  }, [text])

  // Protocol per outbound/inbound index. Needed because protocol `settings` are keyed
  // by protocol in the docs — hysteria's `address` is not vless's — and the path alone
  // cannot say which one applies.
  const protocols = useMemo(() => readProtocols(text), [text])

  /* Validate the draft through the sidecar's real loader, debounced. A client-side
     check would only ever report JSON syntax; the interesting failures are configs that
     parse and then do nothing. */
  useEffect(() => {
    if (!draft) return
    if (debounce.current) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => {
      setChecking(true)
      void window.xraystudio
        .validateText(draft)
        .then((r) => setDiags(r.diagnostics))
        .catch(() => setDiags(null))
        .finally(() => setChecking(false))
    }, 600)
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current)
    }
  }, [draft])

  const save = useCallback(() => {
    if (!configPath || draft === null || !dirty) return
    void window.xraystudio
      .writeConfig(configPath, draft)
      .then(() => {
        setOriginal(draft)
        setSaved(new Date().toLocaleTimeString())
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [configPath, draft, dirty])

  // Cmd+S while the editor has focus. Scoped to this panel rather than the window: a
  // global handler would fire from other tabs and write a file the user is not looking
  // at.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      save()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: a, selectionEnd: b } = el
      const next = `${text.slice(0, a)}  ${text.slice(b)}`
      setDraft(next)
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
    }
  }

  /* The textarea owns scrolling; the highlight layer and the gutter follow it. They are
     separate elements because a textarea cannot render styled children. */
  const onScroll = (): void => {
    const ta = taRef.current
    if (!ta) return
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop
      preRef.current.scrollLeft = ta.scrollLeft
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop
  }

  const onMouseMove = (e: React.MouseEvent<HTMLTextAreaElement>): void => {
    const ta = taRef.current
    const m = metricsRef.current
    if (!ta || !m || !docs) return

    // Measured, not assumed: the character cell comes from a rendered sample in the
    // same font, so a font fallback or a zoom level cannot silently skew the mapping.
    const charW = m.getBoundingClientRect().width / 10
    const lineH = m.getBoundingClientRect().height
    if (!charW || !lineH) return

    const rect = ta.getBoundingClientRect()
    const padL = 10
    const padT = 8
    const x = e.clientX - rect.left + ta.scrollLeft - padL
    const y = e.clientY - rect.top + ta.scrollTop - padT
    const row = Math.floor(y / lineH)
    if (row < 0 || row >= lines.length) return setHint(null)
    const col = Math.max(0, Math.round(x / charW))
    const line = lines[row] ?? ''
    if (col > line.length) return setHint(null)

    const offset = (lineStarts[row] ?? 0) + Math.min(col, line.length)
    const loc = getLocation(text, offset)
    const path = docPath(loc.path, protocols)
    if (!path) return setHint(null)
    const doc = lookup(docs, path)
    if (!doc) return setHint(null)

    setHint({ doc, path, x: e.clientX, y: e.clientY })
  }

  if (!configPath) {
    return <div className="panel empty">Open a config to edit it.</div>
  }
  if (draft === null) return <div className="panel empty">Loading…</div>

  const errCount = (diags ?? []).filter((d) => d.severity === 'error').length
  const dysCount = (diags ?? []).filter((d) => d.severity === 'dysfunction').length

  return (
    <div className="editor">
      <div className="ed-bar">
        <span className="mono dim ed-path" title={configPath}>
          {configPath.split('/').slice(-2).join('/')}
        </span>
        {dirty && <span className="chip tiny warn">unsaved</span>}
        {syntax.length > 0 ? (
          <span className="chip tiny bad" title={syntax.join('\n')}>
            {syntax[0]}
          </span>
        ) : (
          <>
            {checking && <span className="tiny dim">checking…</span>}
            {!checking && errCount > 0 && <span className="chip tiny bad">{errCount} error</span>}
            {!checking && dysCount > 0 && (
              <span className="chip tiny warn" title="Parses, but does not do what it looks like it does.">
                {dysCount} silently broken
              </span>
            )}
            {!checking && diags !== null && errCount === 0 && dysCount === 0 && (
              <span className="chip tiny ok">clean</span>
            )}
          </>
        )}
        <span className="spacer" />
        {saved && !dirty && <span className="tiny dim">saved {saved}</span>}
        <button className="ghost" disabled={!dirty} onClick={() => setDraft(original)}>
          Revert
        </button>
        <button
          className="primary"
          disabled={!dirty || syntax.length > 0}
          onClick={save}
          title={syntax.length > 0 ? 'Fix the syntax error first' : 'Write to disk (⌘S)'}
        >
          Save to file
        </button>
      </div>

      {error && <p className="note bad">{error}</p>}
      {dirty && (
        <p className="note info tiny">
          The running instance keeps the config it started with. Saving writes the file;
          press Reload in the header to restart Xray against it — a config only takes
          effect by starting a fresh process.
        </p>
      )}

      <div className="ed-wrap">
        {/* Off-screen sample in the editor's own font. Ten characters wide so the
            per-character width survives subpixel rounding. */}
        <span ref={metricsRef} className="ed-metrics mono" aria-hidden="true">
          0000000000
        </span>

        <div className="ed-gutter mono" ref={gutterRef} aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>

        <div className="ed-code">
          <pre className="ed-hl mono" ref={preRef} aria-hidden="true">
            {tokens.map((t, i) => (
              <span key={i} className={t.cls}>
                {t.text}
              </span>
            ))}
          </pre>
          <textarea
            ref={taRef}
            className="ed-input mono"
            spellCheck={false}
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onScroll={onScroll}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setHint(null)}
          />
        </div>
      </div>

      <AiChat configPath={configPath} configText={draft} diags={diags} />

      {hint && <HintPopup hint={hint} />}
    </div>
  )
}

interface Hint {
  doc: NonNullable<ReturnType<typeof lookup>>
  path: string
  x: number
  y: number
}

/** Follows the pointer, clamped to the viewport so it is never cut off at an edge. */
function HintPopup({ hint }: { hint: Hint }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: hint.x + 16, top: hint.y + 18 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let left = hint.x + 16
    let top = hint.y + 18
    if (left + r.width > window.innerWidth - pad) left = hint.x - r.width - 16
    if (top + r.height > window.innerHeight - pad) top = hint.y - r.height - 12
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) })
  }, [hint.x, hint.y, hint.path])

  return (
    <div className="ed-hint" ref={ref} style={{ left: pos.left, top: pos.top }}>
      <div className="ed-hint-head">
        <code className="mono">{hint.doc.name}</code>
        <code className="tiny dim">{hint.doc.type}</code>
      </div>
      <Prose text={hint.doc.summary} />
      {hint.doc.detail && <p className="tiny dim prewrap">{hint.doc.detail}</p>}
      <code className="tiny faint">{hint.path}</code>
    </div>
  )
}

/* ── highlighting ──────────────────────────────────────────────────────────── */

interface Token {
  text: string
  cls: string
}

/**
 * Tokenises with jsonc-parser's own scanner — the same one behind every surgical edit
 * in this app — so highlighting cannot disagree with the parser about what a token is.
 *
 * Whitespace between tokens is emitted verbatim rather than reconstructed, which is
 * what keeps the highlight layer aligned with the textarea character for character.
 */
function highlight(text: string): Token[] {
  const out: Token[] = []
  const scanner = createScanner(text, false)
  let last = 0

  for (;;) {
    const kind = scanner.scan()
    if (kind === K['EOF']) break
    const start = scanner.getTokenOffset()
    if (start > last) out.push({ text: text.slice(last, start), cls: '' })
    const raw = text.slice(start, start + scanner.getTokenLength())
    last = start + scanner.getTokenLength()

    switch (kind) {
      case K['StringLiteral']: {
        // A string followed by a colon is a key. Peeking the remaining text is cheaper
        // and more reliable than tracking nesting state through the scan.
        const rest = text.slice(last)
        const isKey = /^\s*:/.test(rest)
        out.push({ text: raw, cls: isKey ? 'tk-key' : 'tk-str' })
        break
      }
      case K['NumericLiteral']:
        out.push({ text: raw, cls: 'tk-num' })
        break
      case K['TrueKeyword']:
      case K['FalseKeyword']:
      case K['NullKeyword']:
        out.push({ text: raw, cls: 'tk-lit' })
        break
      case K['LineCommentTrivia']:
      case K['BlockCommentTrivia']:
        out.push({ text: raw, cls: 'tk-com' })
        break
      default:
        out.push({ text: raw, cls: 'tk-pun' })
    }
  }
  if (last < text.length) out.push({ text: text.slice(last), cls: '' })
  return out
}

/* ── path → documentation key ──────────────────────────────────────────────── */

/**
 * Protocol per outbound and inbound index, read leniently.
 *
 * Deliberately regex-based rather than a full parse: this runs while the document is
 * being typed and is therefore usually invalid JSON. A hint that disappears the moment
 * you open a brace would be worse than a slightly stale one.
 */
function readProtocols(text: string): { outbounds: string[]; inbounds: string[] } {
  const grab = (section: string): string[] => {
    const at = text.indexOf(`"${section}"`)
    if (at < 0) return []
    const slice = text.slice(at)
    const end = slice.search(/\n\s*["}]\s*(?:,|\s*$)/)
    const body = end > 0 ? slice.slice(0, end) : slice
    return [...body.matchAll(/"protocol"\s*:\s*"([^"]+)"/g)].map((m) => m[1] ?? '')
  }
  return { outbounds: grab('outbounds'), inbounds: grab('inbounds') }
}

/**
 * Turns a JSON location into the key the docs bundle uses.
 *
 * Two shapes exist. Most parameters are keyed structurally with array indices collapsed
 * (`routing.balancers[].selector`); protocol settings are keyed by PROTOCOL instead
 * (`outbounds[vless].settings.address`), because the same key name means different
 * things per protocol and a positional index would collide them.
 */
function docPath(
  path: JSONPath,
  protocols: { outbounds: string[]; inbounds: string[] },
): string | null {
  if (path.length === 0) return null

  const section = path[0]
  if ((section === 'outbounds' || section === 'inbounds') && path[2] === 'settings') {
    const idx = typeof path[1] === 'number' ? path[1] : -1
    const proto = protocols[section][idx]
    if (proto) {
      const rest = path.slice(2).map(seg)
      return `${section}[${proto}].${rest.join('.')}`
    }
  }

  let out = ''
  for (const p of path) {
    if (typeof p === 'number') out += '[]'
    else out += out ? `.${p}` : p
  }
  return out
}

function seg(p: string | number): string {
  return typeof p === 'number' ? '[]' : p
}
