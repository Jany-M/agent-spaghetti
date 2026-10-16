// Shared types. One definition for every package, the env bundle and third-party integrations.
export type Role = 'agent' | 'backend' | 'client' | 'tool';   // tool = provides services to agents (e.g. an MCP server)
export type Cost = 'free' | 'metered' | 'unknown';
export type Level = 'detect' | 'observe' | 'drive' | 'client';
export type EnvKind = 'windows' | 'wsl' | 'linux' | 'macos';
export type Platform = 'windows' | 'linux' | 'macos';

export interface ExecResult { code: number; stdout: string; stderr: string }   // code 127 = not found, 124 = timeout
export interface ExecOpts { timeoutMs?: number; input?: string | Buffer }
export interface HttpRequest { method?: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }
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
  readFile(path: string): Promise<string | null>;
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
    process?: string[];
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
    mcpClient?: { config: string; key: string };
    agentPlugins?: { dir: string; variant?: 'agent-plugins' | 'cursor' };
  };
}

export interface Install { path?: string; version?: string; via: 'installed' | 'process' | 'bin' | 'path'; pid?: number }
export interface Detection {
  integration: string; name: string; envId: string; version?: string; endpoint?: string;
  installs: Install[];
  levels: Level[]; cost: Cost; connectable: 'yes' | 'needs-setup' | 'no'; why: string;
}
export interface AgentInfo { id: string; integration: string; name: string; envId: string; provider?: string; model?: string; endpoint?: string; isDefault?: boolean }
export interface BackendInfo { id: string; integration: string; model: string; envId: string; endpoint: string; contextLength?: number; reachableFrom: string[] }
export interface Inspection { detection: Detection; agents: AgentInfo[]; backends: BackendInfo[] }
export interface EnvStatus { id: string; state: 'running' | 'stopped' | 'error'; why?: string; partial?: string[] }
export interface Snapshot { ts: number; envs: EnvStatus[]; detections: Detection[]; agents: AgentInfo[]; backends: BackendInfo[]; rejected: Array<{ id: string; why: string }>;
  pending?: Array<{ subject: string; action: string; resource: string }> }   // permission asks from third-party integrations

/** The one list of event types. Later phases append here, nowhere else. */
export const EVENT_TYPES = [
  'scan.completed', 'scan.integration_error', 'env.status', 'backend.detected', 'agent.detected',
  'session.started', 'session.updated', 'session.ended', 'backend.changed', 'switch.changed', 'permission.pending',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export interface HubEvent { ts: number; type: EventType; envId: string; source: string; data: Record<string, unknown> }
export type StoredEvent = HubEvent & { id: number };
export type Emit = (e: Pick<HubEvent, 'type' | 'data'> & Partial<HubEvent>) => void;

export interface Disposable { dispose(): void }
export interface Ctx { signal: AbortSignal; inventory: Inventory; pollMs?: number }
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
}
export interface Integration { manifest: Manifest; module?: IntegrationModule; source: 'builtin' | 'user'; hash?: string }
