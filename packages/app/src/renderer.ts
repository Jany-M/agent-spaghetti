import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Popover, type Bridge } from '@agent-spaghetti/ui';

const bridge = (window as unknown as { agentSpaghetti: Bridge }).agentSpaghetti;
createRoot(document.getElementById('root')!).render(createElement(Popover, { bridge }));
