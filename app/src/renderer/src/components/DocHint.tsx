import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { lookup, useDocs } from '../lib/docs'
import { Prose } from './Prose'

const WIDTH = 340
const MARGIN = 8
const GAP = 6

/**
 * A hover hint carrying the official description of one config parameter.
 *
 * Kept separate from the app's own explanatory copy on purpose. This text is upstream
 * documentation (CC BY-SA 4.0, linked and attributed); the notes the app writes itself
 * — about behaviour the docs do not mention, like leastLoad degrading without
 * burstObservatory — are ours. Blurring the two would misattribute both.
 *
 * The popup is PORTALLED to <body> and positioned in viewport coordinates rather than
 * placed absolutely inside its trigger. Two reasons, both of which broke the old
 * version: hints sit inside panels that scroll and clip (`overflow: auto` on the
 * inspector rail), so an absolutely-positioned child was cut off rather than
 * overflowing; and a hint near the right or bottom edge ran off-screen entirely, which
 * is worst exactly where the inspector lives. Fixed positioning plus clamping means a
 * hint is always fully readable no matter where its trigger sits.
 */
export function DocHint({ path }: { path: string }): React.JSX.Element | null {
  const bundle = useDocs()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const doc = lookup(bundle, path)

  // useLayoutEffect, not useEffect: measuring after paint would show the popup at its
  // unclamped position for one frame, which reads as a jump.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const anchor = anchorRef.current?.getBoundingClientRect()
    if (!anchor) return
    // The popup's height is content-dependent, so measure it rather than guessing.
    // On the first pass it is not laid out yet; fall back to a plausible height and
    // let the second pass correct it.
    const height = popRef.current?.offsetHeight ?? 160
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = anchor.left
    if (left + WIDTH > vw - MARGIN) left = vw - MARGIN - WIDTH
    if (left < MARGIN) left = MARGIN

    // Prefer below; flip above when that would overflow and there is more room up top.
    let top = anchor.bottom + GAP
    if (top + height > vh - MARGIN) {
      const above = anchor.top - GAP - height
      top = above >= MARGIN ? above : Math.max(MARGIN, vh - MARGIN - height)
    }
    setPos({ left, top })
  }, [open, doc])

  if (!doc) return null

  return (
    <span
      ref={anchorRef}
      className="dochint"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="dochint-btn"
        aria-label={`What does ${doc.name} do?`}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="dochint-pop"
            role="tooltip"
            // Hidden until measured, rather than not rendered: the measurement pass
            // needs it in the DOM to have a height at all.
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            <span className="dochint-head">
              <code className="mono">{doc.name}</code>
              <code className="tiny dim">{doc.type}</code>
            </span>
            <Prose className="dochint-body" text={doc.summary} />
            {doc.detail && <Prose className="dochint-detail" text={doc.detail} />}
            <a className="tiny doclink" href={doc.source} target="_blank" rel="noreferrer">
              official documentation ↗
            </a>
          </div>,
          document.body,
        )}
    </span>
  )
}
