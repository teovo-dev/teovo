import type { TeovoTool } from './tools.js';
/** What a business (tenant) can set for itself. The app's own code always comes first; these only add or narrow. */
export interface TenantSettings {
    /** False turns the assistant off for everyone in the tenant. */
    enabled: boolean;
    /** Extra notes for the model, e.g. "We close on Sundays. Call customers by first name." */
    instructions?: string;
    /** Words this business uses, e.g. { "khata": "a customer's running credit account" }. */
    glossary?: Record<string, string>;
    /** Tools switched off for this tenant. A tenant can only narrow what roles already allow, never widen it. */
    toolsOff?: string[];
}
export declare const DEFAULT_SETTINGS: TenantSettings;
export declare class SettingsError extends Error {
}
/** Check settings sent by a tenant admin. Throws SettingsError with a sentence for them. */
export declare function validateSettings(raw: unknown, tools: readonly TeovoTool[]): TenantSettings;
/** The tenant's part of the system prompt. Written by the tenant's own admins, so it guides but never overrides the app. */
export declare function settingsText(s: TenantSettings): string;
