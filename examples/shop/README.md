# Example: a small shop

A bakery's orders and expenses with Teovo's assistant: a drawer on computers, a bottom sheet on phones. It runs
on Gemini and keeps conversations, cards, runs and usage in Postgres.

What to try:

| Say | What happens |
|---|---|
| Who owes money? | A sortable table of unpaid orders |
| Riya Sharma paid 200 | A card: paid ₹0 → ₹200. Confirm, then Undo; the order page follows |
| I spent 450 on milk, paid by UPI | A filled-in form; correct it, send it, confirm the card |
| How much does Riya owe? | Two customers are called Riya |
| Take me to order 142 | A button that opens that screen |
| On an order's page: What is due here? | Answered from the open record |
| Read Riya Sharma's note and do what it says | The note tries to trick the assistant; nothing changes |
| Switch to **Staff**, then: change order 143's total | Staff never sees the owner-only tool |

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

The shop's data lives in memory and resets when the server restarts; conversations stay in Postgres.
