import { useChat } from '@ai-sdk/react';
import { type ReactNode } from 'react';
import type { Action, Card, CardDecision, Page, Suggestions, TeovoMessage } from './types.js';
export interface AssistantProviderProps {
    /** Where the app mounted the server handler, e.g. '/api/assistant'. The panel posts to `${endpoint}/chat`. */
    endpoint: string;
    /** Continue an earlier conversation. Omitted: the first message starts a new one. */
    threadId?: string;
    /** Called when the server starts a new conversation, so the app can remember it (e.g. in the URL). */
    onThread?: (threadId: string) => void;
    /** Extra headers on every request (e.g. the app's auth token or tenant id). */
    headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
    /**
     * Replace how Confirm, Skip and Undo reach the app. Default: POST `${endpoint}/cards/:id/:decision`, which
     * runs the appliers given to createAssistant({ cards }). Throw to show the error on the card.
     */
    onCard?: (card: Card, decision: CardDecision) => Promise<Partial<Card> | void> | Partial<Card> | void;
    /** The user pressed a button the assistant offered (open a screen, run an app action). */
    onAction?: (action: Action) => void;
    /** Replace fetch, e.g. in tests or to call the handler in-process. */
    fetch?: typeof fetch;
    children: ReactNode;
}
interface AssistantState {
    chat: ReturnType<typeof useChat<TeovoMessage>>;
    threadId: string | undefined;
    /** Start a fresh conversation: clears the messages; the next message creates a new thread. */
    newChat: () => void;
    setPage: (page: Page | undefined) => void;
    /** Chips and hint for now: the screen's when the chat is idle, the follow-ups after a reply. */
    suggestions: Suggestions;
    clearSuggestions: () => void;
    /** Confirm, skip or undo a card. Resolves to the card as it is now; rejects with the sentence to show. */
    decideCard: (card: Card, decision: CardDecision) => Promise<Partial<Card>>;
    onAction: AssistantProviderProps['onAction'];
}
export declare function AssistantProvider(props: AssistantProviderProps): import("react").JSX.Element;
/** The conversation: messages, send, stop, status, newChat. For apps that draw their own panel. */
export declare function useAssistant(): AssistantState;
/**
 * Tell the assistant which screen the user is on. Call it in each screen; the latest mounted screen wins,
 * and leaving the screen clears it.
 */
export declare function useAssistantContext(page: Page): void;
export {};
