/** The UTC day or month a moment falls in, as the key usage is summed under ('2026-11-27' / '2026-11'). */
export const periodKey = (period, at = new Date()) => at.toISOString().slice(0, period === 'day' ? 10 : 7);
export function memoryStorage() {
    const threads = new Map();
    const messages = new Map();
    const cards = new Map();
    const runs = new Map();
    const steps = [];
    const usageRows = [];
    const budgetRows = [];
    const settings = new Map();
    const sum = (rows) => {
        const t = {};
        for (const r of rows)
            t[r.unit] = (t[r.unit] ?? 0) + r.amount;
        return t;
    };
    const storage = {
        threads, messages, cards, runs, steps, usageRows, budgetRows, settings,
        async tenantSettings(tenantId) { const s = settings.get(tenantId); return s ? structuredClone(s) : null; },
        async saveTenantSettings(tenantId, s) { settings.set(tenantId, structuredClone(s)); },
        async getThread(tenantId, userId, id) {
            const t = threads.get(id);
            return t && t.tenantId === tenantId && t.userId === userId ? t : null;
        },
        async createThread(tenantId, userId) {
            const t = { id: crypto.randomUUID(), tenantId, userId, title: null, createdAt: new Date().toISOString() };
            threads.set(t.id, t);
            return t;
        },
        async listMessages(id) { return structuredClone(messages.get(id) ?? []); },
        async saveMessages(id, list) {
            const byId = new Map((messages.get(id) ?? []).map((m) => [m.id, m]));
            for (const m of list)
                byId.set(m.id, structuredClone(m));
            messages.set(id, [...byId.values()]);
        },
        async saveCard(card) { cards.set(card.id, structuredClone({ createdAt: new Date().toISOString(), ...card })); },
        async getCard(tenantId, userId, id) {
            const c = cards.get(id);
            const t = c && threads.get(c.threadId);
            return c && t && t.tenantId === tenantId && t.userId === userId ? structuredClone(c) : null;
        },
        async listCards(threadId) { return [...cards.values()].filter((c) => c.threadId === threadId).map((c) => structuredClone(c)); },
        async updateCard(id, from, patch) {
            const c = cards.get(id);
            if (!c || !from.includes(c.status))
                return null;
            Object.assign(c, structuredClone(patch));
            return structuredClone(c);
        },
        async startRun(run) { runs.set(run.id, { ...run, status: 'running', startedAt: new Date() }); },
        async finishRun(id, end) {
            const r = runs.get(id);
            if (r)
                Object.assign(r, { status: end.status, error: end.error, ...(end.model ? { model: end.model } : {}) });
        },
        async saveStep(step) { steps.push(structuredClone(step)); },
        async runningRuns(tenantId, userId, since) {
            return [...runs.values()].filter((r) => r.tenantId === tenantId && r.userId === userId && r.status === 'running' && r.startedAt > since).length;
        },
        async addUsage(rows) { for (const r of rows)
            usageRows.push({ ...r, at: new Date() }); },
        async usage(tenantId, userId, period) {
            const key = periodKey(period);
            const now = usageRows.filter((r) => r.tenantId === tenantId && periodKey(period, r.at) === key);
            return { user: sum(now.filter((r) => r.userId === userId)), tenant: sum(now) };
        },
        async budgets(tenantId, userId) {
            return budgetRows.filter((b) => b.tenantId === tenantId && (b.userId === '' || b.userId === userId)).map(({ tenantId: _, ...b }) => b);
        },
    };
    return storage;
}
//# sourceMappingURL=storage.js.map