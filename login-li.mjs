// One-time LinkedIn login: opens a VISIBLE browser window on the persistent
// profile. You log in manually (solve any challenge), then press ENTER here.
// The session persists in li-profile/ for all future automated runs.
import { chromium } from 'file:///F:/Hermes/hermes-agent/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import readline from 'node:readline';

const PROFILE_DIR = './profiles/li-profile';
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false, // VISIBLE — you must see and drive this
  viewport: { width: 1280, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
  locale: 'pt-BR',
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log('\nBrowser window opened at linkedin.com/login');
console.log('1. Log in with your account (solve 2FA/captcha if asked)');
console.log('2. Wait until your feed loads');
console.log('3. Come back here and press ENTER');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise(res => rl.question('press ENTER after login... ', res));
rl.close();

// persist + verify (in this SAME headed context — never headless on this profile:
// LinkedIn's bot defense invalidates the li_at session after headless activity,
// verified live 2026-10-22)
const url = page.url();
const cookies = await ctx.cookies('https://www.linkedin.com');
const liat = cookies.find(c => c.name === 'li_at');
const ok = !!liat && liat.value.length > 5 && !/authwall|login/i.test(url);
console.log('current url:', url);
console.log('li_at session cookie:', liat ? 'PRESENT ✅' : 'MISSING ❌');
console.log(ok ? '✅ session saved to li-profile/ — future runs reuse it automatically'
              : '⚠️ login did not complete — run again and make sure the FEED loads before pressing ENTER');
await ctx.close();
