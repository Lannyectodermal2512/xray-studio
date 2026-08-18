import { useCallback, useEffect, useRef, useState } from 'react'
import type { Diagnostic } from '@shared/events'
import { useApp } from '../store/app'
import { buildContext, SYSTEM_PROMPT, type ContextOptions } from '../lib/aiContext'

type Provider = 'anthropic' | 'openai'

const MODELS: Record<Provider, { id: string; label: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
}

interface Turn {
  role: 'user' | 'assistant'
  content: string
  /** Set while this turn is still streaming. */
  live?: boolean
  error?: string
}

/**
 * A collapsible assistant, docked under the editor.
 *
 * Docked rather than a separate tab because the questions it answers are the ones you
 * have while looking at the config — and because the answer usually needs both the text
 * in front of you and the telemetry from the running instance, which this app has and a
 * browser tab does not.
 *
 * Collapsed by default and it stays out of the way: the editor is the tool, this is a
 * second opinion about it.
 */
export function AiChat({
  configPath,
  configText,
  diags,
}: {
  configPath: string | null
  configText: string | null
  diags: Diagnostic[] | null
}): React.JSX.Element {
  const snap = useApp((s) => s.snap)
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [model, setModel] = useState(MODELS.anthropic[0]!.id)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [proxy, setProxy] = useState<{ value: string; source: string }>({ value: '', source: 'none' })
  const [proxyInput, setProxyInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [opts, setOpts] = useState<ContextOptions>({
    includeConfig: true,
    includeTelemetry: true,
    // Default ON. The config carries UUIDs and Reality keys, and this sends it to a
    // third party; masking by default is the only defensible starting point.
    redactSecrets: true,
  })

  const scroller = useRef<HTMLDivElement | null>(null)
  const reqId = useRef<string>('')

  useEffect(() => {
    void window.xraystudio.aiHasKey(provider).then(setHasKey)
  }, [provider])

  useEffect(() => {
    void window.xraystudio.aiGetProxy().then((p) => {
      setProxy(p)
      setProxyInput(p.source === 'stored' ? p.value : '')
    })
  }, [open])

  // Stream deltas into the last turn.
  useEffect(() => {
    return window.xraystudio.onAiEvent((ev) => {
      if (ev.id !== reqId.current) return
      setTurns((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (!last || last.role !== 'assistant') return prev
        if (ev.kind === 'delta') next[next.length - 1] = { ...last, content: last.content + String(ev.payload) }
        else if (ev.kind === 'error')
          next[next.length - 1] = { ...last, live: false, error: String(ev.payload) }
        else if (ev.kind === 'done') next[next.length - 1] = { ...last, live: false }
        return next
      })
      if (ev.kind !== 'delta') setBusy(false)
    })
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, open])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return

    const context = buildContext(snap, { path: configPath, text: configText }, diags, opts)
    // The context rides on the FIRST user turn only. Re-sending a snapshot of the world
    // with every message would both cost a fortune on a long conversation and leave the
    // model with several contradictory versions of the same config to reconcile.
    const isFirst = turns.length === 0
    const content = isFirst ? `${context}\n\n---\n\n${text}` : text

    const history = turns
      .filter((t) => !t.error)
      .map((t) => ({ role: t.role, content: t.content }))

    setTurns((p) => [...p, { role: 'user', content: text }, { role: 'assistant', content: '', live: true }])
    setInput('')
    setBusy(true)

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    reqId.current = id
    try {
      await window.xraystudio.aiSend({
        id,
        provider,
        model,
        system: SYSTEM_PROMPT,
        messages: [...history, { role: 'user', content }],
      })
    } catch (e) {
      setTurns((p) => {
        const next = [...p]
        next[next.length - 1] = { role: 'assistant', content: '', live: false, error: (e as Error).message }
        return next
      })
      setBusy(false)
    }
  }, [input, busy, snap, configPath, configText, diags, opts, turns, provider, model])

  const saveKey = async (): Promise<void> => {
    const k = keyInput.trim()
    if (!k) return
    await window.xraystudio.aiSetKey(provider, k)
    setKeyInput('')
    setHasKey(true)
  }

  const contextSize = open
    ? buildContext(snap, { path: configPath, text: configText }, diags, opts).length
    : 0

  return (
    <section className={`ai ${open ? 'open' : ''}`}>
      <button className="ai-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span>Assistant</span>
        {!open && turns.length > 0 && <span className="chip tiny">{turns.length}</span>}
        <span className="spacer" />
        {open && (
          <span className="tiny faint">
            {Math.round(contextSize / 1000)}k chars of context
          </span>
        )}
      </button>

      {open && (
        <div className="ai-body">
          <div className="ai-bar">
            <select
              value={provider}
              onChange={(e) => {
                const p = e.target.value as Provider
                setProvider(p)
                setModel(MODELS[p][0]!.id)
              }}
            >
              <option value="anthropic">Claude</option>
              <option value="openai">ChatGPT</option>
            </select>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS[provider].map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <button className="ghost tiny" onClick={() => setShowSettings((v) => !v)}>
              {showSettings ? 'Hide setup' : 'Setup'}
            </button>
            {(['includeConfig', 'includeTelemetry', 'redactSecrets'] as const).map((k) => (
              <label key={k} className="tiny lbl" title={OPT_HELP[k]}>
                <input
                  type="checkbox"
                  checked={opts[k]}
                  onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))}
                />
                {OPT_LABEL[k]}
              </label>
            ))}
          </div>

          {(hasKey === false || showSettings) && (
            <div className="ai-key">
              <p className="tiny dim">
                Paste an API key for {provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}. It is
                encrypted with your OS keychain and kept in the main process — the window
                never sees it, and it is never written to the project.
              </p>
              <div className="row gap">
                <input
                  className="grow mono"
                  type="password"
                  placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
                />
                <button className="primary" onClick={() => void saveKey()}>
                  {hasKey ? 'Replace key' : 'Save key'}
                </button>
              </div>

              {/* Chromium ignores HTTPS_PROXY, so an app launched from Finder goes out
                  directly even on a machine where every terminal tool is proxied. For an
                  audience that runs Xray because their network is filtered, that is the
                  difference between the assistant working and a bare 403. */}
              <p className="tiny dim proxy-note">
                Proxy for provider calls:{' '}
                {proxy.value ? (
                  <>
                    <code className="mono">{proxy.value}</code>{' '}
                    <span className="faint">
                      ({proxy.source === 'env' ? 'from the environment' : 'saved here'})
                    </span>
                  </>
                ) : (
                  <span className="warn">none — requests go out directly</span>
                )}
              </p>
              <div className="row gap">
                <input
                  className="grow mono"
                  placeholder="http://127.0.0.1:20809  (leave empty to use the environment)"
                  value={proxyInput}
                  onChange={(e) => setProxyInput(e.target.value)}
                />
                <button
                  onClick={() => {
                    void window.xraystudio
                      .aiSetProxy(proxyInput.trim())
                      .then(() => window.xraystudio.aiGetProxy())
                      .then(setProxy)
                  }}
                >
                  Save proxy
                </button>
              </div>
            </div>
          )}

          <div className="ai-log" ref={scroller}>
            {turns.length === 0 && (
              <div className="ai-empty tiny dim">
                <p>
                  Asks are answered against this config <em>and</em> the running instance:
                  which outbounds the observatory calls alive, their deviation, the reason
                  the balancer rejected each candidate, and any faults you have armed.
                </p>
                <p className="faint">
                  Try: “why is nothing being selected?” · “what does costs 5000 do here?” ·
                  “this outbound is never picked — why?”
                </p>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`ai-turn ${t.role}`}>
                <span className="ai-who tiny">{t.role === 'user' ? 'you' : 'assistant'}</span>
                <div className="ai-text">
                  {t.content}
                  {t.live && <span className="ai-caret" />}
                  {t.error && <span className="bad"> {t.error}</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="ai-input">
            <textarea
              value={input}
              placeholder={hasKey ? 'Ask about this config…  (⏎ to send, ⇧⏎ for a new line)' : 'Set an API key first'}
              disabled={!hasKey}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {busy ? (
              <button className="danger" onClick={() => void window.xraystudio.aiCancel()}>
                Stop
              </button>
            ) : (
              <button className="primary" disabled={!hasKey || !input.trim()} onClick={() => void send()}>
                Send
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

const OPT_LABEL = {
  includeConfig: 'config',
  includeTelemetry: 'telemetry',
  redactSecrets: 'mask secrets',
} as const

const OPT_HELP = {
  includeConfig: 'Send the config text with the first message.',
  includeTelemetry:
    'Send live state: liveness, delays, deviation, the balancer decision funnel, armed faults and recent log lines.',
  redactSecrets:
    'Replace UUIDs, passwords and Reality keys with a marker of the same length. The model still sees that the field exists and is well-formed.',
} as const
