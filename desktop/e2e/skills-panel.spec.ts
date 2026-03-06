import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchApp(skillsDir: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      CI_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      CONSTELLAGENT_SKILLS_DIR: skillsDir,
    },
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  return { app, window }
}

function writeSkill(skillsDir: string, name: string, description: string, content: string): void {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\ncompatibility: Requires test setup.\nmetadata:\n  author: tests\n  version: "1.0"\n---\n\n${content}\n`,
    'utf-8'
  )
}

test.describe('Skills panel', () => {
  test('creates, edits, and deletes skills from the dashboard', async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), 'constellagent-skills-'))
    writeSkill(skillsDir, 'existing-skill', 'Existing skill for list rendering.', 'Initial instructions.')

    const { app, window } = await launchApp(skillsDir)

    try {
      await window.getByRole('button', { name: 'Skills' }).click()
      await expect(window.getByRole('heading', { name: 'Skills' })).toBeVisible()
      await expect(window.locator('text=existing-skill')).toBeVisible()

      await window.getByRole('button', { name: '+ New' }).click()
      await expect(window.locator('text=New Skill')).toBeVisible()

      await window.getByPlaceholder('message-routing').fill('message-triage')
      await window.getByPlaceholder('Route customer messages to the right agent...').fill('Route support messages to the proper workflow.')
      await window.getByPlaceholder('Optional runtime requirements').fill('Requires queue routing config.')
      await window.getByPlaceholder('MIT').fill('Apache-2.0')
      await window.getByPlaceholder('constellagent').fill('dashboard-tests')
      await window.getByPlaceholder('1.0').fill('2.1')
      await window.getByPlaceholder('Describe how the agent should use this skill...').fill('Step 1: Inspect the message.\nStep 2: Pick the right queue.')
      await window.getByRole('button', { name: 'Create' }).click()

      await expect(window.locator('text=message-triage')).toBeVisible()
      const createdPath = join(skillsDir, 'message-triage', 'SKILL.md')
      expect(existsSync(createdPath)).toBe(true)
      expect(readFileSync(createdPath, 'utf-8')).toContain('dashboard-tests')

      await window.locator('[class*="automationRow"]', { hasText: 'message-triage' }).getByRole('button', { name: 'Edit' }).click()
      await expect(window.locator('text=Edit Skill')).toBeVisible()

      await window.getByPlaceholder('message-routing').fill('message-triage-v2')
      await window.getByPlaceholder('Route customer messages to the right agent...').fill('Route support and billing messages to the proper workflow.')
      await window.getByPlaceholder('Describe how the agent should use this skill...').fill('Step 1: Inspect the message.\nStep 2: Pick the queue.\nStep 3: Add escalation context.')
      await window.getByRole('button', { name: 'Save' }).click()

      await expect(window.locator('text=message-triage-v2')).toBeVisible()
      const renamedPath = join(skillsDir, 'message-triage-v2', 'SKILL.md')
      expect(existsSync(renamedPath)).toBe(true)
      expect(existsSync(createdPath)).toBe(false)
      expect(readFileSync(renamedPath, 'utf-8')).toContain('billing messages')
      expect(readFileSync(renamedPath, 'utf-8')).toContain('Step 3: Add escalation context.')

      const row = window.locator('[class*="automationRow"]', { hasText: 'message-triage-v2' })
      await row.getByRole('button').last().click()
      await window.getByRole('button', { name: 'Delete' }).click()

      await expect(window.locator('text=message-triage-v2')).toHaveCount(0)
      expect(existsSync(join(skillsDir, 'message-triage-v2'))).toBe(false)
    } finally {
      await app.close()
      rmSync(skillsDir, { recursive: true, force: true })
    }
  })
})
