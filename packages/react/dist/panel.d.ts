import { type ReactNode } from 'react';
import type { Card, CardDecision } from './types.js';
export interface AssistantPanelProps {
    /** Shown before the first message. */
    welcome?: ReactNode;
    placeholder?: string;
    /** Draw the reply text yourself, e.g. with a Markdown renderer. Default: plain text. */
    renderText?: (text: string) => ReactNode;
    /** Draw a card yourself. `decide` sends Confirm, Skip or Undo to the server (or the provider's onCard). */
    renderCard?: (card: Card, decide: (d: CardDecision) => void, state: CardState) => ReactNode;
    /** Friendly names for tools while they run, e.g. { get_sales: 'Looking at sales' }. */
    stepLabels?: Record<string, string>;
    /** Show suggestion chips above the input. Default true (they only appear when the server has some). */
    showSuggestions?: boolean;
    className?: string;
}
export type CardState = {
    status: 'open' | 'busy' | 'confirmed' | 'skipped' | 'undone' | 'expired';
    reversible?: boolean;
    error?: string;
};
/** A ready-made chat panel. Unstyled apart from `tv-` class names; import '@teovo/react/styles.css' for defaults. */
export declare function AssistantPanel(props: AssistantPanelProps): import("react").JSX.Element;
