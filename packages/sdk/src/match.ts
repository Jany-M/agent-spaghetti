import type { EnvKind } from './types.ts';

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive, `*` = any run of characters. The only matcher for installed-app and process names. */
export function wildcard(pattern: string, text: string): boolean {
  return new RegExp('^' + pattern.split('*').map(escape).join('.*') + '$', 'i').test(text);
}
const norm = (p: string, kind: EnvKind) => {
  const s = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return kind === 'windows' ? s.toLowerCase() : s;
};
export const samePath = (a: string, b: string, kind: EnvKind) => norm(a, kind) === norm(b, kind);
