// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantSheet, Markdown } from './index'

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear() })

describe('Markdown', () => {
  it('draws the common shapes of a reply', () => {
    const { container } = render(<Markdown text={'## Sales\nToday **₹4,200** from *12* orders.\nSee `#142`.\n\n- Riya owes ₹880\n- Asha owes ₹300\n\n1. Remind Riya\n2. Remind Asha\n\n```\ntotal 1180\n```'} />)
    expect(container.querySelector('.tv-md-h strong')?.textContent).toBe('Sales')
    expect(container.querySelector('p:not(.tv-md-h) strong')?.textContent).toBe('₹4,200')
    expect(container.querySelector('p em')?.textContent).toBe('12')
    expect(container.querySelector('p code')?.textContent).toBe('#142')
    expect(Array.from(container.querySelectorAll('ul li')).map((li) => li.textContent)).toEqual(['Riya owes ₹880', 'Asha owes ₹300'])
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
    expect(container.querySelector('pre code')?.textContent).toBe('total 1180')
    expect(container.querySelector('p br')).toBeTruthy()
  })

  it('draws a Markdown table, which models often write', () => {
    const { container } = render(<Markdown text={'Dues:\n| Customer | Due |\n|:--|--:|\n| **Riya** | ₹880 |\n| Asha | ₹0 |\nThat is all.'} />)
    expect(Array.from(container.querySelectorAll('th')).map((t) => t.textContent)).toEqual(['Customer', 'Due'])
    expect(Array.from(container.querySelectorAll('tbody tr')).map((r) => r.textContent)).toEqual(['Riya₹880', 'Asha₹0'])
    expect(container.querySelector('td strong')?.textContent).toBe('Riya')
    expect(Array.from(container.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['Dues:', 'That is all.'])
  })

  it('treats a lone line with pipes as text, and never hangs on it', () => {
    const { container } = render(<Markdown text={'| not a table |\nnext line\n|a|b|'} />)
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toBe('| not a table |next line|a|b|')
  })

  it('never inserts HTML and only links to http(s) or mailto, in a new tab', () => {
    const { container } = render(<Markdown text={'<script>alert(1)</script> <b>x</b> [ok](https://example.com/a) [bad](javascript:alert(1))'} />)
    expect(container.querySelector('script, b')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
    const links = container.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/a')
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer')
    expect(links[0]!.getAttribute('target')).toBe('_blank')
    expect(container.textContent).toContain('bad (javascript:alert(1))')
  })
})

describe('AssistantSheet', () => {
  it('opens from its button or Ctrl+K, closes with Escape, and hands focus back', async () => {
    render(<AssistantSheet modal label="Ask Scoops" theme={{ accent: '#0f766e', radius: '6px', mode: 'dark' }}><textarea aria-label="Message" /></AssistantSheet>)
    const open = screen.getByRole('button', { name: 'Ask Scoops' })
    const root = open.parentElement!
    expect(root.style.getPropertyValue('--tv-accent')).toBe('#0f766e')
    expect(root.style.getPropertyValue('--tv-radius')).toBe('6px')
    expect(root.getAttribute('data-theme')).toBe('dark')

    await userEvent.click(open)
    expect(screen.getByRole('dialog', { name: 'Assistant' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('Message'))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(open)

    await userEvent.keyboard('{Control>}k{/Control}')
    expect(screen.getByRole('dialog')).toBeTruthy()
    // The keyboard stays inside the open sheet: Tab from outside comes back in.
    ;(document.body as HTMLElement).focus()
    await userEvent.tab()
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Close assistant' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('docks beside the page on wide screens: no backdrop, the page stays usable, and the page is told', async () => {
    render(<><button type="button">On the page</button><AssistantSheet label="Ask"><textarea aria-label="Message" /></AssistantSheet></>)
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const panel = screen.getByRole('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('false')
    expect(document.querySelector('.tv-sheet-backdrop')).toBeNull()
    expect(document.documentElement.dataset.tvSheet).toBe('docked')
    expect(document.documentElement.style.getPropertyValue('--tv-sheet-width')).toBe('440px')
    // The keyboard can leave the panel for the page.
    await userEvent.click(screen.getByRole('button', { name: 'On the page' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'On the page' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Close assistant' }))
    expect(document.documentElement.dataset.tvSheet).toBeUndefined()
  })

  it('floats as a window over the page when asked, still without a backdrop', async () => {
    render(<AssistantSheet label="Ask" layout="floating"><textarea aria-label="Message" /></AssistantSheet>)
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const panel = screen.getByRole('dialog')
    expect(panel.className).toContain('tv-sheet-floating')
    expect(panel.getAttribute('aria-modal')).toBe('false')
    expect(document.querySelector('.tv-sheet-backdrop')).toBeNull()
    expect(document.documentElement.dataset.tvSheet).toBe('floating')
    // The page needn't make room for a floating window.
    expect(document.documentElement.style.getPropertyValue('--tv-sheet-width')).toBe('')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
