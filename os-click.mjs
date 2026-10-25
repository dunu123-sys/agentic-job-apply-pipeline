// os-click.mjs — full-automation InfoJobs click: compute a DOM element's
// SCREEN coordinates via CDP, then click it with a REAL OS-level mouse event
// (os-mouse.ps1, user32.dll) so it passes the HUMAN/PerimeterX initiation gate.
//   CDP_PORT=9224 node os-click.mjs "<jsSelectorExpr>"
import { execFile } from 'node:child_process';

const BASE = 'http://127.0.0.1:' + (process.env.CDP_PORT || '9224');
const PS = './os-mouse.ps1';
const sel = process.argv[2];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(BASE + '/json/list')).json();
const t = list.find(x => x.type === 'page' && /infojobs/.test(x.url));
if (!t) { console.log(JSON.stringify({ error: 'no infojobs tab' })); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let seq = 0;
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(method)) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { ws.removeEventListener('message', on); rej(new Error(method + ' timeout')); }, 25000);
});
const evalIn = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

// 1) viewport coords of the target + window frame info
const geo = await evalIn(`{ const el = (${sel}); if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 350)); // let scroll settle
  const q = el.getBoundingClientRect();
  return { x: q.x + q.width / 2, y: q.y + q.height / 2, w: q.width, h: q.height,
           screenX: window.screenX, screenY: window.screenY,
           outerW: window.outerWidth, outerH: window.outerHeight,
           innerW: window.innerWidth, innerH: window.innerHeight,
           cssScreenWidth: window.screen.width }; }`);
if (!geo) { console.log(JSON.stringify({ error: 'element not found' })); process.exit(1); }

// 1b) EXACT outer window bounds via CDP (physical px) — no guessing chrome offsets
// CRITICAL: a maximized window makes JS outer==inner (border math collapses to 0)
// and CDP bounds go stale — clicks silently land on the wrong screen spot.
// Normalize the window to a known windowed state FIRST.
const normalize = async () => {
  const w = await call('Browser.getWindowForTarget', {});
  const g = await evalIn(`return { iw: window.innerWidth, ow: window.outerWidth, ih: window.innerHeight, oh: window.outerHeight };`);
  if (w.bounds.windowState !== 'normal' || Math.abs(g.ow - g.iw) < 2 || Math.abs(g.oh - g.ih) < 2) {
    await call('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal', left: 10, top: 10, width: 945, height: 1020 } });
    await sleep(700);
  }
  return (await call('Browser.getWindowForTarget', {})).bounds;
};
const wb = await normalize();
const geo2 = await evalIn(`return { innerW: window.innerWidth, innerH: window.innerHeight };`);
const leftBorder = Math.max(0, Math.round((wb.width - geo2.innerW) / 2));
const chromeTop = Math.max(0, wb.height - geo2.innerH - leftBorder);
const exactScreenX = Math.round(wb.left + leftBorder + geo.x);
const exactScreenY = Math.round(wb.top + chromeTop + geo.y);

// 2) DPI scale: physical desktop width vs the CSS screen width the browser reports
const scaleOut = await new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -TypeDefinition \'"0000" | Out-Null;\' -ErrorAction SilentlyContinue; ' +
    'Add-Type @"\\nusing System.Runtime.InteropServices;\\npublic class SM { [DllImport(\\"user32.dll\\")] public static extern int GetSystemMetrics(int n); }\\n"@; ' +
    '[SM]::GetSystemMetrics(0)'], { timeout: 15000 }, (e, stdout) => resolve(e ? null : parseInt(stdout.trim())));
});
const dpiScale = scaleOut && geo.cssScreenWidth ? scaleOut / geo.cssScreenWidth : 1;

// 3) viewport -> screen: window origin + frame chrome border estimate
const borderX = Math.max(0, Math.round((geo.outerW - geo.innerW) / 2));
const chromeY = Math.max(0, geo.outerH - geo.innerH - borderX); // title+tabs+bookmarks above viewport
const screenX = Math.round(exactScreenX * dpiScale);
const screenY = Math.round(exactScreenY * dpiScale);
console.log(JSON.stringify({ outerWindow: wb, leftBorder, chromeTop, exact: { x: exactScreenX, y: exactScreenY } }));

console.log(JSON.stringify({ viewport: { x: Math.round(geo.x), y: Math.round(geo.y) },
  frame: { borderX, chromeY }, dpiScale, screen: { x: screenX, y: screenY } }));

// 4) REAL OS-level click via PowerShell (human-like path included)
const clickOut = await new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS,
    '-X', String(screenX), '-Y', String(screenY)], { timeout: 30000 },
    (e, stdout, stderr) => resolve({ ok: !e, out: (stdout || '').trim(), err: (stderr || '').trim().slice(0, 150) }));
});
console.log(JSON.stringify(clickOut));
await sleep(3000);
ws.close();
