import { create } from 'zustand'
import type { FaultRule, Snapshot } from '@shared/events'
import { emptySnapshot } from '@shared/events'

export type Tab = 'observe' | 'graph' | 'build' | 'faults' | 'whatif' | 'validate' | 'selfcheck' | 'reference' | 'protocols' | 'log'

interface AppState {
  snap: Snapshot
  tab: Tab
  selectedBalancer: string | null
  selectedOutbound: string | null
  configPath: string | null
  busy: boolean
  error: string | null
  /** Set when the file changes on disk while an instance is running. */
  configDirty: boolean
  coreLog: string[]
  /**
   * A jump-to-edit request raised by the sidebar and consumed by the Graph tab.
   *
   * Passed as a TAG rather than an index: the rail is driven by live telemetry and the
   * editor by the parsed config text, and those two orderings do not match — the rail
   * sorts naturally and only lists outbounds that have been seen. An index from one is
   * meaningless in the other, so the tag is the only stable handle across them.
   */
  editRequest: { tag: string; kind: 'outbound' | 'balancer' } | null

  setSnapshot: (s: Snapshot) => void
  setTab: (t: Tab) => void
  selectBalancer: (t: string | null) => void
  selectOutbound: (t: string | null) => void
  setConfigPath: (p: string | null) => void
  setBusy: (b: boolean) => void
  setError: (e: string | null) => void
  setConfigDirty: (d: boolean) => void
  appendCoreLog: (line: string) => void
  requestEdit: (tag: string, kind?: 'outbound' | 'balancer') => void
  clearEditRequest: () => void

  openConfig: () => Promise<void>
  openPastedConfig: (text: string) => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  applyFaults: (rules: FaultRule[]) => Promise<void>
  toggleFault: (id: string) => Promise<void>
  clearAllFaults: () => Promise<void>
}

/**
 * The config currently under test: whichever the user picked, else whatever the
 * running instance reports. Both the top bar and the graph need this, and having two
 * answers to it is how the graph ends up claiming no config is open while an
 * instance is plainly running.
 */
export function effectiveConfigPath(s: Pick<AppState, 'configPath' | 'snap'>): string | null {
  return s.configPath ?? s.snap.configPath
}

export const useApp = create<AppState>((set, get) => ({
  snap: emptySnapshot(),
  tab: 'observe',
  selectedBalancer: null,
  selectedOutbound: null,
  configPath: null,
  busy: false,
  error: null,
  configDirty: false,
  coreLog: [],
  editRequest: null,

  setSnapshot: (s) =>
    set((prev) => {
      // Default the funnel to the first balancer so the panel is never empty on
      // first paint.
      const selectedBalancer =
        prev.selectedBalancer ?? (s.balancers.length > 0 ? s.balancers[0]!.tag : null)
      return { snap: s, selectedBalancer }
    }),
  setTab: (tab) => set({ tab }),
  selectBalancer: (selectedBalancer) => set({ selectedBalancer }),
  selectOutbound: (selectedOutbound) => set({ selectedOutbound }),
  setConfigPath: (configPath) => set({ configPath }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  setConfigDirty: (configDirty) => set({ configDirty }),
  appendCoreLog: (line) =>
    set((s) => ({ coreLog: [...s.coreLog.slice(-400), line] })),

  requestEdit: (tag, kind = 'outbound') =>
    set({ tab: 'build', editRequest: { tag, kind }, selectedOutbound: tag }),
  clearEditRequest: () => set({ editRequest: null }),

  openConfig: async () => {
    const path = await window.xraystudio.pickConfig()
    if (!path) return
    set({ configPath: path, error: null, configDirty: false })
  },

  openPastedConfig: async (text) => {
    try {
      // Given a real path, the paste is indistinguishable from an opened file from
      // here on — same start, same watcher, same editor.
      const path = await window.xraystudio.configFromText(text)
      set({ configPath: path, error: null, configDirty: false })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  start: async () => {
    const path = get().configPath
    if (!path) return
    set({ busy: true, error: null })
    try {
      await window.xraystudio.start(path)
      set({ configDirty: false })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  stop: async () => {
    set({ busy: true })
    try {
      await window.xraystudio.stop()
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  applyFaults: async (rules) => {
    try {
      await window.xraystudio.setFaults(rules)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  toggleFault: async (id) => {
    const rules = get().snap.faults.map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled } : r,
    )
    await get().applyFaults(rules)
  },

  clearAllFaults: async () => {
    // The panic button: disable everything at once. Wanted the moment faults are
    // hitting real servers.
    await get().applyFaults(get().snap.faults.map((r) => ({ ...r, enabled: false })))
  },
}))
