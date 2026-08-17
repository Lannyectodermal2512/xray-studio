import { useEffect, useState } from 'react'
import type { DocBundle, ParamDoc } from '@shared/events'

/**
 * Per-parameter documentation, loaded once.
 *
 * The text is adapted from XTLS/Xray-docs-next under CC BY-SA 4.0 — see
 * data/docs-en/ATTRIBUTION.md. Every tooltip carries a link back to the upstream page,
 * which is both the attribution requirement and the honest thing to do: the official
 * docs are the authority, and this extract is a convenience.
 */

let cache: DocBundle | null | undefined
let inflight: Promise<DocBundle | null> | null = null

async function load(): Promise<DocBundle | null> {
  if (cache !== undefined) return cache
  inflight ??= window.xraystudio.docs().then((b) => {
    cache = b
    return b
  })
  return inflight
}

export function useDocs(): DocBundle | null {
  const [bundle, setBundle] = useState<DocBundle | null>(cache ?? null)
  useEffect(() => {
    let alive = true
    void load().then((b) => {
      if (alive) setBundle(b)
    })
    return () => {
      alive = false
    }
  }, [])
  return bundle
}

/**
 * Looks up a config path, normalising array indices so a concrete path from a real
 * config (`routing.balancers[0].selector`) finds the documented shape
 * (`routing.balancers[].selector`).
 */
export function lookup(bundle: DocBundle | null, path: string): ParamDoc | null {
  if (!bundle) return null
  const normalised = path.replace(/\[\d+\]/g, '[]')
  return bundle.params[normalised] ?? bundle.params[path] ?? null
}

/** Finds every documented parameter whose path or text matches a query. */
export function search(bundle: DocBundle | null, query: string, limit = 60): ParamDoc[] {
  if (!bundle) return []
  const q = query.trim().toLowerCase()
  const all = Object.values(bundle.params)
  if (!q) return all.slice(0, limit)

  // Rank by where the match lands: the parameter name beats the path, which beats the
  // prose. Searching "tolerance" should not first surface a paragraph mentioning it.
  const scored = all
    .map((p) => {
      const name = p.name.toLowerCase()
      const path = p.path.toLowerCase()
      let score = -1
      if (name === q) score = 0
      else if (name.startsWith(q)) score = 1
      else if (name.includes(q)) score = 2
      else if (path.includes(q)) score = 3
      else if (p.summary.toLowerCase().includes(q)) score = 4
      else if ((p.detail ?? '').toLowerCase().includes(q)) score = 5
      return { p, score }
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.p.path.localeCompare(b.p.path))

  return scored.slice(0, limit).map((x) => x.p)
}
