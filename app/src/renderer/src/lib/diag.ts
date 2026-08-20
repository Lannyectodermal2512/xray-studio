import type { Diagnostic } from '@shared/events'
import { en, type Key, type T } from './i18n'

/**
 * Translating validator findings.
 *
 * The sidecar sends each finding in English along with a `key` naming the sentence and
 * a `vars` map holding the values it interpolated. The English text is kept as the
 * fallback rather than removed: a finding added to the Go side before its catalogue
 * entry exists still reads correctly, in English, instead of showing a raw key.
 */
const has = (k: string): k is Key => k in en

export function diagMessage(d: Diagnostic, t: T): string {
  const k = `diag.${d.key}`
  return d.key && has(k) ? t(k, d.vars) : d.message
}

export function diagDetail(d: Diagnostic, t: T): string | undefined {
  const k = `diag.${d.key}.detail`
  if (d.key && has(k)) return t(k, d.vars)
  return d.detail
}
