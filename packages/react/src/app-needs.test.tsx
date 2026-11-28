// @vitest-environment happy-dom
// What apps needed and had to build themselves: a layout naming every screen under record screens, tool labels,
// a usage meter for settings, and room for the open button above a bottom navigation bar.
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { createAssistant, defineTool, memoryStorage, type AssistantConfig } from '@teovo/server'
import type { Card, CardDecision } from './types'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AllowanceMeter, AssistantPanel, AssistantProvider, AssistantSheet, useAssistantContext } from './index'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const streamOf = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const say = (text: string) => streamOf([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }])
const call = (toolName: string, input: unknown) => streamOf([{ type: 'tool-call', toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }])

function server(steps: ReturnType<typeof say>[], extra: Partial<AssistantConfig> = {}) {
  const teovo = createAssistant({
    identify: () => ({ tenantId: 'shop-1', userId: 'u1', role: 'owner' }), asUser: () => null, instructions: 'Help.', storage: memoryStorage(),
    tools: [defineTool({ name: 'get_sale', kind: 'read', label: 'Looked at the order', description: 'One order', input: z.object({}), run: () => ({ total: 950 }) })],
    models: [new MockLanguageModelV4({ doStream: steps as never })], ...extra,
  })
  return (async (input: RequestInfo | URL, init?: RequestInit) => teovo.fetch(new Request(new URL(String(input), 'https://app.test'), init))) as typeof fetch
}

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear() })

describe('a layout naming every screen, under record screens', () => {
  function Layout({ children }: { children?: React.ReactNode }) { useAssistantContext({ path: '/sales/4', title: 'An order' }, { fallback: true }); return <>{children}</> }
  function Order({ title }: { title: string }) { useAssistantContext({ path: '/sales/4', title }); return null }
  const page = () => document.querySelector('.tv-page span')?.textContent

  it("shows the record screen's own title, whatever order the effects ran in, and the layout's when it goes", async () => {
    const f = server([])
    // The record screen is inside the layout: React runs its effect first, then the layout's.
    const view = render(<AssistantProvider endpoint="/api/assistant" fetch={f}><Layout><Order title="Order #4 · Kavya" /></Layout><AssistantPanel /></AssistantProvider>)
    await waitFor(() => expect(page()).toBe('On Order #4 · Kavya'))
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={f}><Layout><Order title="Order #4 · Kavya R" /></Layout><AssistantPanel /></AssistantProvider>)
    await waitFor(() => expect(page()).toBe('On Order #4 · Kavya R'))
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={f}><Layout /><AssistantPanel /></AssistantProvider>)
    await waitFor(() => expect(page()).toBe('On An order'))
  })

  it('reports no page for an empty one', async () => {
    function Nothing() { useAssistantContext({}); return null }
    render(<AssistantProvider endpoint="/api/assistant" fetch={server([])}><Nothing /><AssistantPanel /></AssistantProvider>)
    await new Promise((r) => setTimeout(r, 20))
    expect(document.querySelector('.tv-page')).toBeNull()
  })
})

describe("tools' own labels", () => {
  it('shows the label the tool was defined with, and the app can still reword it', async () => {
    render(<AssistantProvider endpoint="/api/assistant" fetch={server([call('get_sale', {}), say('₹950.'), call('get_sale', {}), say('Still ₹950.')])}><AssistantPanel showSteps="open" /></AssistantProvider>)
    await userEvent.type(screen.getByLabelText('Message'), 'order 4?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('₹950.')
    expect(screen.getByText('Looked at the order')).toBeTruthy()
    cleanup()
    render(<AssistantProvider endpoint="/api/assistant" fetch={server([call('get_sale', {}), say('₹950.')])}><AssistantPanel showSteps="open" stepLabels={{ get_sale: 'Opened the order' }} /></AssistantProvider>)
    await userEvent.type(screen.getByLabelText('Message'), 'order 4?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('₹950.')
    expect(screen.getByText('Opened the order')).toBeTruthy()
  })
})

describe('AllowanceMeter', () => {
  it("shows the tenant's use today against its limit, and turns amber past 70%", async () => {
    const f = server([say('one'), say('two'), say('three')], { limits: { tenant: { messages: 4 } } })
    render(<AssistantProvider endpoint="/api/assistant" fetch={f}><AllowanceMeter units={{ messages: 'AI requests' }} note="Resets at midnight." /><AssistantPanel /></AssistantProvider>)
    for (const [q, a] of [['first', 'one'], ['second', 'two'], ['third', 'three']] as const) {
      await userEvent.type(screen.getByLabelText('Message'), q)
      await userEvent.click(screen.getByRole('button', { name: 'Send' }))
      await screen.findByText(a)
    }
    await waitFor(() => expect(document.querySelector('.tv-meter-pct')?.textContent).toBe('75%'))
    expect(document.querySelector('.tv-meter')?.className).toContain('tv-meter-mid')
    expect(document.querySelector('.tv-meter-lines')?.textContent).toBe('3 of 4 AI requests today. Resets at midnight.')
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('75')
  })

  it('draws nothing when no limit applies', async () => {
    render(<AssistantProvider endpoint="/api/assistant" fetch={server([])}><AllowanceMeter /></AssistantProvider>)
    await new Promise((r) => setTimeout(r, 20))
    expect(document.querySelector('.tv-meter')).toBeNull()
  })
})

describe('room under the open button', () => {
  it('sets --tv-open-offset on the button when given', () => {
    render(<AssistantProvider endpoint="/api/assistant" fetch={server([])}><AssistantSheet buttonOffset="5.5rem"><AssistantPanel /></AssistantSheet></AssistantProvider>)
    const button = document.querySelector('.tv-sheet-open') as HTMLElement
    expect(button.style.getPropertyValue('--tv-open-offset')).toBe('5.5rem')
  })
})

describe('onCardDecided', () => {
  it("tells the app once the server applied a card, so its screens can reload", async () => {
    const decided: [Card, CardDecision][] = []
    const f = server([call('pay', { amount: 200 }), say('Ready.')], {
      tools: [defineTool({ name: 'pay', kind: 'propose', description: 'Pay', input: z.object({ amount: z.number() }), run: ({ amount }) => ({ kind: 'pay', title: `Payment ₹${amount}`, payload: { amount } }) })],
      cards: { pay: { apply: () => ({ note: 'Paid' }) } },
    })
    render(<AssistantProvider endpoint="/api/assistant" fetch={f} onCardDecided={(c, d) => decided.push([c, d])}><AssistantPanel /></AssistantProvider>)
    await userEvent.type(screen.getByLabelText('Message'), 'she paid 200')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(decided).toHaveLength(1))
    expect(decided[0]![1]).toBe('confirm')
    expect(decided[0]![0]).toMatchObject({ title: 'Payment ₹200', status: 'confirmed' })
  })
})
