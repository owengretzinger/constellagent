/// <reference types="vite/client" />

import type { ElectronAPI } from './api-adapter'

declare global {
  interface Window {
    api: ElectronAPI
  }
}

declare module '*.module.css' {
  const classes: { [key: string]: string }
  export default classes
}
