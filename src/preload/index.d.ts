import type { WorkbenchApi } from './index'

declare global {
  interface Window {
    api: WorkbenchApi
  }
}

export {}
