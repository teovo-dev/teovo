# 0001. Wire format: the Vercel AI SDK UI message stream

Status: accepted, 27 Nov 2026, after the trial in `packages/server/src/trials/wire-format.test.ts`.

## Question

Should the panel and the server talk through the Vercel AI SDK's UI message stream, carrying Teovo's own
pieces as custom data parts, or through events of our own?

## What the trial showed

With `ai` 7.0.183, a real `streamText` tool loop against a mock model, sent as the SSE response the browser
receives and read back the way `useChat` does:

- **Cards** (`data-card`), **progress steps** (`data-step`) and **views** (`data-view`) arrive as typed parts
  of the assistant message, next to its text and the tool call itself.
- Writing a part again **with the same id replaces it**, so a step can go from running to done, and a card
  can change status, without adding duplicates.
- **Suggestions** sent as **transient** data reach the browser but are not saved in the message, which is
  what follow-up chips need.
- **Message metadata** carries the run id.
- The finished message is plain JSON and round-trips unchanged, so it can be stored in `tv_messages.parts`.

## Decision

Use the AI SDK UI message stream. Teovo's pieces are data parts named `data-card`, `data-step`, `data-view`,
`data-choices`, `data-sources` and `data-action`. `data-suggestions` is sent as transient. Run ids travel as
message metadata.

## Not covered by the trial

- The real `useChat` hook in a browser. The trial reads the stream with the same SDK function that hook uses,
  but no React screen was rendered.
- Hosts that hold back streams (Firebase Hosting in front of scobly). The plan's long-poll transport (v2)
  handles those.
