import { useEffect, useState } from 'react'

/**
 * What the user sees when something in here throws.
 *
 * The point is a report that can be pasted into an issue without the reporter having to
 * know how to get one. A message alone is rarely enough to locate a fault — the stack
 * is what names the component and the line — so it is shown rather than hidden behind a
 * disclosure, and Copy puts the whole thing on the clipboard together with the versions
 * and the platform, which are the first three questions any bug report gets asked.
 *
 * Reload restarts the interface, not the application: the sidecar and the Xray instance
 * it supervises are a separate process and keep running, so a crashed window costs the
 * telemetry history and nothing else. Saying so matters, because "restart" otherwise
 * reads as "lose whatever is running".
 */
export function CrashDialog({
  err,
  where,
  onRetry,
}: {
  err: Error
  /** The panel or surface that failed, named the way the user sees it. */
  where: string
  /** Present when the failure is recoverable by re-rendering — a panel, not the shell. */
  onRetry?: (() => void) | undefined
}): React.JSX.Element {
  const [versions, setVersions] = useState<Record<string, string> | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.xraystudio?.getVersions?.().then(setVersions).catch(() => setVersions(null))
  }, [])

  const report = [
    `Xray Studio crash report`,
    ``,
    `where:    ${where}`,
    `error:    ${err.name}: ${err.message}`,
    `platform: ${window.xraystudio?.platform ?? 'unknown'}`,
    versions
      ? `versions: app ${versions['app']}, electron ${versions['electron']}, chrome ${versions['chrome']}`
      : `versions: (unavailable)`,
    ``,
    err.stack ?? '(no stack)',
  ].join('\n')

  const copy = (): void => {
    void navigator.clipboard.writeText(report).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => setCopied(false),
    )
  }

  return (
    // Not dismissible by clicking away. Every other modal here is something the user
    // opened; this one is the application admitting a fault, and quietly closing it
    // would leave a panel that is still broken with nothing to say why.
    <div className="modal-scrim crash-scrim">
      <div className="modal crash">
        <div className="modal-head">
          <h3>Xray Studio hit a bug</h3>
        </div>

        <p className="crash-lede">
          The <strong>{where}</strong> could not render. This is a defect in Xray Studio,
          not a problem with the config you opened — nothing has been written to your
          file, and the Xray instance is still running.
        </p>

        <pre className="crash-trace mono">{report}</pre>

        <p className="tiny faint">
          Please paste this into an{' '}
          <a href="https://github.com/notacircle/xray-studio/issues" target="_blank" rel="noreferrer">
            issue
          </a>
          . It contains no part of your config — no tags, addresses, UUIDs or keys — so it
          is safe to post as it is.
        </p>

        <div className="modal-foot">
          <button onClick={copy}>{copied ? 'Copied' : 'Copy report'}</button>
          <span className="spacer" />
          {onRetry && (
            <button onClick={onRetry} title="Render this panel again. Worth one try — a crash caused by a transient state may not repeat.">
              Try again
            </button>
          )}
          <button
            className="primary"
            onClick={() => window.location.reload()}
            title="Reloads the interface. The sidecar and the running Xray instance are a separate process and are not restarted."
          >
            Restart the interface
          </button>
        </div>
      </div>
    </div>
  )
}
