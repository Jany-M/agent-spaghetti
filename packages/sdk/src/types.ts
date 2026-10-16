// Shared types. One definition for every package, the env bundle and third-party integrations.
import type { Pending } from './permissions.ts';

/** The one version number (env bundle, MCP server info, client plugin). */
export const VERSION = '0.3.0';
export type Role = 'agent' | 'backend' | 'client' | 'tool';   // tool = provides services to agents (e.g. an MCP server)
export type Cost = 'free' | 'metered' | 'unknown';
export type Level = 'detect' | 'observe' | 'drive' | 'client';
export type EnvKind = 'windows' | 'wsl' | 'linux' | 'macos';
export type Platform = 'windows' | 'linux' | 'macos';

export interface ExecResult { code: number; stdout: string; stderr: string }   // code 127 = not found, 124 = timeout
export interface ExecOpts { timeoutMs?: number; input?: string | Buffer }
export interface StreamOpts { input?: string; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }
export interface HttpRequest { method?: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; signal?: AbortSignal }
export interface HttpResult { status: number; body: string }

/** What the OS itself reports (ADR 0008). Collected once per environment per scan. */
export interface Inventory {
  installed: Array<{ name: string; version?: string; location?: string; source: 'uninstall' | 'msix' | 'desktop' | 'bundle' }>;
  processes: Array<{ name: string; pid: number; path?: string }>;   // name without extension
  listening: Array<{ port: number; address: string; pid?: number }>;
  env: Record<string, string>;                                     // ONLY the names manifests list in detect.env
  partial: string[];                                               // sources that could not be read
}

export interface Environment {
  id: string;                                            // 'windows' | 'linux' | 'wsl:<distro>'
  kind: EnvKind;
  exec(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;   // never throws
  http(req: HttpRequest): Promise<HttpResult | null>;                         // null = unreachable / timeout
  // Streaming (runs): one item per output line; the iteration throws when the process exits non-zero / HTTP is not 2xx.
  execLines(cmd: string, args: string[], opts?: StreamOpts): AsyncIterable<string>;
  httpLines(req: HttpRequest): AsyncIterable<string>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;   // creates folders; `connect` only (a `write` grant for third parties)
  remove(path: string): Promise<void>;                       // file or folder, recursive; missing is fine; `connect` only (`write`)
  which(bin: string): Promise<string | null>;            // absolute path on PATH
  glob(pattern: string): Promise<string | null>;         // first match; expands ~, %VAR% (windows), $VAR; '*' inside one segment
  hostCandidates(): Promise<string[]>;                   // where this env may reach local servers; re-resolved per call
  inventory(envNames: string[]): Promise<Inventory>;
}

export interface Manifest {
  $schema?: string;
  manifest: 1; id: string; name: string; roles: Role[]; cost?: Cost; platforms?: Platform[];
  detect?: {
    installed?: string[];
    process?: string[]; processNotIn?: string[];   // path fragments of copies bundled in other tools
    bin?: string[];
    env?: string[];
    paths?: string[] | Partial<Record<Platform, string[]>>;
    version?: { from: 'installed' } | { args: string[]; regex?: string } | { file: string; json: string } | { json: string };
    http?: { port?: number; path: string };
  };
  models?: { path?: string; list: string; id: string; filter?: Array<{ field: string; in: Array<string | boolean> }>; context?: string[] };
  speaks?: {
    openai?: { port: number; base: string };
    mcpServer?: { command: string[] };
    acp?: { command: string[] };
    mcpClient?: { config: string; key: string; type?: boolean };   // type: entries carry "type": "stdio" (VS Code requires it)
    agentPlugins?: { dir: string; variant?: 'agent-plugins' | 'cursor' };
  };
}

export interface Install { path?: string; version?: string; via: 'installed' | 'process' | 'bin' | 'path'; pid?: number }
export interface Detection {
  integration: string; name: string; envId: string; version?: string; endpoint?: string;
  installs: Install[];
  levels: Level[]; cost: Cost; connectable: 'yes' | 'needs-setup' | 'no'; why: string;
  connected?: boolean;   // clients only: agent-spaghetti's MCP server is in the tool (undefined = cannot connect here)
}
export interface AgentInfo { id: string; integration: string; name: string; envId: string; provider?: string; model?: string; endpoint?: string; isDefault?: boolean }
export interface BackendInfo { id: string; integration: string; model: string; envId: string; endpoint: string; contextLength?: number; reachableFrom: string[] }
export interface Inspection { detection: Detection; agents: AgentInfo[]; backends: BackendInfo[] }
export interface EnvStatus { id: string; state: 'running' | 'stopped' | 'error'; why?: string; partial?: string[] }
export interface Snapshot { ts: number; envs: EnvStatus[]; detections: Detection[]; agents: AgentInfo[]; backends: BackendInfo[]; rejected: Array<{ id: string; why: string }>;
  pending?: Pending[] }   // permission asks from third-party integrations

/** The one list of event types. Later phases append here, nowhere else. */
export const EVENT_TYPES = [
  'scan.completed', 'scan.integration_error', 'env.status', 'backend.detected', 'agent.detected',
  'session.started', 'session.updated', 'session.ended', 'backend.changed', 'tool.changed', 'switch.changed', 'permission.pending',
  'consent.requested', 'consent.answered', 'consent.expired',
  'run.started', 'run.event', 'run.finished', 'backend.queue', 'client.hook', 'client.connected',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export interface HubEvent { ts: number; type: EventType; envId: string; source: string; data: Record<string, unknown> }
export type StoredEvent = HubEvent & { id: number };
export type Emit = (e: Pick<HubEvent, 'type' | 'data'> & Partial<HubEvent>) => void;

export interface Disposable { dispose(): void }

/** Delegation (ADR 0007): the one list of task kinds, and the run record. */
export const TASK_KINDS = ['code-edit', 'tests', 'review', 'research', 'summarize', 'refactor', 'docs', 'other'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export interface RunRequest {
  target: string; task: string; kind?: TaskKind; reason?: string; model?: string;
  cwd?: string; resultDir?: string; jobId?: string; parentRunId?: number; deadlineMs?: number;
}
export type RunEvent =
  | { type: 'text'; text: string } | { type: 'tool'; name: string; summary: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'done'; result: string } | { type: 'error'; message: string };
export type RunOutcome = 'running' | 'done' | 'error' | 'denied' | 'expired' | 'cancelled';
export interface RunRow {
  id: number; ts: number; source: string; target: string; model?: string; parentRunId?: number; jobId?: string;
  kind: TaskKind; reason?: string; taskHash: string; durationMs?: number;
  inputTokens?: number; outputTokens?: number; costUsd?: number; outcome: RunOutcome; error?: string;
  resultPath?: string; resultSha256?: string; verdict?: 'up' | 'down' | 'redo';
}
/** Something `delegate` can hand a task to: a local model server (OpenAI API) or an agent with a run hook. */
export interface Target { id: string; name: string; kind: 'model' | 'agent'; cost: Cost; envId: string; models: string[] }
export interface Ctx { signal: AbortSignal; inventory: Inventory; pollMs?: number; runId?: number }   // runId: set for run(), so nested delegations link to it
export interface Switch { id: string; label: string; on: boolean; envId: string; integration: string }
export interface TestStep { name: string; ok: boolean; detail: string; ms: number }
export interface TestResult { ok: boolean; steps: TestStep[] }

/** Optional code for what a manifest cannot express (ADR 0004 tier 2). */
export interface IntegrationModule {
  inspect?(env: Environment, base: Inspection, ctx: Ctx): Promise<Inspection>;
  // The hooks below receive the detection the engine already made, so a module never re-implements finding its tool.
  observe?(env: Environment, det: Detection, emit: Emit, ctx: Ctx): Disposable;
  switches?(env: Environment, det: Detection, ctx: Ctx): Promise<Switch[]>;
  setSwitch?(env: Environment, det: Detection, id: string, on: boolean, ctx: Ctx): Promise<void>;
  test?(env: Environment, det: Detection, ctx: Ctx): Promise<TestStep[]>;
  run?(env: Environment, det: Detection, req: RunRequest, ctx: Ctx): AsyncIterable<RunEvent>;
  /** Add (on) or remove agent-spaghetti's MCP server where the tool's own CLI is the documented way (else core/connect.ts does it). */
  connect?(env: Environment, det: Detection, cli: Cli, on: boolean, dryRun: boolean): Promise<Connected>;
  /** Tool-side setup (e.g. the OpenClaw workflow pack): check reports, apply changes the tool (Tools → Set up, `agent-spaghetti setup`). */
  setup?(env: Environment, det: Detection, o: SetupOpts): Promise<TestStep[]>;
}
/** A loaded model of a local OpenAI-compatible server, as an agent's config needs it. */
export interface LocalModel { integration: string; base: string; model: string; contextLength?: number }
export interface SetupOpts {
  action: 'check' | 'apply'; dryRun: boolean; cli: Cli;
  options: Record<string, string>;                         // this tool's settings without the prefix (openclaw.model → model)
  localModels(): Promise<LocalModel[]>;                    // the engine's scan of this environment
}
/** How to run agent-spaghetti in an environment (`[...args, 'mcp', '--as', id]` starts the MCP bridge). */
export interface Cli { command: string; args: string[] }
export interface Connected { description: string; changes: string[]; applied: boolean }
export interface Integration { manifest: Manifest; module?: IntegrationModule; source: 'builtin' | 'user'; hash?: string }
