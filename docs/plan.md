# Plan

Teovo is extracted from a live app (scoops) and goes public only after a second app (scobly) runs on it.
See [architecture](architecture.md) for how it works and [features](features.md) for what each release holds.

## Build phases

Each phase ends with a test in a real app.

1. **Safety net in scoops.** Record real conversations and replay them as tests against a scripted model.
   - Ends when: the saved conversations replay with the same cards and tool calls on every run.
   - Status: done in the scoops repository (10 recorded conversations).
2. **Build the packages.** The tool loop, the three tool types, cards with undo, screen context, limits, the run log, the tables, the setup command and the panel.
   - Ends when: every v1 row in [features](features.md) is built and tested here.
   - Status: every v1 row is built, in pull requests 1–10 and 12–21, waiting for review.
3. **Move scoops onto the packages.** Scoops' behaviour does not change; its phase 1 replays still pass. Starts only after phase 2 is finished.
   - Ends when: scoops runs on the packages in production, and a thread opens on a second device.
4. **Ready for other businesses (v1.1).**
   - Ends when: a second business uses the assistant in scoops with its own settings, limits and privacy notice.
5. **Second app: scobly.** Long runs on a queue, done-checks, the run viewer and trace export.
   - Ends when: scobly's chat runs on the kit with its queue, resume and credit hold intact.
6. **A new app from day one.**
   - Ends when: a developer who did not write the kit has a working assistant without reading its source.
7. **Public release.** Docs site, example app and a versioning policy.
   - Ends when: someone outside the team installs it from the docs alone.

## Decisions

Settled on 27 Nov 2026 unless noted.

| Question | Decision |
| --- | --- |
| Name and licence | Teovo, MIT |
| Where the code lives | This repository, all packages together (npm workspaces) |
| Database | Postgres only. No browser-only history mode |
| Wire format | The Vercel AI SDK UI message stream with `data-*` parts. Confirmed by a trial: [0001](decisions/0001-wire-format.md) |
| Where a confirmed card is applied | **Changed while building:** on the server by default (`POST /cards/:id/confirm` calls the app's `apply`, as the user), which gives one place for the double-tap guard, the changed-record check and stored undo. An app can still apply in the browser through the panel's `onCard`. The original plan said browser for v1, server from v2 |
| Panel foundation | **Changed while building:** the panel uses the AI SDK's `useChat` directly. assistant-ui is still planned for attachments, markdown, edit and regenerate, but isn't a dependency yet |
| Follow-up suggestions | Planned: in the same reply. **Built:** the app's `suggestions` callback runs after the reply (no extra model call unless the app makes one). The in-reply version is still open |
| Second app | scobly; parityai tests done-checks and version-restore undo |
| Log retention | Run steps 30 days; conversations and change history until deleted (`npx teovo prune --days N`) |
| Order of work | All Teovo pull requests are finished before scoops moves onto Teovo |

## Risks

- **Shaped around one app.** Scoops is quick and single-request; scobly is queued and long-running. The interface isn't stable until both run on it.
- **Moving foundations.** The Vercel AI SDK changed major versions in 2026. Versions are pinned and used through thin layers.
- **Neighbours.** CopilotKit and Mastra cover nearby ground. Teovo's difference is confirm-before-write cards, tenant limits and its tables arriving as one install.
