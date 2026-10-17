import type { Integration, Level } from './types.ts';

export interface Engines { openai: boolean; acp: boolean }   // which generic run engines the hub has today
/** Control levels are derived from what an integration provides, never declared (ADR 0004). */
export function levelsOf(i: Integration, engines: Engines): Level[] {
  const m = i.manifest, mod = i.module;
  const l: Level[] = ['detect'];
  if (m.models || mod?.inspect || mod?.observe) l.push('observe');
  if ((m.speaks?.openai && engines.openai) || (m.speaks?.acp && engines.acp) || mod?.run) l.push('drive');
  if (m.speaks?.mcpClient || m.speaks?.agentPlugins || m.speaks?.mcpCli) l.push('client');
  return l;
}
