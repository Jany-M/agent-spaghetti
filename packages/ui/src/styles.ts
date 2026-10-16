// The one stylesheet for the tray popover (Phase 4 app reuses it). Follows the OS light/dark setting.
export const CSS = `
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
.tabs button { border:0; background:none; border-radius:6px 6px 0 0; padding:5px 9px; color:var(--muted); border-bottom:2px solid transparent; }
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
.form label.setting { padding:6px 0; border-bottom:1px solid var(--line); } .form label.setting .name { color:var(--fg); font-weight:600; }
input, select, textarea { font:inherit; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:4px 6px; width:100%; }
textarea { resize:vertical; }
.runs .line { display:block; width:100%; text-align:left; border:0; border-bottom:1px solid var(--line); border-radius:0; background:none; padding:4px 0;
  font:11px/1.4 ui-monospace,"Cascadia Mono",Consolas,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.list .me { font-weight:600; }
.mono div { font:11px/1.4 ui-monospace,"Cascadia Mono",Consolas,monospace; }
.foot { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
`;
