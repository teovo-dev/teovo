# Features

What each release holds. "Proven in" names the apps where it already works today; "Built on" is what Teovo uses for it.
Status numbers are pull requests in this repository. Rows with no status are planned for that release.
"Checked in the app" means someone used it in examples/shop as a user, with a real model, and it looked and behaved
right (last walk-through: 27 Nov 2026, Gemini 2.5 Flash and flash-lite, desktop and phone width). "Tests only" means automated tests
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
| Long runs: queue, resume after a restart, stop from any server | v2 |  |  | scobly | pg-boss |
| Done-checks that can refuse a reply before it ships | v2 |  |  | parityai, scobly | kit |
| Continue check when the model stops early | v2 | Partly (#34): a reply that ends in silence is asked once more for words | Yes, seen with Gemini | bricks, parityai | kit |
| Tools that run in the browser against the open document | v2 |  |  | bricks | kit |
| Large on-screen content cut to what the question needs | v2 |  |  | bricks | kit hook |
| Undo by restoring a version saved before the run | v2 |  |  | bricks, parityai | kit |
| One assistant turn as one step in the app's own undo | v2 |  |  | bricks | kit |
| Run viewer and trace export | v2 |  |  | parityai, scobly, bricks | OpenTelemetry |
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
| Spend check before a run, and a hold that can be raised mid-run | v2 |  |  | scobly, parityai | kit hook |
| Planned model switch inside one run, such as analyst to designer | v2 |  |  | parityai, scobly | kit |
| Runs started with no user present, such as scheduled or heartbeat runs | v2 |  |  | scobly, parityai | kit |
| Long-poll transport for hosts that hold back streams | v2 |  |  | scobly | kit |
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
