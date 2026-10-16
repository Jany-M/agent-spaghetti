// Every built-in integration, listed statically so the env bundle can embed them (review R4).
// tests/guards asserts this list equals the folders. Third-party manifests are loaded from disk by the registry.
import type { Integration, Manifest } from '@agent-spaghetti/sdk';
import { openclawModule } from './openclaw/index.ts';
import chatgptDesktopManifest from './chatgpt-desktop/manifest.json' with { type: 'json' };
import claudeCliManifest from './claude-cli/manifest.json' with { type: 'json' };
import claudeDesktopManifest from './claude-desktop/manifest.json' with { type: 'json' };
import clineManifest from './cline/manifest.json' with { type: 'json' };
import codexManifest from './codex/manifest.json' with { type: 'json' };
import continueManifest from './continue/manifest.json' with { type: 'json' };
import cursorManifest from './cursor/manifest.json' with { type: 'json' };
import kiloManifest from './kilo/manifest.json' with { type: 'json' };
import llamacppManifest from './llamacpp/manifest.json' with { type: 'json' };
import lmstudioManifest from './lmstudio/manifest.json' with { type: 'json' };
import mempalaceManifest from './mempalace/manifest.json' with { type: 'json' };
import ollamaManifest from './ollama/manifest.json' with { type: 'json' };
import openclawManifest from './openclaw/manifest.json' with { type: 'json' };
import opencodeManifest from './opencode/manifest.json' with { type: 'json' };
import rooManifest from './roo/manifest.json' with { type: 'json' };
import vllmManifest from './vllm/manifest.json' with { type: 'json' };
import vscodeManifest from './vscode/manifest.json' with { type: 'json' };
import windsurfManifest from './windsurf/manifest.json' with { type: 'json' };

const MODULES: Record<string, Integration['module']> = { openclaw: openclawModule };
export const BUILTIN_MANIFESTS = [chatgptDesktopManifest, claudeCliManifest, claudeDesktopManifest, clineManifest, codexManifest, continueManifest, cursorManifest, kiloManifest, llamacppManifest, lmstudioManifest, mempalaceManifest, ollamaManifest, openclawManifest, opencodeManifest, rooManifest, vllmManifest, vscodeManifest, windsurfManifest] as unknown as Manifest[];
export const BUILTINS: Integration[] = BUILTIN_MANIFESTS.map(manifest => ({ manifest, module: MODULES[manifest.id], source: 'builtin' }));
export const BUILTIN_DIR = new URL('.', import.meta.url);
