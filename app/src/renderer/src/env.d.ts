/// <reference types="vite/client" />

import type { XrayStudioApi } from '../../preload'

declare global {
  interface Window {
    xraystudio: XrayStudioApi
  }
}

export {}
