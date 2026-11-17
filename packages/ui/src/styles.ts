// The one stylesheet for the tray popover (Phase 4 app reuses it). Follows the OS light/dark setting.
export const CSS = `
/* tools (tc0-6: teal 172, violet 262, lime 84, rose 330, azure 217, fuchsia 292, slate; neighbours far apart; a manifest color may take
   orange 25) never share a hue with the actions (red 0, gold 45, green 142; sending is plain bold text, like the → between tools) */
:root { --tc0:#0f9488; --tc1:#7c3aed; --tc2:#4d7c0f; --tc3:#db2777; --tc4:#2563eb; --tc5:#c026d3; --tc6:#64748b;
  --a-answer:#15803d; --a-decide:#a16207; --a-fail:#dc2626; }
@media (prefers-color-scheme: dark) { :root { --tc0:#2dd4bf; --tc1:#a78bfa; --tc2:#bef264; --tc3:#f472b6; --tc4:#60a5fa; --tc5:#e879f9; --tc6:#94a3b8;
  --a-answer:#4ade80; --a-decide:#facc15; --a-fail:#f87171; } }
:root { --bg:#f7f7f8; --card:#fff; --fg:#1d1f23; --muted:#646a73; --line:#e3e5e8; --accent:#e8892b;
  --idle:#4b9c6b; --working:#3b82f6; --approval:#f59e0b; --problem:#dc2626; --btn:#eceef1; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#17181b; --card:#202227; --fg:#eceef1; --muted:#9aa1ab; --line:#2e3138; --btn:#2b2e35; } }
* { box-sizing:border-box; margin:0; }
body { font:13px/1.45 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--fg); }
.pop { display:flex; flex-direction:column; height:100vh; }
.head { display:flex; gap:10px; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line); }
.head img { width:36px; height:36px; }
.head .lines div:first-child { font-weight:600; }
.head .lines div + div { color:var(--muted); font-size:12px; }
.dot { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:6px; vertical-align:1px; }
.dot.idle{background:var(--idle)} .dot.working{background:var(--working)} .dot.approval{background:var(--approval)} .dot.problem{background:var(--problem)}
.body { flex:1; overflow:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
h2 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
.card.ask { border-left:3px solid var(--approval); }
.card .what { font-weight:600; }
.card code, .card pre { font:12px/1.4 ui-monospace,"Cascadia Mono",Consolas,monospace; overflow-wrap:anywhere; }
.card pre { white-space:pre-wrap; max-height:160px; overflow:auto; background:var(--bg); border-radius:6px; padding:8px; margin-top:6px; }
.card .why, .card .meta { color:var(--muted); font-size:12px; margin-top:4px; }
.badge { font-size:11px; padding:1px 6px; border-radius:10px; background:var(--approval); color:#1d1f23; margin-left:6px; }
.row { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
button { font:inherit; border:1px solid var(--line); background:var(--btn); color:var(--fg); border-radius:6px; padding:4px 10px; cursor:pointer; }
button.allow { background:var(--accent); border-color:var(--accent); color:#fff; }
button:focus-visible { outline:2px solid var(--working); outline-offset:1px; }
button:disabled { opacity:.6; cursor:default; }
.list div { padding:3px 0; border-bottom:1px solid var(--line); } .list div:last-child { border:0; }
.empty { color:var(--muted); }
.tabs { display:flex; gap:2px; padding:6px 8px 0; border-bottom:1px solid var(--line); }
.tabs button { border:0; background:none; border-radius:6px 6px 0 0; padding:5px 7px; color:var(--muted); border-bottom:2px solid transparent; }
.tabs button[aria-current=page] { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
.count { margin-left:5px; font-size:10px; background:var(--approval); color:#1d1f23; border-radius:8px; padding:0 5px; }
.panel { display:flex; flex-direction:column; gap:8px; }
details.group > summary { cursor:pointer; list-style:none; display:flex; align-items:baseline; gap:4px; padding:2px 0; }
details.group > summary::before { content:"▸"; color:var(--muted); font-size:10px; width:12px; }
details.group[open] > summary::before { content:"▾"; }
details.group > .card { margin-top:6px; }
.tool .top { display:flex; align-items:center; gap:6px; flex-wrap:wrap; } .tool .name { font-weight:600; }
.tool.asking { border-left:3px solid var(--approval); }
.tool details { margin-top:6px; } .tool details > summary { cursor:pointer; color:var(--muted); font-size:12px; }
.state { font-size:11px; padding:0 6px; border-radius:10px; border:1px solid var(--line); color:var(--muted); }
.state.ready, .state.running { color:var(--idle); border-color:var(--idle); } .state.stopped { color:var(--problem); border-color:var(--problem); }
.meta { color:var(--muted); font-size:12px; }
.sub { margin-top:6px; } .sub h3 { font-size:12px; margin-bottom:2px; }
.check { display:block; font-size:12px; } .perm { padding:4px 0; border-bottom:1px solid var(--line); } .perm .row { margin-top:4px; }
.card.error { border-left:3px solid var(--problem); }
.form .grid { display:grid; grid-template-columns:1fr 1fr; gap:6px 8px; margin:6px 0; }
.form label { display:flex; flex-direction:column; gap:2px; font-size:12px; color:var(--muted); }
.form .setting { padding:6px 0; border-bottom:1px solid var(--line); display:flex; flex-direction:column; gap:3px; } .form .setting:last-child { border:0; }
.routing .route { padding:5px 0; border-bottom:1px solid var(--line); } .routing .route:last-child { border:0; } .routing .route .row { margin-top:3px; }
.routing .route .row button { font-size:12px; padding:1px 8px; } .routing .skip { color:var(--muted); } .routing .why { color:var(--muted); font-size:12px; }
.form .setting .name { font-weight:600; } .ok { color:var(--idle); font-weight:400; font-size:12px; }
.checks { display:grid; grid-template-columns:1fr 1fr; gap:0 8px; } .checks input, .check input { width:auto; margin-right:4px; }
.out { margin-top:6px; } .out.fail pre { border-left:3px solid var(--problem); } .out.pass pre { border-left:3px solid var(--idle); }
.steps { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-top:4px; } .step { font-size:12px; padding:1px 4px 1px 8px; border-radius:10px; border:1px solid var(--line); }
.step button { border:0; background:none; padding:0 4px; }
input, select, textarea { font:inherit; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:4px 6px; width:100%; }
textarea { resize:vertical; }
.row select { width:auto; }
.tool .row button, .tool .row select { font-size:12px; padding:2px 8px; }
.runs .line { display:block; width:100%; text-align:left; border:0; border-bottom:1px solid var(--line); border-radius:0; background:none; padding:4px 0;
  font:11px/1.4 ui-monospace,"Cascadia Mono",Consolas,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.list .me { font-weight:600; }
.runs .open > .line { font-weight:600; } .runs .detail { padding:4px 4px 10px 10px; } .runs .detail div { border:0; } .runs .detail .row { margin-top:6px; }
.runs .detail pre { white-space:pre-wrap; max-height:220px; overflow:auto; background:var(--bg); border-radius:6px; padding:8px; margin-top:6px; }
.mono div { font:11px/1.4 ui-monospace,"Cascadia Mono",Consolas,monospace; }
.story .tool { font-weight:600; } .story .tool.hub { color:var(--fg); }
.tc0{color:var(--tc0)} .tc1{color:var(--tc1)} .tc2{color:var(--tc2)} .tc3{color:var(--tc3)} .tc4{color:var(--tc4)} .tc5{color:var(--tc5)} .tc6{color:var(--tc6)}
.story .act { font-weight:600; } .act.send{color:var(--fg)} .act.answer{color:var(--a-answer)} .act.decide{color:var(--a-decide)} .act.fail{color:var(--a-fail)} .act.note{color:var(--muted)}
.head .live-btn { margin-left:auto; font-size:12px; padding:2px 10px; }
[class*="tone-"], .runs .line[class*="tone-"] { border-left:3px solid var(--line); padding-left:6px; }
.tone-ok, .runs .line.tone-ok { border-left-color:var(--idle); } .tone-fail, .runs .line.tone-fail { border-left-color:var(--problem); }
.tone-run, .runs .line.tone-run { border-left-color:var(--working); }
button.badge { border:0; cursor:pointer; }
.tool .parts { display:flex; gap:6px; flex-wrap:wrap; margin:2px 0; } .tool .part { font-size:11px; color:var(--muted); border:1px solid var(--line); border-radius:6px; padding:0 6px; }
.tool .part.used { color:var(--fg); border-color:var(--muted); }
/* the flow diagram, a small solar system: Agent Spaghetti the sun, the tools glassy planets in their colors (currentColor) on faint
   orbits over a dot grid; a working planet glows and its dot pulses, the sun's corona breathes while anything runs; lights travel
   along the lines the way the work goes (slower and dimmer while a result waits for its caller). SVG/CSS animation only, none when
   still or with reduced motion. */
.flow-box { width:100%; } .flow-box.fill { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; }
.flow { display:block; }
.flow .backdrop { fill:url(#flow-dots); } .flow pattern circle { fill:var(--line); }
.flow .g0 { stop-color:var(--card); } .flow .g1 { stop-color:var(--bg); }
.flow .s0 { stop-color:var(--card); } .flow .s1 { stop-color:var(--bg); }
.flow .orbit { fill:none; stroke:var(--line); stroke-width:1; stroke-dasharray:1 5; }
.flow .caption { fill:var(--muted); font-weight:600; letter-spacing:.14em; text-transform:uppercase; text-anchor:middle; }
.flow .spoke { stroke:var(--line); stroke-width:1; stroke-dasharray:2 4; fill:none; }
.flow .trail { stroke:currentColor; stroke-width:1.6; stroke-opacity:.55; fill:none; stroke-linecap:round; filter:drop-shadow(0 0 2px currentColor); }
.flow .light { fill:currentColor; filter:drop-shadow(0 0 3px currentColor) drop-shadow(0 0 6px currentColor); }
.flow .waiting .trail { stroke-dasharray:3 5; stroke-opacity:.4; } .flow .waiting .light { opacity:.6; }
.flow .box { fill:url(#flow-glass); stroke:currentColor; stroke-opacity:.35; stroke-width:1; transition:stroke-opacity .3s; }
.flow .ear { fill:currentColor; stroke:currentColor; stroke-width:1; opacity:.45; } .flow .tip { fill:currentColor; opacity:.6; }
.flow .on .ear, .flow .on .tip { opacity:1; } .flow .on .tip { animation:flow-pulse 1.2s ease-in-out infinite; }
.flow .bar { fill:currentColor; opacity:.5; } .flow .on .bar { opacity:1; }
.flow .dot { fill:var(--line); } .flow .on .dot { fill:currentColor; animation:flow-pulse 1.2s ease-in-out infinite; }
.flow .on .box { stroke-opacity:1; stroke-width:1.4; animation:flow-glow 2s ease-in-out infinite; }
.flow .hub { color:var(--fg); }
.flow .sun { fill:url(#flow-sun); stroke:currentColor; stroke-width:1.5; stroke-opacity:.7; filter:drop-shadow(0 0 6px currentColor); }
.flow .corona { fill:none; stroke:currentColor; stroke-opacity:.18; stroke-width:4; }
.flow .hub.on .corona { animation:flow-corona 2.4s ease-in-out infinite; }
.flow text { text-anchor:start; stroke:none; } .flow .hub text { text-anchor:middle; }
.flow .name { font-weight:700; fill:currentColor; } .flow .uses { text-anchor:end; fill:var(--muted); letter-spacing:.08em; font-weight:600; } .flow .hub .name { fill:var(--fg); }
.flow .off { opacity:.45; } .flow .off .box { stroke-dasharray:3 3; }
.flow .what { fill:var(--muted); } .flow .on .what { fill:var(--fg); } .flow .what.next { opacity:.75; }
.flow.still * { animation:none !important; }
@keyframes flow-glow { 50% { filter:drop-shadow(0 0 6px currentColor); } }
@keyframes flow-pulse { 50% { opacity:.3; } }
@keyframes flow-corona { 50% { stroke-opacity:.45; stroke-width:7; } }
@media (prefers-reduced-motion: reduce) { .flow * { animation:none !important; } }
.flow-card { padding:4px; }
.flow-window { display:flex; flex-direction:column; height:100vh; }
.live { display:flex; flex-direction:column; height:100vh; }
.live .bar, .flow-window .bar { display:flex; gap:6px; align-items:center; padding:6px 8px; border-bottom:1px solid var(--line); background:var(--card); -webkit-app-region:drag; user-select:none; }
.live .bar .label, .flow-window .bar .label { font-weight:600; } .live .bar .grow, .flow-window .bar .grow { flex:1; }
.live .bar select, .live .bar button, .flow-window .bar button { -webkit-app-region:no-drag; width:auto; font-size:12px; padding:2px 8px; }
.live .chip { border-radius:10px; }
.live .feed { flex:1; overflow:auto; padding:4px 8px; }
.live .entry { padding:2px 0 2px 6px; margin:2px 0; }
.live .line { display:flex; gap:6px; align-items:baseline; }
.live .line .tag { flex:none; border:0; background:none; padding:0; color:var(--muted); font:inherit; }
.live .line .text { border:0; background:none; padding:0; text-align:left; font:inherit; color:inherit; white-space:pre-wrap; word-break:break-word; }
.live .line span { white-space:pre-wrap; word-break:break-word; }
.live pre { margin:4px 0 2px; padding:6px; border-radius:6px; background:var(--bg); white-space:pre-wrap; word-break:break-word; max-height:260px; overflow:auto; }
.live .empty { padding:16px 10px; }
.foot { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
`;
