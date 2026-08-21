import { useEffect, useState } from 'react'
import { CrashDialog } from './CrashDialog'

/**
 * Failures React never sees.
 *
 * An error boundary only catches what throws during a render. A rejected promise from
 * an IPC call, or a throw inside an event handler or a timer, bypasses it entirely —
 * those used to reach the console and stop there, which for a packaged application
 * means nowhere at all. The user experienced them as a button that did nothing.
 *
 * Only the first is shown. A broken interval fires forever, and a dialog that replaced
 * itself sixty times a second would be less use than silence.
 */
export function GlobalErrors(): React.JSX.Element | null {
  const [err, setErr] = useState<Error | null>(null)
  const [where, setWhere] = useState('application')

  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      setErr((prev) => prev ?? (e.error instanceof Error ? e.error : new Error(String(e.message))))
      setWhere('application')
    }
    const onRejection = (e: PromiseRejectionEvent): void => {
      const r: unknown = e.reason
      setErr((prev) => prev ?? (r instanceof Error ? r : new Error(String(r))))
      // Named separately because the distinction is the first thing worth knowing: a
      // rejected promise here is almost always an IPC call to the sidecar.
      setWhere('a background request')
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  if (!err) return null
  return <CrashDialog err={err} where={where} onRetry={() => setErr(null)} />
}
