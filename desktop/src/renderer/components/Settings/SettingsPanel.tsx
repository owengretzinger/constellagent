import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Settings } from '../../store/types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './SettingsPanel.module.css'

const SHORTCUTS = [
  { action: 'Quick open file', keys: '⌘P' },
  { action: 'New terminal', keys: '⌘T' },
  { action: 'Close tab', keys: '⌘W' },
  { action: 'Close all tabs', keys: '⇧⌘W' },
  { action: 'Next tab', keys: '⇧⌘]' },
  { action: 'Previous tab', keys: '⇧⌘[' },
  { action: 'Tab 1–9', keys: '⌘1 – ⌘9' },
  { action: 'Next workspace', keys: '⇧⌘↓' },
  { action: 'Previous workspace', keys: '⇧⌘↑' },
  { action: 'New workspace', keys: '⌘N' },
  { action: 'Toggle sidebar', keys: '⌘B' },
  { action: 'Toggle right panel', keys: '⌥⌘B' },
  { action: 'Files panel', keys: '⇧⌘E' },
  { action: 'Changes panel', keys: '⇧⌘G' },
  { action: 'Focus terminal', keys: '⌘J' },
  { action: 'Increase font size', keys: '⌘+' },
  { action: 'Decrease font size', keys: '⌘−' },
  { action: 'Reset font size', keys: '⌘0' },
  { action: 'Settings', keys: '⌘,' },
]

function ToggleRow({ label, description, value, onChange }: {
  label: string
  description: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className={styles.row} onClick={() => onChange(!value)}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDescription}>{description}</div>
      </div>
      <button
        className={`${styles.toggle} ${value ? styles.toggleOn : ''}`}
        onClick={(e) => { e.stopPropagation(); onChange(!value) }}
      >
        <span className={styles.toggleKnob} />
      </button>
    </div>
  )
}

function TextRow({ label, description, value, onChange, placeholder }: {
  label: string
  description: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDescription}>{description}</div>
      </div>
      <input
        className={styles.textInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

function NumberRow({ label, description, value, onChange, min = 8, max = 32 }: {
  label: string
  description: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDescription}>{description}</div>
      </div>
      <div className={styles.stepper}>
        <button
          className={styles.stepperBtn}
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
        >
          −
        </button>
        <span className={styles.stepperValue}>{value}</span>
        <button
          className={styles.stepperBtn}
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
        >
          +
        </button>
      </div>
    </div>
  )
}

function SelectRow({ label, description, value, onChange, options }: {
  label: string
  description: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDescription}>{description}</div>
      </div>
      <select
        className={styles.selectInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

function ClaudeHooksSection() {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    window.api.claude.checkHooks().then((result: { installed: boolean }) => {
      setInstalled(result.installed)
    }).catch(() => setInstalled(false))
  }, [])

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await window.api.claude.installHooks()
      setInstalled(true)
    } catch {
      setInstalled(false)
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async () => {
    setInstalling(true)
    try {
      await window.api.claude.uninstallHooks()
      setInstalled(false)
    } catch {
      // keep current state
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>Claude Code hooks</div>
        <div className={styles.rowDescription}>
          Show an unread indicator when Claude Code finishes responding in a workspace
        </div>
      </div>
      {installed === true ? (
        <button
          className={styles.actionBtnDanger}
          onClick={handleUninstall}
          disabled={installing}
        >
          {installing ? 'Removing...' : 'Uninstall'}
        </button>
      ) : (
        <button
          className={styles.actionBtn}
          onClick={handleInstall}
          disabled={installing || installed === null}
        >
          {installing ? 'Installing...' : 'Install'}
        </button>
      )}
    </div>
  )
}

function CodexNotifySection() {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    window.api.codex.checkNotify().then((result: { installed: boolean }) => {
      setInstalled(result.installed)
    }).catch(() => setInstalled(false))
  }, [])

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await window.api.codex.installNotify()
      setInstalled(true)
    } catch {
      setInstalled(false)
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async () => {
    setInstalling(true)
    try {
      await window.api.codex.uninstallNotify()
      setInstalled(false)
    } catch {
      // keep current state
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>Codex notify hook</div>
        <div className={styles.rowDescription}>
          Show done/unread state for Codex turns and clear active state when a turn completes
        </div>
      </div>
      {installed === true ? (
        <button
          className={styles.actionBtnDanger}
          onClick={handleUninstall}
          disabled={installing}
        >
          {installing ? 'Removing...' : 'Uninstall'}
        </button>
      ) : (
        <button
          className={styles.actionBtn}
          onClick={handleInstall}
          disabled={installing || installed === null}
        >
          {installing ? 'Installing...' : 'Install'}
        </button>
      )}
    </div>
  )
}

export function SettingsPanel() {
  const { settings, updateSettings, toggleSettings } = useAppStore()

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    updateSettings({ [key]: value })
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSettings])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <Tooltip label="Back" shortcut="⌘,">
              <button className={styles.backBtn} onClick={toggleSettings}>‹</button>
            </Tooltip>
            <h2 className={styles.title}>Settings</h2>
          </div>
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.inner}>
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Appearance</div>

          <NumberRow
            label="Terminal font size"
            description="Font size in pixels for terminal tabs"
            value={settings.terminalFontSize}
            onChange={(v) => update('terminalFontSize', v)}
          />

          <NumberRow
            label="Editor font size"
            description="Font size in pixels for file and diff editors"
            value={settings.editorFontSize}
            onChange={(v) => update('editorFontSize', v)}
          />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>General</div>

          <ToggleRow
            label="Confirm on close"
            description="Show confirmation when closing tabs with unsaved changes"
            value={settings.confirmOnClose}
            onChange={(v) => update('confirmOnClose', v)}
          />

          <ToggleRow
            label="Auto-save on blur"
            description="Automatically save files when switching away from a tab"
            value={settings.autoSaveOnBlur}
            onChange={(v) => update('autoSaveOnBlur', v)}
          />

          <ToggleRow
            label="Restore workspace"
            description="Restore the last active workspace when the app starts"
            value={settings.restoreWorkspace}
            onChange={(v) => update('restoreWorkspace', v)}
          />

          <ToggleRow
            label="Inline diffs"
            description="Show diffs inline instead of side-by-side"
            value={settings.diffInline}
            onChange={(v) => update('diffInline', v)}
          />

          <TextRow
            label="Default shell"
            description="Path to shell executable (leave empty for system default)"
            value={settings.defaultShell}
            onChange={(v) => update('defaultShell', v)}
            placeholder="/bin/zsh"
          />

          <SelectRow
            label="PR link provider"
            description="Where to open pull request links"
            value={settings.prLinkProvider}
            onChange={(v) => update('prLinkProvider', v as Settings['prLinkProvider'])}
            options={[
              { value: 'github', label: 'GitHub' },
              { value: 'graphite', label: 'Graphite' },
              { value: 'devinreview', label: 'Devin Review' },
            ]}
          />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Agent Integrations</div>
          <ClaudeHooksSection />
          <CodexNotifySection />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Keyboard Shortcuts</div>

          {SHORTCUTS.map((s) => (
            <div key={s.action} className={styles.shortcutRow}>
              <span className={styles.shortcutAction}>{s.action}</span>
              <kbd className={styles.kbd}>{s.keys}</kbd>
            </div>
          ))}
        </div>
        </div>
      </div>
    </div>
  )
}
