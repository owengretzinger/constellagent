import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillsService } from './skills-service'

const testDirs: string[] = []

function createService(): SkillsService {
  const dir = mkdtempSync(join(tmpdir(), 'skills-service-test-'))
  testDirs.push(dir)
  return new SkillsService(join(dir, 'skills.json'))
}

afterEach(() => {
  while (testDirs.length > 0) {
    const dir = testDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SkillsService', () => {
  it('creates and lists skills', async () => {
    const service = createService()
    const created = await service.create({
      name: 'Ticket triage',
      description: 'Prioritize incoming support tickets',
      instruction: 'Classify by urgency and ownership',
    })

    expect(created.id).toBeTruthy()
    expect(created.enabled).toBe(true)

    const all = await service.list()
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe('Ticket triage')
  })

  it('updates and deletes a skill', async () => {
    const service = createService()
    const created = await service.create({
      name: 'Order lookup',
      instruction: 'Ask for order id and summarize status',
    })

    const updated = await service.update(created.id, {
      name: 'Order status lookup',
      enabled: false,
    })
    expect(updated.name).toBe('Order status lookup')
    expect(updated.enabled).toBe(false)

    await service.delete(created.id)
    const all = await service.list()
    expect(all).toHaveLength(0)
  })
})
