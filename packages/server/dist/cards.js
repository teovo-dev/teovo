export class CardError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
/** What the browser may see of a card. */
export function publicCard(c) {
    const { undo: _, ...rest } = c;
    return rest;
}
/** Confirm, skip or undo one card, for the person who was shown it. Throws CardError with a sentence for the user. */
export async function decide(opts) {
    const { storage, identity, id, decision, rules } = opts;
    const card = await storage.getCard(identity.tenantId, identity.userId, id);
    if (!card)
        throw new CardError(404, 'That card was not found.');
    const applier = opts.appliers[card.kind];
    const now = new Date();
    const claim = async (from, patch) => {
        const c = await storage.updateCard(id, from, patch);
        if (!c)
            throw new CardError(409, 'This card was already decided.');
        return c;
    };
    if (decision === 'skip')
        return claim(['shown'], { status: 'skipped', decidedBy: identity.userId, decidedAt: now.toISOString() });
    if (decision === 'confirm') {
        if (card.status !== 'shown')
            throw new CardError(409, 'This card was already decided.');
        if (!applier)
            throw new CardError(501, `This app can't apply "${card.kind}" changes yet.`);
        if (applier.roles && !applier.roles.includes(identity.role))
            throw new CardError(403, 'Your role can’t make this change. Ask an owner.');
        if (card.createdAt && now.getTime() - new Date(card.createdAt).getTime() > rules.ttlMs) {
            await storage.updateCard(id, ['shown'], { status: 'expired' });
            throw new CardError(410, 'This card is too old to apply. Ask again and the assistant will prepare a fresh one.');
        }
        const ctx = await opts.ctx();
        if (applier.current && card.before) {
            const cur = await applier.current(card.payload, ctx);
            const changed = Object.keys(card.before).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(card.before[k]));
            if (changed.length) {
                await storage.updateCard(id, ['shown'], { status: 'expired' });
                throw new CardError(409, `This changed since the card was prepared (${changed.join(', ')}). Ask again for a fresh card.`);
            }
        }
        const claimed = await claim(['shown'], { status: 'confirmed', decidedBy: identity.userId, decidedAt: now.toISOString() });
        try {
            const out = await applier.apply(card.payload, ctx);
            const reversible = Boolean(applier.undo);
            return (await storage.updateCard(id, ['confirmed'], { reversible, undo: out?.undo ?? null })) ?? claimed;
        }
        catch (e) {
            // Nothing was applied: put the card back so the user can try again or skip it.
            await storage.updateCard(id, ['confirmed'], { status: 'shown', decidedBy: undefined, decidedAt: undefined });
            throw new CardError(422, e instanceof Error ? e.message : String(e));
        }
    }
    // undo
    if (card.status !== 'confirmed')
        throw new CardError(409, 'Only a confirmed change can be undone.');
    if (!applier?.undo || !card.reversible)
        throw new CardError(409, 'This change can’t be undone here.');
    if (card.decidedBy !== identity.userId)
        throw new CardError(403, 'Only the person who confirmed this can undo it.');
    if (now.getTime() - new Date(card.decidedAt).getTime() > rules.undoMs)
        throw new CardError(410, 'It’s too late to undo this here.');
    const claimed = await claim(['confirmed'], { status: 'undone', undoneAt: now.toISOString() });
    try {
        await applier.undo(card.undo, card.payload, await opts.ctx());
        return claimed;
    }
    catch (e) {
        await storage.updateCard(id, ['undone'], { status: 'confirmed', undoneAt: undefined });
        throw new CardError(422, e instanceof Error ? e.message : String(e));
    }
}
/** How a card reads to the model in later turns, with its status now (not when it was shown). */
export function cardForModel(c) {
    const what = { shown: 'shown, not decided yet', confirmed: 'the user confirmed it and it was applied', skipped: 'the user skipped it; nothing changed',
        undone: 'the user confirmed it, then undid it; nothing changed', expired: 'it expired before being applied; nothing changed',
        waiting_for_approval: 'waiting for someone to approve it' }[c.status];
    return `[Card "${c.title}": ${what}]`;
}
//# sourceMappingURL=cards.js.map