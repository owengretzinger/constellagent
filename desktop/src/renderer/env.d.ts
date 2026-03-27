/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type { ElectronAPI } from '../preload/index'

declare global {
  interface Window {
    api: ElectronAPI
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        allowpopups?: string | boolean
        partition?: string
      }
    }
  }
}

declare module '*.module.css' {
  const classes: { [key: string]: string }
  export default classes
}
