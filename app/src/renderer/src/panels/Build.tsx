import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Diagnostic } from '@shared/events'
import { effectiveConfigPath, useApp } from '../store/app'
import { parseConfig } from '../graph/edit'
import { ConfigGraph } from './ConfigGraph'
import { Inspector, type Selection } from './Inspector'

/**
 * Visual config editing.
 *
 * Two rules shape this panel:
 *
 *  1. Edits are minimal text patches on a working copy (see graph/edit.ts), so
 *     everything the graph does not model — protocol settings, TLS, Reality, mux — plus
 *     the user's comments and formatting survive untouched.
 *
 *  2. Nothing is written until Save is pressed. This edits a real config the user also
 *     maintains by hand; overwriting it on every keystroke would be indefensible, and
 *     the file watcher would fight the editor.
 */
export function Build(): React.JSX.Element {
  const configPath = useApp(effectiveConfigPath)
  const editRequest = useApp((s) => s.editRequest)
  const clearEditRequest = useApp((s) => s.clearEditRequest)
  const selectedOutbound = useApp((s) => s.selectedOutbound)
  const selectOutbound = useApp((s) => s.selectOutbound)
  const [notFound, setNotFound] = useState<string | null>(null)
  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [diags, setDiags] = useState<Diagnostic[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const debounce = useRef<number | null>(null)

  // Load, and reload whenever the file changes on disk — but never clobber unsaved work.
  const load = useCallback(() => {
    if (!configPath) return
    void window.xraystudio.readConfig(configPath).then((t) => {
      setOriginal(t)
      setDraft((d) => (d === null ? t : d))
    })
  }, [configPath])

  useEffect(load, [load])

  const dirty = draft !== null && original !== null && draft !== original
  const cfg = useMemo(() => (draft ? parseConfig(draft) : null), [draft])

  // "Edit" in the sidebar lands here. Resolve the tag against the parsed draft rather
  // than trusting an index from the rail: the rail lists what telemetry has SEEN, in
  // its own order, so its indices do not correspond to positions in the config.
  useEffect(() => {
    if (!editRequest || !cfg) return
    const i =
      editRequest.kind === 'balancer'
        ? cfg.balancers.findIndex((b) => b.tag === editRequest.tag)
        : cfg.outbounds.findIndex((o) => o.tag === editRequest.tag)
    if (i >= 0) {
      setSelection({ kind: editRequest.kind, index: i })
      setNotFound(null)
    } else {
      // An outbound can exist in telemetry but not in the draft — a dial reported a tag
      // the config no longer has, or the draft was edited. Saying so beats silently
      // opening nothing.
      setNotFound(editRequest.tag)
    }
    clearEditRequest()
  }, [editRequest, cfg, clearEditRequest])

  /* Follow the rail's selection. Picking an outbound there is a statement about which
     host you are looking at, not about which tab you want, so this does not steal the
     view the way "Edit" does — the diagram is simply already on the right node when you
     arrive. Resolved by tag against the parsed draft for the same reason as above: the
     rail's order is telemetry's, not the config's. */
  useEffect(() => {
    if (!selectedOutbound || !cfg) return
    const i = cfg.outbounds.findIndex((o) => o.tag === selectedOutbound)
    if (i >= 0) setSelection({ kind: 'outbound', index: i })
  }, [selectedOutbound, cfg])

  // Validate the draft through the sidecar, which parses it with the very loader the
  // core uses. A client-side check would only tell us about JSON syntax.
  useEffect(() => {
    if (!draft || !dirty) {
      setDiags(null)
      return
    }
    if (debounce.current) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => {
      setChecking(true)
      void window.xraystudio
        .validateText(draft)
        .then((r) => setDiags(r.diagnostics))
        .catch((e: Error) => setError(e.message))
        .finally(() => setChecking(false))
    }, 400)
  }, [draft, dirty])

  const apply = useCallback((text: string, warn?: string[]) => {
    setDraft(text)
    setSaved(null)
    if (warn?.length) setWarnings(warn)
  }, [])

  if (!configPath) return <div className="panel empty">Open a config to edit it.</div>
  if (!draft || !cfg) return <div className="panel empty">Loading…</div>

  const blocking = (diags ?? []).filter((d) => d.severity === 'error')

  return (
    <div className="build">
      <div className="build-bar">
        <span className={dirty ? 'chip warn' : 'chip dim'}>
          {dirty ? 'unsaved changes' : 'no changes'}
        </span>
        {checking && <span className="tiny dim">validating…</span>}
        {!checking && dirty && blocking.length > 0 && (
          <span className="tiny bad">{blocking.length} error(s) — fix before saving</span>
        )}
        {!checking && dirty && blocking.length === 0 && (
          <span className="tiny ok">parses cleanly</span>
        )}
        <span className="spacer" />
        <button
          disabled={!dirty}
          onClick={() => {
            setDraft(original)
            setWarnings([])
            setSaved(null)
          }}
        >
          Revert
        </button>
        <button
          className="primary"
          disabled={!dirty || blocking.length > 0}
          onClick={() => {
            void window.xraystudio
              .writeConfig(configPath, draft)
              .then(() => {
                setOriginal(draft)
                setSaved(new Date().toLocaleTimeString())
              })
              .catch((e: Error) => setError(e.message))
          }}
        >
          Save to file
        </button>
      </div>

      {saved && (
        <p className="note ok">
          Saved at {saved}. The instance keeps running the previous config until you press
          Reload — a config is only applied by starting a fresh process.
        </p>
      )}
      {error && <p className="note bad">{error}</p>}

      {/* `!== null`, not truthiness: the tag can legitimately be the empty string —
          dials made outside any outbound report one — and `{'' && …}` renders nothing,
          which is how the click that raised this silently did nothing at all. */}
      {notFound !== null && (
        <p className="note warn">
          <code className="inline-code">{notFound || '(no outbound tag)'}</code> is
          reported by the running instance but is not in this config text — either it was
          renamed in the draft, or the dial was made outside any outbound (the
          connectivity check and the built-in DNS client both do this).
          <button className="tiny" onClick={() => setNotFound(null)}>
            dismiss
          </button>
        </p>
      )}

      {warnings.length > 0 && (
        <div className="note warn">
          {warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
          <button className="tiny" onClick={() => setWarnings([])}>
            dismiss
          </button>
        </div>
      )}

      {dirty && diags && diags.length > 0 && (
        <div className="build-diags">
          {diags.slice(0, 6).map((d, i) => (
            <p key={i} className={`tiny ${d.severity === 'error' ? 'bad' : 'warn'}`}>
              <strong>{d.severity}</strong> {d.message}
            </p>
          ))}
          {diags.length > 6 && (
            <p className="tiny dim">
              …and {diags.length - 6} more — see the Validate tab for the full report.
            </p>
          )}
        </div>
      )}

      <div className="build-body">
        <div className="build-graph">
          <ConfigGraph
            source={draft}
            selection={selection}
            onSelect={(sel) => {
              setSelection(sel)
              // Push it back to the rail, so the highlighted host is the same one in
              // both places. A diagram and a list disagreeing about what is selected is
              // worse than neither showing anything.
              if (sel?.kind === 'outbound') selectOutbound(cfg?.outbounds[sel.index]?.tag ?? null)
            }}
          />
        </div>
        <aside className="build-side">
          <Inspector
            src={draft}
            cfg={cfg}
            selection={selection}
            onChange={apply}
            onSelect={setSelection}
          />
        </aside>
      </div>
    </div>
  )
}
