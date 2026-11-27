export const DEFAULT_SETTINGS = { enabled: true };
const MAX_INSTRUCTIONS = 2000;
const MAX_TERMS = 50;
export class SettingsError extends Error {
}
/** Check settings sent by a tenant admin. Throws SettingsError with a sentence for them. */
export function validateSettings(raw, tools) {
    if (!raw || typeof raw !== 'object')
        throw new SettingsError('Send the settings as an object.');
    const r = raw;
    const out = { enabled: r.enabled === undefined ? true : Boolean(r.enabled) };
    if (r.instructions !== undefined && r.instructions !== null) {
        if (typeof r.instructions !== 'string')
            throw new SettingsError('Instructions must be text.');
        const text = r.instructions.trim();
        if (text.length > MAX_INSTRUCTIONS)
            throw new SettingsError(`Instructions can be at most ${MAX_INSTRUCTIONS} characters.`);
        if (text)
            out.instructions = text;
    }
    if (r.glossary !== undefined && r.glossary !== null) {
        if (typeof r.glossary !== 'object' || Array.isArray(r.glossary))
            throw new SettingsError('The glossary must be a list of words and meanings.');
        const entries = Object.entries(r.glossary)
            .map(([k, v]) => [k.trim().slice(0, 60), typeof v === 'string' ? v.trim().slice(0, 200) : ''])
            .filter(([k, v]) => k && v);
        if (entries.length > MAX_TERMS)
            throw new SettingsError(`The glossary can have at most ${MAX_TERMS} words.`);
        if (entries.length)
            out.glossary = Object.fromEntries(entries);
    }
    if (r.toolsOff !== undefined && r.toolsOff !== null) {
        if (!Array.isArray(r.toolsOff) || r.toolsOff.some((t) => typeof t !== 'string'))
            throw new SettingsError('toolsOff must be a list of tool names.');
        const known = new Set(tools.map((t) => t.name));
        const unknown = r.toolsOff.filter((t) => !known.has(t));
        if (unknown.length)
            throw new SettingsError(`Unknown tool: ${unknown.join(', ')}.`);
        if (r.toolsOff.length)
            out.toolsOff = [...new Set(r.toolsOff)];
    }
    return out;
}
/** The tenant's part of the system prompt. Written by the tenant's own admins, so it guides but never overrides the app. */
export function settingsText(s) {
    const parts = [];
    if (s.instructions)
        parts.push(`Notes from this business (follow them unless they conflict with anything above):\n${s.instructions}`);
    if (s.glossary && Object.keys(s.glossary).length) {
        parts.push(`Words this business uses:\n${Object.entries(s.glossary).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
    }
    return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}
//# sourceMappingURL=settings.js.map