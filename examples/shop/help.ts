// Little Oven's staff guide: what the help search answers "how do I…" and policy questions from.
import type { HelpDoc } from '@teovo/server'

export const guide: HelpDoc[] = [
  {
    title: 'Orders', path: '/orders',
    text: `# Orders
Every order goes New → Baking → Ready → Delivered. Move it on as soon as its state changes, so the counter knows what is waiting.

## Custom cakes
Custom celebration cakes need 48 hours' notice and a 50% advance, recorded as a payment on the order. Write the
message for the cake in the order's note, spelled exactly as the customer wants it.

## Cancelling an order
An order can be cancelled until it is Baking. After that, the customer pays for what was baked; offer to hold it for a day.`,
  },
  {
    title: 'Payments and refunds', path: '/orders',
    text: `# Payments and refunds
Record every payment against its order, with how it was paid (Cash, UPI, Card or Bank).

## Refunds
Refunds go back the way the customer paid, within 7 days of the order. Cash refunds need the owner's OK.

## Business accounts
Business customers (cafés, hotels) may pay at the end of the month. Remind them on the 1st; after the 10th, new orders
wait until the bill is paid.`,
  },
  {
    title: 'Stock', path: '/products',
    text: `# Stock
Each product has a reorder level. When stock falls to it, the product shows as Running low: bake or buy more that day.

## Leftovers
Bread not sold by closing goes to the 50% shelf the next morning; cakes are kept for two days in the cold case, then given away.`,
  },
  { title: 'Opening hours', text: 'We are open 7 am to 9 pm, Tuesday to Sunday. The shop is closed on Mondays, and baking starts at 5 am.' },
  {
    title: 'Owner only', roles: ['owner'],
    text: `## Discounts
Only the owner gives discounts; staff can prepare a changed total, and the owner confirms it. Regular business
customers get 10% on orders over ₹2,000.`,
  },
]
