import { useSyncExternalStore } from 'react'

/**
 * Language of the PARAMETER DOCUMENTATION, and of nothing else.
 *
 * The interface itself is English only. This setting picks which upstream
 * documentation bundle the tooltips and the Reference tab read from — the text is
 * XTLS/Xray-docs-next, translated by the Xray project rather than by this app, so the
 * choice is between two authored sources rather than between an original and a machine
 * rendering of it.
 *
 * Kept outside the zustand store on purpose: it is a property of the installation
 * rather than of the session, it has to be readable before React mounts, and changing
 * it must not invalidate telemetry state.
 */

export type DocLang = 'en' | 'ru'

/** Every bundle shipped in data/docs-<lang>/. Add a locale here and it appears. */
export const DOC_LANGS: { id: DocLang; label: string; full: string }[] = [
  { id: 'en', label: 'EN', full: 'English' },
  { id: 'ru', label: 'RU', full: 'Русский' },
]

const STORAGE_KEY = 'xray-studio.doc-lang'

function initial(): DocLang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'ru') return saved
  } catch {
    /* private mode, or storage disabled */
  }
  // Follow the system on first run, then never again — an explicit choice outranks it.
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

let current: DocLang = initial()
const listeners = new Set<() => void>()

export function getDocLang(): DocLang {
  return current
}

export function setDocLang(next: DocLang): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* not fatal: the choice simply will not survive a restart */
  }
  for (const l of listeners) l()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useDocLang(): DocLang {
  return useSyncExternalStore(subscribe, getDocLang, getDocLang)
}
