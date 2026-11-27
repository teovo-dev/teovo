import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useAssistant } from './provider.js';
/** A ready-made chat panel. Unstyled apart from `tv-` class names; import '@teovo/react/styles.css' for defaults. */
export function AssistantPanel(props) {
    const { chat, newChat, suggestions, clearSuggestions } = useAssistant();
    const [text, setText] = useState('');
    const busy = chat.status === 'submitted' || chat.status === 'streaming';
    const hint = suggestions.placeholder;
    function ask(t) {
        if (!t.trim() || busy)
            return;
        setText('');
        clearSuggestions();
        void chat.sendMessage({ text: t.trim() });
    }
    function send(e) {
        e.preventDefault();
        ask(text);
    }
    return (_jsxs("section", { className: `tv-panel ${props.className ?? ''}`, "aria-label": "Assistant", children: [_jsxs("div", { className: "tv-messages", role: "log", "aria-live": "polite", children: [chat.messages.length === 0 && props.welcome ? _jsx("div", { className: "tv-welcome", children: props.welcome }) : null, chat.messages.map((m) => _jsx(Message, { message: m, ...props }, m.id)), chat.status === 'submitted' ? _jsx("div", { className: "tv-thinking", children: "Thinking\u2026" }) : null, chat.error ? _jsx("div", { className: "tv-error", role: "alert", children: errorText(chat.error) }) : null] }), props.showSuggestions !== false && !busy && suggestions.suggestions.length ? (_jsx("div", { className: "tv-chips", role: "group", "aria-label": "Suggestions", children: suggestions.suggestions.map((s) => _jsx("button", { type: "button", className: "tv-chip", onClick: () => ask(s), children: s }, s)) })) : null, _jsxs("form", { className: "tv-input", onSubmit: send, children: [_jsx("textarea", { "aria-label": "Message", value: text, placeholder: hint ? `${hint}  (Tab)` : (props.placeholder ?? 'Ask anything'), onChange: (e) => setText(e.target.value), onKeyDown: (e) => {
                            if (e.key === 'Tab' && !text && hint) {
                                e.preventDefault();
                                setText(hint);
                            } // accept the hint, like autocomplete
                            else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)
                                send(e);
                        }, rows: 1 }), busy
                        ? _jsx("button", { type: "button", onClick: () => void chat.stop(), children: "Stop" })
                        : _jsx("button", { type: "submit", disabled: !text.trim(), children: "Send" }), chat.messages.length > 0 && !busy ? _jsx("button", { type: "button", className: "tv-new", onClick: newChat, children: "New chat" }) : null] })] }));
}
function Message({ message, ...props }) {
    const { onAction } = useAssistant();
    const steps = message.parts.filter((p) => p.type === 'data-step');
    const running = steps.filter((p) => p.data.state === 'running');
    return (_jsxs("div", { className: `tv-message tv-${message.role}`, "data-role": message.role, children: [message.parts.map((p, i) => {
                if (p.type === 'text')
                    return _jsx("div", { className: "tv-text", children: props.renderText ? props.renderText(p.text) : p.text }, i);
                if (p.type === 'data-card')
                    return _jsx(CardView, { card: p.data, ...props }, p.id ?? i);
                if (p.type === 'data-action') {
                    const a = p.data;
                    return _jsx("button", { type: "button", className: "tv-action", onClick: () => onAction?.(a), children: a.label }, p.id ?? i);
                }
                return null;
            }), running.map((p) => {
                const name = p.data.name;
                return _jsxs("div", { className: "tv-step", children: [props.stepLabels?.[name] ?? `Using ${name.replace(/_/g, ' ')}`, "\u2026"] }, p.id);
            })] }));
}
const FINAL = { confirmed: 'confirmed', skipped: 'skipped', undone: 'undone', expired: 'expired' };
const AFTER = { confirm: 'confirmed', skip: 'skipped', undo: 'undone' };
function CardView({ card, renderCard }) {
    const { decideCard } = useAssistant();
    const [state, setState] = useState({ status: FINAL[card.status] ?? 'open', reversible: card.reversible });
    async function decide(d) {
        const allowed = d === 'undo' ? state.status === 'confirmed' && state.reversible : state.status === 'open';
        if (!allowed)
            return;
        const before = state;
        setState({ ...state, status: 'busy', error: undefined });
        try {
            const now = await decideCard(card, d);
            setState({ status: AFTER[d], reversible: now.reversible });
        }
        catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            setState({ ...before, error });
        }
    }
    if (renderCard)
        return _jsx(_Fragment, { children: renderCard(card, (d) => void decide(d), state) });
    const keys = [...new Set([...Object.keys(card.before ?? {}), ...Object.keys(card.after ?? {})])];
    return (_jsxs("div", { className: "tv-card", "data-status": state.status, role: "group", "aria-label": card.title, children: [_jsx("div", { className: "tv-card-title", children: card.title }), keys.length ? (_jsx("table", { className: "tv-card-diff", children: _jsx("tbody", { children: keys.map((k) => (_jsxs("tr", { children: [_jsx("th", { scope: "row", children: k }), _jsx("td", { children: show(card.before?.[k]) }), _jsx("td", { children: "\u2192" }), _jsx("td", { children: show(card.after?.[k]) })] }, k))) }) })) : null, state.error ? _jsx("div", { className: "tv-error", role: "alert", children: state.error }) : null, state.status === 'confirmed' ? (_jsxs("div", { className: "tv-card-done", children: ["Done", state.reversible ? _jsx("button", { type: "button", onClick: () => void decide('undo'), children: "Undo" }) : null] })) : state.status === 'skipped' || state.status === 'undone' || state.status === 'expired' ? (_jsx("div", { className: "tv-card-done", children: { skipped: 'Skipped', undone: 'Undone', expired: 'Expired' }[state.status] })) : (_jsxs("div", { className: "tv-card-buttons", children: [_jsx("button", { type: "button", disabled: state.status === 'busy', onClick: () => void decide('confirm'), children: "Confirm" }), _jsx("button", { type: "button", disabled: state.status === 'busy', onClick: () => void decide('skip'), children: "Skip" })] }))] }));
}
const show = (v) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** Server errors arrive as JSON ({ error }) or plain text; show the sentence, not the JSON. */
function errorText(e) {
    try {
        const j = JSON.parse(e.message);
        if (j.error)
            return j.error;
    }
    catch { /* not JSON */ }
    return e.message || 'Something went wrong. Try again.';
}
//# sourceMappingURL=panel.js.map