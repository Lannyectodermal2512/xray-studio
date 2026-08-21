/**
 * Reading values out of somebody else's JSON.
 *
 * The config under test is an arbitrary file. TypeScript's `as` asserts a shape without
 * checking it, so `(doc['selector'] as string[]) ?? []` is a promise about a value the
 * compiler has never seen — and when the file disagrees, the promise is broken at the
 * first method call. `"interval": 30` instead of `"30s"` reached `interval.matchAll`
 * and took the entire window down with it, from a config Xray itself would merely have
 * refused to load.
 *
 * These check instead of assert. They are deliberately forgiving: this is a tool for
 * looking at broken configs, so a field of the wrong type should render as best it can
 * and let the Validate tab be the thing that objects.
 */

/**
 * A list of strings from whatever was written.
 *
 * A bare string becomes a one-element list, split on commas the way Xray's own
 * StringList does, since several of the fields this reads accept exactly that.
 * Non-string members are dropped rather than stringified: a number in a selector list
 * is a mistake, and rendering it as `"0"` would hide it.
 */
export function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

/** A string, or undefined if it was not one. Numbers are NOT coerced — see below. */
export function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** A number, or undefined if it was not one. */
export function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * A duration string.
 *
 * A number is not silently turned into `"30s"`. Xray's duration fields take a string,
 * so a bare number is a real error in the config, and inventing a unit here would put a
 * value in the editor that the user never wrote and Xray will never accept.
 */
export function optDuration(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
