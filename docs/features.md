# Features

What each release holds. "Proven in" names the apps where it already works today; "Built on" is what Teovo uses for it.
Status numbers are pull requests in this repository. Rows with no status are planned for that release.
"Checked in the app" means someone used it in examples/shop as a user, with a real model, and it looked and behaved
right (or, where it says so, in Scoops on its local test shop) (last walk-through: 27 Nov 2026, Gemini 2.5 Flash and flash-lite, desktop and phone width). "Tests only" means automated tests
cover it but nobody has tried it by hand. A feature counts as done only when this column says Yes.

| Feature | Release | Status | Checked in the app | Proven in | Built on |
| --- | --- | --- | --- | --- | --- |
| Tool loop with step cap, retries and timeouts | v1 | Built (#3) | Yes | all five apps | Vercel AI SDK |
| Ordered model fallback, with no switch after a tool has changed something | v1 | Built (#3) | Yes: Flash overloaded, flash-lite answered | scoops, bricks | kit |
| Stalled-reply watchdog: first-output and idle timeouts | v1 | Built (#3, fixed #27) | Yes (#27: it never fired with Gemini; now times the wait itself and hands over to the next model) | bricks | Vercel AI SDK |
| Three tool types: read, propose, action | v1 | Built (#3) | Yes | scoops | kit |
| Steps panel: what the assistant did for each reply, folded under an arrow, with what it asked for and found | v1.1 | Built (#41) | Yes: open while it works, folds to "2 steps", phone shown as [hidden] | scoops | kit |
| Blank replies recovered: a step with no words and no tool call is asked again with tools on (from where it stopped), then with tools off, then a plain sentence | v1.1 | Built (#42) | Yes: "take me to order 154" gave a button 8 of 8 times with Gemini, up from 1 of 3 | scoops | kit |
| Docked panel on wide screens: no backdrop, the page stays usable beside the chat and can make room (data-tv-sheet, --tv-sheet-width); phones keep the modal bottom sheet (`modal` option) | v1.1 | Built (#43) | Yes: opened an order from the list with the chat open, the chat followed the page | scoops | kit |
| Floating full-height chat window over the page, as an alternative to the docked panel (`layout: 'panel' | 'floating'`) | v1.1 | Built (#44) | Yes: switched both ways from the example's chat header; the pick survives a reload | scoops, bricks | kit |
| Assistant name in the server config (`name`): told to the model, shown on the open button ("Ask Teovo") and as the chat's name; AI sparkle icon by default; "Powered by Teovo" link at the bottom of the chat (`poweredBy={false}` hides it) | v1.1 | Built (#47) | Yes: button reads "Ask Teovo" from the config; Gemini answers "I'm Teovo" | scoops | kit |
| Chat UI owned by the SDK: AssistantHeader (name, History, dock/float switch remembered, close), earlier chats inside the panel, remembered conversation (`rememberThread`), open state and `ask()` from anywhere, × on the page chip, card `lines` and after-confirm `note`/`link`, phone chat closes when a button opens a screen | v1.1 | Built (#50) | Yes: demo dropped its own tabs, switch, thread storage and ask context; History, ×, page button and phone header checked by hand | scoops, demo | kit |
| Pictures for tools and cards: a tool sees the pictures on the message it answers (`ctx.files`) and can keep one's id in its card; the card's applier reads it with `ctx.file(id)` (only the sender's own) | v1.1 | Built (#58) | Yes, in Scoops: a bill photo sent in the chat became an expense card; confirmed, the expense kept the photo | scoops | kit |
| Tool labels: `defineTool({ label })` names the step in the chat ("Looked at the order"); the panel's `stepLabels` can still reword it | v1.1 | Built (#58) | Yes, in Scoops: "Looked at customers" from the tool's own label | scoops | kit |
| A layout can name every screen with `useAssistantContext(page, { fallback: true })`; a screen's own call (e.g. "Order #4 · Kavya") always wins over it | v1.1 | Built (#58) | Yes, in Scoops: "On Order #2 · Priya Nair" over the layout's "An order"; "On Sales" elsewhere | scoops | kit |
| Room under the open button for a bottom navigation bar: `AssistantSheet buttonOffset`, or the CSS variable `--tv-open-offset` under the app's own breakpoint | v1.1 | Built (#58) | Yes, in Scoops: the button sits above the bottom bar at phone width | scoops | kit |
| `AllowanceMeter`: a settings-screen bar of the tenant's (or person's) use against its limits, amber at 70%, red at 90% | v1.1 | Built (#58) | Yes, in Scoops' Settings: "3 of 400 AI requests … today" | scoops | kit |
| Old pictures removed from Supabase Storage too (`supabaseFiles` + `supabaseFileIndex`), so `removeOldFiles()` works there | v1.1 | Built (#58) | Tests only (Scoops' test removes a 31-day-old picture from local Supabase Storage) | scoops | kit tables |
| Screens only some roles may open (`screens: [{ …, roles: ['owner'] }]`): other roles never hear of them, and open_screen refuses them | v1.1 | Built (#58) | Tests only (Scoops' catalog is owner-only; not tried as staff by hand) | scoops | kit |
| `onCardDecided` on the provider: the app hears when a card was confirmed, skipped or undone (server-applied or its own), e.g. to reload the screen | v1.1 | Built (#58) | Yes, in Scoops: the order screen showed the payment as soon as the card was confirmed, and again after Undo | scoops | kit |
| `useReader(name, { onError })`: the screen hears why a read failed (e.g. to show a toast); read resolves to null | v1.1 | Built (#58) | Yes, in Scoops: Catalog's "Describe it" filled name, sizes and own price | scoops | kit |
| Readers (one input → one checked answer: text, a picture or a recording → a form draft; same models, fallback, limits, usage and untrusted rule as the chat; `teovo.read` for webhooks) and voice to text (`voice`, `workersAiWhisper`, `VoiceButton`, the chat microphone) | v1.1 | Built (#51) | Yes: Little Oven Quick add filled from a Hinglish note, a spoken recording and a bill photo with Gemini, and ignored an injected instruction | scoops | kit, Vercel AI SDK |
| Confirm and skip cards | v1 | Built (#7) | Yes (#26: labels, ₹ and dates, new-record layout) | scoops | kit |
| Undo by reversing the change, stored so it survives a reload | v1 | Built (#7) | Yes, after a reload too | scoops, in memory only | kit tables |
| Screen awareness: route, record on screen, component state | v1 | Built (#9, #21) | Yes (#26: shown in the panel) | scoops | kit |
| Screens map and navigation buttons | v1 | Built (#3, #21) | Yes (#25: filters kept) | scoops | kit |
| Chat panel: streaming, markdown, attachments, stop | v1 | Built (#5, #17, #18) | Yes (#26: Stop now stops the server) | none of ours has all of these | assistant-ui |
| Suggestions above the box: follow-ups to the last reply, and chips for the screen and its record using real names | v1 | Built (#9) | Yes (#26: follow the page mid-chat) | scoops, fixed starters in an empty chat only | kit |
| Voice input and image reading | v1 | Built (#17) | Pictures yes; voice needs a real microphone | scoops | kit, Vercel AI SDK |
| Threads and message history | v1 | Built (#4, #13) | Yes | parityai, scobly | kit tables |
| One rule for what history the model sees, including earlier tool results | v1 | Built (#7, #21) | Tests only | new | kit |
| Per-tenant budgets and a usage ledger | v1 | Built (#6) | Yes: a budget row stopped the 7th message with a clear sentence | scoops, scobly | kit tables |
| Run log of every model and tool call, with retention and trimming | v1 | Built (#6, prune in #8) | Yes (stopped runs marked) | scobly, bricks | kit tables |
| Fake model and record/replay for tests | v1 | Built (#20) | Tests (it is a test tool) | scobly, parityai | kit |
| Recordings as tests: `recordChat` / `replayChat` and `recordRead` / `replayRead` keep a real chat or reader call as a JSON file (ids saved as names with `idNames`, earlier turns, the screen, a picture next to it) and replay it through the app's assistant as it is now; `toolCalls`, `toolErrors`, `saveRecording`, `loadRecordings` | v1.1 | Built (#64) | Tests (it is a test tool); Scoops' 16 recordings replay through it | scoops | kit |
| Tools filtered by role, so staff never see owner-only tools | v1 | Built (#3) | Yes (#26: says who can) | scoops, told in the prompt only | kit |
| Identity check required in the handler, with per-user limits beside per-tenant ones | v1 | Built (#3, #6) | Tests only | not checked | kit tables |
| Outside text marked as untrusted (customer notes, screenshots, bank texts, web pages): it never triggers an action and is labelled on the card | v1 | Built (#3, #9, #19) | Yes (#26: reads it, never acts on it) | not checked | kit |
| Interactive replies as typed views: choices, form, table, record card, plus views the app registers | v1 | Built (#14) | Yes, all four (#26: Continue button) | scoops, hard-wired expense and payment cards | kit, assistant-ui |
| Setup command (npx teovo init) and table migrations with an upgrade path | v1 | Built (#4, #8) | Yes: init, migrate, status, prune | not checked | kit |
| Theming from the app: colours, fonts, corner radius, dark mode, bottom sheet on phones | v1 | Built (#18) | Yes: dark mode, phone sheet | not checked | kit, assistant-ui |
| Per-task model choice: a cheap model for simple reads, a stronger one for hard questions | v1 | Built (#15) | Yes (#27: the example routes short look-ups to flash-lite) | scoops, chosen by hand | kit |
| Local formats: dates, currency such as ₹, and the tenant's time zone in replies and views | v1 | Built (#16) | Yes | scoops, chosen by hand | kit |
| Row-level rules on the tv\_ tables that match the app's own tenancy | v1 | Built (#4) | Yes, by hand in Postgres as a non-owner role; how-to in docs/architecture.md (#27) | scoops, scobly, parityai (their own tables) | kit tables |
| Placeholder that cycles through examples for the screen | v1.1 | Built (#9, #37: examples rotate) | Yes | new | kit |
| Completion while typing: customer, product and phrase matches on the device, Tab or tap to accept, no model call | v1.1 | Built (#37) | Yes: "chand b" → Chand Bakers | new | kit |
| Remaining allowance shown in the panel | v1.1 | Built (#36) | Yes: counted down 3 → 1 | bricks, scobly | kit |
| Audit trail of proposed, confirmed, skipped and undone changes | v1.1 | Built (#35) | Yes: example Admin page | new | kit tables |
| Miss log: questions the assistant could not answer | v1.1 | Built (#35) | Yes: logged with Gemini, shown on Admin | new | kit tables |
| Wipe a user's or a tenant's conversations and logs on request | v1.1 | Built (#35) | Yes: "Delete my conversations" | not checked | kit tables |
| Answers link to the records they used | v1.1 | Built (#37) | Yes: "From: Order #141 · #142 · #143" | not checked | kit |
| Thumbs up or down on a reply, saved with its run | v1.1 | Built (#34) | Yes: saved on the run | not checked | kit tables |
| Prompt and model version stored on each run | v1.1 | Built (#6) | Tests only (stored on the run; nothing to see in the app) | not checked | kit tables |
| A question with answer buttons when the request is unclear | v1.1 | Built early (#14, choices view) | Yes: "Which order for Riya?" buttons | not checked | kit |
| One card for a change to many records, with a list to review and a single undo | v1.1 | Built (#38) | Yes: 2 orders settled, then undone together | not checked | kit |
| Custom instructions and a word list per tenant | v1.1 | Built (#10) | Yes: a sign-off note and "khata" used in 10 of 10 replies | not checked | kit tables |
| Before and after shown on a card, such as price ₹350 → ₹380 | v1.1 | Built (#5) | Yes | not checked | kit |
| Instant switch-off of one tool or model for every tenant | v1.1 | Built (#10 per tenant, #36 for every tenant) | Yes: Flash off → flash-lite answered; paused for everyone | not checked | kit |
| Privacy notice and consent per tenant: what is sent to the model, images allowed or not | v1.1 | Built (#36) | Yes: notice before chatting, pictures off hid attach | not checked | kit tables |
| Fixed prompt parts (instructions, catalog, tools) placed first so the provider can cache them | v1.1 | Built (#38) | Tests only (the prompt is not visible in the app) | not checked | kit |
| Edit and resend a message, regenerate a reply, copy a reply | v1.1 | Built (#34) | Yes: edit, Try again, copy | not checked | kit, assistant-ui |
| Tool versions, so a pending card made by an older tool still works after a deploy | v1.1 | Built (#38) | Tests only (needs two deploys to see by hand) | not checked | kit tables |
| Accessibility: screen reader labels and a keyboard shortcut to open the panel | v1.1 | Built (#18, #38: keyboard kept inside the open sheet) | Yes: Ctrl/⌘+K, Tab stays in the sheet | not checked | kit, assistant-ui |
| Long runs: queue, resume after a restart, stop from any server: `runs: { asUser }`, `teovo.startWorker()` or `teovo.work()`; the queue is on Teovo's own tables (tv_runs, tv_run_events), so it works on Workers through Supabase's API too. A reply goes on when the panel closes, a reload shows it still being written, Stop works from any server, and a reply whose server stopped or crashed is carried on from its last finished tool step | v2 | Built (#61) | Yes: Little Oven with Gemini 2.5 Flash, tools slowed to 6 s: a page reload mid-reply carried on and showed the table once; Stop ended the run on the server; the server killed mid-reply, a new one took it over, kept the finished customers lookup and finished the reply | scobly | kit tables |
| Done-checks that can refuse a reply before it ships: `checks: [defineCheck({ name, check })]` see the words, the run's cards and tool calls; a refused reply is held back, the model is told why and writes it again (`checkRetries`, default 1), else a plain sentence. Ready-made: `noClaimedChanges` | v2 | Built (#57) | Yes: Little Oven with Gemini 2.5 Flash, a refused first reply never reached the panel or the saved conversation; normal replies and cards unchanged | parityai, scobly | kit |
| Continue check when the model stops early | v2 | Partly (#34): a reply that ends in silence is asked once more for words | Yes, seen with Gemini | bricks, parityai | kit |
| Tools that run in the browser against the open document | v2 |  |  | bricks | kit |
| Large on-screen content cut to what the question needs | v2 |  |  | bricks | kit hook |
| Undo by restoring a version saved before the run | v2 |  |  | bricks, parityai | kit |
| One assistant turn as one step in the app's own undo | v2 |  |  | bricks | kit |
| Run viewer and trace export: `<RunViewer />` for an app's admin screen (every reply with its question, tools with inputs and results, refused replies, model, time and tokens; filters by status and rating), GET …/runs and …/runs/:id for admins, and an OpenTelemetry trace per run (…/runs/:id/trace, `teovo.trace()`, `runTrace`) | v2 | Built (#59) | Yes: Little Oven admin with Gemini 2.5 Flash, a run with two tools and a refused reply, trace downloaded with 4 spans; staff refused; phone width | parityai, scobly, bricks | OpenTelemetry |
| Guarded read-only query tool | v2 |  |  | parityai, bricks | kit |
| Search over help content | v2 |  |  | parityai, whole guide in the prompt | kit |
| Suggestions from data checks (such as orders unpaid for 5 days) and from the user's own habits, ranked by taps | v2 |  |  | new | kit tables |
| Personal details masked in logs, such as phone numbers and UPI ids | v2 | Built early (#12); also hidden from the model |  | not checked | kit |
| Alert when the backup model is in use or errors rise | v2 |  |  | not checked | kit |
| Replies survive a dropped connection, and a message typed offline is sent later | v2 |  |  | not checked | kit |
| Push notification when a long run finishes | v2 |  |  | not checked | kit |
| Tick lists that turn the chosen rows into one card, and charts | v2 |  |  | not checked | kit |
| Live views that refresh from their read tool when the data changes | v2 |  |  | not checked | kit |
| Translations for the panel's own text | v2 |  |  | not checked | kit |
| Risk level per tool: low-risk changes apply at once with an Undo toast, high-risk ones need a confirm | v2 |  |  | not checked | kit |
| Approval by someone else: staff proposes, the owner approves | v2 |  |  | not checked | kit tables |
| Summary of older turns once a thread gets long | v2 |  |  | not checked | kit tables |
| Share or download a reply: an image for WhatsApp, or a view as CSV or PDF | v2 |  |  | not checked | kit |
| Search across past conversations, with automatic titles | v2 |  |  | not checked | kit tables |
| Dashboard of usage, top questions, misses and ratings | v2 |  |  | not checked | kit tables |
| A tenant brings its own model key and pays for its own AI use | v2 |  |  | not checked | kit tables |
| Spend check before a run, and a hold that can be raised mid-run: `spend: { hold, reserve, settle, cost?, step? }`. The app's own wallet does the holding (Teovo keeps no balance): a reply is refused with the app's sentence before anything is saved, a tool raises the hold with `ctx.reserve(amount)` before costly work, `cost` raises it as tokens add up and ends the reply with a sentence when refused, and `settle` gets the status and what was used. Works with long runs (a resumed reply is not held again; one stopped while queued is settled) | v2 | Built (#62) | Yes: Little Oven with Gemini 2.5 Flash and a 3-credit demo wallet: a reply held 1, was raised twice as it passed 10,000 tokens and charged 3; the next message was refused with the shop's sentence; with 2 credits a reply kept its table, ended with the sentence and got both back | scobly, parityai | kit hook |
| Planned model switch inside one run, such as analyst to designer: `roles: { writer: { description, models, instructions?, tools?, takesOver? } }`. The model can call `hand_over({ to, note })`, or the app's own `takesOver` plan switches before a step; the rest of the reply runs on that role's models (with fallback), instructions and tools. The run log records each hand-over; usage is counted per model that answered | v2 | Built (#PR) | Yes: Little Oven with DEMO_ROLES=1: "write me a short report on this week…" gathered sales, customers and stock on Flash-Lite, the shop's plan handed over, and Flash wrote the report; usage split by model. Left to itself, Flash-Lite wrote the report without handing over (twice), so `takesOver` is the reliable way | parityai, scobly | kit |
| Runs started with no user present, such as scheduled or heartbeat runs: `teovo.start({ identity, text, label })` runs a reply in that person's conversations with their tools, limits and spend; the app's message is saved marked as the app's (the model is told, and the panel labels it, with no Edit); cards wait there to be confirmed. Returns the reply's words and cards; with long runs it can return at once (`wait: false`) | v2 | Built (#65) | Yes: Little Oven with Gemini 2.5 Flash: a "Morning check" started by POST /api/shop/morning-check wrote to the owner ("Good morning! Here are the three most important things…") from orders, stock and money due; it showed in her chats labelled, and she carried on to a payment card | scobly, parityai | kit |
| Long-poll transport for hosts that hold back streams: `<AssistantProvider transport="poll">` sends the message with a plain request (202 with the run's id) and reads the reply with short `GET …/runs/:id/poll` requests that answer as soon as there is more (up to 20 s). Needs long runs; reload, Stop and a reply picked up by another server work the same | v2 | Built (#63) | Yes: Little Oven with Gemini 2.5 Flash at ?transport=poll: a payment card and a stock table arrived through 202 + polls, no stream; a reload mid-reply carried on | scobly | kit |
| Fallback rules by plan or country | later |  |  | bricks | kit |
| Export logged runs as a fine-tuning or eval dataset | later |  |  | bricks | kit |
| Code execution in a sandbox | later |  |  | bricks, scobly, eepoz | to decide |
| Eval runner with a leaderboard | later |  |  | bricks, parityai | to decide |
| Long-term memory | later |  |  | scobly | to decide |
| Several agents handing work to each other | later |  |  | scobly | to decide |
| Tools generated from an OpenAPI file or MCP server | later |  |  | bricks | Vercel AI SDK |
| Client for screens that are not React | later |  |  | bricks | kit |
| Model completion while typing, after a pause | later |  |  | new | to decide |
| Daily summary or nudges the assistant sends on its own | later |  |  | not checked | to decide |
| Model-written HTML in a locked-down frame with no network, talking only through declared actions | later |  |  | not checked | to decide |
| Reading answers aloud | later |  |  | not checked | to decide |
| Handing a conversation over to a real person | later |  |  | not checked | to decide |

Each app keeps these itself: its tools, prompts and card designs; billing (Teovo records usage and offers hooks);
sign-in (the app tells Teovo who the user is); backends not written in TypeScript; team agents in Slack or Linear.
