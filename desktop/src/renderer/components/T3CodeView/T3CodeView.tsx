import { useEffect, useRef } from 'react'
import styles from './T3CodeView.module.css'

type Props = {
  serverUrl: string
  /** Reserved for parity with other tab panels (terminals use visibility). */
  active?: boolean
}

export function T3CodeView({ serverUrl }: Props) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const registeredIdRef = useRef<number | null>(null)

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const onDomReady = () => {
      const id = wv.getWebContentsId()
      if (id) {
        registeredIdRef.current = id
        window.api.webview.registerTabSwitch(id)
      }
    }

    wv.addEventListener('dom-ready', onDomReady)
    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      if (registeredIdRef.current != null) {
        window.api.webview.unregisterTabSwitch(registeredIdRef.current)
        registeredIdRef.current = null
      }
    }
  }, [serverUrl])

  return (
    <div className={styles.wrap}>
      <webview
        ref={webviewRef as React.Ref<HTMLElement>}
        className={styles.webview}
        src={serverUrl}
        allowpopups=""
      />
    </div>
  )
}
