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
.foot { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
`;
