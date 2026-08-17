import { contextBridge, ipcRenderer } from 'electron'
import type {
  Diagnostic,
  DocBundle,
  ProtocolSchema,
  FaultRule,
  RttSeries,
  SimRequest,
  SimResponse,
  SelfCheckReport,
  Snapshot,
} from '@shared/events'

/**
 * The entire surface the renderer is allowed to touch.
 *
 * The renderer never learns the sidecar's port or bearer token, never touches the
 * filesystem, and never sees Node. Everything is a typed IPC call.
 */
const api = {
  getVersions: (): Promise<{ app: string; electron: string; chrome: string; node: string }> =>
    ipcRenderer.invoke('app:versions'),

  pickConfig: (): Promise<string | null> => ipcRenderer.invoke('config:pick'),
  /** Overwrites a config file. Only called from an explicit Save. */
  writeConfig: (path: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('config:write', path, text),

  /** Validates unsaved text through the sidecar's real config loader. */
  validateText: (text: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> =>
    ipcRenderer.invoke('instance:validateText', text),

  readConfig: (path: string): Promise<string> => ipcRenderer.invoke('config:read', path),

  /** Writes pasted JSON to a scratch file and returns its path. Everything downstream
   *  is path-addressed, so this keeps pasting on the same code path as opening. */
  configFromText: (text: string, name?: string): Promise<string> =>
    ipcRenderer.invoke('config:fromText', text, name),

  start: (path: string): Promise<unknown> => ipcRenderer.invoke('instance:start', path),
  stop: (): Promise<unknown> => ipcRenderer.invoke('instance:stop'),
  validate: (path: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> =>
    ipcRenderer.invoke('instance:validate', path),

  setFaults: (rules: FaultRule[]): Promise<{ applied: number; poisoned: Record<string, number> }> =>
    ipcRenderer.invoke('faults:set', rules),

  /** Pulled on demand rather than pushed: the series is large and changes slowly
   *  relative to the 30Hz snapshot. */
  /** What-if analysis; runs the real strategy in the sidecar. */
  /** Cross-check the dashboard's claims against the core's own answers. */
  /** Per-parameter documentation, or null when the bundle is unavailable. */
  /** Generated protocol settings schema, or null when unavailable. */
  schema: (): Promise<ProtocolSchema | null> => ipcRenderer.invoke('schema:bundle'),

  docs: (): Promise<DocBundle | null> => ipcRenderer.invoke('docs:bundle'),

  selfCheck: (): Promise<SelfCheckReport> => ipcRenderer.invoke('selfcheck:run'),

  simulate: (req: SimRequest): Promise<SimResponse> => ipcRenderer.invoke('sim:run', req),

  rttSeries: (): Promise<RttSeries> => ipcRenderer.invoke('rtt:series'),

  onSnapshot: (cb: (s: Snapshot) => void): (() => void) => {
    const h = (_e: unknown, s: Snapshot): void => cb(s)
    ipcRenderer.on('snapshot', h)
    return () => ipcRenderer.off('snapshot', h)
  },

  onCoreLog: (cb: (line: string) => void): (() => void) => {
    const h = (_e: unknown, line: string): void => cb(line)
    ipcRenderer.on('core:log', h)
    return () => ipcRenderer.off('core:log', h)
  },

  onConfigOpened: (cb: (path: string) => void): (() => void) => {
    const h = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('config:opened', h)
    return () => ipcRenderer.off('config:opened', h)
  },

  onConfigChanged: (cb: (path: string) => void): (() => void) => {
    const h = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('config:changed', h)
    return () => ipcRenderer.off('config:changed', h)
  },
} as const

export type XrayStudioApi = typeof api

contextBridge.exposeInMainWorld('xraystudio', api)
