// @vitest-environment happy-dom
// The panel against the real server handler (createAssistant) with a scripted model: no network, no mocks of our own code.
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { builtinViews, createAssistant, defineTool, memoryFiles, memoryStorage, type AssistantConfig, type CardApplier } from '@teovo/server'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AssistantPanel, AssistantProvider, complete, ThreadList, useAssistantContext, type AssistantProviderProps } from './index'

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

function server(steps: ReturnType<typeof say>[], signedIn = true, cards: Record<string, CardApplier> = {}, extra: Partial<AssistantConfig> = {}) {
  const bodies: any[] = []
  const teovo = createAssistant({
    identify: () => (signedIn ? { tenantId: 'shop-1', userId: 'u1', role: 'owner' } : null),
    asUser: () => null, tools, instructions: 'Help.', storage: memoryStorage(), cards,
    models: [new MockLanguageModelV4({ doStream: steps as never })], ...extra,
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    return teovo.fetch(new Request(new URL(String(input), 'https://app.test'), init))
  }) as typeof globalThis.fetch
  return { fetch, bodies }
}

function Screen({ path, id }: { path: string; id?: string }) { useAssistantContext({ path, title: 'Orders', ...(id ? { record: { type: 'order', id } } : {}) }); return null }

function mount(props: Partial<AssistantProviderProps> & { fetch: typeof fetch }, extra?: React.ReactNode) {
  return render(<AssistantProvider endpoint="/api/assistant" {...props}>{extra}<AssistantPanel welcome="Ask about your shop" /></AssistantProvider>)
}
async function ask(text: string) {
  await userEvent.type(screen.getByLabelText('Message'), text)
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
}

afterEach(() => { cleanup(); gate = undefined })

describe('one card for many records', () => {
  it('lists each record\'s change with the old value struck out, and a count', async () => {
    const s = server([call('raise', {}), say('Ready.')], true, {}, {
      formats: { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' },
      tools: [defineTool({ name: 'raise', kind: 'propose', description: 'Raise prices', input: z.object({}), run: () => ({
        kind: 'raise', title: 'Raise 2 prices', payload: {}, fields: [{ key: 'price', label: 'Price', format: 'money' as const }],
        items: [{ label: 'Mango 500 ml', before: { price: 350 }, after: { price: 380 } }, { label: 'Kulfi', before: { price: 300 }, after: { price: 330 } }] }) })],
    })
    mount({ fetch: s.fetch })
    await ask('raise prices')
    const card = await screen.findByRole('group', { name: 'Raise 2 prices' })
    expect(card.querySelector('.tv-card-count')?.textContent).toBe('2 changes')
    const rows = Array.from(card.querySelectorAll('.tv-card-items tr')).map((r) => r.textContent)
    expect(rows).toEqual(['Mango 500 ml₹350.00 → ₹380.00', 'Kulfi₹300.00 → ₹330.00'])
  })
})

describe('typing help and record links', () => {
  it('completes the last words from the app\'s list or an earlier message', () => {
    const words = ['Riya K', 'Riya Sharma', 'Chand Bakers', 'Belgian chocolate 500 ml']
    expect(complete('Chand B', words)).toEqual({ word: 'Chand Bakers', full: 'Chand Bakers ' })
    expect(complete('two belgian ch', words)).toEqual({ word: 'Belgian chocolate 500 ml', full: 'two Belgian chocolate 500 ml ' })
    expect(complete('r', words)).toBeNull()                    // too short
    expect(complete('Riya K ', words)).toBeNull()              // a finished word
    expect(complete('who ow', [], ['who owes the most?'])).toEqual({ word: 'who owes the most?', full: 'who owes the most?' })
  })

  it('offers a completion while typing, and Tab takes it', async () => {
    const s = server([], true, {}, { completions: () => ['Chand Bakers'] })
    mount({ fetch: s.fetch })
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    await waitFor(() => expect(s.bodies).toBeDefined())
    await userEvent.type(box, 'how much does chand b')
    await screen.findByRole('button', { name: 'Complete: Chand Bakers' })
    await userEvent.keyboard('{Tab}')
    expect(box.value).toBe('how much does Chand Bakers ')
  })

  it('cycles the empty box through the screen\'s example questions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const s = server([], true, {}, { suggestions: () => ({ suggestions: [], examples: ['Who owes money?', 'Sales this week?'] }) })
      mount({ fetch: s.fetch })
      const box = screen.getByLabelText('Message') as HTMLTextAreaElement
      await waitFor(() => expect(box.placeholder).toBe('Who owes money?  (Tab)'))
      await act(async () => { vi.advanceTimersByTime(3600) })
      expect(box.placeholder).toBe('Sales this week?  (Tab)')
    } finally { vi.useRealTimers() }
  })

  it('shows "From:" links under an answer and opens one through onAction', async () => {
    const onAction = vi.fn()
    const s = server([call('get_sales', {}), say('₹950 today.')], true, {}, {
      tools: [defineTool({ name: 'get_sales', kind: 'read', description: 'Sales', input: z.object({}), run: () => ({ total: 950 }), links: () => [{ label: 'Sales today', to: '/sales?day=today' }] })],
    })
    mount({ fetch: s.fetch, onAction })
    await ask('sales today?')
    await userEvent.click(await screen.findByRole('button', { name: 'Sales today' }))
    expect(onAction).toHaveBeenCalledWith({ label: 'Sales today', action: 'navigate', args: { to: '/sales?day=today' } })
  })
})

describe('notice, pictures and allowance', () => {
  it('shows the notice and blocks typing until it is accepted, then sends the acceptance with each message', async () => {
    localStorage.clear()
    const s = server([say('Hello.')], true, {}, { attachments: {} })
    // The tenant's notice, set the way an admin would.
    await s.fetch('/api/assistant/settings', { method: 'PUT', body: JSON.stringify({ enabled: true, privacy: { notice: 'Questions go to Google Gemini.' } }) })
    mount({ fetch: s.fetch })
    const notice = await screen.findByRole('region', { name: 'About this assistant' })
    expect(notice.textContent).toContain('Questions go to Google Gemini.')
    expect(screen.getByLabelText('Message').closest('form')!.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'I understand' }))
    expect(screen.queryByRole('region', { name: 'About this assistant' })).toBeNull()
    await ask('hi')
    await screen.findByText('Hello.')
    expect(s.bodies.at(-1).consent).toMatch(/^[0-9a-f]{16}$/)
  })

  it('hides the attach button when pictures are turned off', async () => {
    const s = server([], true, {}, { attachments: {} })
    await s.fetch('/api/assistant/settings', { method: 'PUT', body: JSON.stringify({ enabled: true, privacy: { pictures: false } }) })
    render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><AssistantPanel attach /></AssistantProvider>)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Attach a picture' })).toBeNull())
  })

  it('says how many messages are left once the allowance runs low', async () => {
    const s = server([say('one'), say('two')], true, {}, { limits: { user: { messages: 3 } } })
    mount({ fetch: s.fetch })
    await ask('first')
    await screen.findByText('one')
    await waitFor(() => expect(document.querySelector('.tv-allowance')?.textContent).toBe('You have 2 messages left today.'))
    await ask('second')
    await screen.findByText('two')
    await waitFor(() => expect(document.querySelector('.tv-allowance')?.textContent).toBe('You have 1 message left today.'))
  })
})

describe('actions on messages', () => {
  it('edits a question and sends it again: the old reply goes, a new one comes', async () => {
    const s = server([say('Sales today: ₹500.'), say('Sales this week: ₹4,200.')])
    mount({ fetch: s.fetch })
    await ask('sales today?')
    await screen.findByText('Sales today: ₹500.')
    await userEvent.click(screen.getByRole('button', { name: 'Edit and send again' }))
    const box = screen.getByLabelText('Edit your message') as HTMLTextAreaElement
    expect(box.value).toBe('sales today?')
    await userEvent.clear(box)
    await userEvent.type(box, 'sales this week?')
    await userEvent.click(screen.getByRole('button', { name: 'Send again' }))
    await screen.findByText('Sales this week: ₹4,200.')
    expect(screen.queryByText('Sales today: ₹500.')).toBeNull()
    expect(screen.queryByText('sales today?')).toBeNull()
    const last = s.bodies.at(-1)
    expect(last.message.id).toBe(s.bodies[0].message.id)            // the same message, sent again
    expect(last.message.parts[0].text).toBe('sales this week?')
  })

  it('asks for the last reply again, rates a reply and copies it', async () => {
    const s = server([say('First try.'), say('Second try.')])
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mount({ fetch: s.fetch })
    await ask('hello')
    await screen.findByText('First try.')
    await userEvent.click(screen.getByRole('button', { name: 'Good answer' }))
    await waitFor(() => expect(s.bodies.at(-1)).toEqual({ value: 'up' }))
    expect(screen.getByRole('button', { name: 'Good answer' }).getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('First try.')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Second try.')
    expect(screen.queryByText('First try.')).toBeNull()
  })
})

describe('card values', () => {
  it('shows a new record as its values, in the given order, with labels, money and dates in the tenant\'s format', async () => {
    const s = server([call('add_expense', { amount: 1320 }), say('Ready to confirm.')], true, {}, {
      formats: { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' },
      tools: [defineTool({ name: 'add_expense', kind: 'propose', description: 'Add', input: z.object({ amount: z.number() }),
        run: ({ amount }) => ({ kind: 'add_expense', title: 'Expense to Sharma', after: { vendor: 'Sharma', date: '2026-11-26', amount }, payload: {},
          fields: [{ key: 'amount', label: 'Amount', format: 'money' as const }, { key: 'vendor', label: 'Vendor' }, { key: 'date', label: 'Date' }] }) })],
    })
    mount({ fetch: s.fetch })
    await ask('add it')
    const card = await screen.findByRole('group', { name: 'Expense to Sharma' })
    const rows = Array.from(card.querySelectorAll('tr')).map((r) => Array.from(r.children).map((c) => c.textContent))
    expect(rows).toEqual([['Amount', '₹1,320.00'], ['Vendor', 'Sharma'], ['Date', '26 Nov 2026']])
    expect(card.textContent).not.toContain('→')
  })
})

describe('page label', () => {
  function Filtered({ unpaid }: { unpaid: boolean }) { useAssistantContext({ path: '/orders', title: 'Orders', state: { filter: unpaid ? 'unpaid' : null, selected: 0 } }); return null }

  it('shows which page the assistant sees, follows the page, and can be hidden or reworded', async () => {
    const s = server([])
    const view = render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><Filtered unpaid /><AssistantPanel /></AssistantProvider>)
    await waitFor(() => expect(document.querySelector('.tv-page')?.textContent).toBe('On Orders · filter: unpaid · selected: 0'))
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><Filtered unpaid={false} /><AssistantPanel /></AssistantProvider>)
    await waitFor(() => expect(document.querySelector('.tv-page')?.textContent).toBe('On Orders · selected: 0'))
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><AssistantPanel /></AssistantProvider>)
    await waitFor(() => expect(document.querySelector('.tv-page')).toBeNull())   // no page reported: no label
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><Screen path="/orders/142" id="142" /><AssistantPanel pageLabel={(p) => `Order #${p.record?.id}`} /></AssistantProvider>)
    await waitFor(() => expect(document.querySelector('.tv-page')?.textContent).toBe('Order #142'))
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><Screen path="/orders/142" id="142" /><AssistantPanel pageLabel={false} /></AssistantProvider>)
    expect(document.querySelector('.tv-page')).toBeNull()
  })
})

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
    expect(card.textContent).toContain('Paid0→200')
    await screen.findByText('Ready to confirm.')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onCard).toHaveBeenCalledWith(expect.objectContaining({ kind: 'record_payment', payload: { amount: 200 }, status: 'shown' }), 'confirm')
    await screen.findByText('Done')
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('records what the app applied on the server, so a reopened conversation shows the card decided with Undo', async () => {
    const s = server([call('record_payment', { amount: 200 }), say('Ready to confirm.')], true, {}, { cards: { record_payment: { inApp: true } } })
    const onCard = vi.fn().mockResolvedValue({ reversible: true })
    let id: string | undefined
    const view = render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch} onCard={onCard} onThread={(t) => { id = t }}><AssistantPanel /></AssistantProvider>)
    await ask('paid 200')
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    await screen.findByText('Done')
    await waitFor(() => expect(s.bodies.at(-1)).toEqual({ reversible: true }))
    view.unmount()

    render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch} threadId={id} onCard={onCard}><AssistantPanel /></AssistantProvider>)
    await screen.findByText('Done')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
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

  it("by default confirms and undoes through the server's card endpoints", async () => {
    let paid = 0
    const cards = { record_payment: { apply: ({ amount }: { amount: number }) => { paid += amount; return { undo: amount } }, undo: (n: unknown) => { paid -= n as number } } }
    mount({ fetch: server([call('record_payment', { amount: 200 }), say('Ready.')], true, cards).fetch })
    await ask('paid 200')
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    await screen.findByText('Done')
    expect(paid).toBe(200)
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByText('Undone')
    expect(paid).toBe(0)
  })

  it("shows the server's reason when a card can't be applied", async () => {
    mount({ fetch: server([call('record_payment', { amount: 200 }), say('Ready.')], true, {}).fetch })
    await ask('paid 200')
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This app can\'t apply "record_payment" changes yet.')
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy()
  })

  it('offers buttons from action tools', async () => {
    const onAction = vi.fn()
    mount({ fetch: server([call('open_order', { no: 2 }), say('Here it is.')]).fetch, onAction })
    await ask('open order 2')
    await userEvent.click(await screen.findByRole('button', { name: 'Open order #2' }))
    expect(onAction).toHaveBeenCalledWith({ label: 'Open order #2', action: 'navigate', args: { to: '/orders/2' } })
  })

  it('shows the steps live while it works, then folds them into "1 step" with details under arrows', async () => {
    let open!: () => void
    gate = { open: () => open(), wait: new Promise<void>((r) => { open = r }) }
    mount({ fetch: server([call('get_sales', {}), say('₹950')]).fetch })
    await ask('sales?')
    await screen.findByText('Looked up get sales…')                  // live, with a spinner
    await act(async () => gate!.open())
    await screen.findByText('₹950')
    expect(screen.queryByText('Looked up get sales…')).toBeNull()
    const toggle = screen.getByRole('button', { name: /^1 step/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(toggle)
    const row = screen.getByRole('button', { name: /Looked up get sales/ })
    await userEvent.click(row)
    expect(screen.getByText('Asked for').parentElement!.textContent).toBe('Asked for everything')
    expect(screen.getByText('Found').parentElement!.textContent).toBe('Found 1 record (total)')
    expect(document.querySelector('.tv-step-raw pre')!.textContent).toContain('"total": 950')
  })

  it('marks a step that failed, with the reason', async () => {
    const s = server([call('get_stock', {}), say('I could not read the stock.')], true, {}, {
      tools: [defineTool({ name: 'get_stock', kind: 'read', description: 'Stock', input: z.object({}), run: () => { throw new Error('The stock sheet is offline.') } })],
    })
    mount({ fetch: s.fetch })
    await ask('stock?')
    await screen.findByText('I could not read the stock.')
    await userEvent.click(screen.getByRole('button', { name: /1 failed/ }))
    expect(document.querySelector('.tv-steps-item')!.getAttribute('data-state')).toBe('failed')
    await userEvent.click(screen.getByRole('button', { name: /Looked up get stock/ }))
    expect(document.querySelector('.tv-step-detail .tv-error')!.textContent).toBe('The stock sheet is offline.')
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

  it('shows chips for the screen, sends one on click, then shows follow-ups', async () => {
    const seen: unknown[] = []
    const s = server([say('Riya owes ₹880.')], true, {}, {
      suggestions: ({ page, after }) => {
        seen.push(after ? 'after' : page)
        return after ? { suggestions: ['Send Riya a reminder'] } : { suggestions: [`Who owes for order ${page?.record?.id}?`], placeholder: 'Ask about this order' }
      },
    })
    mount({ fetch: s.fetch }, <Screen path="/orders/142" id="142" />)
    const chip = await screen.findByRole('button', { name: 'Who owes for order 142?' })
    expect(seen[0]).toEqual({ path: '/orders/142', title: 'Orders', record: { type: 'order', id: '142' } })
    await userEvent.click(chip)
    expect(s.bodies[0].message.parts[0].text).toBe('Who owes for order 142?')
    await screen.findByText('Riya owes ₹880.')
    await screen.findByRole('button', { name: 'Send Riya a reminder' })
    expect(screen.queryByRole('button', { name: 'Who owes for order 142?' })).toBeNull()
  })

  it('Tab fills in the hint when the input is empty', async () => {
    const s = server([say('ok')], true, {}, { suggestions: () => ({ suggestions: [], placeholder: 'Ask about this order' }) })
    mount({ fetch: s.fetch })
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    await waitFor(() => expect(box.placeholder).toBe('Ask about this order  (Tab)'))
    box.focus()
    await userEvent.keyboard('{Tab}')
    expect(box.value).toBe('Ask about this order')
  })

  it('fetches new chips when the screen changes', async () => {
    const s = server([], true, {}, { suggestions: ({ page }) => ({ suggestions: [`On ${page?.path ?? 'home'}`] }) })
    const view = mount({ fetch: s.fetch }, <Screen path="/orders" />)
    await screen.findByRole('button', { name: 'On /orders' })
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><Screen path="/expenses" /><AssistantPanel /></AssistantProvider>)
    await screen.findByRole('button', { name: 'On /expenses' })
  })

  it('fetches the new screen\'s chips mid-conversation too, replacing the last reply\'s follow-ups', async () => {
    const s = server([say('ok')], true, {}, { suggestions: ({ page, after }) => ({ suggestions: [after ? 'Follow-up' : `On ${page?.path ?? 'home'}`] }) })
    const view = mount({ fetch: s.fetch }, <Screen path="/orders" />)
    await ask('hello')
    await screen.findByRole('button', { name: 'Follow-up' })
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><Screen path="/orders/142" id="142" /><AssistantPanel /></AssistantProvider>)
    await screen.findByRole('button', { name: 'On /orders/142' })
    expect(screen.queryByRole('button', { name: 'Follow-up' })).toBeNull()
  })

  it('tells the app which conversation is open, also when one is opened from the list', async () => {
    const s = server([say('First answer.'), say('Second answer.')])
    const onThread = vi.fn()
    const view = render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch} onThread={onThread}><AssistantPanel /></AssistantProvider>)
    await ask('first question')
    await screen.findByText('First answer.')
    const firstId = onThread.mock.calls.at(-1)![0] as string
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await ask('second question')
    await screen.findByText('Second answer.')
    expect(onThread.mock.calls.at(-1)![0]).not.toBe(firstId)
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch} onThread={onThread}><ThreadList /><AssistantPanel /></AssistantProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'first question' }))
    await screen.findByText('First answer.')
    expect(onThread.mock.calls.at(-1)![0]).toBe(firstId)
  })

  it('lists earlier conversations, opens one, and continues it', async () => {
    const s = server([say('First answer.'), say('Second answer.'), say('Continued.')])
    const view = mount({ fetch: s.fetch })
    await ask('first question')
    await screen.findByText('First answer.')
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await ask('second question')
    await screen.findByText('Second answer.')
    const first = s.bodies.length   // requests so far
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><ThreadList /><AssistantPanel /></AssistantProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'first question' }))
    await screen.findByText('First answer.')
    expect(screen.queryByText('Second answer.')).toBeNull()
    await ask('more')
    await screen.findByText('Continued.')
    const sent = s.bodies.slice(first).find((b) => b.message?.parts?.[0]?.text === 'more')
    const firstThread = s.bodies.find((b) => b.message?.parts?.[0]?.text === 'first question')
    expect(sent.threadId).toBeTruthy()
    expect(s.bodies.filter((b) => b.threadId === sent.threadId).length).toBe(1)
    expect(firstThread.threadId).toBeUndefined()
  })

  it('opens the conversation the app passes in, with its cards as they are now', async () => {
    let id = ''
    const s = server([call('record_payment', { amount: 200 }), say('Ready.')], true, { record_payment: { apply: () => {}, undo: () => {} } })
    const first = render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch} onThread={(t) => { id = t }}><AssistantPanel /></AssistantProvider>)
    await ask('paid 200')
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    await screen.findByText('Done')
    first.unmount()
    render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch} threadId={id}><AssistantPanel /></AssistantProvider>)
    await screen.findByText('paid 200')
    await screen.findByText('Done')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('asks with choices, sends the pick, and closes the choices once answered', async () => {
    const s = server([call('show_choices', { question: 'Which Riya?', options: [{ label: 'Riya Sharma' }, { label: 'Riya K' }] }), say('Pick one.'), say('Riya K owes ₹880.')], true, {}, { views: builtinViews })
    mount({ fetch: s.fetch })
    await ask('what does Riya owe?')
    const group = await screen.findByRole('group', { name: 'Which Riya?' })
    await userEvent.click(screen.getByRole('button', { name: 'Riya K' }))
    expect(s.bodies.at(-1).message.parts[0].text).toBe('Riya K')
    await screen.findByText('Riya K owes ₹880.')
    expect((group.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sorts a table by a column', async () => {
    const rows = [{ name: 'Bina', due: 300 }, { name: 'Asha', due: 900 }, { name: 'Chand', due: 50 }]
    const s = server([call('show_table', { title: 'Unpaid', columns: [{ key: 'name', label: 'Customer' }, { key: 'due', label: 'Due' }], rows }), say('Here.')], true, {}, { views: builtinViews })
    mount({ fetch: s.fetch })
    await ask('unpaid?')
    await screen.findByText('Bina')
    const names = () => Array.from(document.querySelectorAll('.tv-table tbody tr td:first-child')).map((td) => td.textContent)
    expect(names()).toEqual(['Bina', 'Asha', 'Chand'])
    await userEvent.click(screen.getByRole('button', { name: 'Due' }))
    expect(names()).toEqual(['Chand', 'Bina', 'Asha'])
    await userEvent.click(screen.getByRole('button', { name: 'Due' }))
    expect(names()).toEqual(['Asha', 'Bina', 'Chand'])
  })

  it('sends a corrected form and shows the card it became, right under it', async () => {
    const form = { title: 'New expense', submit: { kind: 'expense' }, fields: [
      { name: 'amount', label: 'Amount', type: 'number', value: 450, required: true }, { name: 'vendor', label: 'Vendor', value: 'Milk depot' }] }
    let applied: unknown
    const s = server([call('show_form', form), say('Check it.')], true, { add_expense: { apply: (p: unknown) => { applied = p } } }, {
      views: builtinViews, forms: { expense: (v) => ({ kind: 'add_expense', title: `Expense ₹${v.amount} to ${v.vendor}`, payload: v }) },
    })
    mount({ fetch: s.fetch })
    await ask('spent 450 on milk')
    const amount = await screen.findByDisplayValue('450')
    await userEvent.clear(amount)
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Amount is required.')
    await userEvent.type(amount, '480')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('group', { name: 'Expense ₹480 to Milk depot' })
    expect(screen.getByText('Sent')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await screen.findByText('Done')
    expect(applied).toEqual({ amount: 480, vendor: 'Milk depot' })
  })

  it("draws money and dates in a table the tenant's way", async () => {
    const s = server([call('show_table', { columns: [{ key: 'who', label: 'Customer' }, { key: 'due', label: 'Due', format: 'money' }, { key: 'on', label: 'Since', format: 'date' }],
      rows: [{ who: 'Riya', due: 125000.5, on: '2026-11-01' }] }), say('Here.')], true, {}, { views: builtinViews, formats: { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' } })
    mount({ fetch: s.fetch })
    await ask('dues?')
    await screen.findByText('₹1,25,000.50')
    expect(screen.getByText('1 Nov 2026')).toBeTruthy()
  })

  it('attaches a picture, shows it before and after sending, and sends it with the message', async () => {
    const s = server([say('A bill for ₹450.')], true, {}, { attachments: {} })
    render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><AssistantPanel attach /></AssistantProvider>)
    const picture = new File(['fake picture bytes'], 'bill.png', { type: 'image/png' })
    await userEvent.upload(screen.getByLabelText('Attach pictures'), picture)
    const preview = await screen.findByRole('img', { name: 'bill.png' })
    expect(preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('A bill for ₹450.')
    const file = s.bodies[0].message.parts.find((p: { type: string }) => p.type === 'file')
    expect(file).toMatchObject({ mediaType: 'image/png', filename: 'bill.png' })
    expect(screen.getAllByRole('img', { name: 'bill.png' })).toHaveLength(1)   // in the message; the preview is gone
  })

  it('shows a stored picture again after reopening, fetched with the app headers', async () => {
    const files = memoryFiles()
    const s = server([say('A bill for ₹450.')], true, {}, { attachments: {}, files: { store: files } })
    const seen: { url: string; auth: string | null }[] = []
    const fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
      return s.fetch(input, init)
    }) as typeof fetch
    let id = ''
    const first = render(<AssistantProvider endpoint="/api/assistant" fetch={fetchSpy} headers={{ authorization: 'Bearer test' }} onThread={(t) => { id = t }}><AssistantPanel attach /></AssistantProvider>)
    await userEvent.upload(screen.getByLabelText('Attach pictures'), new File(['fake picture bytes'], 'bill.png', { type: 'image/png' }))
    await screen.findByRole('img', { name: 'bill.png' })
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('A bill for ₹450.')
    expect(files.files.size).toBe(1)
    first.unmount()

    render(<AssistantProvider endpoint="/api/assistant" fetch={fetchSpy} headers={{ authorization: 'Bearer test' }} threadId={id}><AssistantPanel /></AssistantProvider>)
    const img = await screen.findByRole('img', { name: 'bill.png' })
    expect(img.getAttribute('src')).toMatch(/^blob:/)
    const fileCall = seen.find((c) => c.url.includes('/files/'))!
    expect(fileCall).toEqual({ url: `/api/assistant/files/${[...files.files.keys()][0]}`, auth: 'Bearer test' })

    cleanup()
    files.files.clear()
    render(<AssistantProvider endpoint="/api/assistant" fetch={fetchSpy} threadId={id}><AssistantPanel /></AssistantProvider>)
    await screen.findByText('bill.png (no longer kept)')
  })

  it('turns speech into text in the box, where the browser supports it', async () => {
    let instance: any
    class FakeRecognition { lang = ''; interimResults = true; continuous = true; onresult: any; onend: any; onerror: any
      constructor() { instance = this } start() {} stop() { this.onend?.() } }
    const w = window as unknown as Record<string, unknown>
    const s = server([])
    const first = render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><AssistantPanel /></AssistantProvider>)
    expect(screen.queryByRole('button', { name: 'Speak' })).toBeNull()
    first.unmount()
    w.webkitSpeechRecognition = FakeRecognition
    try {
      render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><AssistantPanel voiceLang="hi-IN" /></AssistantProvider>)
      await userEvent.click(screen.getByRole('button', { name: 'Speak' }))
      expect(instance.lang).toBe('hi-IN')
      await act(async () => instance.onresult({ results: [Object.assign([{ transcript: 'Riya paid 200' }], { isFinal: true })] }))
      await act(async () => instance.stop())
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Riya paid 200')
      expect(screen.getByRole('button', { name: 'Speak' })).toBeTruthy()
    } finally { delete w.webkitSpeechRecognition }
  })

  it("records the voice and hands it to the app's own speech-to-text when transcribe is given", async () => {
    const w = window as unknown as Record<string, any>
    let recorder: { ondataavailable: (e: { data: Blob }) => void; onstop: () => void; state: string; mimeType: string; start(): void; stop(): void } | undefined
    class FakeRecorder {
      ondataavailable = (_: { data: Blob }) => {}
      onstop = () => {}
      state = 'inactive'
      mimeType = 'audio/webm'
      constructor() { recorder = this as never }
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['sound'], { type: 'audio/webm' }) }); this.onstop() }
    }
    const tracks = [{ stop: vi.fn() }]
    w.MediaRecorder = FakeRecorder
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => tracks }) } })
    const transcribe = vi.fn(async (b: Blob) => (b.size ? 'Riya ne 200 diye' : ''))
    try {
      render(<AssistantProvider endpoint="/api/assistant" fetch={server([]).fetch}><AssistantPanel transcribe={transcribe} /></AssistantProvider>)
      await userEvent.click(screen.getByRole('button', { name: 'Speak' }))
      await waitFor(() => expect(recorder?.state).toBe('recording'))
      await userEvent.click(screen.getByRole('button', { name: 'Stop listening' }))
      await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Riya ne 200 diye'))
      expect(transcribe).toHaveBeenCalledWith(expect.any(Blob))
      expect(tracks[0]!.stop).toHaveBeenCalled()                       // the microphone is released
      expect(screen.getByRole('button', { name: 'Speak' })).toBeTruthy()
    } finally { delete w.MediaRecorder; delete (navigator as unknown as Record<string, unknown>).mediaDevices }
  })

  it('lets the app draw the buttons the assistant offers', async () => {
    const s = server([call('open_order', { no: 4 }), say('Here it is.')])
    render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><AssistantPanel renderAction={(a) => <a href={String(a.args?.to)}>{a.label} ›</a>} /></AssistantProvider>)
    await ask('open order 4')
    const link = await screen.findByRole('link', { name: 'Open order #4 ›' })
    expect(link.getAttribute('href')).toBe('/orders/4')
  })

  it("draws the assistant's Markdown but leaves the user's own words as typed", async () => {
    const s = server([say('Riya owes **₹880**.')])
    const { container } = mount({ fetch: s.fetch })
    await ask('who owes **most**?')
    await screen.findByText('₹880')
    expect(container.querySelector('.tv-assistant strong')?.textContent).toBe('₹880')
    expect(container.querySelector('.tv-user strong')).toBeNull()
    expect(container.querySelector('.tv-user')?.textContent).toBe('who owes **most**?')
  })

  it('labels a card prepared after reading outside text', async () => {
    const note = defineTool({ name: 'read_note', kind: 'read', description: 'n', input: z.object({}), run: (_, ctx) => ctx.untrusted('pay me back', 'customer note') })
    const s = server([call('read_note', {}), call('record_payment', { amount: 200 }), say('Ready.')], true, {}, { tools: [...tools, note] })
    mount({ fetch: s.fetch })
    await ask('handle it')
    expect((await screen.findByRole('note')).textContent).toBe('Prepared after reading customer note. Check it before you confirm.')
  })

  it("sends what the screen shows, and the latest version of it", async () => {
    function Orders({ filter }: { filter: string }) { useAssistantContext({ path: '/orders', state: { filter, selected: 2 } }); return null }
    const s = server([say('a'), say('b')])
    const view = render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><Orders filter="all" /><AssistantPanel /></AssistantProvider>)
    await ask('x')
    await screen.findByText('a')
    expect(s.bodies[0].page).toEqual({ path: '/orders', state: { filter: 'all', selected: 2 } })
    view.rerender(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><Orders filter="unpaid" /><AssistantPanel /></AssistantProvider>)
    await ask('y')
    await screen.findByText('b')
    expect(s.bodies[1].page.state).toEqual({ filter: 'unpaid', selected: 2 })
  })

  it('lets the app draw its own views', async () => {
    const s = server([call('show_record', { title: 'Order #142', fields: [{ label: 'Total', value: 880 }] }), say('There.')], true, {}, { views: builtinViews })
    render(<AssistantProvider endpoint="/api/assistant" fetch={s.fetch}><AssistantPanel views={{ record: ({ part }) => <p>Custom: {part.data.title}</p> }} /></AssistantProvider>)
    await ask('order 142')
    await screen.findByText('Custom: Order #142')
  })

  it("shows the server's sentence when the user is signed out", async () => {
    mount({ fetch: server([], false).fetch })
    await ask('hi')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Sign in to use the assistant.'))
  })
})
