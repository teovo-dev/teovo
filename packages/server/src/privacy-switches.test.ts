import { chat, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, type AssistantConfig } from './assistant'
import { noticeId } from './settings'
import { memoryStorage } from './storage'
import { defineTool, type Identity } from './tools'

const owner: Identity = { tenantId: 'shop', userId: 'u1', role: 'owner' }

function app(extra: Partial<AssistantConfig> = {}) {
  const storage = memoryStorage()
  const main = scriptedModel(() => say('from main'), { modelId: 'main' })
  const backup = scriptedModel(() => say('from backup'), { modelId: 'backup' })
  const teovo = createAssistant({
    identify: () => owner, asUser: () => null, instructions: 'Help.', storage, models: [main, backup], attachments: {},
    tools: [defineTool({ name: 'refund', kind: 'read', description: 'Refunds', input: z.object({}), run: () => [] })],
    ...extra,
  })
  const send = (body: Record<string, unknown>) => teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hi' }] }, ...body }) }))
  return { teovo, storage, main, backup, send }
}

describe('privacy notice and pictures', () => {
  it('asks each person to accept the notice in its current words before chatting', async () => {
    const s = app()
    await s.storage.saveTenantSettings('shop', { enabled: true, privacy: { notice: 'Questions go to Google Gemini. Do not share card numbers.' } })
    const pol = (await (await s.teovo.fetch(new Request('https://a.test/policy'))).json()) as { notice: string; noticeId: string; pictures: boolean }
    expect(pol).toMatchObject({ notice: 'Questions go to Google Gemini. Do not share card numbers.', pictures: true })
    expect((await s.send({})).status).toBe(428)
    expect((await s.send({ consent: 'wrong' })).status).toBe(428)
    const ok = await s.send({ consent: pol.noticeId })
    expect(ok.status).toBe(200)
    await ok.text()
    // Changing the notice asks again.
    await s.storage.saveTenantSettings('shop', { enabled: true, privacy: { notice: 'Questions go to Google Gemini and Cloudflare.' } })
    expect((await s.send({ consent: pol.noticeId })).status).toBe(428)
    expect((await s.send({ consent: await noticeId('Questions go to Google Gemini and Cloudflare.') })).status).toBe(200)
  })

  it('refuses pictures when the tenant turned them off, and says so in the policy', async () => {
    const s = app()
    await s.storage.saveTenantSettings('shop', { enabled: true, privacy: { pictures: false } })
    expect(((await (await s.teovo.fetch(new Request('https://a.test/policy'))).json()) as { pictures: boolean }).pictures).toBe(false)
    const res = await s.teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'p', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }, { type: 'text', text: 'bill' }] } }) }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Pictures are turned off for your team. Describe it in words instead.')
  })
})

describe('allowance', () => {
  it('lists every limit with how much is used', async () => {
    const s = app({ limits: { user: { messages: 10 }, tenant: { messages: 100 } } })
    await chat(s.teovo, 'one')
    await chat(s.teovo, 'two')
    const { allowance } = (await (await s.teovo.fetch(new Request('https://a.test/allowance'))).json()) as { allowance: unknown[] }
    expect(allowance).toEqual(expect.arrayContaining([
      { scope: 'user', unit: 'messages', period: 'day', limit: 10, used: 2 },
      { scope: 'tenant', unit: 'messages', period: 'day', limit: 100, used: 2 },
    ]))
  })
})

describe('switches for every tenant', () => {
  it('pauses everyone, takes a model or a tool out of service, and switches back on', async () => {
    const s = app()
    await s.teovo.setSwitches({ enabled: false })
    expect((await s.send({})).status).toBe(503)

    await s.teovo.setSwitches({ modelsOff: ['main'], toolsOff: ['refund'] })
    expect((await chat(s.teovo, 'hi')).text).toBe('from backup')
    expect((s.backup.doStreamCalls.at(-1)!.tools ?? []).map((t) => t.name)).not.toContain('refund')

    await s.teovo.setSwitches({ modelsOff: ['main', 'backup'] })
    expect((await s.send({})).status).toBe(503)

    await s.teovo.setSwitches({})
    expect((await chat(s.teovo, 'hi')).text).toBe('from main')
  })
})
