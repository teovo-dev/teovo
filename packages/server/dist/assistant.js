import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, isStepCount, streamText, tool, toUIMessageStream } from 'ai';
import { fallbackModel } from './fallback.js';
import { CardError, cardForModel, decide, publicCard } from './cards.js';
import { checkLimits, limitMessage } from './limits.js';
import { toolsFor } from './tools.js';
import { makeUntrusted, UNTRUSTED_RULE } from './untrusted.js';
import { DEFAULT_SETTINGS, SettingsError, settingsText, validateSettings } from './settings.js';
import { readPage, screenText, tidy } from './screens.js';
const DEFAULT_TIMEOUTS = { firstChunkMs: 30_000, chunkMs: 20_000, totalMs: 120_000 };
function clip(v, max) {
    if (v === undefined)
        return { value: undefined, truncated: false };
    const text = JSON.stringify(v) ?? '';
    return text.length <= max ? { value: v, truncated: false } : { value: text.slice(0, max), truncated: true };
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export function createAssistant(config) {
    if (!config.models.length)
        throw new Error('createAssistant: at least one model is required');
    async function chat(req) {
        const identity = await config.identify(req);
        if (!identity)
            return json(401, { error: 'Sign in to use the assistant.' });
        let body;
        try {
            body = (await req.json());
        }
        catch {
            return json(400, { error: 'The request was not valid JSON.' });
        }
        const message = body.message;
        if (!message || message.role !== 'user' || !Array.isArray(message.parts) || !message.parts.some((p) => p.type === 'text' && p.text.trim())) {
            return json(400, { error: 'Send one user message with some text.' });
        }
        const { storage } = config;
        const settings = (await storage.tenantSettings(identity.tenantId)) ?? DEFAULT_SETTINGS;
        if (!settings.enabled)
            return json(403, { error: 'The assistant is turned off for your team. An admin can turn it on in settings.' });
        // Before anything is saved, so a refused message leaves no empty thread behind.
        const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
        const hit = await checkLimits(storage, identity, config.limits, timeouts.totalMs * 2);
        if (hit) {
            config.on?.limit?.(hit, identity);
            return json(429, { error: limitMessage(hit), limit: hit });
        }
        const thread = body.threadId
            ? await storage.getThread(identity.tenantId, identity.userId, body.threadId)
            : await storage.createThread(identity.tenantId, identity.userId);
        if (!thread)
            return json(404, { error: 'That conversation was not found.' }); // also when it is someone else's
        const history = [...(await storage.listMessages(thread.id)), message].slice(-(config.historyMessages ?? 30));
        await storage.saveMessages(thread.id, [message]);
        const db = await config.asUser(identity, req);
        const runId = crypto.randomUUID();
        const first = config.models[0];
        await storage.startRun({ id: runId, threadId: thread.id, tenantId: identity.tenantId, userId: identity.userId, model: first.modelId, promptVersion: config.promptVersion });
        await storage.addUsage([{ tenantId: identity.tenantId, userId: identity.userId, runId, provider: first.provider, model: first.modelId, unit: 'messages', amount: 1 }]);
        let seq = 0;
        const statuses = new Map((await storage.listCards(thread.id)).map((c) => [c.id, c]));
        const nonce = crypto.randomUUID().slice(0, 8);
        const ctx = { identity, db, untrusted: makeUntrusted(nonce) };
        const page = readPage(body.page);
        const instructions = typeof config.instructions === 'function' ? await config.instructions({ identity, page }) : config.instructions;
        const summary = page && config.screen ? await Promise.resolve().then(() => config.screen(page, ctx)).catch((e) => { config.on?.error?.(e, { identity, threadId: thread.id }); return null; }) : null;
        const system = `${instructions}${settingsText(settings)}\n\n${UNTRUSTED_RULE}${screenText(page, summary, ctx.untrusted)}`;
        const stream = createUIMessageStream({
            originalMessages: history,
            execute: async ({ writer }) => {
                writer.write({ type: 'start', messageMetadata: { runId, threadId: thread.id } });
                const tools = {};
                const off = new Set(settings.toolsOff ?? []);
                for (const t of toolsFor(config.tools, identity).filter((x) => !off.has(x.name))) {
                    tools[t.name] = tool({
                        description: t.description,
                        inputSchema: t.input,
                        execute: async (input, { toolCallId }) => {
                            writer.write({ type: 'data-step', id: toolCallId, data: { name: t.name, state: 'running' } });
                            const started = Date.now();
                            const step = { runId, seq: seq++, type: 'tool', toolCallId, name: t.name };
                            const max = config.logLimit ?? 8000;
                            const logged = clip(input, max);
                            try {
                                const out = await t.run(input, ctx);
                                const result = clip(out, max);
                                await storage.saveStep({ ...step, input: logged.value, output: result.value, truncated: logged.truncated || result.truncated, durationMs: Date.now() - started });
                                if (t.kind === 'propose') {
                                    const p = out;
                                    const card = { ...p, id: crypto.randomUUID(), threadId: thread.id, runId, status: 'shown' };
                                    await storage.saveCard(card);
                                    config.on?.card?.(card);
                                    writer.write({ type: 'data-card', id: card.id, data: publicCard(card) });
                                    return `Shown to the user as a card: "${p.title}". Nothing has changed yet; the user confirms or skips it.`;
                                }
                                if (t.kind === 'action') {
                                    writer.write({ type: 'data-action', id: toolCallId, data: out });
                                    return 'A button is shown under your reply.';
                                }
                                return out;
                            }
                            catch (e) {
                                await storage.saveStep({ ...step, input: logged.value, truncated: logged.truncated, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started });
                                throw e;
                            }
                            finally {
                                writer.write({ type: 'data-step', id: toolCallId, data: { name: t.name, state: 'done' } });
                            }
                        },
                    });
                }
                // Tools only read, propose or offer buttons; none writes during a run, so switching model is always safe.
                let usedModel = first;
                const model = fallbackModel(config.models, () => true, (from, e) => {
                    const i = config.models.findIndex((m) => m.modelId === from);
                    usedModel = config.models[i + 1] ?? usedModel;
                    config.on?.modelSwitch?.(from, e);
                });
                let streamError;
                const result = streamText({
                    onError: ({ error }) => { streamError ??= error; },
                    model,
                    system,
                    messages: await convertToModelMessages(history, {
                        // Earlier cards reach the model with their status now, so it knows what the user confirmed or skipped.
                        convertDataPart: (p) => {
                            if (p.type !== 'data-card')
                                return undefined;
                            const c = p.data;
                            return { type: 'text', text: cardForModel(statuses.get(c.id) ?? c) };
                        },
                    }),
                    tools,
                    stopWhen: isStepCount(config.maxSteps ?? 8),
                    timeout: timeouts,
                    maxRetries: 1,
                    abortSignal: req.signal,
                });
                writer.merge(toUIMessageStream({ stream: result.stream, sendStart: false }));
                try {
                    const text = await result.text;
                    await finish('done');
                    if (config.suggestions) {
                        // Follow-ups ride along as a transient part: shown under this reply, never saved in the history.
                        const s = await Promise.resolve().then(() => config.suggestions({ identity: identity, page, after: text, db })).catch(() => null);
                        if (s && s.suggestions.length)
                            writer.write({ type: 'data-suggestions', data: tidy(s), transient: true });
                    }
                }
                catch (e) {
                    await finish(req.signal.aborted ? 'stopped' : 'failed', streamError ?? e);
                    throw e;
                }
                async function finish(status, error) {
                    await storage.finishRun(runId, { status, model: usedModel.modelId, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) });
                    const u = await Promise.resolve(result.totalUsage).catch(() => undefined);
                    const base = { tenantId: identity.tenantId, userId: identity.userId, runId, provider: usedModel.provider, model: usedModel.modelId };
                    const rows = [];
                    if (u?.inputTokens)
                        rows.push({ ...base, unit: 'input_tokens', amount: u.inputTokens });
                    if (u?.outputTokens)
                        rows.push({ ...base, unit: 'output_tokens', amount: u.outputTokens });
                    if (rows.length) {
                        await storage.addUsage(rows);
                        config.on?.usage?.(rows);
                    }
                }
            },
            onError: (e) => {
                config.on?.error?.(e, { identity, threadId: thread.id });
                return 'The assistant could not finish this reply. Try again.';
            },
            onEnd: async ({ messages }) => {
                const reply = messages.at(-1);
                if (reply && reply.role === 'assistant')
                    await storage.saveMessages(thread.id, [reply]);
            },
        });
        return createUIMessageStreamResponse({ stream, headers: { 'x-teovo-thread': thread.id } });
    }
    const rules = { ttlMs: 24 * 3600_000, undoMs: 10 * 60_000, ...config.cardRules };
    async function suggestions(req) {
        const identity = await config.identify(req);
        if (!identity)
            return json(401, { error: 'Sign in to use the assistant.' });
        if (!config.suggestions || ((await config.storage.tenantSettings(identity.tenantId)) ?? DEFAULT_SETTINGS).enabled === false)
            return json(200, { suggestions: [] });
        const q = new URL(req.url).searchParams;
        const page = readPage({ path: q.get('path'), title: q.get('title'), record: { type: q.get('recordType'), id: q.get('recordId') } });
        try {
            return json(200, tidy(await config.suggestions({ identity, page, db: await config.asUser(identity, req) })));
        }
        catch (e) {
            config.on?.error?.(e, { identity, threadId: '' });
            return json(200, { suggestions: [] });
        }
    }
    async function tenantSettings(req) {
        const identity = await config.identify(req);
        if (!identity)
            return json(401, { error: 'Sign in to use the assistant.' });
        if (!(config.settingsRoles ?? ['owner', 'admin']).includes(identity.role))
            return json(403, { error: 'Only an admin can change assistant settings.' });
        const tools = config.tools.map((t) => ({ name: t.name, description: t.description, kind: t.kind }));
        if (req.method === 'PUT') {
            let body;
            try {
                body = await req.json();
            }
            catch {
                return json(400, { error: 'The request was not valid JSON.' });
            }
            try {
                const s = validateSettings(body, config.tools);
                await config.storage.saveTenantSettings(identity.tenantId, s);
                return json(200, { settings: s, tools });
            }
            catch (e) {
                if (e instanceof SettingsError)
                    return json(400, { error: e.message });
                throw e;
            }
        }
        return json(200, { settings: (await config.storage.tenantSettings(identity.tenantId)) ?? DEFAULT_SETTINGS, tools });
    }
    async function card(req, id, decision) {
        const identity = await config.identify(req);
        if (!identity)
            return json(401, { error: 'Sign in to use the assistant.' });
        try {
            const done = await decide({
                storage: config.storage, appliers: config.cards ?? {}, rules, identity, id, decision,
                ctx: async () => ({ identity, db: await config.asUser(identity, req), untrusted: makeUntrusted(crypto.randomUUID().slice(0, 8)) }),
            });
            config.on?.decision?.(done, decision, identity);
            return json(200, { card: publicCard(done) });
        }
        catch (e) {
            if (e instanceof CardError)
                return json(e.status, { error: e.message });
            config.on?.error?.(e, { identity, threadId: '' });
            return json(500, { error: 'Something went wrong. Nothing was changed.' });
        }
    }
    return {
        /** Mount under any path, e.g. app.all('/api/assistant/*', teovo.fetch). Handles POST …/chat, GET …/suggestions, GET/PUT …/settings and POST …/cards/:id/(confirm|skip|undo). */
        async fetch(req) {
            const path = new URL(req.url).pathname;
            if (req.method === 'POST' && path.endsWith('/chat'))
                return chat(req);
            if (req.method === 'GET' && path.endsWith('/suggestions'))
                return suggestions(req);
            if ((req.method === 'GET' || req.method === 'PUT') && path.endsWith('/settings'))
                return tenantSettings(req);
            const m = /\/cards\/([0-9a-f-]{36})\/(confirm|skip|undo)$/i.exec(path);
            if (req.method === 'POST' && m)
                return card(req, m[1].toLowerCase(), m[2]);
            return json(404, { error: 'Not found.' });
        },
    };
}
//# sourceMappingURL=assistant.js.map