import { useEffect, useMemo, useRef, useState } from 'react'
import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser'

/**
 * Paste a config instead of picking a file.
 *
 * Configs mostly arrive as text — from a subscription panel, a chat message, a
 * colleague — and the file-picker-only flow forced a detour through a text editor
 * before the tool could say anything at all about them. Which is backwards: telling
 * you what is wrong with a config you were just handed is the whole point.
 *
 * Parsed with jsonc-parser rather than JSON.parse so comments and trailing commas are
 * accepted here exactly as they are everywhere else in the app, and so a syntax error
 * can be reported with a line and column instead of a character offset.
 */
export function PasteConfig({
  onCancel,
  onAccept,
}: {
  onCancel: () => void
  onAccept: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const check = useMemo(() => analyse(text), [text])

  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Paste config JSON</h3>
          <button className="link" onClick={onCancel}>
            close
          </button>
        </div>

        <textarea
          ref={ref}
          className="paste-area mono"
          spellCheck={false}
          placeholder={'{\n  "inbounds": [ … ],\n  "outbounds": [ … ]\n}'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="modal-foot">
          <span className={`tiny ${check.kind === 'error' ? 'bad' : check.kind === 'ok' ? 'ok' : 'dim'}`}>
            {check.message}
          </span>
          <span className="spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={check.kind !== 'ok'} onClick={() => onAccept(text)}>
            Use this config
          </button>
        </div>

        <p className="tiny faint">
          Saved to the app&apos;s own scratch directory, never beside your configs, and
          opened from there. Edits in the Graph tab save back to that copy — your
          original is untouched because there is no original on disk.
        </p>
      </div>
    </div>
  )
}

interface Check {
  kind: 'idle' | 'ok' | 'error'
  message: string
}

function analyse(text: string): Check {
  if (text.trim() === '') return { kind: 'idle', message: 'Paste a config to continue.' }

  const errors: ParseError[] = []
  const doc = parse(text, errors, { allowTrailingComma: true }) as unknown

  if (errors.length > 0) {
    const first = errors[0]!
    const { line, col } = lineCol(text, first.offset)
    return {
      kind: 'error',
      message: `${printParseErrorCode(first.error)} at line ${line}, column ${col}`,
    }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { kind: 'error', message: 'Top level must be a JSON object.' }
  }

  // Deliberately shallow. The real check runs in the sidecar through the core's own
  // loader once the config is open — duplicating its rules here would produce a second
  // opinion that drifts.
  const o = doc as Record<string, unknown>
  if (!Array.isArray(o['outbounds']) || o['outbounds'].length === 0) {
    return { kind: 'error', message: 'No outbounds — there would be nothing to test.' }
  }
  const n = o['outbounds'].length
  const inbounds = Array.isArray(o['inbounds']) ? o['inbounds'].length : 0
  return { kind: 'ok', message: `Parses. ${n} outbound(s), ${inbounds} inbound(s).` }
}

function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1
  let last = -1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++
      last = i
    }
  }
  return { line, col: offset - last }
}
