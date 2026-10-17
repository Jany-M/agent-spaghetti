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
export const samePath = (a: string, b: string, kind: EnvKind) => norm(a, kind) === norm(b, kind);
