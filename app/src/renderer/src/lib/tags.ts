import { tr } from './i18n'

/**
 * Grouping and ordering for outbound tags.
 *
 * Shared rather than duplicated because the sidebar, the RTT legend and the failure
 * lane must agree: if the chart groups `LTE-*` together and the rail sorts them
 * differently, moving your eye between the two costs a re-read every time.
 */

/**
 * Orders `LTE-2` before `LTE-10`.
 *
 * Plain lexicographic order interleaves them as 1, 10, 11, …, 2, 20, which makes a
 * twenty-outbound list impossible to scan and hides that they are a numbered series
 * at all.
 */
export const natural = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
}).compare

/**
 * Splits a tag into group and member: `REGULAR-1` -> `REGULAR` / `1`.
 *
 * Tags in real configs are overwhelmingly `<ROLE>-<n>`, and the role is the axis people
 * actually reason about ("are the LTE ones all down?"). Anything without a separator is
 * its own group, which keeps small configs from growing a pointless grouping level.
 */
/**
 * The label for a dial made outside any outbound. Read through `tr` rather than
 * frozen at module load, so a language switch reaches it — every consumer rebuilds
 * its model when the language changes.
 */
export const noTagLabel = (): string => tr('tags.noOutboundTag')

export function splitTag(tag: string): { group: string; member: string } {
  // Dials made outside any outbound — the burst observatory's connectivity check and
  // the built-in DNS client both do this — arrive with an empty tag. They are real and
  // worth showing, but an unnamed group heading reads as a rendering fault.
  if (tag === '') {
    const label = noTagLabel()
    return { group: label, member: label }
  }
  const m = /^(.*?)[-_ ](.+)$/.exec(tag)
  if (!m) return { group: tag, member: '' }
  return { group: m[1]!, member: m[2]! }
}

export interface TagGroup<T> {
  name: string
  items: T[]
}

/** Groups by tag prefix, natural-sorted within each group and across groups. */
export function groupBy<T>(items: T[], tagOf: (x: T) => string): TagGroup<T>[] {
  const by = new Map<string, T[]>()
  for (const it of items) {
    const { group } = splitTag(tagOf(it))
    const arr = by.get(group)
    if (arr) arr.push(it)
    else by.set(group, [it])
  }
  return [...by.entries()]
    .map(([name, xs]) => ({ name, items: xs.sort((a, b) => natural(tagOf(a), tagOf(b))) }))
    .sort((a, b) => natural(a.name, b.name))
}
