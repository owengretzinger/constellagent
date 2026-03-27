import styles from './T3CodeView.module.css'

type Props = {
  serverUrl: string
  /** Reserved for parity with other tab panels (terminals use visibility). */
  active?: boolean
}

export function T3CodeView({ serverUrl }: Props) {
  return (
    <div className={styles.wrap}>
      {/* Electron <webview>; requires webPreferences.webviewTag in the host BrowserWindow */}
      <webview className={styles.webview} src={serverUrl} allowpopups="" />
    </div>
  )
}
