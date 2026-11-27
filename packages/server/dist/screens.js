const MAX_CHIPS = 4;
const MAX_CHARS = 80;
/** Keep suggestions short and few, whatever the app returns. */
export function tidy(s) {
    const clean = (t) => t.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    const suggestions = [...new Set(s.suggestions.map(clean).filter(Boolean))].slice(0, MAX_CHIPS);
    const placeholder = s.placeholder ? clean(s.placeholder) : undefined;
    return placeholder ? { suggestions, placeholder } : { suggestions };
}
/** A page from the request body or query string, with anything malformed dropped. */
export function readPage(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const r = raw;
    const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const page = {};
    const path = str(r.path, 300), title = str(r.title, 200);
    if (path)
        page.path = path;
    if (title)
        page.title = title;
    const rec = r.record;
    const type = str(rec?.type, 50), id = str(rec?.id, 100);
    if (type && id)
        page.record = { type, id };
    return Object.keys(page).length ? page : undefined;
}
/** The part of the system prompt that says where the user is. All of it is fenced: the browser and the records supplied it. */
export function screenText(page, summary, untrusted) {
    if (!page && !summary)
        return '';
    const lines = [
        page?.title ? `Screen: ${page.title}` : '',
        page?.path ? `Path: ${page.path}` : '',
        page?.record ? `Open record: ${page.record.type} ${page.record.id}` : '',
        summary ? `What it shows:\n${summary}` : '',
    ].filter(Boolean);
    return lines.length ? `\n\nWhat the user is looking at now:\n${untrusted(lines.join('\n'), 'screen')}` : '';
}
//# sourceMappingURL=screens.js.map