// What may run inside a WSL distro (env bundle, Node >= 20): no node:sqlite, no daemon.
export { scanEnv, type EnvScan } from './scan.ts';
export { decodePayload, type EnvPayload } from './env/wsl.ts';
export { localEnvironment, currentKind } from './env/local.ts';
export { observeEnv, type ObserveOpts } from './engine/observe.ts';
export { runEnvCommand, runHere, ENV_COMMANDS, type EnvCommand } from './actions.ts';
export { extraHostsFromEnv } from './env/hosts.ts';
