// What may run inside a WSL distro (env bundle, Node >= 20): no node:sqlite, no daemon.
export { scanEnv, type EnvScan, type InspectPayload } from './scan.ts';
export { localEnvironment, currentKind } from './env/local.ts';
