// real-click.mjs — real CDP mouse click at an element found by JS expression.
// Usage: CDP_TAB=<url-substring> node real-click.mjs "<jsExprReturningElement>"
// The react-dropdown-select widget only opens on TRUSTED mouse events.
const BASE = 'http://127.0.0.1:' + (process.env.CDP_PORT || '9223');
const expr = process.argv[2];

const list = await (await fetch(BASE + '/json/list')).json();
const want = process.env.CDP_TAB;
const t = want ? list.find(x => x.type === 'page' && x.url.includes(want))
               : list.find(x => x.type === 'page' && /linkedin\.com/.test(x.url));
if (!t) { console.log(JSON.stringify({ error: 'no target' })); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let seq = 0;
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(method)) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { ws.removeEventListener('message', on); rej(new Error(method + ' timeout')); }, 15000);
});
await call('Runtime.enable');
await call('Page.enable');

const r = await call('Runtime.evaluate', {
  expression: `(() => { const el = (${expr}); if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  returnByValue: true,
});
const box = r.result.value;
if (!box) { console.log(JSON.stringify({ error: 'element not found' })); process.exit(1); }
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
await new Promise(r => setTimeout(r, 120));
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 60));
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
console.log(JSON.stringify({ clicked: true, x: Math.round(box.x), y: Math.round(box.y) }));
ws.close();
