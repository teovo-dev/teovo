import { jsx as _jsx } from "react/jsx-runtime";
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
const Ctx = createContext(null);
export function AssistantProvider(props) {
    const [threadId, setThreadId] = useState(props.threadId);
    const thread = useRef(props.threadId);
    const page = useRef(undefined);
    const [pageKey, setPageKey] = useState('');
    const [suggestions, setSuggestions] = useState({ suggestions: [] });
    const latest = useRef(props);
    latest.current = props;
    const transport = useMemo(() => new DefaultChatTransport({
        api: `${props.endpoint.replace(/\/$/, '')}/chat`,
        headers: async () => {
            const h = latest.current.headers;
            return typeof h === 'function' ? await h() : (h ?? {});
        },
        // Only the new message goes up: the server keeps the history and checks it belongs to this person.
        prepareSendMessagesRequest: ({ messages }) => ({ body: { threadId: thread.current, message: messages.at(-1), page: page.current } }),
        fetch: async (input, init) => {
            const res = await (latest.current.fetch ?? fetch)(input, init);
            const id = res.headers.get('x-teovo-thread');
            if (id && id !== thread.current) {
                thread.current = id;
                setThreadId(id);
                latest.current.onThread?.(id);
            }
            return res;
        },
    }), [props.endpoint]);
    const chat = useChat({
        transport,
        onData: (part) => { if (part.type === 'data-suggestions')
            setSuggestions(part.data); },
    });
    // The screen's own suggestions: fetched when the panel opens, when the screen changes, and on New chat.
    const empty = chat.messages.length === 0;
    useEffect(() => {
        if (!empty)
            return;
        let live = true;
        void (async () => {
            const p = latest.current;
            const q = new URLSearchParams();
            const pg = page.current;
            if (pg?.path)
                q.set('path', pg.path);
            if (pg?.title)
                q.set('title', pg.title);
            if (pg?.record) {
                q.set('recordType', pg.record.type);
                q.set('recordId', pg.record.id);
            }
            try {
                const h = typeof p.headers === 'function' ? await p.headers() : (p.headers ?? {});
                const res = await (p.fetch ?? fetch)(`${p.endpoint.replace(/\/$/, '')}/suggestions?${q}`, { headers: h });
                if (res.ok && live)
                    setSuggestions((await res.json()));
            }
            catch { /* chips are a nicety; the panel works without them */ }
        })();
        return () => { live = false; };
    }, [empty, pageKey, props.endpoint]);
    const newChat = useCallback(() => {
        chat.stop();
        thread.current = undefined;
        setThreadId(undefined);
        chat.setMessages([]);
    }, [chat]);
    const setPage = useCallback((p) => {
        page.current = p;
        setPageKey(JSON.stringify(p ?? null));
    }, []);
    const clearSuggestions = useCallback(() => setSuggestions({ suggestions: [] }), []);
    const decideCard = useCallback(async (card, decision) => {
        const p = latest.current;
        if (p.onCard)
            return (await p.onCard(card, decision)) ?? {};
        const h = typeof p.headers === 'function' ? await p.headers() : (p.headers ?? {});
        const res = await (p.fetch ?? fetch)(`${p.endpoint.replace(/\/$/, '')}/cards/${card.id}/${decision}`, { method: 'POST', headers: h });
        const body = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(body.error ?? 'Something went wrong. Nothing was changed.');
        return body.card ?? {};
    }, []);
    const value = useMemo(() => ({ chat, threadId, newChat, setPage, suggestions, clearSuggestions, decideCard, onAction: props.onAction }), [chat, threadId, newChat, setPage, suggestions, clearSuggestions, decideCard, props.onAction]);
    return _jsx(Ctx.Provider, { value: value, children: props.children });
}
/** The conversation: messages, send, stop, status, newChat. For apps that draw their own panel. */
export function useAssistant() {
    const v = useContext(Ctx);
    if (!v)
        throw new Error('useAssistant must be used inside <AssistantProvider>');
    return v;
}
/**
 * Tell the assistant which screen the user is on. Call it in each screen; the latest mounted screen wins,
 * and leaving the screen clears it.
 */
export function useAssistantContext(page) {
    const { setPage } = useAssistant();
    const { path, title } = page;
    const type = page.record?.type, id = page.record?.id;
    useEffect(() => {
        setPage({ path, title, ...(type && id ? { record: { type, id } } : {}) });
        return () => setPage(undefined);
    }, [setPage, path, title, type, id]);
}
//# sourceMappingURL=provider.js.map