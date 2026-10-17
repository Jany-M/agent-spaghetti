import type { Detection, EnvKind } from './types.ts';

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive, `*` = any run of characters. The only matcher for installed-app and process names. */
export function wildcard(pattern: string, text: string): boolean {
  return new RegExp('^' + pattern.split('*').map(escape).join('.*') + '$', 'i').test(text);
}
const norm = (p: string, kind: EnvKind) => {
  const s = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return kind === 'windows' ? s.toLowerCase() : s;
};
/** A tool's own program among the installs found on PATH or at a manifest path: the one named `name` (any extension), else the
 *  first. A companion app, a desktop app's own exe or an extension folder never counts. */
export function programOf(det: Pick<Detection, 'installs'>, name?: string): string | undefined {
  const base = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const progs = det.installs.filter(i => i.path && (i.via === 'bin' || i.via === 'path'));
  return (name ? progs.find(i => base(i.path!) === name.toLowerCase()) : progs[0])?.path;
}
/** Header values with {env:NAME} filled from `env`; null when a variable is not set (the tool needs setup). */
export function fillEnv(headers: Record<string, string> | undefined, env: Record<string, string | undefined>): Record<string, string> | null {
  let ok = true;
  const out = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, v.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => env[n] ?? (ok = false, ''))]));
  return ok ? out : null;
}
/** A path as an environment spells it: Windows `C:\\x` (backslashes) ↔ WSL `/mnt/c/x`, and `\\\\wsl$\\<distro>\\x` → `/x` inside the distro. Others unchanged. */
export function envPath(p: string, kind: 'windows' | 'posix'): string {
  if (kind === 'posix') {
    const unc = /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)[\\/][^\\/]+(.*)$/i.exec(p);
    if (unc) return unc[1].replaceAll('\\', '/') || '/';
    const d = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p);
    return d ? `/mnt/${d[1].toLowerCase()}/${d[2].replaceAll('\\', '/')}`.replace(/\/$/, '') : p;
  }
  const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${(m[2] ?? '').replaceAll('/', '\\')}` : /^[a-zA-Z]:/.test(p) ? p.replaceAll('/', '\\') : p;
}
/** A `file:` URI (MCP roots) as a local path: `file:///e%3A/x` → `e:/x`, `file:///home/u` → `/home/u`, `file://wsl.localhost/D/x` → `//wsl.localhost/D/x`. */
export function uriPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  const [, host, rest] = /^file:\/\/([^/]*)(.*)$/.exec(uri)!, p = decodeURIComponent(rest);
  return host && host !== 'localhost' ? `//${host}${p}` : /^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p;   // a host: a UNC path (e.g. wsl.localhost)
}
export const samePath = (a: string, b: string, kind: EnvKind) => norm(a, kind) === norm(b, kind);
