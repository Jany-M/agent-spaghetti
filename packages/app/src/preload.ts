// The only thing the sandboxed renderer can reach: allowlisted daemon ops and the event feed (no token, no Node).
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL, type Bridge, type BridgeEvent } from '@agent-spaghetti/ui/bridge';

const bridge: Bridge = {
  call: (op, input) => ipcRenderer.invoke(CHANNEL.call, op, input ?? {}),
  onEvent: fn => {
    const h = (_e: unknown, ev: BridgeEvent) => fn(ev);
    ipcRenderer.on(CHANNEL.event, h);
    return () => { ipcRenderer.removeListener(CHANNEL.event, h); };
  },
};
contextBridge.exposeInMainWorld('agentSpaghetti', bridge);
