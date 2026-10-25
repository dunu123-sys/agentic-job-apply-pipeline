// cdp2.mjs — raw CDP remote control (no Playwright). Node's built-in WebSocket.
// One command per call; connects to the PAGE target's WS on :9223.
//   node cdp2.mjs goto <url> | state | dump | click <text> | fill <id> <value>
//   node cdp2.mjs pick <id> <label> | check <id> <0|1> | shot <name> | eval <js>
const BASE = 'http://127.0.0.1:' + (process.env.CDP_PORT || '9223');

async function pageTarget() {
  const list = await (await fetch(BASE + '/json/list')).json();
  const want = process.env.CDP_TAB; // optional URL substring filter
  let t = want ? list.find(x => x.type === 'page' && x.url.includes(want))
               : (list.find(x => x.type === 'page' && /linkedin\.com/.test(x.url))
                  || list.find(x => x.type === 'page' && !/^chrome:/.test(x.url)));
  if (!t) throw new Error('no page target');
  return t;
}

async function cdpCall(ws, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(method + ' timeout')); }, 25000);
  });
}

const q = (s) => JSON.stringify(s);

// JS helpers injected into the page (as expression strings)
const HELPERS = `
  var __vis = (el) => el && el.offsetParent !== null;
  var __clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  var __modal = () => {
    let anchor = [...document.querySelectorAll('button')].find(b => __vis(b) && /^(next|submit application|enviar candidatura|review)/i.test(__clean(b.textContent)));
    if (!anchor) anchor = [...document.querySelectorAll('input')].find(i => __vis(i) && /@|\\d{10,}/.test(i.value || ''));
    if (!anchor) return null;
    let best = null, bestArea = 0, el = anchor.parentElement;
    for (let i = 0; i < 9 && el; i++) {
      const a = (el.offsetWidth || 0) * (el.offsetHeight || 0);
      if (el.tagName === 'DIV' && a > bestArea) { bestArea = a; best = el; }
      el = el.parentElement;
    }
    return best || document.body;
  };
`;

async function evaluate(ws, expr, awaitPromise = true) {
  const r = await cdpCall(ws, 'Runtime.evaluate', {
    expression: `${HELPERS}\n(async () => { ${expr} })()`,
    awaitPromise, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error('page-eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result.value;
}

const [, , cmd, ...args] = process.argv;
try {
  const t = await pageTarget();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws open timeout')), 10000); });
  await cdpCall(ws, 'Runtime.enable');
  await cdpCall(ws, 'Page.enable');

  if (cmd === 'goto') {
    await cdpCall(ws, 'Page.navigate', { url: args[0] });
    await new Promise(r => setTimeout(r, 3500));
    console.log(JSON.stringify({ ok: true, url: args[0].slice(0, 80) }));
  } else if (cmd === 'state') {
    console.log(JSON.stringify(await evaluate(ws, `
      const applied = /applied|candidatura enviada/i.test(document.body.innerText);
      const btns = [...document.querySelectorAll('button, a[role=button]')].filter(__vis)
        .map(b => ({ text: __clean(b.textContent).slice(0,40), aria: (b.getAttribute('aria-label')||'').slice(0,55) }))
        .filter(b => /apply|applied|save|easy|candidat/i.test(b.text + ' ' + b.aria)).slice(0,8);
      return { url: location.href.slice(0,95), title: document.title.slice(0,60), alreadyApplied: applied, buttons: btns };`)));
  } else if (cmd === 'dump') {
    console.log(JSON.stringify(await evaluate(ws, `
      const scope = __modal() || document.body;
      const fields = [...scope.querySelectorAll('input,select,textarea')].filter(__vis).map(f => {
        const lbl = f.id ? ((scope.querySelector('label[for=\"'+f.id+'\"]') || document.querySelector('label[for=\"'+f.id+'\"]'))?.textContent || '') : '';
        return { id: f.id, type: f.type, label: __clean(lbl || f.getAttribute('aria-label') || f.closest('fieldset')?.querySelector('legend')?.textContent).slice(0,95),
                 value: String(f.value||'').slice(0,42), required: f.required, checked: f.checked };
      }).slice(0,18);
      const buttons = [...scope.querySelectorAll('button')].filter(__vis)
        .map(b => ({ text: __clean(b.textContent).slice(0,42), aria: (b.getAttribute('aria-label')||'').slice(0,60), disabled: b.disabled }))
        .filter(b => b.text || b.aria).slice(0,16);
      const fieldsets = [...scope.querySelectorAll('fieldset')].filter(__vis).map(fs => ({
        q: __clean(fs.querySelector('legend')?.textContent).slice(0,130),
        optLabels: [...fs.querySelectorAll('label')].map(l => __clean(l.textContent).slice(0,42)).slice(0,8),
        checked: [...fs.querySelectorAll('input')].map(i => i.checked),
      })).filter(f => f.q).slice(0,8);
      return { modalFound: scope !== document.body, heading: __clean(scope.querySelector('h2,h3')?.textContent).slice(0,95),
               fields, fieldsets, buttons };`), null, 1));
  } else if (cmd === 'click') {
    const needle = args.join(' ').toLowerCase();
    console.log(JSON.stringify(await evaluate(ws, `
      const needle = ${q(needle)};
      const cands = [...document.querySelectorAll('button')].filter(__vis).filter(b => {
        const t = __clean(b.textContent).toLowerCase(), a = (b.getAttribute('aria-label')||'').toLowerCase();
        return t === needle || t.startsWith(needle) || t.includes(needle) || a.includes(needle);
      });
      if (!cands.length) return { clicked: false };
      cands.sort((x,y) => __clean(x.textContent).length - __clean(y.textContent).length);
      cands[0].click();
      return { clicked: __clean(cands[0].textContent) };`)));
    await new Promise(r => setTimeout(r, 2800));
  } else if (cmd === 'fill') {
    console.log(JSON.stringify(await evaluate(ws, `
      const f = document.getElementById(${q(args[0])});
      if (!f) return { filled: false };
      const set = Object.getOwnPropertyDescriptor(f.constructor.prototype, 'value').set;
      set.call(f, ${q(args.slice(1).join(' '))});
      f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, value: f.value };`)));
  } else if (cmd === 'pick') {
    console.log(JSON.stringify(await evaluate(ws, `
      const f = document.getElementById(${q(args[0])});
      if (!f) return { picked: false };
      const want = ${q(args.slice(1).join(' '))}.toLowerCase();
      const opt = [...f.options].find(o => o.value === want || __clean(o.textContent).toLowerCase().includes(want));
      if (!opt) return { picked: false, options: [...f.options].map(o => __clean(o.textContent)).slice(0,12) };
      f.value = opt.value; f.dispatchEvent(new Event('change', { bubbles: true }));
      return { picked: true, as: __clean(opt.textContent) };`)));
  } else if (cmd === 'check') {
    console.log(JSON.stringify(await evaluate(ws, `
      const f = document.getElementById(${q(args[0])});
      if (!f) return { ok: false };
      if (f.checked !== (${args[1]} === '1')) f.click();
      return { id: ${q(args[0])}, checked: f.checked };`)));
  } else if (cmd === 'shot') {
    const r = await cdpCall(ws, 'Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
    const p = `./shots/${args[0] || 'shot'}.png`;
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log(JSON.stringify({ shot: p }));
  } else if (cmd === 'opts') {
    // dump radio-group options with their per-option label text
    console.log(JSON.stringify(await evaluate(ws, `
      const scope = __modal() || document.body;
      const radios = [...scope.querySelectorAll('input[type=radio]')].filter(__vis);
      const groups = {};
      for (const r of radios) {
        const lbl = document.querySelector('label[for=\"'+r.id+'\"]')?.textContent || '';
        const g = groups[r.name] = groups[r.name] || { name: r.name, question: '', options: [] };
        g.options.push({ id: r.id, label: __clean(lbl).slice(0, 40), checked: r.checked });
      }
      for (const g of Object.values(groups)) {
        const first = document.getElementById(g.options[0].id);
        const legend = first?.closest('fieldset')?.querySelector('legend')?.textContent || '';
        const big = first?.closest('div')?.parentElement?.querySelector('label, span, p')?.textContent || '';
        g.question = __clean(legend || g.options.find(o => o.label && o.label.length > 15)?.label).slice(0, 130);
      }
      return Object.values(groups);`), null, 1));
  } else if (cmd === 'radio') {
    // radio <optionText>: match by the option's visible <p> SIBLING text (LinkedIn
    // renders option labels as a sibling div><p>, NOT in label[for])
    const needle = args.join(' ').toLowerCase();
    console.log(JSON.stringify(await evaluate(ws, `
      const needle = ${q(needle)};
      const scope = __modal() || document.body;
      const hit = [...scope.querySelectorAll('input[type=radio]')].filter(__vis).find(r => {
        const box = r.closest('div')?.parentElement;
        const txt = __clean(box?.querySelector('p, span')?.textContent).toLowerCase();
        const aria = (r.getAttribute('aria-label')||'').toLowerCase();
        const label = __clean(document.querySelector('label[for=\"'+r.id+'\"]')?.textContent).toLowerCase();
        return txt === needle || txt.startsWith(needle) || label.includes(needle) || aria.includes(needle);
      });
      if (!hit) return { clicked: false };
      hit.click();
      return { clicked: true, id: hit.id, checked: hit.checked };`)));
    await new Promise(r => setTimeout(r, 800));
  } else if (cmd === 'eval') {
    console.log(JSON.stringify(await evaluate(ws, 'return ' + args.join(' '), true), null, 1));
  } else {
    console.log(JSON.stringify({ error: 'unknown cmd ' + cmd }));
  }
  ws.close();
} catch (e) {
  console.log(JSON.stringify({ error: String(e).slice(0, 700) }));
  process.exit(1);
}
