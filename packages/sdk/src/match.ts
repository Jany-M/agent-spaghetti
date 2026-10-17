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
/** A tool's own program among the installs found (PATH or a manifest path): the one named `name` (any extension), else, without a
 *  name, the first. A companion app or extension folder found alongside never counts. */
export function programOf(det: Pick<Detection, 'installs'>, name?: string): string | undefined {
  const progs = det.installs.filter(i => (i.via === 'bin' || i.via === 'path') && i.path);
  const base = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return (name ? progs.find(i => base(i.path!).toLowerCase() === name.toLowerCase()) : progs[0])?.path;
}
export const samePath = (a: string, b: string, kind: EnvKind) => norm(a, kind) === norm(b, kind);
