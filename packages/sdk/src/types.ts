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
export interface StreamOpts { input?: string | AsyncIterable<string>; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }   // iterable input: lines written as they come (a conversation, e.g. ACP)
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
    http?: { port?: number; path: string; url?: string };   // url: a hosted API (probed once its env vars are set; not by the live poll)
  };
  models?: { path?: string; list: string; id: string; filter?: Array<{ field: string; in: Array<string | boolean> }>; context?: string[] };
  speaks?: {
    openai?: { base: string; headers?: Record<string, string> };   // headers: {env:NAME} read at request time
    openaiClient?: { setup: string };                                // takes a custom OpenAI endpoint (the gateway): steps with {url} {key}; the tool asks for model `auto`
    mcpServer?: { command: string[] };
    acp?: { command: string[] };
    chat?: { command: string[] };   // its chat takes a task: <command…> <prompt> - (task on stdin); the result comes back through `report`
    mcpClient?: { config: string; key: string; entry?: Record<string, unknown>; commandArray?: boolean };   // entry: extra fields our server entry needs (e.g. type); commandArray: command and args as one array
    mcpCli?: { add: string[]; remove: string[]; config?: string };   // the tool's CLI: <bin> <add…> agent-spaghetti -- <command…> (e.g. `claude mcp add`); config: the file it writes (connected = it names our server)
    agentPlugins?: { dir: string; variant?: 'agent-plugins' | 'cursor' };
    mcpClientNames?: string[];   // the name it gives as an MCP client (clientInfo.name), so a server it starts from another tool's config still knows it
    promptHook?: { config: string; event: string };
    agentFile?: string;   // where its custom agents live: connect writes the `agent-spaghetti` agent there (a pick in its agent list)   // its prompt hook (`>>` shortcut): a JSON settings file with hooks.<event>[] = { hooks: [{ type: 'command', command, args }] }
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
  'consent.requested', 'consent.answered', 'consent.expired', 'tool.checked',
  'run.started', 'run.event', 'run.finished', 'run.delivered', 'dispatcher.action', 'backend.queue', 'client.hook', 'client.connected',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export interface HubEvent { ts: number; type: EventType; envId: string; source: string; data: Record<string, unknown> }
export type StoredEvent = HubEvent & { id: number };
export type Emit = (e: Pick<HubEvent, 'type' | 'data'> & Partial<HubEvent>) => void;

export interface Disposable { dispose(): void }

/** Delegation (ADR 0007): the one list of task kinds, and the run record. */
export const TASK_KINDS = ['code-edit', 'tests', 'review', 'research', 'summarize', 'refactor', 'docs', 'other', 'report'] as const;   // report: a result handed back, no reply expected
export type TaskKind = (typeof TASK_KINDS)[number];
/** The kinds a caller picks (report is the runner's own). */
export const HANDOFF_KINDS = TASK_KINDS.filter(k => k !== 'report');
/** One hand-off (ADR 0010 envelope). `then` = the next hops (`target[:model]`), each getting the previous result as `context`;
 *  the last result goes back to the caller (`returnTo`, default 'caller'), into `returnSession` when the caller knows its session. */
/** The target that means "let Agent Spaghetti choose" (core/dispatcher.ts). */
export const AUTO = 'auto';
export interface RunRequest {
  target: string; task: string; kind?: TaskKind; reason?: string; model?: string;
  cwd?: string; resultDir?: string; jobId?: string; parentRunId?: number; deadlineMs?: number;
  context?: string; then?: string[]; returnTo?: 'caller' | 'none'; returnSession?: string;
  files?: string[];                                         // what the user meant (attached, referenced, named): listed for agents, inlined for models
  session?: string;                                         // a session of the target to continue (engines that can resume)
  chainId?: number;                                         // set by the runner for hops after the first
}
export type RunEvent =
  | { type: 'text'; text: string } | { type: 'tool'; name: string; summary: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'done'; result: string } | { type: 'error'; message: string }
  | { type: 'session'; id: string };                        // the target's session, so a result can be resumed into it later
export type RunOutcome = 'running' | 'done' | 'error' | 'denied' | 'expired' | 'cancelled';
export interface RunRow {
  id: number; ts: number; source: string; target: string; model?: string; parentRunId?: number; jobId?: string;
  kind: TaskKind; reason?: string; taskHash: string; durationMs?: number;
  inputTokens?: number; outputTokens?: number; costUsd?: number; outcome: RunOutcome; error?: string;
  resultPath?: string; resultSha256?: string; verdict?: 'up' | 'down' | 'redo';
  chainId: number; session?: string; returnTo?: 'caller' | 'none'; delivered?: Delivery;
}
/** Where a chain's result went (ADR 0010): the waiting call, a resumed session, the caller's chat, or its unread results. */
export type Delivery = 'inline' | 'resumed' | 'injected' | 'unread' | 'read';
/** Something `delegate` can hand a task to: a local model server (OpenAI API) or an agent with a run hook.
 *  `engine`: how its runs are made; `resumable`: a run can continue one of its sessions (results can go back into it). */
export interface Target { id: string; name: string; kind: 'model' | 'agent'; cost: Cost; envId: string; models: string[]; engine: 'openai' | 'acp' | 'module' | 'chat'; resumable: boolean }
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
  /** `run` emits `session` events and continues `req.session` (ADR 0010 resumed returns). */
  resumes?: boolean;
  /** Add (on) or remove agent-spaghetti's MCP server where the tool's own CLI is the documented way (else core/connect.ts does it). */
  connect?(env: Environment, det: Detection, cli: Cli, on: boolean, dryRun: boolean): Promise<Connected>;
  /** Tool-side setup (e.g. a workflow pack): check reports, apply changes the tool (Tools → Set up, `agent-spaghetti setup`). */
  setup?(env: Environment, det: Detection, o: SetupOpts): Promise<TestStep[]>;
  /** The tool's own commands for people and agents in its environment: `agent-spaghetti-env.mjs tool <id> <args…>`. Returns the exit code. */
  cli?(env: Environment, det: Detection, args: string[], say: (line: string) => void): Promise<number>;
  /** The tool's own settings (shown in Settings as `<id>.<key>`; its hooks get them as `options`). */
  settings?: Record<string, SettingDef>;
}
export interface SettingDef { default: string | number | string[]; help: string; choices?: SettingChoices }
/** Where a setting's values come from, so the GUI offers a pick list: found tools, connectable clients, loaded models; `extra` first. */
export interface SettingChoices { from: 'tools' | 'clients' | 'models'; extra?: readonly string[] }
/** A loaded model of a local OpenAI-compatible server, as an agent's config needs it. */
export interface LocalModel { integration: string; base: string; model: string; contextLength?: number }
export interface SetupOpts {
  action: 'check' | 'apply'; dryRun: boolean; cli: Cli;
  options: Record<string, string>;                         // this tool's settings without the prefix (<id>.model → model)
  localModels(): Promise<LocalModel[]>;                    // the engine's scan of this environment, best first (rankTargets)
}
/** How to run agent-spaghetti in an environment (`[...args, 'mcp', '--as', id]` starts the MCP bridge). */
export interface Cli { command: string; args: string[] }
export interface Connected { description: string; changes: string[]; applied: boolean }
export interface Integration { manifest: Manifest; module?: IntegrationModule; source: 'builtin' | 'user'; hash?: string }
