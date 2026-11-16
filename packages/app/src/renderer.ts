import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { FlowWindow, Popover, type Bridge } from '@agent-spaghetti/ui';
import { LiveView } from '@agent-spaghetti/ui/live';
const bridge = (window as unknown as { agentSpaghetti: Bridge }).agentSpaghetti;
const PANES = { live: LiveView, flow: FlowWindow } as const;       // the floating windows (?window=<name>); none: the popover
const pane = new URLSearchParams(window.location.search).get('window') as keyof typeof PANES | null;
createRoot(document.getElementById('root')!).render(createElement((pane && PANES[pane]) || Popover, { bridge }));
