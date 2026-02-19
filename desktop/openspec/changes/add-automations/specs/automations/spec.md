## ADDED Requirements

### Requirement: Automation entity CRUD
The system SHALL support creating, reading, updating, and deleting automations. Each automation SHALL have: id, name, projectId, prompt, cronExpression, enabled (boolean), and createdAt timestamp.

#### Scenario: Create automation
- **WHEN** user creates an automation with a name, project, prompt, and cron expression
- **THEN** the system persists the automation with `enabled: true` and schedules it immediately

#### Scenario: Update automation schedule
- **WHEN** user updates an automation's cron expression
- **THEN** the system reschedules the cron job with the new expression

#### Scenario: Delete automation
- **WHEN** user deletes an automation
- **THEN** the system unschedules the cron job and removes the automation from persisted state

### Requirement: Automation scheduling
The system SHALL schedule enabled automations using cron expressions. The scheduler SHALL run in the Electron main process and activate on app startup.

#### Scenario: App startup with existing automations
- **WHEN** the app starts and persisted state contains enabled automations
- **THEN** the system schedules all enabled automations with their cron expressions

#### Scenario: Disable automation
- **WHEN** user sets an automation's `enabled` field to false
- **THEN** the system unschedules the cron job but retains the automation in state

#### Scenario: Re-enable automation
- **WHEN** user sets a disabled automation's `enabled` field to true
- **THEN** the system schedules the automation with its cron expression

#### Scenario: Wake catch-up while app stays open
- **WHEN** the machine sleeps through one or more scheduled times while the app remains open
- **THEN** the system runs at most one catch-up execution on wake/unlock for that automation
- **AND** resumes normal cron scheduling afterward

#### Scenario: No catch-up after full app relaunch
- **WHEN** the app is fully quit and later relaunched
- **THEN** the system does not backfill runs missed while the app was not running
- **AND** only schedules future runs from relaunch time onward

### Requirement: Automation execution
When a scheduled automation fires, the system SHALL spawn `claude -p "<prompt>" --no-input` via node-pty in the automation's project repoPath. The system SHALL create a new workspace and terminal tab to display the streaming output.

#### Scenario: Scheduled run triggers
- **WHEN** the cron schedule fires for an enabled automation
- **THEN** the system spawns a PTY running `claude -p "<prompt>" --no-input` in the project's repoPath
- **AND** creates a new workspace named `<automation-name> · <formatted-timestamp>` under the project
- **AND** creates a terminal tab in that workspace connected to the PTY

#### Scenario: Manual run
- **WHEN** user triggers "Run now" on an automation
- **THEN** the system executes the automation immediately, same as a scheduled run

#### Scenario: Skip concurrent runs
- **WHEN** a scheduled run fires but the previous run for that automation is still active
- **THEN** the system skips the run

#### Scenario: Run timeout
- **WHEN** a run exceeds 10 minutes
- **THEN** the system kills the PTY process

### Requirement: Automation run workspace tagging
Each workspace created by an automation run SHALL include an `automationId` field linking it to the source automation. This distinguishes automation-created workspaces from manually-created ones.

#### Scenario: Workspace has automation link
- **WHEN** an automation run creates a workspace
- **THEN** the workspace's `automationId` field SHALL match the automation's id

### Requirement: Run history cleanup
The system SHALL retain at most 5 run workspaces per automation. When a new run creates a 6th workspace, the oldest run workspace for that automation SHALL be automatically deleted.

#### Scenario: Auto-cleanup old runs
- **WHEN** an automation has 5 existing run workspaces and a new run starts
- **THEN** the oldest run workspace (and its PTY) is destroyed before creating the new one

### Requirement: Automation persistence
Automations SHALL be persisted to disk alongside projects and workspaces. Automation runs (workspaces) are persisted as normal workspaces.

#### Scenario: Persist and restore
- **WHEN** the app saves state
- **THEN** all automations are included in the persisted state
- **AND** on next app startup, automations are restored and scheduled

### Requirement: Automation IPC channels
The system SHALL expose IPC channels for automation operations: create, update, delete, list, run-now, and stop. The main process SHALL own scheduler state; the renderer SHALL send commands via the preload bridge.

#### Scenario: Renderer creates automation via IPC
- **WHEN** the renderer calls `window.api.automations.create(automation)`
- **THEN** the main process persists the automation and schedules its cron job
- **AND** sends a `automation:run-started` event to renderer when runs begin
