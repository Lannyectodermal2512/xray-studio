import { useMemo, useState } from 'react'
import { search, useDocs } from '../lib/docs'
import { Prose } from '../components/Prose'

/**
 * Searchable reference for every documented config parameter.
 *
 * Text is adapted from XTLS/Xray-docs-next under CC BY-SA 4.0. Each entry links to its
 * upstream page: that satisfies attribution, and it keeps the authority where it
 * belongs — this extract is a convenience, not a replacement.
 */
export function Reference(): React.JSX.Element {
  const docs = useDocs()
  const active = docs.active ?? docs.fallback
  const [q, setQ] = useState('')
  const results = useMemo(() => search(docs, q), [docs, q])

  if (!active) {
    return (
      <div className="pad">
        <p className="dim">
          Documentation bundle not found. Generate it with{' '}
          <code>go -C tools run ./docsgen -out ../data/docs-en</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="whatif">
      <section className="card">
        <div className="card-head">
          <h3>Parameter reference</h3>
          <span className="tiny dim">
            {Object.keys(active.params).length} parameters · docs @{' '}
            <code>{active.docsCommit.slice(0, 7)}</code>
            {docs.lang !== 'en' && <> · {docs.lang.toUpperCase()}</>}
          </span>
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search by name, path or text — try “tolerance”, “selector”, “sniffing”"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <p className="tiny faint">
          Adapted from the XTLS/Xray-docs-next documentation, licensed CC BY-SA 4.0. Each entry
          links to the original page.
        </p>
      </section>

      {results.length === 0 && (
        <section className="card">
          <p className="dim">No parameter matches “{q}”.</p>
        </section>
      )}

      {results.map((p) => (
        <section key={p.path} className="card diag">
          <div className="card-head">
            <code className="mono">{p.path}</code>
            <code className="tiny dim">{p.type}</code>
          </div>
          <p className="diag-msg">
            <Prose text={p.summary} />
          </p>
          {p.detail && <Prose className="tiny dim prewrap block" text={p.detail} />}
          <a className="tiny doclink" href={p.source} target="_blank" rel="noreferrer">
            official documentation ↗
          </a>
        </section>
      ))}
    </div>
  )
}
