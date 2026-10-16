// One collector per OS (ADR 0008). Collectors only read structured sources; they never parse localized text.
import type { EnvKind, Environment, Inventory } from '@agent-spaghetti/sdk';
import { windowsCollector } from './windows.ts';
import { linuxCollector } from './linux.ts';

export type Collector = (env: Pick<Environment, 'exec'>, envNames: string[]) => Promise<Inventory>;
const macosCollector: Collector = async () =>
  ({ installed: [], processes: [], listening: [], env: {}, partial: ['macos inventory arrives in Phase 7'] });

export const collectorFor = (kind: EnvKind): Collector =>
  kind === 'windows' ? windowsCollector : kind === 'macos' ? macosCollector : linuxCollector;
