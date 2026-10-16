// The orchestrator section of the default agent's AGENTS.md, between stable markers (port of apply.sh's inline Python).
// Text always comes from a file, never a shell string. Old markers (pre-rename) are replaced too.
export const BEGIN_PREFIX = '<!-- BEGIN ORCHESTRATOR';
export const BEGIN = '<!-- BEGIN ORCHESTRATOR (managed by agent-spaghetti; edit roles/orchestrator.block.md) -->';
export const END = '<!-- END ORCHESTRATOR -->';
const ANY_BLOCK = /<!-- BEGIN ORCHESTRATOR \(managed by [^)]*\) -->[\s\S]*?<!-- END ORCHESTRATOR -->\n?/;
const SECTION = /^## Background Work and Completion Reporting[\s\S]*?(?=^## |(?![\s\S]))/m;

export function applyBlock(doc: string, block: string): string {
  const fresh = `${BEGIN}\n${block.trim()}\n${END}\n`;
  if (ANY_BLOCK.test(doc)) return doc.replace(ANY_BLOCK, () => fresh);
  const m = SECTION.exec(doc);
  return m ? doc.slice(0, m.index) + fresh + '\n' + doc.slice(m.index + m[0].length) : doc.trimEnd() + (doc.trim() ? '\n\n' : '') + fresh;
}
