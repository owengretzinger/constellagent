import { useEffect, useState, useRef } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Settings, FavoriteEditor, McpServer, AgentType, SkillEntry, SubagentEntry } from '../../store/types'
import type { PhoneControlStatus } from '@shared/phone-control-types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './SettingsPanel.module.css'

const SHORTCUTS = [
  { action: 'Quick open file', keys: '⌘P' },
  { action: 'New terminal', keys: '⌘T' },
  { action: 'Close pane / tab', keys: '⌘W' },
  { action: 'Close all tabs', keys: '⇧⌘W' },
  { action: 'Next tab', keys: '⇧⌘]' },
  { action: 'Previous tab', keys: '⇧⌘[' },
  { action: 'Previous tab', keys: '⌘←' },
  { action: 'Next tab', keys: '⌘→' },
  { action: 'Split terminal right', keys: '⌘D' },
  { action: 'Split terminal down', keys: '⇧⌘D' },
  { action: 'Open file in split', keys: '⌘\\' },
  { action: 'Open file in split pane', keys: '⌘+Click' },
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
  { action: 'Open in editor', keys: '⇧⌘O' },
  { action: 'Context history', keys: '⇧⌘K' },
  { action: 'Plan picker (search + filter by agent)', keys: '⇧⌘M' },
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
        className={styles.textInput}
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

function SkillsSubagentsSection() {
  const { settings, addSkill, removeSkill, updateSkill, addSubagent, removeSubagent, updateSubagent, addToast } = useAppStore()
  const activeProject = useAppStore((s) => s.activeProject())

  const handleAddSkill = async () => {
    const dirPath = await window.api.app.selectDirectory()
    if (!dirPath) return
    const info = await window.api.skills.scan(dirPath)
    if (!info) {
      addToast({ id: crypto.randomUUID(), message: 'No SKILL.md found in selected directory', type: 'error' })
      return
    }
    const skill: SkillEntry = {
      id: crypto.randomUUID(),
      name: info.name,
      description: info.description,
      sourcePath: dirPath,
      enabled: true,
    }
    addSkill(skill)
    if (activeProject) {
      await window.api.skills.sync(dirPath, activeProject.repoPath)
      await window.api.skills.kvSave(activeProject.repoPath, skill).catch(() => {})
    }
  }

  const handleRemoveSkill = async (skill: SkillEntry) => {
    if (activeProject) {
      await window.api.skills.remove(skill.name, activeProject.repoPath)
      await window.api.skills.kvRemove(activeProject.repoPath, skill.name).catch(() => {})
    }
    removeSkill(skill.id)
  }

  const handleToggleSkill = async (skill: SkillEntry) => {
    const newEnabled = !skill.enabled
    updateSkill(skill.id, { enabled: newEnabled })
    if (activeProject) {
      if (newEnabled) {
        await window.api.skills.sync(skill.sourcePath, activeProject.repoPath)
      } else {
        await window.api.skills.remove(skill.name, activeProject.repoPath)
      }
      await window.api.skills.kvSave(activeProject.repoPath, { ...skill, enabled: newEnabled }).catch(() => {})
    }
  }

  const handleAddSubagent = async () => {
    const filePath = await window.api.app.selectFile([{ name: 'Markdown', extensions: ['md'] }])
    if (!filePath) return
    const info = await window.api.subagents.scan(filePath)
    if (!info) {
      addToast({ id: crypto.randomUUID(), message: 'Could not parse subagent file (needs YAML frontmatter with name)', type: 'error' })
      return
    }
    const subagent: SubagentEntry = {
      id: crypto.randomUUID(),
      name: info.name,
      description: info.description,
      sourcePath: filePath,
      tools: info.tools,
      enabled: true,
    }
    addSubagent(subagent)
    if (activeProject) {
      await window.api.subagents.sync(filePath, activeProject.repoPath)
      await window.api.subagents.kvSave(activeProject.repoPath, subagent).catch(() => {})
    }
  }

  const handleRemoveSubagent = async (subagent: SubagentEntry) => {
    if (activeProject) {
      await window.api.subagents.remove(subagent.name, activeProject.repoPath)
      await window.api.subagents.kvRemove(activeProject.repoPath, subagent.name).catch(() => {})
    }
    removeSubagent(subagent.id)
  }

  const handleToggleSubagent = async (subagent: SubagentEntry) => {
    const newEnabled = !subagent.enabled
    updateSubagent(subagent.id, { enabled: newEnabled })
    if (activeProject) {
      if (newEnabled) {
        await window.api.subagents.sync(subagent.sourcePath, activeProject.repoPath)
      } else {
        await window.api.subagents.remove(subagent.name, activeProject.repoPath)
      }
      await window.api.subagents.kvSave(activeProject.repoPath, { ...subagent, enabled: newEnabled }).catch(() => {})
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Skills & Subagents</div>

      <div className={styles.subsectionLabel}>Skills</div>
      {settings.skills.length === 0 && (
        <div className={styles.emptyHint}>No skills configured. Add a directory containing a SKILL.md file.</div>
      )}
      {settings.skills.map((skill) => (
        <div key={skill.id} className={styles.entryRow}>
          <div className={styles.rowText}>
            <div className={styles.rowLabel}>{skill.name}</div>
            <div className={styles.rowDescription}>{skill.description}</div>
          </div>
          <button
            className={`${styles.toggle} ${skill.enabled ? styles.toggleOn : ''}`}
            onClick={() => handleToggleSkill(skill)}
          >
            <span className={styles.toggleKnob} />
          </button>
          <button className={styles.removeEntryBtn} onClick={() => handleRemoveSkill(skill)} title="Remove">
            ✕
          </button>
        </div>
      ))}
      <button className={styles.addEntryBtn} onClick={handleAddSkill}>+ Add Skill</button>

      <div className={styles.subsectionLabel} style={{ marginTop: 16 }}>Subagents</div>
      {settings.subagents.length === 0 && (
        <div className={styles.emptyHint}>No subagents configured. Add a .md file with YAML frontmatter.</div>
      )}
      {settings.subagents.map((sa) => (
        <div key={sa.id} className={styles.entryRow}>
          <div className={styles.rowText}>
            <div className={styles.rowLabel}>{sa.name}</div>
            <div className={styles.rowDescription}>{sa.description}{sa.tools ? ` · Tools: ${sa.tools}` : ''}</div>
          </div>
          <button
            className={`${styles.toggle} ${sa.enabled ? styles.toggleOn : ''}`}
            onClick={() => handleToggleSubagent(sa)}
          >
            <span className={styles.toggleKnob} />
          </button>
          <button className={styles.removeEntryBtn} onClick={() => handleRemoveSubagent(sa)} title="Remove">
            ✕
          </button>
        </div>
      ))}
      <button className={styles.addEntryBtn} onClick={handleAddSubagent}>+ Add Subagent</button>
    </div>
  )
}

function ClaudeHooksSection() {
  const settings = useAppStore((s) => s.settings)
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
      await window.api.claude.installHooks(settings.contextCaptureEnabled)
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

function CodexHooksSection() {
  const settings = useAppStore((s) => s.settings)
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
      await window.api.codex.installNotify(settings.contextCaptureEnabled)
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
        <div className={styles.rowLabel}>Codex hooks</div>
        <div className={styles.rowDescription}>
          Notify on Codex turn completion and capture context when context capture is enabled
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

const AGENT_LABELS: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'gemini': 'Gemini CLI',
  'cursor': 'Cursor',
}

function McpServerCard({ server, onDelete, onOpenConfig }: {
  server: McpServer
  onDelete: (name: string) => void
  onOpenConfig: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  const letter = server.name.charAt(0).toUpperCase()

  return (
    <div className={styles.mcpCard}>
      <div className={styles.mcpCardMain} onClick={() => setExpanded(!expanded)}>
        <div className={styles.mcpAvatar}>{letter}</div>
        <div className={styles.mcpCardText}>
          <div className={styles.rowLabel}>{server.name}</div>
          <div className={styles.mcpCardSub}>
            {server.command} {server.args.length > 0 ? server.args[0] : ''}
          </div>
        </div>
        <div className={styles.mcpCardActions}>
          <button
            className={styles.mcpIconBtn}
            title="Edit in config file"
            onClick={(e) => { e.stopPropagation(); onOpenConfig() }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button
            className={styles.mcpIconBtn}
            title="Delete server"
            onClick={(e) => { e.stopPropagation(); onDelete(server.name) }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4m2 0v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4h9.34z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className={styles.mcpCardExpanded}>
          <div className={styles.mcpCardDetail}>
            <span className={styles.mcpDetailLabel}>Command</span>
            <span className={styles.mcpDetailValue}>{server.command} {server.args.join(' ')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function McpServersSection() {
  const openFileTab = useAppStore((s) => s.openFileTab)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const [servers, setServers] = useState<McpServer[]>([])
  const [configPaths, setConfigPaths] = useState<Record<string, string>>({})
  const [selectedAgent, setSelectedAgent] = useState<AgentType>('claude-code')

  const loadServers = () => {
    window.api.mcp.loadServers().then(setServers).catch(() => {})
  }

  useEffect(() => {
    loadServers()
    window.api.mcp.getConfigPaths().then(setConfigPaths).catch(() => {})
  }, [])

  // Refresh when window regains focus (user may have edited the file)
  useEffect(() => {
    const onFocus = () => loadServers()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const openConfig = () => {
    const path = configPaths[selectedAgent]
    if (path) {
      openFileTab(path)
      toggleSettings()
    }
  }

  const handleDelete = async (serverName: string) => {
    await window.api.mcp.removeServer(serverName)
    loadServers()
  }

  const configFileNames: Record<AgentType, string> = {
    'claude-code': '~/.claude.json',
    'codex': '~/.codex/config.toml',
    'gemini': '~/.gemini/settings.json',
    'cursor': '~/.cursor/mcp.json',
  }
  const configFileName = configFileNames[selectedAgent]

  return (
    <div className={styles.mcpList}>
      <div className={styles.mcpAgentSelect}>
        <select
          className={styles.textInput}
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value as AgentType)}
        >
          {(Object.keys(AGENT_LABELS) as AgentType[]).map((agent) => (
            <option key={agent} value={agent}>{AGENT_LABELS[agent]}</option>
          ))}
        </select>
      </div>

      {servers.map((server) => (
        <McpServerCard
          key={server.id}
          server={server}
          onDelete={handleDelete}
          onOpenConfig={openConfig}
        />
      ))}

      <div className={styles.mcpCardMain} onClick={openConfig} style={{ cursor: 'pointer' }}>
        <div className={styles.mcpAvatarAdd}>+</div>
        <div className={styles.mcpCardText}>
          <div className={styles.rowLabel}>New MCP Server</div>
          <div className={styles.mcpCardSub}>Open {configFileName} to add a server</div>
        </div>
      </div>
    </div>
  )
}

function PhoneControlSection() {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const addToast = useAppStore((s) => s.addToast)
  const [status, setStatus] = useState<PhoneControlStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const contactRestartTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    updateSettings({ [key]: value })
  }

  useEffect(() => {
    window.api.phoneControl.status().then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    return () => {
      if (contactRestartTimer.current) clearTimeout(contactRestartTimer.current)
    }
  }, [])

  const handleToggle = async (enabled: boolean) => {
    update('phoneControlEnabled', enabled)
    if (enabled && settings.phoneControlContactId) {
      try {
        await window.api.phoneControl.start({
          enabled: true,
          contactId: settings.phoneControlContactId,
          notifyOnStart: settings.phoneControlNotifyOnStart,
          notifyOnFinish: settings.phoneControlNotifyOnFinish,
          streamOutput: settings.phoneControlStreamOutput,
          streamIntervalSec: settings.phoneControlStreamIntervalSec,
        })
        setStatus(await window.api.phoneControl.status())
      } catch (e: unknown) {
        addToast({
          id: crypto.randomUUID(),
          message: e instanceof Error ? e.message : 'Failed to start phone control.',
          type: 'error',
        })
        update('phoneControlEnabled', false)
        setStatus(await window.api.phoneControl.status())
      }
    } else {
      await window.api.phoneControl.stop()
      setStatus(await window.api.phoneControl.status())
    }
  }

  const handleTestSend = async () => {
    setTesting(true)
    try {
      await window.api.phoneControl.testSend('Constellagent connected')
      addToast({ id: crypto.randomUUID(), message: 'Test message sent', type: 'info' })
    } catch (e: unknown) {
      addToast({
        id: crypto.randomUUID(),
        message: e instanceof Error ? e.message : 'Failed to send test message',
        type: 'error',
      })
    } finally {
      setTesting(false)
    }
  }

  const handleOpenPrivacy = () => {
    window.api.phoneControl.openFullDiskAccessSettings().catch(() => {
      addToast({ id: crypto.randomUUID(), message: 'Could not open System Settings', type: 'error' })
    })
  }

  const handleContactChange = (contactId: string) => {
    update('phoneControlContactId', contactId)
    if (!settings.phoneControlEnabled) return
    if (contactRestartTimer.current) clearTimeout(contactRestartTimer.current)
    contactRestartTimer.current = setTimeout(() => {
      contactRestartTimer.current = null
      const s = useAppStore.getState().settings
      const id = s.phoneControlContactId
      if (!id) return
      window.api.phoneControl
        .start({
          enabled: true,
          contactId: id,
          notifyOnStart: s.phoneControlNotifyOnStart,
          notifyOnFinish: s.phoneControlNotifyOnFinish,
          streamOutput: s.phoneControlStreamOutput,
          streamIntervalSec: s.phoneControlStreamIntervalSec,
        })
        .then(() => window.api.phoneControl.status())
        .then(setStatus)
        .catch((e: unknown) => {
          addToast({
            id: crypto.randomUUID(),
            message: e instanceof Error ? e.message : 'Failed to restart phone control',
            type: 'error',
          })
          void window.api.phoneControl.status().then(setStatus)
        })
    }, 450)
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Phone Control</div>

      <ToggleRow
        label="Enable phone control"
        description="Control agents from your iPhone via iMessage"
        value={settings.phoneControlEnabled}
        onChange={handleToggle}
      />

      <TextRow
        label="Contact ID"
        description="Your phone number or email to listen for (e.g. +15551234567)"
        value={settings.phoneControlContactId}
        onChange={handleContactChange}
        placeholder="+15551234567"
      />

      <div className={styles.row}>
        <div className={styles.rowText}>
          <div className={styles.rowLabel}>Full Disk Access</div>
          <div className={styles.rowDescription}>
            Add the path below under System Settings → Privacy &amp; Security → Full Disk Access (toggle on). If the Electron window shows only “To run a local app…”, you launched Electron.app from Finder; quit it and run Constellagent via bun run dev from the repo root. Each clone uses a different path—match the line below.
          </div>
          {status?.executablePathForPermissions ? (
            <div className={styles.phoneControlPath}>{status.executablePathForPermissions}</div>
          ) : null}
        </div>
        <button type="button" className={styles.actionBtn} onClick={handleOpenPrivacy}>
          Open settings
        </button>
      </div>

      {status?.permissionError ? (
        <div className={styles.phoneControlWarn}>{status.permissionError}</div>
      ) : null}

      {status?.running && (
        <div className={styles.row}>
          <div className={styles.rowText}>
            <div className={styles.rowLabel}>Status</div>
            <div className={styles.rowDescription}>
              Listening for messages from {status.contactId}
              {status.sessionCount > 0 ? ` · ${status.sessionCount} active session${status.sessionCount === 1 ? '' : 's'}` : ''}
            </div>
          </div>
          <button
            className={styles.actionBtn}
            onClick={handleTestSend}
            disabled={testing}
          >
            {testing ? 'Sending...' : 'Test'}
          </button>
        </div>
      )}

      <ToggleRow
        label="Notify on agent start"
        description="Send an iMessage when an agent starts running"
        value={settings.phoneControlNotifyOnStart}
        onChange={(v) => update('phoneControlNotifyOnStart', v)}
      />

      <ToggleRow
        label="Notify on agent finish"
        description="Send an iMessage when an agent finishes"
        value={settings.phoneControlNotifyOnFinish}
        onChange={(v) => update('phoneControlNotifyOnFinish', v)}
      />

      <ToggleRow
        label="Stream output"
        description="Periodically send agent output to your phone"
        value={settings.phoneControlStreamOutput}
        onChange={(v) => update('phoneControlStreamOutput', v)}
      />

      {settings.phoneControlStreamOutput && (
        <NumberRow
          label="Stream interval"
          description="Seconds between output updates"
          value={settings.phoneControlStreamIntervalSec}
          onChange={(v) => update('phoneControlStreamIntervalSec', v)}
          min={5}
          max={30}
        />
      )}

      <div className={styles.row}>
        <div className={styles.rowText}>
          <div className={styles.rowDescription}>
            Text &quot;claude fix the tests&quot; from your phone to start an agent (when Phone Control is running and permissions are OK).
          </div>
        </div>
      </div>
    </div>
  )
}

export function SettingsPanel() {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const toggleSettings = useAppStore((s) => s.toggleSettings)

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

          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>PR link provider</div>
              <div className={styles.rowDescription}>
                Set per project in Project Settings (gear icon in the sidebar).
              </div>
            </div>
          </div>

          <SelectRow
            label="Favorite editor"
            description="External editor to open workspaces in (⇧⌘O)"
            value={settings.favoriteEditor}
            onChange={(v) => update('favoriteEditor', v as FavoriteEditor)}
            options={[
              { value: 'cursor', label: 'Cursor' },
              { value: 'vscode', label: 'VS Code' },
              { value: 'zed', label: 'Zed' },
              { value: 'sublime', label: 'Sublime Text' },
              { value: 'webstorm', label: 'WebStorm' },
              { value: 'custom', label: 'Custom...' },
            ]}
          />

          {settings.favoriteEditor === 'custom' && (
            <TextRow
              label="Custom editor command"
              description="CLI command used to open a directory (e.g. nvim, emacs)"
              value={settings.favoriteEditorCustom}
              onChange={(v) => update('favoriteEditorCustom', v)}
              placeholder="code"
            />
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>MCP Servers</div>
          <McpServersSection />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Agent Integrations</div>
          <ClaudeHooksSection />
          <CodexHooksSection />

          <ToggleRow
            label="Context capture"
            description="Auto-capture agent tool usage and inject context into new sessions"
            value={settings.contextCaptureEnabled}
            onChange={(v) => {
              update('contextCaptureEnabled', v)
              // Re-install hooks with updated context capture setting
              window.api.claude.installHooks(v).catch(() => {})
              window.api.codex.installNotify(v).catch(() => {})
            }}
          />

          <ToggleRow
            label="Auto-resume sessions"
            description="Offer to resume the last agent session when reopening a workspace"
            value={settings.sessionResumeEnabled}
            onChange={(v) => update('sessionResumeEnabled', v)}
          />
        </div>

        <PhoneControlSection />

        <SkillsSubagentsSection />

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
