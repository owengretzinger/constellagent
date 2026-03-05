import './api-adapter'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useAppStore, hydrateFromDisk } from './store/app-store'
import '@xterm/xterm/css/xterm.css'
import './styles/global.css'

;(window as any).__store = useAppStore

hydrateFromDisk().then(() => {
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
