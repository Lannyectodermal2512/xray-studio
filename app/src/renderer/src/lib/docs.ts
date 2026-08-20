import { useEffect, useState } from 'react'
import { useDocLang } from './docLang'
import type { DocBundle, ParamDoc } from '@shared/events'

/**
 * Per-parameter documentation, loaded once.
 *
 * The text is adapted from XTLS/Xray-docs-next under CC BY-SA 4.0 — see
 * data/docs-en/ATTRIBUTION.md. Every tooltip carries a link back to the upstream page,
 * which is both the attribution requirement and the honest thing to do: the official
 * docs are the authority, and this extract is a convenience.
 */

const cache = new Map<string, DocBundle | null>()
const inflight = new Map<string, Promise<DocBundle | null>>()

async function load(lang: string): Promise<DocBundle | null> {
  if (cache.has(lang)) return cache.get(lang) ?? null
  let p = inflight.get(lang)
  if (!p) {
    p = window.xraystudio.docs(lang).then((b) => {
      cache.set(lang, b)
      return b
    })
    inflight.set(lang, p)
  }
  return p
}

/**
 * The active locale's bundle, with English behind it.
 *
 * Both are loaded, because the fallback is per PARAMETER rather than per bundle: the
 * upstream translation can be complete today and gain a parameter tomorrow, and the
 * useful behaviour then is an English description for that one key rather than an empty
 * tooltip or a wholesale switch back to English.
 */
export interface Docs {
  active: DocBundle | null
  fallback: DocBundle | null
  lang: string
}

export function useDocs(): Docs {
  const lang = useDocLang()
  const [docs, setDocs] = useState<Docs>({ active: null, fallback: null, lang })

  useEffect(() => {
    let alive = true
    void Promise.all([load(lang), lang === 'en' ? Promise.resolve(null) : load('en')]).then(
      ([active, fallback]) => {
        if (alive) setDocs({ active, fallback, lang })
      },
    )
    return () => {
      alive = false
    }
  }, [lang])

  return docs
}

/**
 * Looks up a config path, normalising array indices so a concrete path from a real
 * config (`routing.balancers[0].selector`) finds the documented shape
 * (`routing.balancers[].selector`).
 */
function pick(bundle: DocBundle | null, path: string): ParamDoc | null {
  if (!bundle) return null
  const normalised = path.replace(/\[\d+\]/g, '[]')
  return bundle.params[normalised] ?? bundle.params[path] ?? null
}

/**
 * Looks a parameter up in the active language, falling back to English for that one
 * parameter. `translated` is false when the fallback was used, so the UI can say which
 * language the reader is actually looking at.
 */
export function lookup(
  docs: Docs,
  path: string,
): (ParamDoc & { translated: boolean }) | null {
  const active = pick(docs.active, path)
  if (active) return { ...active, translated: true }
  const fallback = pick(docs.fallback, path)
  return fallback ? { ...fallback, translated: docs.lang === 'en' } : null
}

/** Finds every documented parameter whose path or text matches a query. */
export function search(docs: Docs, query: string, limit = 60): ParamDoc[] {
  const bundle = docs.active ?? docs.fallback
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
