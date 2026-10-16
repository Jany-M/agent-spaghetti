// The orchestrator is OpenClaw's default agent, else the first. Workspace paths may start with ~.
export interface OrchAgent { id: string; workspace: string }
export function pickOrchestrator(list: unknown, home = ''): OrchAgent | undefined {
  const ag = (Array.isArray(list) ? list : []).filter(a => a && typeof a.id === 'string');
  const a = ag.find(x => x.isDefault === true) || ag[0];
  return a ? { id: a.id, workspace: typeof a.workspace === 'string' ? a.workspace.replace(/^~(?=$|\/)/, home) : '' } : undefined;
}
