// Windows inventory: ONE powershell.exe call that prints ONE JSON object (locale-independent).
import type { Inventory } from '@agent-spaghetti/sdk';
import { parseJson } from '@agent-spaghetti/sdk';
import type { Collector } from './index.ts';

const UNINSTALL = ['HKCU:\\Software', 'HKLM:\\Software', 'HKLM:\\Software\\WOW6432Node']
  .map(root => `'${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'`);

/** Env names come from manifests (schema: ^[A-Za-z_][A-Za-z0-9_]*$), so they are safe inside single quotes. */
export function windowsScript(envNames: string[]): string {
  const names = envNames.filter(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)).map(n => `'${n}'`).join(',');
  return `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8
$partial=@(); $inst=New-Object System.Collections.ArrayList; $proc=New-Object System.Collections.ArrayList; $lis=New-Object System.Collections.ArrayList; $env2=@{}
try { Get-ItemProperty ${UNINSTALL.join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object { [void]$inst.Add(@{ n=[string]$_.DisplayName; v=[string]$_.DisplayVersion; l=[string]$_.InstallLocation; i=[string]$_.DisplayIcon; s='uninstall' }) } } catch { $partial+='uninstall' }
try { Get-AppxPackage -ErrorAction Stop | ForEach-Object { [void]$inst.Add(@{ n=[string]$_.Name; v=[string]$_.Version; l=[string]$_.InstallLocation; s='msix' }) } } catch { $partial+='msix' }
try { Get-Process -ErrorAction Stop | ForEach-Object { [void]$proc.Add(@{ n=[string]$_.ProcessName; p=[int]$_.Id; x=[string]$_.Path }) } } catch { $partial+='processes' }
try { Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { [void]$lis.Add(@{ a=[string]$_.LocalAddress; o=[int]$_.LocalPort; p=[int]$_.OwningProcess }) } } catch { $partial+='listening' }
foreach ($n in @(${names})) { $v=[Environment]::GetEnvironmentVariable($n); if ($v) { $env2[$n]=$v } }
ConvertTo-Json -Compress -Depth 4 @{ installed=@($inst); processes=@($proc); listening=@($lis); env=$env2; partial=@($partial) }`;
}
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const unquote = (p?: string) => p?.replace(/^"(.*)"$/, '$1');   // some installers write InstallLocation in quotes
/** "C:\\Apps\\X\\x.exe",0 → C:\\Apps\\X */
const iconDir = (icon?: string) => {
  const p = icon?.replace(/^"|"?,\s*-?\d+$|"$/g, '').trim();
  return p && /[\\/]/.test(p) ? p.replace(/[\\/][^\\/]*$/, '') : undefined;
};

export function parseWindowsInventory(json: string): Inventory {
  const j = parseJson(json) as Record<string, any> | undefined;
  if (!j) return { installed: [], processes: [], listening: [], env: {}, partial: ['inventory output was not JSON'] };
  const arr = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []);
  return {
    installed: arr(j.installed).map((x: any) => ({ name: x.n, version: str(x.v), location: unquote(str(x.l)) ?? iconDir(str(x.i)), source: x.s }))
      .filter(x => x.name),
    processes: arr(j.processes).map((x: any) => ({ name: x.n, pid: x.p, path: str(x.x) })),
    listening: arr(j.listening).map((x: any) => ({ address: x.a, port: x.o, pid: x.p || undefined })),
    env: j.env && typeof j.env === 'object' ? j.env : {},
    partial: arr(j.partial),
  };
}

export const windowsCollector: Collector = async (env, envNames) => {
  const encoded = Buffer.from(windowsScript(envNames), 'utf16le').toString('base64');
  const r = await env.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeoutMs: 60000 });
  if (r.code !== 0 && !r.stdout.trim()) return { installed: [], processes: [], listening: [], env: {}, partial: [`inventory failed (powershell exit ${r.code})`] };
  return parseWindowsInventory(r.stdout);
};
