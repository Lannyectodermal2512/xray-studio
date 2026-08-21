import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type JSONPath,
  type ParseError,
} from 'jsonc-parser'
// With the .ts extension, because this module is also loaded directly by Node for
// test/edit-indent.test.mts — Node's ESM resolver does not guess extensions, and the
// test imports this file the same way.
import { optDuration, optNum, optStr, strList } from '../lib/coerce.ts'

/**
 * Surgical edits to a config's TEXT.
 *
 * Every operation is a minimal text patch, never a re-serialisation. That matters more
 * than it might look: the graph models tags, balancers and routing rules, but a real
 * config also carries protocol settings, streamSettings, TLS and Reality keys, `mux`,
 * `sockopt` — none of which the graph understands. Rebuilding JSON from the graph model
 * would silently delete all of it.
 *
 * Using jsonc-parser additionally preserves comments and the user's own formatting, so
 * the file stays theirs. They are expected to keep editing it in their own editor; a
 * tool that reformatted the whole document on every click would be intolerable.
 */

const FORMAT: FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: '\n',
}

function edit(src: string, path: JSONPath, value: unknown, isArrayInsertion = false): string {
  const edits = modify(src, path, value, {
    formattingOptions: FORMAT,
    ...(isArrayInsertion ? { isArrayInsertion: true } : {}),
  })
  return applyEdits(src, edits)
}

/** Deleting is `modify` with undefined — the same minimal-edit machinery. */
function remove(src: string, path: JSONPath): string {
  return edit(src, path, undefined)
}

export interface ObservatorySettings {
  burst: boolean
  subjectSelector: string[]
  /** plain only */
  probeUrl?: string | undefined
  probeInterval?: string | undefined
  enableConcurrency?: boolean | undefined
  /** burst only */
  destination?: string | undefined
  interval?: string | undefined
  sampling?: number | undefined
  timeout?: string | undefined
  connectivity?: string | undefined
}

/**
 * One entry of `dns.servers`.
 *
 * The field is polymorphic: an element is either a bare address string or an object
 * with per-server overrides. Both forms are common in real configs — the string form
 * for a plain resolver list, the object form the moment domain routing is wanted — so
 * the editor has to keep whichever the user wrote rather than normalising to one and
 * rewriting their file.
 */
export interface DnsServerEntry {
  simple: boolean
  address: string
  port?: number | undefined
  tag?: string | undefined
  domains?: string[] | undefined
  expectedIPs?: string[] | undefined
  skipFallback?: boolean | undefined
  queryStrategy?: string | undefined
}

export interface DnsSettings {
  servers: DnsServerEntry[]
  queryStrategy?: string | undefined
  tag?: string | undefined
  clientIp?: string | undefined
  disableCache?: boolean | undefined
  disableFallback?: boolean | undefined
  disableFallbackIfMatch?: boolean | undefined
  enableParallelQuery?: boolean | undefined
  useSystemHosts?: boolean | undefined
  serveStale?: boolean | undefined
  hostsCount: number
}

export interface ParsedConfig {
  outbounds: Array<{ tag?: string; protocol?: string }>
  balancers: Array<{
    tag?: string
    selector?: string[]
    fallbackTag?: string
    strategy?: { type?: string; settings?: Record<string, unknown> }
  }>
  rules: Array<{
    inboundTag?: string[]
    balancerTag?: string
    outboundTag?: string
    ruleTag?: string
  }>
  inbounds: Array<{ tag?: string; protocol?: string; port?: unknown }>
  hasObservatory: boolean
  hasBurst: boolean
  observatory: ObservatorySettings | null
  dns: DnsSettings | null
}

/** Reads the parts of a config the graph edits. Tolerant: a malformed file yields empties. */
export function parseConfig(src: string): ParsedConfig | null {
  const errors: { error: number; offset: number; length: number }[] = []
  const doc = parse(src, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined
  if (!doc || typeof doc !== 'object') return null

  const routing = (doc['routing'] ?? {}) as Record<string, unknown>
  return {
    outbounds: (doc['outbounds'] as ParsedConfig['outbounds']) ?? [],
    inbounds: (doc['inbounds'] as ParsedConfig['inbounds']) ?? [],
    balancers: (routing['balancers'] as ParsedConfig['balancers']) ?? [],
    rules: (routing['rules'] as ParsedConfig['rules']) ?? [],
    hasObservatory: doc['observatory'] != null,
    hasBurst: doc['burstObservatory'] != null,
    observatory: readObservatory(doc),
    dns: readDns(doc),
  }
}

/* ── outbounds ─────────────────────────────────────────────────────────────── */

/**
 * Renames an outbound and repoints everything that referenced it.
 *
 * A rename that did not follow through would be worse than no rename at all: balancer
 * selectors are PREFIX matches, so renaming `proxy-a` to `a-proxy` silently drops it
 * out of `selector: ["proxy-"]` with no error anywhere. References are updated where
 * they are exact (fallbackTag, outboundTag); selectors are left alone and reported,
 * because a prefix is a deliberate pattern and rewriting it would be a guess.
 */
export function renameOutbound(
  src: string,
  index: number,
  next: string,
): { text: string; warnings: string[] } {
  const cfg = parseConfig(src)
  const prev = cfg?.outbounds[index]?.tag
  let text = edit(src, ['outbounds', index, 'tag'], next)
  const warnings: string[] = []
  if (!cfg || !prev || prev === next) return { text, warnings }

  cfg.balancers.forEach((b, i) => {
    if (b.fallbackTag === prev) {
      text = edit(text, ['routing', 'balancers', i, 'fallbackTag'], next)
    }
    const matching = (b.selector ?? []).filter((s) => prev.startsWith(s) && !next.startsWith(s))
    if (matching.length > 0) {
      warnings.push(
        `Balancer "${b.tag ?? i}" selects by prefix ${matching.map((s) => `"${s}"`).join(', ')}, ` +
          `which matched "${prev}" but does not match "${next}". It has been left as-is — ` +
          `a prefix is a pattern, not a reference, so rewriting it would be a guess. ` +
          `The outbound is no longer part of that balancer.`,
      )
    }
  })

  cfg.rules.forEach((r, i) => {
    if (r.outboundTag === prev) {
      text = edit(text, ['routing', 'rules', i, 'outboundTag'], next)
    }
  })

  return { text, warnings }
}

export function addOutbound(src: string, tag: string, protocol: string): string {
  const cfg = parseConfig(src)
  const at = cfg?.outbounds.length ?? 0
  // freedom and blackhole need no settings; anything else gets an empty object so the
  // user has an obvious place to fill in, rather than a key that silently defaults.
  const body: Record<string, unknown> = { tag, protocol }
  if (protocol !== 'freedom' && protocol !== 'blackhole') body['settings'] = {}
  return edit(src, ['outbounds', at], body, true)
}

export function removeOutbound(src: string, index: number): string {
  return remove(src, ['outbounds', index])
}

/* ── balancers ─────────────────────────────────────────────────────────────── */

export function addBalancer(src: string, tag: string, selector: string[]): string {
  const cfg = parseConfig(src)
  const at = cfg?.balancers.length ?? 0
  return edit(
    src,
    ['routing', 'balancers', at],
    { tag, selector, strategy: { type: 'leastLoad', settings: { expected: 1 } } },
    true,
  )
}

export function removeBalancer(src: string, index: number): string {
  return remove(src, ['routing', 'balancers', index])
}

export function setBalancerTag(src: string, index: number, tag: string): string {
  const cfg = parseConfig(src)
  const prev = cfg?.balancers[index]?.tag
  let text = edit(src, ['routing', 'balancers', index, 'tag'], tag)
  // A rule pointing at the old tag would make the instance fail to start with
  // "balancer <tag> not found", so follow the reference.
  cfg?.rules.forEach((r, i) => {
    if (prev && r.balancerTag === prev) {
      text = edit(text, ['routing', 'rules', i, 'balancerTag'], tag)
    }
  })
  return text
}

export function setBalancerSelector(src: string, index: number, selector: string[]): string {
  return edit(src, ['routing', 'balancers', index, 'selector'], selector)
}

export function setBalancerFallback(src: string, index: number, tag: string): string {
  return edit(src, ['routing', 'balancers', index, 'fallbackTag'], tag === '' ? undefined : tag)
}

export function setBalancerStrategy(src: string, index: number, type: string): string {
  let text = edit(src, ['routing', 'balancers', index, 'strategy', 'type'], type)
  // Only leastLoad reads strategy.settings; on the others it parses and is discarded.
  // Dropping it on switch avoids leaving behind config that looks active but is inert.
  if (type !== 'leastLoad') {
    text = remove(text, ['routing', 'balancers', index, 'strategy', 'settings'])
  }
  return text
}

export function setStrategySetting(
  src: string,
  index: number,
  key: string,
  value: unknown,
): string {
  return edit(src, ['routing', 'balancers', index, 'strategy', 'settings', key], value)
}

/* ── rules ─────────────────────────────────────────────────────────────────── */

export function addRule(src: string, inboundTag: string, target: { balancerTag?: string; outboundTag?: string }): string {
  const cfg = parseConfig(src)
  const at = cfg?.rules.length ?? 0
  const body: Record<string, unknown> = {}
  if (inboundTag) body['inboundTag'] = [inboundTag]
  Object.assign(body, target)
  return edit(src, ['routing', 'rules', at], body, true)
}

export function removeRule(src: string, index: number): string {
  return remove(src, ['routing', 'rules', index])
}

/**
 * Points a rule at a balancer or an outbound.
 *
 * The two are mutually exclusive in effect: when both are present Xray takes
 * `outboundTag` and ignores `balancerTag` entirely, with no warning. Setting one
 * therefore clears the other rather than leaving a config whose visible intent and
 * actual behaviour disagree.
 */
export function setRuleTarget(
  src: string,
  index: number,
  kind: 'balancerTag' | 'outboundTag',
  value: string,
): string {
  const other = kind === 'balancerTag' ? 'outboundTag' : 'balancerTag'
  let text = edit(src, ['routing', 'rules', index, kind], value === '' ? undefined : value)
  text = remove(text, ['routing', 'rules', index, other])
  return text
}

/* ── observatory ───────────────────────────────────────────────────────────── */

/**
 * Adds an observatory covering the given selectors.
 *
 * Offered because leastPing and leastLoad without one do not fail cleanly: the
 * dependency is resolved lazily, so core.New reports only "not all dependencies are
 * resolved." with no mention of which balancer caused it.
 */
export function addObservatory(src: string, selectors: string[], burst: boolean): string {
  if (burst) {
    return edit(src, ['burstObservatory'], {
      subjectSelector: selectors,
      pingConfig: {
        destination: 'https://connectivitycheck.gstatic.com/generate_204',
        interval: '30s',
        sampling: 10,
        timeout: '5s',
      },
    })
  }
  return edit(src, ['observatory'], {
    subjectSelector: selectors,
    probeUrl: 'https://www.google.com/generate_204',
    probeInterval: '10s',
    enableConcurrency: true,
  })
}


/* ── observatory ───────────────────────────────────────────────────────────── */

function readObservatory(doc: Record<string, unknown>): ObservatorySettings | null {
  const burst = doc['burstObservatory'] as Record<string, unknown> | undefined
  if (burst) {
    const ping = (burst['pingConfig'] ?? {}) as Record<string, unknown>
    return {
      burst: true,
      subjectSelector: strList(burst['subjectSelector']),
      destination: optStr(ping['destination']),
      interval: optDuration(ping['interval']),
      sampling: optNum(ping['sampling']),
      timeout: optDuration(ping['timeout']),
      connectivity: optStr(ping['connectivity']),
    }
  }
  const plain = doc['observatory'] as Record<string, unknown> | undefined
  if (!plain) return null
  return {
    burst: false,
    subjectSelector: strList(plain['subjectSelector']),
    probeUrl: optStr(plain['probeUrl']),
    probeInterval: optDuration(plain['probeInterval']),
    enableConcurrency: plain['enableConcurrency'] as boolean | undefined,
  }
}

/** Path to a field of whichever observatory block the config uses. */
function obsPath(burst: boolean, key: string): JSONPath {
  if (!burst) return ['observatory', key]
  // Everything except subjectSelector lives under pingConfig for the burst variant.
  return key === 'subjectSelector' ? ['burstObservatory', key] : ['burstObservatory', 'pingConfig', key]
}

export function setObservatoryField(
  src: string,
  burst: boolean,
  key: string,
  value: unknown,
): string {
  return edit(src, obsPath(burst, key), value === '' ? undefined : value)
}

export function removeObservatory(src: string, burst: boolean): string {
  return remove(src, [burst ? 'burstObservatory' : 'observatory'])
}

/**
 * Switches between the two observatory kinds.
 *
 * They are not interchangeable and the difference is not cosmetic: only burst produces
 * HealthPing data, which is what leastLoad ranks on. Without it leastLoad degrades to
 * leastPing with a cost multiplier, and `tolerance` stops doing anything at all.
 */
export function convertObservatory(src: string, toBurst: boolean, selectors: string[]): string {
  const cleared = remove(src, [toBurst ? 'observatory' : 'burstObservatory'])
  return addObservatory(cleared, selectors, toBurst)
}

/* ── dns ───────────────────────────────────────────────────────────────────── */

function readDns(doc: Record<string, unknown>): DnsSettings | null {
  const dns = doc['dns'] as Record<string, unknown> | undefined
  if (!dns) return null

  const raw = (dns['servers'] as unknown[]) ?? []
  const servers: DnsServerEntry[] = raw.map((s) => {
    if (typeof s === 'string') return { simple: true, address: s }
    const o = (s ?? {}) as Record<string, unknown>
    return {
      simple: false,
      address: String(o['address'] ?? ''),
      port: o['port'] as number | undefined,
      tag: o['tag'] as string | undefined,
      domains: strList(o['domains']),
      // Both spellings exist in the parser; expectedIPs is the current one and
      // expectIPs the legacy alias, so read whichever the config actually uses.
      expectedIPs: strList(o['expectedIPs'] ?? o['expectIPs']),
      skipFallback: o['skipFallback'] as boolean | undefined,
      queryStrategy: o['queryStrategy'] as string | undefined,
    }
  })

  const hosts = dns['hosts'] as Record<string, unknown> | undefined
  return {
    servers,
    queryStrategy: dns['queryStrategy'] as string | undefined,
    tag: dns['tag'] as string | undefined,
    clientIp: dns['clientIp'] as string | undefined,
    disableCache: dns['disableCache'] as boolean | undefined,
    disableFallback: dns['disableFallback'] as boolean | undefined,
    disableFallbackIfMatch: dns['disableFallbackIfMatch'] as boolean | undefined,
    enableParallelQuery: dns['enableParallelQuery'] as boolean | undefined,
    useSystemHosts: dns['useSystemHosts'] as boolean | undefined,
    serveStale: dns['serveStale'] as boolean | undefined,
    hostsCount: hosts ? Object.keys(hosts).length : 0,
  }
}

/** Creates a `dns` block. The defaults are deliberately plain resolvers with no
 *  domain routing — an opinionated starter would be a guess about someone's network. */
export function addDns(src: string): string {
  return edit(src, ['dns'], { servers: ['1.1.1.1', 'localhost'], queryStrategy: 'UseIP' })
}

export function removeDns(src: string): string {
  return remove(src, ['dns'])
}

export function setDnsField(src: string, key: string, value: unknown): string {
  return edit(src, ['dns', key], value === '' ? undefined : value)
}

export function addDnsServer(src: string, address: string): string {
  const cfg = parseConfig(src)
  const at = cfg?.dns?.servers.length ?? 0
  // Added in the string form: that is what a resolver with no overrides looks like,
  // and promoting it to an object only when a per-server field is set keeps the file
  // as small as the intent.
  return edit(src, ['dns', 'servers', at], address, true)
}

export function removeDnsServer(src: string, index: number): string {
  return remove(src, ['dns', 'servers', index])
}

/**
 * Sets a field on one server, converting the string form to the object form first.
 *
 * The conversion is the whole reason this is not a plain `edit`: writing
 * `dns.servers[0].domains` onto a string element produces `"1.1.1.1"` with a key
 * grafted onto it — invalid JSON that jsonc-parser will happily construct.
 */
export function setDnsServerField(
  src: string,
  index: number,
  key: string,
  value: unknown,
): string {
  const cfg = parseConfig(src)
  const entry = cfg?.dns?.servers[index]
  if (!entry) return src

  let text = src
  if (entry.simple) {
    text = edit(text, ['dns', 'servers', index], { address: entry.address })
  }
  if (key === 'address') {
    // An address-only server stays in the compact form rather than being silently
    // expanded by the act of editing it.
    const stillSimple = entry.simple
    if (stillSimple) return edit(src, ['dns', 'servers', index], value)
  }
  return edit(text, ['dns', 'servers', index, key], value === '' ? undefined : value)
}

/** Collapses an object server back to a bare address when nothing else is set. */
export function simplifyDnsServer(src: string, index: number): string {
  const cfg = parseConfig(src)
  const entry = cfg?.dns?.servers[index]
  if (!entry || entry.simple) return src
  return edit(src, ['dns', 'servers', index], entry.address)
}

/* ── raw slices ────────────────────────────────────────────────────────────── */

export interface Slice {
  /** The node's text as it appears in the document, indentation and all. */
  text: string
  offset: number
  length: number
  /**
   * The whitespace this node sits behind on its own line.
   *
   * An outbound nested in an array carries that indentation on every line but its
   * first, because the first line begins at the node itself. Shown raw in a narrow
   * editor the block looks shunted to the right and ragged, which is a property of
   * where it lives in the file, not of the value — so display dedents by this and
   * applying re-indents by it.
   */
  indent: string
}

/**
 * The exact TEXT of one node, by path.
 *
 * The form fields above can only cover what the graph models, which is tags, selectors
 * and strategy settings. An outbound is mostly the parts they do not model —
 * `settings.vnext`, `streamSettings`, Reality keys, `mux`, `sockopt` — and telling
 * someone to go and edit those in another editor defeats the point of having the
 * config open here.
 *
 * Returning offsets rather than a re-serialised value is what makes editing safe:
 * splicing the user's own text back into the same character range leaves every byte
 * outside it — including comments and whatever formatting they prefer — untouched.
 * `modify()` cannot do that; it rebuilds the value from a parsed object and drops any
 * comments inside it.
 */
export function sliceAt(src: string, path: JSONPath): Slice | null {
  const root = parseTree(src, [], { allowTrailingComma: true })
  if (!root) return null
  const node = findNodeAtLocation(root, path)
  if (!node) return null
  const lineStart = src.lastIndexOf('\n', node.offset - 1) + 1
  const lead = src.slice(lineStart, node.offset)
  return {
    text: src.slice(node.offset, node.offset + node.length),
    offset: node.offset,
    length: node.length,
    // Only whitespace counts. `"tag": {` puts other text before the node, and there is
    // no indentation to strip in that case.
    indent: /^[ \t]*$/.test(lead) ? lead : '',
  }
}

/**
 * Removes one level of document indentation for display.
 *
 * The first line is left alone: it starts at the node, so it never carried the indent
 * in the first place. Lines that are shorter than the indent, or indented differently
 * from the rest, are left as they are rather than being forced — guessing there would
 * corrupt deliberate formatting.
 */
export function dedent(text: string, indent: string): string {
  if (!indent) return text
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n')
}

/** Puts the document's indentation back, so the file stays correctly formatted. */
export function reindent(text: string, indent: string): string {
  if (!indent) return text
  return text
    .split('\n')
    // A blank line stays blank: padding it out would leave trailing whitespace on
    // every empty line in the block.
    .map((line, i) => (i === 0 || line.trim() === '' ? line : indent + line))
    .join('\n')
}

/**
 * Replaces one node's text with `next`, verbatim.
 *
 * `next` is validated by the caller — this deliberately does not reformat, reindent or
 * normalise it. Anything it did here would be a change the user did not type, in a
 * field whose whole purpose is to let them type exactly what they mean.
 */
export function replaceSlice(src: string, path: JSONPath, next: string): string {
  const s = sliceAt(src, path)
  if (!s) return src
  return src.slice(0, s.offset) + next + src.slice(s.offset + s.length)
}

/** Parse errors in a standalone fragment, as `line:col message`, or [] when clean. */
export function fragmentErrors(text: string): string[] {
  const errs: ParseError[] = []
  parse(text, errs, { allowTrailingComma: true })
  return errs.map((e) => {
    let line = 1
    let lineStart = -1
    for (let i = 0; i < e.offset && i < text.length; i++) {
      if (text[i] === '\n') {
        line++
        lineStart = i
      }
    }
    return `line ${line}, column ${e.offset - lineStart}: ${printParseErrorCode(e.error)}`
  })
}
