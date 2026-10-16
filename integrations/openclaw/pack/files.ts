// The OpenClaw workflow pack's files (packs/openclaw): read from the repo here; scripts/build.mjs embeds them in the env bundle
// (it replaces this module), so the pack works inside a distro with nothing else copied there.
import { readFileSync } from 'node:fs';

export const PACK_FILES = ['config/orchestrator.patch.json5', 'mcp/catalog.json', 'roles/orchestrator.block.md',
  'roles/worker.AGENTS.md', 'roles/toolsmith.AGENTS.md', 'roles/verifier.AGENTS.md', 'scripts/jobctl'] as const;
export type PackFile = (typeof PACK_FILES)[number];
const PACK_ROOT = new URL('../../../packs/openclaw/', import.meta.url);
export const packFile = (f: PackFile): string => readFileSync(new URL(f, PACK_ROOT), 'utf8');
