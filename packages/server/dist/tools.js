export function defineTool(tool) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name))
        throw new Error(`Tool name "${tool.name}" must be lowercase letters, digits and underscores`);
    return tool;
}
/** The tools this person may use. */
export function toolsFor(tools, identity) {
    return tools.filter((t) => !t.roles || t.roles.includes(identity.role));
}
//# sourceMappingURL=tools.js.map