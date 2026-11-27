// @vitest-environment happy-dom
// The panel against the real server handler (createAssistant) with a scripted model: no network, no mocks of our own code.
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { createAssistant, defineTool, memoryStorage } from '@teovo/server'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AssistantPanel, AssistantProvider, useAssistantContext, type AssistantProviderProps } from './index'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const streamOf = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const say = (text: string) => streamOf([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }])
const call = (toolName: string, input: unknown) => streamOf([{ type: 'tool-call', toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }])

let gate: { open: () => void; wait: Promise<void> } | undefined
const tools = [
  defineTool({ name: 'get_sales', kind: 'read', description: 'Sales', input: z.object({}), run: async () => { await gate?.wait; return { total: 950 } } }),
  defineTool({ name: 'record_payment', kind: 'propose', description: 'Pay', input: z.object({ amount: z.number() }),
    run: ({ amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount}`, before: { paid: 0 }, after: { paid: amount }, payload: { amount } }) }),
  defineTool({ name: 'open_order', kind: 'action', description: 'Open', input: z.object({ no: z.number() }),
    run: ({ no }) => ({ label: `Open order #${no}`, action: 'navigate', args: { to: `/orders/${no}` } }) }),
]

function server(steps: ReturnType<typeof say>[], signedIn = true) {
  const bodies: any[] = []
  const teovo = createAssistant({
    identify: () => (signedIn ? { tenantId: 'shop-1', userId: 'u1', role: 'owner' } : null),
    asUser: () => null, tools, instructions: 'Help.', storage: memoryStorage(),
    models: [new MockLanguageModelV4({ doStream: steps as never })],
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return teovo.fetch(new Request(new URL(String(input), 'https://app.test'), init))
  }) as typeof globalThis.fetch
  return { fetch, bodies }
}

function Screen({ path }: { path: string }) { useAssistantContext({ path, title: 'Orders' }); return null }

function mount(props: Partial<AssistantProviderProps> & { fetch: typeof fetch }, extra?: React.ReactNode) {
  return render(<AssistantProvider endpoint="/api/assistant" {...props}>{extra}<AssistantPanel welcome="Ask about your shop" /></AssistantProvider>)
}
async function ask(text: string) {
  await userEvent.type(screen.getByLabelText('Message'), text)
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
}

afterEach(() => { cleanup(); gate = undefined })

describe('AssistantPanel', () => {
  it('sends only the new message, then continues the same thread', async () => {
    const s = server([say('Sales are ₹950.'), say('Yes, today.')])
    const onThread = vi.fn()
    mount({ fetch: s.fetch, onThread })
    expect(screen.getByText('Ask about your shop')).toBeTruthy()
    await ask('sales?')
    await screen.findByText('Sales are ₹950.')
    expect(s.bodies[0]).toMatchObject({ message: { role: 'user', parts: [{ type: 'text', text: 'sales?' }] } })
    expect(s.bodies[0].threadId).toBeUndefined()
    expect(s.bodies[0].messages).toBeUndefined()
    expect(onThread).toHaveBeenCalledTimes(1)
    await ask('today?')
    await screen.findByText('Yes, today.')
    expect(s.bodies[1].threadId).toBe(onThread.mock.calls[0]![0])
  })

  it('shows a card with before and after; Confirm goes to onCard and the card says Done', async () => {
    const onCard = vi.fn()
    mount({ fetch: server([call('record_payment', { amount: 200 }), say('Ready to confirm.')]).fetch, onCard })
    await ask('paid 200')
    const card = await screen.findByRole('group', { name: 'Payment ₹200' })
    expect(card.textContent).toContain('paid0→200')
    await screen.findByText('Ready to confirm.')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onCard).toHaveBeenCalledWith(expect.objectContaining({ kind: 'record_payment', payload: { amount: 200 }, status: 'shown' }), 'confirm')
    await screen.findByText('Done')
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('keeps the card open and shows the reason when applying it fails', async () => {
    const onCard = vi.fn().mockRejectedValue(new Error('Order #2 was already paid.'))
    mount({ fetch: server([call('record_payment', { amount: 200 }), say('Ready.')]).fetch, onCard })
    await ask('paid 200')
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Order #2 was already paid.')
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
  })

  it('offers buttons from action tools', async () => {
    const onAction = vi.fn()
    mount({ fetch: server([call('open_order', { no: 2 }), say('Here it is.')]).fetch, onAction })
    await ask('open order 2')
    await userEvent.click(await screen.findByRole('button', { name: 'Open order #2' }))
    expect(onAction).toHaveBeenCalledWith({ label: 'Open order #2', action: 'navigate', args: { to: '/orders/2' } })
  })

  it('shows a line while a tool runs and removes it when done', async () => {
    let open!: () => void
    gate = { open: () => open(), wait: new Promise<void>((r) => { open = r }) }
    mount({ fetch: server([call('get_sales', {}), say('₹950')]).fetch })
    await ask('sales?')
    await screen.findByText('Using get sales…')
    await act(async () => gate!.open())
    await screen.findByText('₹950')
    expect(screen.queryByText('Using get sales…')).toBeNull()
  })

  it('sends the screen the user is on, and stops after they leave it', async () => {
    const s = server([say('a'), say('b')])
    const view = mount({ fetch: s.fetch }, <Screen path="/orders" />)
    await ask('x')
    await screen.findByText('a')
    expect(s.bodies[0].page).toEqual({ path: '/orders', title: 'Orders' })
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><AssistantPanel /></AssistantProvider>)
    await ask('y')
    await screen.findByText('b')
    expect(s.bodies[1].page).toBeUndefined()
  })

  it('New chat clears the panel and the next message starts a new thread', async () => {
    const s = server([say('first'), say('second')])
    mount({ fetch: s.fetch })
    await ask('one')
    await screen.findByText('first')
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(screen.queryByText('first')).toBeNull()
    await ask('two')
    await screen.findByText('second')
    expect(s.bodies[1].threadId).toBeUndefined()
  })

  it("shows the server's sentence when the user is signed out", async () => {
    mount({ fetch: server([], false).fetch })
    await ask('hi')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Sign in to use the assistant.'))
  })
})
