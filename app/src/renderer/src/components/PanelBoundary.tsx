import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Keeps one panel's failure inside that panel.
 *
 * React unmounts the whole tree when a render throws, so before this a single bad field
 * in somebody's config blanked the entire window — no interface, no error, nothing to
 * click. That is the worst possible response from a tool whose subject is broken
 * configs: the moment it is most useful is the moment it disappeared.
 *
 * The coercions in lib/coerce.ts are the real fix for the causes found so far. This is
 * the floor under the ones not found yet. It cannot be a substitute for them — a panel
 * showing this message is still a bug — so it prints what threw and asks for it,
 * rather than quietly rendering something reassuring.
 */
export class PanelBoundary extends Component<
  { children: ReactNode; what: string },
  { err: Error | null }
> {
  override state: { err: Error | null } = { err: null }

  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err }
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    // The console is captured to the trace file when XRAYSTUDIO_TRACE is set, which is
    // how this gets diagnosed from a bug report rather than from a screenshot.
    console.error(`panel "${this.props.what}" failed to render:`, err, info.componentStack)
  }

  /** Clearing the error re-renders; a different config or a fixed field then works. */
  override componentDidUpdate(prev: { children: ReactNode; what: string }): void {
    if (this.state.err && prev.children !== this.props.children) this.setState({ err: null })
  }

  override render(): ReactNode {
    const { err } = this.state
    if (!err) return this.props.children
    return (
      <div className="panel-crash">
        <h3>The {this.props.what} panel could not render this config.</h3>
        <p className="dim">
          This is a bug in Xray Studio, not something wrong with what you opened — the
          rest of the application is still working, and the other tabs are unaffected.
        </p>
        <pre className="mono">{err.message}</pre>
        <p className="tiny faint">
          Please report it with the part of the config this panel was showing, scrubbed
          of UUIDs, passwords and Reality keys.
        </p>
      </div>
    )
  }
}
