import { Component, type ErrorInfo, type ReactNode } from 'react'
import { CrashDialog } from './CrashDialog'

/**
 * Catches a render failure and turns it into something reportable.
 *
 * React unmounts the whole tree when a render throws, so before this a single bad field
 * in somebody's config blanked the entire window — no interface, no error, nothing to
 * click. That is the worst possible response from a tool whose subject is broken
 * configs: the moment it is most useful is the moment it disappeared.
 *
 * The coercions in lib/coerce.ts are the real fix for the causes found so far. This is
 * the floor under the ones not found yet, and it deliberately does not paper over them:
 * a dialog naming the panel and carrying a stack is how the next one gets reported
 * instead of endured.
 */
export class PanelBoundary extends Component<
  { children: ReactNode; what: string; retryable?: boolean },
  { err: Error | null }
> {
  override state: { err: Error | null } = { err: null }

  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err }
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    // Also to the console, which XRAYSTUDIO_TRACE captures to a file — so a crash is
    // diagnosable from a trace even when the reporter closed the dialog.
    console.error(`panel "${this.props.what}" failed to render:`, err, info.componentStack)
  }

  /**
   * A different panel is a fresh chance; the same one re-rendering is not.
   *
   * This compared `children` by identity, which is a new element object on every
   * render of the parent — and the parent re-renders thirty times a second from the
   * telemetry snapshot. So the dialog cleared itself on the next frame: the crash
   * report existed for about a millisecond, which is not long enough to read, let
   * alone copy. It looked like a flicker rather than a crash, and hid a real bug for
   * as long as it took someone to catch the flash on video.
   */
  override componentDidUpdate(prev: { children: ReactNode; what: string }): void {
    if (this.state.err && prev.what !== this.props.what) this.setState({ err: null })
  }

  override render(): ReactNode {
    const { err } = this.state
    if (!err) return this.props.children
    return (
      <>
        {/* The dialog sits over whatever was there, so the tab bar and the rail stay
            usable and the user can leave the broken panel without reloading. */}
        <CrashDialog
          err={err}
          where={`${this.props.what} panel`}
          onRetry={
            this.props.retryable === false ? undefined : () => this.setState({ err: null })
          }
        />
      </>
    )
  }
}
