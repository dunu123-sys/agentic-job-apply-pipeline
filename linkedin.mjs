// LinkedIn discovery + detail extraction via the public guest endpoints (no login).
// Verified on this host 2026-10-20: search 10 cards/page, start= N paginates cleanly,
// f_AL=true returns the Easy-Apply subset, f_TPR=r604800 = past week.
// Pace 2-5s/request — the endpoint 429s after ~10 rapid hits from one IP.

import { chromium } from 'file:///F:/Hermes/hermes-agent/node_modules/playwright/index.mjs';

const GUEST_SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const GUEST_JOB = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function makeBrowser() {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ userAgent: UA, locale: 'pt-BR', extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' } });
  return { b, ctx };
}

export async function searchOnce(ctx, params) {
  const url = GUEST_SEARCH + '?' + new URLSearchParams(params).toString();
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    return await p.evaluate(() => {
      const out = [];
      for (const c of document.querySelectorAll('.base-card')) {
        const urn = c.getAttribute('data-entity-urn') || '';
        const id = urn.replace(/.*:/, '');
        if (!id) continue;
        out.push({
          id,
          title: c.querySelector('.base-search-card__title')?.textContent?.trim() || null,
          company: c.querySelector('.base-search-card__subtitle .hidden-nested-link')?.textContent?.trim()
            || c.querySelector('h4')?.textContent?.trim() || null,
          location: c.querySelector('.job-search-card__location')?.textContent?.trim() || null,
          posted: c.querySelector('time')?.getAttribute('datetime') || null,
          url: c.querySelector('.base-card__full-link')?.href?.split('?')[0] || null,
        });
      }
      return out;
    });
  } catch { return []; }
  finally { await p.close(); }
}

// Discover across (query x page x {plain, easyApply}) and return a map id -> job.
export async function discover(ctx, queries, filters, pacingMs) {
  const byId = new Map();
  let reqs = 0, hits = 0;
  for (const q of queries) {
    const pages = q.pages || 1;
    for (let page = 0; page < pages; page++) {
      for (const ea of [false, true]) {
        const params = { keywords: q.keywords, location: q.location, start: page * 10 };
        Object.assign(params, filters);
        if (ea) params.f_AL = 'true';
        const cards = await searchOnce(ctx, params);
        reqs++;
        for (const c of cards) {
          const prev = byId.get(c.id);
          if (prev) {
            if (ea) prev.easy_apply = 1;
          } else {
            byId.set(c.id, {
              source: 'linkedin', source_id: c.id, url: c.url, title: c.title, company: c.company,
              location: c.location, posted_date: c.posted,
              easy_apply: ea ? 1 : null,
              apply_method: ea ? 'easy_apply' : null,
              found_by: [q.keywords + (ea ? ' [EA]' : '')],
            });
            hits++;
          }
        }
        await sleep(pacingMs);
      }
    }
  }
  return { jobs: [...byId.values()], requests: reqs, unique: byId.size };
}

// Detail pass: description + criteria + title from the jobPosting fragment.
export async function enrich(ctx, jobIds, pacingMs) {
  const out = {};
  for (const id of jobIds) {
    const p = await ctx.newPage();
    try {
      await p.goto(GUEST_JOB + id, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await p.waitForTimeout(500);
      const r = await p.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const crit = [...document.querySelectorAll('.description__job-criteria-item')]
          .map(e => clean(e.textContent)).filter(Boolean);
        // offsite apply URL lives in <code id="applyUrl"> on some renders
        const au = document.querySelector('code#applyUrl');
        let applyUrl = null;
        if (au) { const m = (au.textContent || '').match(/url=([^"&]+)/); applyUrl = m ? decodeURIComponent(m[1]) : clean(au.textContent); }
        return {
          title: clean(document.querySelector('.top-card-layout__title, .topcard__title')?.textContent) || null,
          company: clean(document.querySelector('.topcard__org-name-link, .top-card-layout__entity-url')?.textContent) || null,
          location: clean(document.querySelector('.topcard__flavor--bullet, .top-card-layout__flavor--bullet')?.textContent) || null,
          description: clean(document.querySelector('.show-more-less-html__markup, .description__text')?.textContent) || null,
          criteria: crit,
          apply_url: applyUrl,
        };
      });
      if (r.description) out[id] = r;
    } catch { /* authwall/timeout -> leave undefined */ }
    finally { await p.close(); }
    await sleep(pacingMs);
  }
  return out;
}
