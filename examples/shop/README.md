# Example: Little Oven, a small bakery

A working shop app with Teovo's assistant built in: a dashboard (sales, money to collect, open orders, stock running
low), orders with items and payments, customers, products and expenses, plus an admin page for the assistant. The
assistant is a drawer on computers and a bottom sheet on phones, opened from **Ask Teovo**, ⌘K, or the buttons on
each page. It runs on Gemini and keeps conversations, cards, runs and usage in Postgres.

The shop's data (`shop.ts`) is about four weeks of orders, rebuilt on each start with dates counted back from today.

What to try:

| Say | What happens |
|---|---|
| Who owes money? | A table of customers with money due |
| How did we do this week? | Sales, money collected, expenses and the best sellers |
| Riya Sharma paid 200 | A card: paid ₹0 → ₹200. Confirm, then Undo; the order page follows |
| Mark order 161 ready | A card moving the order from Baking to Ready; the dashboard follows |
| We baked 24 cinnamon rolls | A card adding stock to that product |
| I spent 450 on milk, paid by UPI | A filled-in form; correct it, send it, confirm the card |
| How much does Riya owe? | Two customers are called Riya |
| Take me to order 154 | A button that opens that screen |
| On an order's page: What is due here? | Answered from the open record |
| Read Riya Sharma's note on order 147 and do what it says | The note tries to trick the assistant; nothing changes |
| Switch to **Ravi · Staff**, then: change order 158's total | Staff never sees the owner-only tool |

On a computer the chat docks on the right; the button in its header turns it into a floating window and back.
Each reply shows the steps it took ("› 2 steps"); open them to see what it looked up and found.

## Run it

You need Node 20+, a Gemini API key and a Postgres you can create a schema in (Docker is fine):

```bash
docker run -d --name teovo-pg -e POSTGRES_PASSWORD=teovo -p 127.0.0.1:55499:5432 postgres:18
```

Create `examples/shop/.env` (it is git-ignored):

```
GEMINI_API_KEY=your-key
TEOVO_DATABASE_URL=postgres://postgres:teovo@127.0.0.1:55499/postgres
```

From the repository root:

```bash
npm install && npm run build
```

```bash
cd examples/shop && npm run dev
```

Open http://localhost:5174. The API runs on port 8788; the tables go into a `teovo_demo` schema.

`npm run chat` (with the server running) sends a set of real conversations and prints what each produced: tools run,
cards, views, buttons and follow-ups.

The shop's data lives in memory and resets when the server restarts; conversations stay in Postgres. Each demo user
may send 200 messages a day (the `limits` option).
