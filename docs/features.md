# Features

What each release holds. "Proven in" names the apps where it already works today; "Built on" is what Teovo uses for it.
Status numbers are pull requests in this repository. Rows with no status are planned for that release.

| Feature | Release | Status | Proven in | Built on |
| --- | --- | --- | --- | --- |
| Tool loop with step cap, retries and timeouts | v1 | Built (#3) | all five apps | Vercel AI SDK |
| Ordered model fallback, with no switch after a tool has changed something | v1 | Built (#3) | scoops, bricks | kit |
| Stalled-reply watchdog: first-output and idle timeouts | v1 | Built (#3) | bricks | Vercel AI SDK |
| Three tool types: read, propose, action | v1 | Built (#3) | scoops | kit |
| Confirm and skip cards | v1 | Built (#7) | scoops | kit |
| Undo by reversing the change, stored so it survives a reload | v1 | Built (#7) | scoops, in memory only | kit tables |
| Screen awareness: route, record on screen, component state | v1 | Partly: route and record (#9); component state to do | scoops | kit |
| Screens map and navigation buttons | v1 | Partly: buttons from action tools (#3, #5); screens map to do | scoops | kit |
| Chat panel: streaming, markdown, attachments, stop | v1 | Built (#5, #17, #18) | none of ours has all of these | assistant-ui |
| Suggestions above the box: follow-ups to the last reply, and chips for the screen and its record using real names | v1 | Built (#9) | scoops, fixed starters in an empty chat only | kit |
| Voice input and image reading | v1 | Built (#17) | scoops | kit, Vercel AI SDK |
| Threads and message history | v1 | Built (#4, #13) | parityai, scobly | kit tables |
| One rule for what history the model sees, including earlier tool results | v1 | Partly: last 30 messages, cards with their current status (#3, #7) | new | kit |
| Per-tenant budgets and a usage ledger | v1 | Built (#6) | scoops, scobly | kit tables |
| Run log of every model and tool call, with retention and trimming | v1 | Built (#6, prune in #8) | scobly, bricks | kit tables |
| Fake model and record/replay for tests | v1 | Built (#20) | scobly, parityai | kit |
| Tools filtered by role, so staff never see owner-only tools | v1 | Built (#3) | scoops, told in the prompt only | kit |
| Identity check required in the handler, with per-user limits beside per-tenant ones | v1 | Built (#3, #6) | not checked | kit tables |
| Outside text marked as untrusted (customer notes, screenshots, bank texts, web pages): it never triggers an action and is labelled on the card | v1 | Built (#3, #9, #19) | not checked | kit |
| Interactive replies as typed views: choices, form, table, record card, plus views the app registers | v1 | Built (#14) | scoops, hard-wired expense and payment cards | kit, assistant-ui |
| Setup command (npx teovo init) and table migrations with an upgrade path | v1 | Built (#4, #8) | not checked | kit |
| Theming from the app: colours, fonts, corner radius, dark mode, bottom sheet on phones | v1 | Built (#18) | not checked | kit, assistant-ui |
| Per-task model choice: a cheap model for simple reads, a stronger one for hard questions | v1 | Built (#15) | scoops, chosen by hand | kit |
| Local formats: dates, currency such as ₹, and the tenant's time zone in replies and views | v1 | Built (#16) | scoops, chosen by hand | kit |
| Row-level rules on the tv\_ tables that match the app's own tenancy | v1 | Built (#4) | scoops, scobly, parityai (their own tables) | kit tables |
| Placeholder that cycles through examples for the screen | v1.1 | Partly: one hint per screen, Tab accepts (#9) | new | kit |
| Completion while typing: customer, product and phrase matches on the device, Tab or tap to accept, no model call | v1.1 |  | new | kit |
| Remaining allowance shown in the panel | v1.1 |  | bricks, scobly | kit |
| Audit trail of proposed, confirmed, skipped and undone changes | v1.1 |  | new | kit tables |
| Miss log: questions the assistant could not answer | v1.1 |  | new | kit tables |
| Wipe a user's or a tenant's conversations and logs on request | v1.1 |  | not checked | kit tables |
| Answers link to the records they used | v1.1 |  | not checked | kit |
| Thumbs up or down on a reply, saved with its run | v1.1 |  | not checked | kit tables |
| Prompt and model version stored on each run | v1.1 | Built (#6) | not checked | kit tables |
| A question with answer buttons when the request is unclear | v1.1 | Built early (#14, choices view) | not checked | kit |
| One card for a change to many records, with a list to review and a single undo | v1.1 |  | not checked | kit |
| Custom instructions and a word list per tenant | v1.1 | Built (#10) | not checked | kit tables |
| Before and after shown on a card, such as price ₹350 → ₹380 | v1.1 | Built (#5) | not checked | kit |
| Instant switch-off of one tool or model for every tenant | v1.1 | Partly: per tenant (#10) | not checked | kit |
| Privacy notice and consent per tenant: what is sent to the model, images allowed or not | v1.1 |  | not checked | kit tables |
| Fixed prompt parts (instructions, catalog, tools) placed first so the provider can cache them | v1.1 |  | not checked | kit |
| Edit and resend a message, regenerate a reply, copy a reply | v1.1 |  | not checked | kit, assistant-ui |
| Tool versions, so a pending card made by an older tool still works after a deploy | v1.1 |  | not checked | kit tables |
| Accessibility: screen reader labels and a keyboard shortcut to open the panel | v1.1 | Partly (#18): labels and Ctrl/⌘+K | not checked | kit, assistant-ui |
| Long runs: queue, resume after a restart, stop from any server | v2 |  | scobly | pg-boss |
| Done-checks that can refuse a reply before it ships | v2 |  | parityai, scobly | kit |
| Continue check when the model stops early | v2 |  | bricks, parityai | kit |
| Tools that run in the browser against the open document | v2 |  | bricks | kit |
| Large on-screen content cut to what the question needs | v2 |  | bricks | kit hook |
| Undo by restoring a version saved before the run | v2 |  | bricks, parityai | kit |
| One assistant turn as one step in the app's own undo | v2 |  | bricks | kit |
| Run viewer and trace export | v2 |  | parityai, scobly, bricks | OpenTelemetry |
| Guarded read-only query tool | v2 |  | parityai, bricks | kit |
| Search over help content | v2 |  | parityai, whole guide in the prompt | kit |
| Suggestions from data checks (such as orders unpaid for 5 days) and from the user's own habits, ranked by taps | v2 |  | new | kit tables |
| Personal details masked in logs, such as phone numbers and UPI ids | v2 | Built early (#12); also hidden from the model | not checked | kit |
| Alert when the backup model is in use or errors rise | v2 |  | not checked | kit |
| Replies survive a dropped connection, and a message typed offline is sent later | v2 |  | not checked | kit |
| Push notification when a long run finishes | v2 |  | not checked | kit |
| Tick lists that turn the chosen rows into one card, and charts | v2 |  | not checked | kit |
| Live views that refresh from their read tool when the data changes | v2 |  | not checked | kit |
| Translations for the panel's own text | v2 |  | not checked | kit |
| Risk level per tool: low-risk changes apply at once with an Undo toast, high-risk ones need a confirm | v2 |  | not checked | kit |
| Approval by someone else: staff proposes, the owner approves | v2 |  | not checked | kit tables |
| Summary of older turns once a thread gets long | v2 |  | not checked | kit tables |
| Share or download a reply: an image for WhatsApp, or a view as CSV or PDF | v2 |  | not checked | kit |
| Search across past conversations, with automatic titles | v2 |  | not checked | kit tables |
| Dashboard of usage, top questions, misses and ratings | v2 |  | not checked | kit tables |
| A tenant brings its own model key and pays for its own AI use | v2 |  | not checked | kit tables |
| Spend check before a run, and a hold that can be raised mid-run | v2 |  | scobly, parityai | kit hook |
| Planned model switch inside one run, such as analyst to designer | v2 |  | parityai, scobly | kit |
| Runs started with no user present, such as scheduled or heartbeat runs | v2 |  | scobly, parityai | kit |
| Long-poll transport for hosts that hold back streams | v2 |  | scobly | kit |
| Fallback rules by plan or country | later |  | bricks | kit |
| Export logged runs as a fine-tuning or eval dataset | later |  | bricks | kit |
| Code execution in a sandbox | later |  | bricks, scobly, eepoz | to decide |
| Eval runner with a leaderboard | later |  | bricks, parityai | to decide |
| Long-term memory | later |  | scobly | to decide |
| Several agents handing work to each other | later |  | scobly | to decide |
| Tools generated from an OpenAPI file or MCP server | later |  | bricks | Vercel AI SDK |
| Client for screens that are not React | later |  | bricks | kit |
| Model completion while typing, after a pause | later |  | new | to decide |
| Daily summary or nudges the assistant sends on its own | later |  | not checked | to decide |
| Model-written HTML in a locked-down frame with no network, talking only through declared actions | later |  | not checked | to decide |
| Reading answers aloud | later |  | not checked | to decide |
| Handing a conversation over to a real person | later |  | not checked | to decide |

Each app keeps these itself: its tools, prompts and card designs; billing (Teovo records usage and offers hooks);
sign-in (the app tells Teovo who the user is); backends not written in TypeScript; team agents in Slack or Linear.
