// The orchestrator is the default OpenClaw agent, or ORCH_AGENT_ID. Workspace paths may start with ~.
export interface OrchAgent { id: string; workspace: string }
export function pickOrchestrator(list: unknown, want: string | undefined, home = process.env.HOME ?? ''): OrchAgent | undefined {
  const ag = (Array.isArray(list) ? list : []).filter(a => a && typeof a.id === 'string');
  const a = (want && ag.find(x => x.id === want)) || ag.find(x => x.isDefault === true) || ag[0];
  return a ? { id: a.id, workspace: typeof a.workspace === 'string' ? a.workspace.replace(/^~(?=$|\/)/, home) : '' } : undefined;
}
