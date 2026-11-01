import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Popover, type Bridge } from '@agent-spaghetti/ui';
import { LiveView } from '@agent-spaghetti/ui/live';
const bridge = (window as unknown as { agentSpaghetti: Bridge }).agentSpaghetti;
const live = new URLSearchParams(window.location.search).get('window') === 'live';
createRoot(document.getElementById('root')!).render(createElement(live ? LiveView : Popover, { bridge }));
