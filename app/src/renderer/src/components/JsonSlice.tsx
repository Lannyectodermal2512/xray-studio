import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSONPath } from 'jsonc-parser'
import * as E from '../graph/edit'
import { useT } from '../lib/i18n'

/**
 * Raw JSON editing of one node of the config.
 *
 * The structured fields elsewhere in the inspector only reach what the graph models.
 * For an outbound that is the tag and little else — the substance is `settings.vnext`,
 * `streamSettings`, Reality keys, `mux`, `sockopt`, none of which a form can usefully
 * cover for every protocol. Rather than send people to a separate editor for the parts
 * that matter, this exposes the node's own text.
 *
 * Three properties make it safe to hand someone a textarea onto their live config:
 *
 *  1. It edits a character range, not a parsed value. The user's text is spliced back
 *     between the same offsets, so everything outside — and every comment and choice of
 *     formatting inside — survives exactly as written.
 *  2. Nothing is applied until it parses. A half-typed object cannot reach the draft,
 *     let alone the file.
 *  3. Applying is explicit. Live-applying on keystroke would rewrite the document from
 *     under the graph on every character and make an accidental deletion invisible.
 */
export function JsonSlice({
  src,
  path,
  label,
  onChange,
}: {
  src: string
  path: JSONPath
  label: string
  onChange: (text: string) => void
}): React.JSX.Element | null {
  const { t } = useT()
  const slice = useMemo(() => E.sliceAt(src, path), [src, path])
  // Shown without the document's indentation, so the block reads as a value rather than
  // as a fragment torn out of somewhere deeper. Put back on Apply.
  const shown = useMemo(
    () => (slice ? E.dedent(slice.text, slice.indent) : ''),
    [slice],
  )
  const [text, setText] = useState(shown)
  // Open by default. This is the only place most of an outbound can be edited at all —
  // the fields above it reach the tag and nothing else — so hiding it behind a
  // disclosure made the inspector look like it could not edit the thing it was showing.
  const [open, setOpen] = useState(true)
  // What the document said when this editor was last synced. Used to tell an external
  // change (another field, a reload) from the user's own unapplied typing.
  const base = useRef(shown)

  useEffect(() => {
    if (shown === base.current) return
    // The document moved underneath us — adopt it, since the alternative is applying
    // an edit computed against text that no longer exists.
    base.current = shown
    setText(shown)
  }, [shown])

  if (!slice) return null

  const errors = text.trim() === '' ? ['empty'] : E.fragmentErrors(text)
  const dirty = text !== shown

  return (
    <div className="jslice">
      <button className="jslice-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span>{label} JSON</span>
        {dirty && <span className="chip tiny warn">edited</span>}
        <span className="spacer" />
        <span className="tiny faint">{shown.split('\n').length} lines</span>
      </button>

      {open && (
        <>
          <textarea
            className="jslice-area mono"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // A textarea that swallows Tab is unusable for JSON; a textarea that
              // moves focus on Tab is worse. Insert two spaces, matching the file.
              if (e.key !== 'Tab') return
              e.preventDefault()
              const el = e.currentTarget
              const { selectionStart: a, selectionEnd: b } = el
              const next = `${text.slice(0, a)}  ${text.slice(b)}`
              setText(next)
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
            }}
          />

          <div className="jslice-foot">
            {errors.length > 0 ? (
              <span className="tiny bad">{errors[0] === 'empty' ? 'Empty.' : errors[0]}</span>
            ) : (
              <span className={dirty ? 'tiny warn' : 'tiny dim'}>
                {dirty ? t('slice.parsesNotApplied') : t('slice.matchesDraft')}
              </span>
            )}
            <span className="spacer" />
            <button
              className="tiny"
              disabled={!dirty}
              onClick={() => {
                setText(shown)
                base.current = shown
              }}
            >
              {t('editor.reset')}
            </button>
            <button
              className="tiny primary"
              disabled={!dirty || errors.length > 0}
              onClick={() => {
                // Re-indent on the way back in, so the file keeps the shape it had and
                // the diff is confined to what was actually changed.
                const next = E.replaceSlice(src, path, E.reindent(text, slice.indent))
                base.current = text
                onChange(next)
              }}
            >
              {t('editor.apply')}
            </button>
          </div>

          <p className="tiny faint">
            {t('editor.applyDraftNote')}
          </p>
        </>
      )}
    </div>
  )
}
