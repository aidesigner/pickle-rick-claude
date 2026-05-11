export function extractTrapDoorsSection(content) {
    const start = content.search(/^##\s+Trap Doors\s*$/m);
    if (start === -1)
        return '';
    const afterHeading = content.indexOf('\n', start) + 1;
    const rest = content.slice(afterHeading);
    const nextHeading = rest.search(/^##\s+/m);
    return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}
