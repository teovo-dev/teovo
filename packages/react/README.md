# @teovo/react

The assistant panel for Teovo's server handler.

```tsx
import { AssistantPanel, AssistantProvider, useAssistantContext } from '@teovo/react'
import '@teovo/react/styles.css' // optional defaults

<AssistantProvider
  endpoint="/api/assistant"
  onCard={(card, decision) => applyOrSkip(card, decision)}   // throw to show the error on the card
  onAction={(a) => a.action === 'navigate' && navigate(String(a.args?.to))}
>
  <AssistantPanel welcome="Ask about your shop" stepLabels={{ get_sales: 'Looking at sales' }} />
</AssistantProvider>

// In each screen:
useAssistantContext({ path: '/orders/2', title: 'Order #2' })
```

- Only the new message is sent; the server keeps the history and checks it belongs to the signed-in user.
- `useAssistant()` gives the messages, `sendMessage`, `stop`, `status` and `newChat` for apps that draw their own panel.
- `renderText`, `renderCard` replace the default drawing of reply text and cards.
