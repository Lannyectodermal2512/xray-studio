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
  const selectedOutbound = useApp((s) => s.selectedOutbound)
  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [diags, setDiags] = useState<Diagnostic[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<Hint | null>(null)
  // A pinned hint outlives the pointer. Kept apart from the hovered one rather than as
  // a flag on it, so pinning cannot be undone by the next mouse move over the code.
  const [pinned, setPinned] = useState<Hint | null>(null)

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

  /* Scroll to whatever the rail has selected.

     Keyed on the selection and on whether the file has arrived, with the text itself
     read through a ref. A dependency on `draft` would re-scroll and re-select on every
     keystroke, which is the difference between "go here" and "trap the caret here"; the
     `loaded` flag is needed anyway because the panel mounts before the read resolves,
     and without it a selection made on another tab would find an empty document.

     That is also what makes it work across tabs: pick a host on Observe, open Editor,
     and it is already at that outbound. */
  const textRef = useRef(text)
  textRef.current = text
  const loaded = draft !== null
  useEffect(() => {
    const ta = taRef.current
    const m = metricsRef.current
    if (!ta || !m || !loaded || !selectedOutbound) return
    const at = outboundAt(textRef.current, selectedOutbound)
    if (!at) return

    const lineH = m.getBoundingClientRect().height || 19
    const lineOf = (offset: number): number =>
      textRef.current.slice(0, offset).split('\n').length - 1
    const first = lineOf(at.start)
    const last = lineOf(at.end)

    /* Park the outbound's last line on the bottom edge, so the whole block is on screen
       and the reading starts at its opening brace rather than somewhere in the middle.
       
       Unless it does not fit — a wireguard peer list or a long fallback set can be
       taller than the window, and then the end-at-the-bottom rule would put the tag off
       the top, leaving a screen of settings with nothing saying whose they are. The
       `min` picks whichever constraint binds: end at the bottom when the block fits,
       start at the top when it does not. */
    const endAtBottom = (last + 1) * lineH - ta.clientHeight
    ta.scrollTop = Math.max(0, Math.min(first * lineH, endAtBottom))
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(at.tagOffset, at.tagOffset + at.tagLength)
  }, [selectedOutbound, loaded])

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
    if (e.key === 'Escape' && pinned) {
      e.preventDefault()
      setPinned(null)
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
    // While something is pinned it owns the popup; a second one over the pointer would
    // put two overlapping explanations on screen.
    if (pinned) return

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
    let hit: { doc: NonNullable<ReturnType<typeof lookup>>; path: string } | null = null
    for (const candidate of docPath(loc.path, protocols)) {
      const doc = lookup(docs, candidate)
      if (doc) {
        hit = { doc, path: candidate }
        break
      }
    }
    if (!hit) return setHint(null)

    setHint({ doc: hit.doc, path: hit.path, x: e.clientX, y: e.clientY })
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
            /* Clicking a documented token pins its hint. The click still places the
               caret, which is what a click in a text editor is for — pinning rides
               along rather than taking the gesture over. Clicking anywhere without
               documentation puts the popup away. */
            onClick={() => setPinned(hint)}
          />
        </div>
      </div>

      <AiChat configPath={configPath} configText={draft} diags={diags} />

      {(pinned ?? hint) && (
        <HintPopup hint={(pinned ?? hint)!} pinned={pinned !== null} onClose={() => setPinned(null)} />
      )}
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
/**
 * The hint, in two modes.
 *
 * Hovering is a glance and stays one: the popup is clamped to a fraction of the
 * viewport and never takes the pointer, so it cannot get between you and the code. A
 * third of the upstream entries do not fit — `dns.servers` alone is 3kB across
 * twenty-odd paragraphs — and an unclamped popup for those simply ran off the bottom of
 * the screen with no way to reach the rest.
 *
 * Clicking the token pins it. A pinned hint keeps its place, takes the pointer, scrolls,
 * and offers the way out to the Reference tab for the entries where scrolling a popup is
 * still the wrong way to read something.
 */
function HintPopup({
  hint,
  pinned,
  onClose,
}: {
  hint: Hint
  pinned: boolean
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: hint.x + 16, top: hint.y + 18 })
  const [clipped, setClipped] = useState(false)
  const requestDoc = useApp((s) => s.requestDoc)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let left = hint.x + 16
    if (left + r.width > window.innerWidth - pad) left = hint.x - r.width - 16

    // Prefer below, flip above when that overflows, and slide up as a last resort. The
    // slide matters for a pinned hint: at 70vh it rarely fits above the pointer either,
    // and clamping to the top of the window instead would park it over the toolbar —
    // across Start, Stop and Reload, the controls most likely to be wanted next.
    let top = hint.y + 18
    if (top + r.height > window.innerHeight - pad) {
      const above = hint.y - r.height - 12
      top = above >= pad ? above : window.innerHeight - pad - r.height
    }
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) })
    setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [hint.x, hint.y, hint.path, pinned])

  return (
    <div
      className={pinned ? 'ed-hint pinned' : 'ed-hint'}
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="ed-hint-head">
        <code className="mono">{hint.doc.name}</code>
        <code className="tiny dim">{hint.doc.type}</code>
        {!hint.doc.translated && <span className="chip tiny faint">EN</span>}
        {pinned && (
          <>
            <span className="spacer" />
            <button className="link tiny" onClick={() => requestDoc(hint.path)}>
              full text ↗
            </button>
            <button className="link tiny" onClick={onClose} title="Escape">
              ✕
            </button>
          </>
        )}
      </div>
      <Prose text={hint.doc.summary} />
      {hint.doc.detail && <p className="tiny dim prewrap">{hint.doc.detail}</p>}
      <code className="tiny faint">{hint.path}</code>
      {/* Only when there is genuinely more below: a fade over text that already ends
          would be a promise of content that is not there. */}
      {!pinned && clipped && <div className="ed-hint-more">click to pin and scroll</div>}
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
 * Protocol per outbound and inbound index.
 *
 * Read from the tolerant parse tree, which is the same thing `getLocation` walks a few
 * lines later — so the protocol and the path a hint resolves through always come from
 * one reading of the document, and a half-typed brace degrades both together instead of
 * pairing a stale protocol with a fresh path.
 *
 * This was a regex over the raw text, which stopped at the first `},` it saw. That is
 * the end of the FIRST outbound's settings, so every outbound after the first had no
 * known protocol — and with no protocol there is no `outbounds[vless].settings.*` key
 * to look up. Hovering anything inside them found nothing at all.
 */
function readProtocols(text: string): { outbounds: string[]; inbounds: string[] } {
  const root = jsonc.parseTree(text)
  const grab = (section: string): string[] => {
    const arr = root ? jsonc.findNodeAtLocation(root, [section]) : undefined
    return (arr?.children ?? []).map(
      (item) => (jsonc.findNodeAtLocation(item, ['protocol'])?.value as string) ?? '',
    )
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
/**
 * Where an outbound lives in the text: its `tag` value, and the whole object.
 *
 * Located through the parse tree rather than by searching for the tag as a string: a
 * tag can appear in a routing rule, a balancer selector or a fallbackTag long before it
 * appears in the outbound it names, and jumping to the first textual occurrence would
 * land somewhere else entirely.
 */
function outboundAt(
  text: string,
  tag: string,
): { tagOffset: number; tagLength: number; start: number; end: number } | null {
  const root = jsonc.parseTree(text)
  if (!root) return null
  const arr = jsonc.findNodeAtLocation(root, ['outbounds'])
  for (const item of arr?.children ?? []) {
    const node = jsonc.findNodeAtLocation(item, ['tag'])
    if (node && node.value === tag) {
      return {
        tagOffset: node.offset,
        tagLength: node.length,
        start: item.offset,
        end: item.offset + item.length,
      }
    }
  }
  return null
}

/**
 * Legacy containers inside protocol `settings`.
 *
 * v26.7.28 accepts both shapes: `settings.address` directly, and the older
 * `settings.vnext[0].users[0].id` that most panels still emit — `Build()` folds the
 * first into the second. Upstream documents only the flat form, so a config written the
 * old way found nothing for any field inside `settings`, which is most of a config.
 *
 * Dropped rather than mapped one by one: the containers carry no fields of their own,
 * so removing them is exactly what turns a legacy path into the documented one.
 */
const LEGACY_CONTAINERS = new Set(['vnext', 'servers', 'users', 'clients'])

/**
 * Renamed keys, old spelling to documented one.
 *
 * `StreamConfig` declares both members of each pair and reads either — `tcpSettings`
 * and `rawSettings` are both `*TCPConfig`, `splithttpSettings` and `xhttpSettings` both
 * `*SplitHTTPConfig` — so a config written against older documentation is correct and
 * must still get its hint.
 *
 * Matched as a prefix, because the renamed thing is sometimes a whole subtree: every
 * key under `tcpSettings` is documented under `rawSettings` and nowhere else.
 *
 * An explicit table rather than anything inferred. These are two names for one thing
 * only because upstream says so, and guessing from spelling would eventually pair keys
 * that merely look alike.
 */
const LEGACY_KEYS: Record<string, string> = {
  'streamSettings.tcpSettings': 'streamSettings.rawSettings',
  'streamSettings.splithttpSettings': 'streamSettings.xhttpSettings',
  'streamSettings.network': 'streamSettings.method',
  'streamSettings.realitySettings.publicKey': 'streamSettings.realitySettings.password',
}

/**
 * Config path to documentation keys, best first.
 *
 * More than one because a path can be documented under a shape other than the one it
 * was written in; the caller takes the first that resolves.
 */
function docPath(
  path: JSONPath,
  protocols: { outbounds: string[]; inbounds: string[] },
): string[] {
  if (path.length === 0) return []
  const out: string[] = []

  const section = path[0]
  if ((section === 'outbounds' || section === 'inbounds') && path[2] === 'settings') {
    const idx = typeof path[1] === 'number' ? path[1] : -1
    const proto = protocols[section][idx]
    if (proto) {
      const rest = path.slice(2)
      out.push(`${section}[${proto}].${rest.map(seg).join('.')}`)

      // The index following a dropped container goes with it, or the flattened path
      // would carry a stray "[]".
      const kept: (string | number)[] = []
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i]!
        if (typeof p === 'string' && LEGACY_CONTAINERS.has(p)) {
          if (typeof rest[i + 1] === 'number') i++
          continue
        }
        kept.push(p)
      }
      if (kept.length !== rest.length) {
        out.push(`${section}[${proto}].${kept.map(seg).join('.')}`)
      }
    }
  }

  let generic = ''
  for (const p of path) {
    if (typeof p === 'number') generic += '[]'
    else generic += generic ? `.${p}` : p
  }
  out.push(generic)

  /* Transport settings are documented once, as a shared object keyed `streamSettings.*`,
     because the same block hangs off both an inbound and an outbound. A config path
     therefore always carries a section prefix the documentation does not, and without
     this nothing inside `streamSettings` resolved at all. Re-keying the bundle per
     section was the alternative, and it would list all sixty-odd entries twice in the
     Reference tab to say the same thing. */
  const at = generic.indexOf('streamSettings')
  if (at > 0) out.push(generic.slice(at))

  // Old spellings the core still accepts under names upstream has stopped documenting.
  for (const p of [...out]) {
    for (const [from, to] of Object.entries(LEGACY_KEYS)) {
      if (p === from) out.push(to)
      else if (p.startsWith(`${from}.`)) out.push(to + p.slice(from.length))
    }
  }

  return out
}

function seg(p: string | number): string {
  return typeof p === 'number' ? '[]' : p
}
