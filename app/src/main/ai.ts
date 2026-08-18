import { app, net, safeStorage, session } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The assistant's connection to a model provider.
 *
 * Lives in the main process for two reasons, and only one of them is convenience:
 *
 *  1. The renderer's CSP is `connect-src 'self'`. It cannot reach an API host at all,
 *     and widening that for a sandboxed window which renders strings from remote
 *     servers would be a poor trade for a chat panel.
 *  2. The key never enters the renderer. It is stored encrypted by the OS keychain via
 *     safeStorage, decrypted here, and attached to the request — the window that draws
 *     the conversation never holds the credential that pays for it.
 *
 * Nothing here is written to the repository. The key comes from the user at runtime and
 * lives in the app's userData directory.
 */

export type Provider = 'anthropic' | 'openai'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface Stored {
  anthropic?: string
  openai?: string
  /** Explicit proxy for provider calls; overrides the environment. */
  proxy?: string
}

const FILE = (): string => join(app.getPath('userData'), 'provider-keys.bin')

/** Cleartext keys never touch disk: safeStorage hands them to the OS keychain. */
async function readKeys(): Promise<Stored> {
  try {
    const buf = await readFile(FILE())
    if (!safeStorage.isEncryptionAvailable()) return {}
    return JSON.parse(safeStorage.decryptString(buf)) as Stored
  } catch {
    return {}
  }
}

async function writeKeys(keys: Stored): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'The OS keychain is unavailable, so the key cannot be stored safely. ' +
        'Refusing to write it in the clear.',
    )
  }
  await writeFile(FILE(), safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 })
}

export async function hasKey(p: Provider): Promise<boolean> {
  return Boolean((await readKeys())[p])
}

export async function setKey(p: Provider, key: string): Promise<void> {
  const keys = await readKeys()
  if (key) keys[p] = key
  else delete keys[p]
  await writeKeys(keys)
}

export async function clearKeys(): Promise<void> {
  await rm(FILE(), { force: true })
}

/**
 * The proxy used for provider calls.
 *
 * This matters more here than in most apps. Chromium ignores HTTPS_PROXY and friends —
 * it reads the system proxy settings, which are usually off — so the request goes out
 * directly even when every other tool on the machine is proxied. Anthropic then answers
 * 403 "Request not allowed" for a blocked region, and the user, whose curl works fine,
 * has no way to tell that from a bad key.
 *
 * Stored alongside the keys because a proxy URL can carry credentials of its own.
 */
export async function getProxy(): Promise<{ value: string; source: 'stored' | 'env' | 'none' }> {
  const stored = (await readKeys()).proxy
  if (stored) return { value: stored, source: 'stored' }
  const env = process.env['HTTPS_PROXY'] ?? process.env['HTTP_PROXY'] ?? process.env['ALL_PROXY']
  return env ? { value: env, source: 'env' } : { value: '', source: 'none' }
}

export async function setProxy(url: string): Promise<void> {
  const keys = await readKeys()
  if (url) keys.proxy = url
  else delete keys.proxy
  await writeKeys(keys)
}

/** Applied per request: the setting can change between messages. */
async function applyProxy(): Promise<void> {
  const { value } = await getProxy()
  await session.defaultSession.setProxy(
    value ? { proxyRules: value, proxyBypassRules: '<local>' } : { mode: 'system' },
  )
}

export interface ChatRequest {
  provider: Provider
  model: string
  system: string
  messages: ChatMessage[]
}

export interface Sink {
  delta: (text: string) => void
  done: (info: { stopReason?: string; inputTokens?: number; outputTokens?: number }) => void
  error: (message: string) => void
}

/**
 * Streams a completion, forwarding text deltas as they arrive.
 *
 * Streaming rather than awaiting the whole reply because the useful answers here are
 * long — a walk through a balancer's behaviour, or a rewritten outbound — and watching
 * one appear is the difference between a tool that feels alive and one that appears to
 * have hung.
 */
export async function chat(req: ChatRequest, sink: Sink, signal: AbortSignal): Promise<void> {
  const keys = await readKeys()
  const key = keys[req.provider]
  if (!key) {
    sink.error(`No API key set for ${req.provider}.`)
    return
  }

  try {
    await applyProxy()
    const res =
      req.provider === 'anthropic'
        ? await anthropic(req, key, signal)
        : await openai(req, key, signal)

    if (!res.ok || !res.body) {
      // The provider's own error text is far more useful than a status code — it names
      // an invalid key, an unknown model or a rate limit specifically.
      const detail = await res.text().catch(() => '')
      let msg = `HTTP ${res.status}${detail ? `: ${trimDetail(detail)}` : ''}`
      // The single most likely cause for this audience, and the one the raw message
      // gives no hint about: the request left directly from a region the provider
      // blocks, while everything else on the machine is proxied.
      if (res.status === 403) {
        const { value, source } = await getProxy()
        msg +=
          value
            ? ` — sent through ${source === 'env' ? 'the environment proxy' : 'the configured proxy'} ${value}.`
            : ' — no proxy is configured, so this request went out directly. If the provider blocks your region, set a proxy below.'
      }
      sink.error(msg)
      return
    }

    await consume(res.body, req.provider, sink)
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      sink.done({ stopReason: 'cancelled' })
      return
    }
    sink.error((err as Error).message)
  }
}

function anthropic(req: ChatRequest, key: string, signal: AbortSignal): Promise<Response> {
  // net.fetch, not the global fetch: only Chromium's stack honours the session proxy.
  return net.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Electron's main process issues this through Chromium's network stack, which
      // attaches an Origin — and Anthropic rejects anything that looks browser-borne
      // (403 "Request not allowed") to stop sites shipping keys to end users. Verified
      // by reproducing it with curl: adding an Origin turns 200 into a rejection, and
      // this header turns it back.
      //
      // The name warns about exposing a key to page JavaScript. That is precisely what
      // does NOT happen here: the key is decrypted in the main process and the renderer
      // never receives it. Do not copy this header into renderer code, where the
      // warning would apply in full.
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'XrayStudio',
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 4096,
      stream: true,
      system: req.system,
      messages: req.messages,
    }),
  })
}

function openai(req: ChatRequest, key: string, signal: AbortSignal): Promise<Response> {
  return net.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: req.model,
      stream: true,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
    }),
  })
}

/** Both providers stream SSE; only the event shapes differ. */
async function consume(body: ReadableStream<Uint8Array>, provider: Provider, sink: Sink): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usage: { inputTokens?: number; outputTokens?: number } = {}
  let stopReason: string | undefined

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let ev: Record<string, unknown>
        try {
          ev = JSON.parse(payload) as Record<string, unknown>
        } catch {
          continue
        }

        if (provider === 'anthropic') {
          const type = ev['type']
          if (type === 'content_block_delta') {
            const d = ev['delta'] as { text?: string } | undefined
            if (d?.text) sink.delta(d.text)
          } else if (type === 'message_delta') {
            const d = ev['delta'] as { stop_reason?: string } | undefined
            const u = ev['usage'] as { output_tokens?: number } | undefined
            if (d?.stop_reason) stopReason = d.stop_reason
            if (u?.output_tokens) usage.outputTokens = u.output_tokens
          } else if (type === 'message_start') {
            const m = ev['message'] as { usage?: { input_tokens?: number } } | undefined
            if (m?.usage?.input_tokens) usage.inputTokens = m.usage.input_tokens
          } else if (type === 'error') {
            const e = ev['error'] as { message?: string } | undefined
            sink.error(e?.message ?? 'stream error')
            return
          }
        } else {
          const choice = (ev['choices'] as { delta?: { content?: string }; finish_reason?: string }[])?.[0]
          if (choice?.delta?.content) sink.delta(choice.delta.content)
          if (choice?.finish_reason) stopReason = choice.finish_reason
        }
      }
    }
  }
  sink.done({ ...usage, ...(stopReason ? { stopReason } : {}) })
}

function trimDetail(s: string): string {
  const t = s.trim()
  try {
    const j = JSON.parse(t) as { error?: { message?: string } }
    if (j.error?.message) return j.error.message
  } catch {
    /* not JSON; fall through */
  }
  return t.slice(0, 300)
}
