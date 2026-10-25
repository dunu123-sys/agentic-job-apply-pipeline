// InfoJobs discovery + detail extraction. Plain HTTP (works from this host —
// server-rendered cards; --compressed is REQUIRED or you get 0-byte responses).
// Verified 2026-10-20: empregos.aspx?palabra=X[&poblacion=5211323(São Paulo)]
// returns 20 cards; pagina= params are ignored (pagination is JS) -> keyword fanout.

const BASE = 'https://www.infojobs.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', 'Accept': 'text/html,application/xhtml+xml' },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

function decode(s) {
  return (s || '')
    .replace(/&#x27;|&#39;/g, "'").replace(/"/g, '"')
    .replace(/&/g, '&').replace(/&#x2B;/g, '+').replace(/&#xE3;|&atilde;/gi, 'ã')
    .replace(/&#xEA;|&ecirc;/gi, 'ê').replace(/&#xE1;|&aacute;/gi, 'á')
    .replace(/&#xE9;|&eacute;/gi, 'é').replace(/&#xED;|&iacute;/gi, 'í')
    .replace(/&#xF3;|&oacute;/gi, 'ó').replace(/&#xE7;|&ccedil;/gi, 'ç')
    .replace(/&#xF5;|&otilde;/gi, 'õ').replace(/&#xFA;|&uacute;/gi, 'ú')
    .replace(/&#x2F;/g, '/').replace(/\s+/g, ' ').trim();
}

// ---- search cards -------------------------------------------------------
export async function searchOnce(q) {
  const params = new URLSearchParams();
  if (q.palabra) params.set('palabra', q.palabra);
  if (q.poblacion) params.set('poblacion', String(q.poblacion));
  const html = await get(BASE + '/empregos.aspx?' + params.toString());

  const jobs = [];
  const cardRe = /<div[^>]*id="vacancy(\d+)"[^>]*data-href="([^"]+)"[^>]*>([\s\S]*?)(?=<div[^>]*id="vacancy\d+"|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>|$)/g;
  for (const m of html.matchAll(cardRe)) {
    const [, id, href, body] = m;
    const title = (body.match(/js_vacancyTitle[^>]*>([^<]+)/) || [])[1];
    const company = (body.match(/class="[^"]*js_divCompany[^"]*"[^>]*>\s*<a[^>]*>([^<]+)/) || [])[1]
      || (body.match(/class="[^"]*js_rowCard[^"]*".*?<span[^>]*>([^<]+)<\/span>/) || [])[1];
    const date = (body.match(/data-value="([\d\/]+ [\d:]+)"/) || [])[1];
    const salary = (body.match(/R\$[\s\S]{0,40}?<\//) || [])[0];
    jobs.push({
      id,
      url: BASE + decode(href),
      title: decode(title),
      company: company ? decode(company) : null,
      location: q.poblacion ? 'São Paulo - SP' : null,
      posted_date: date || null,
      salary: salary ? decode(salary.replace(/<[^>]*>/g, ' ')) : null,
    });
  }
  return jobs;
}

// ---- detail page --------------------------------------------------------
export async function detail(job) {
  const html = await get(job.url);

  // PRIMARY: JSON-LD JobPosting (verified on every InfoJobs detail page)
  let j = null;
  const ldm = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldm) { try { const p = JSON.parse(ldm[1]); if (p['@type'] === 'JobPosting') j = p; } catch {} }

  // description: take the LONGER of JSON-LD desc and the biggest HTML block
  function htmlDesc() {
    let best = '';
    for (const m of html.matchAll(/class="[^"]*white-space-pre-line[^"]*"[^>]*>([\s\S]{100,}?)<\/div>/g)) {
      const t = decode(m[1].replace(/<[^>]*>/g, ' '));
      if (t.length > best.length) best = t;
    }
    if (!best) {
      for (const m of html.matchAll(/<(?:div|p)[^>]*class="([^"]*)"[^>]*>([\s\S]{200,6000}?)<\/(?:div|p)>/g)) {
        const t = decode(m[2].replace(/<[^>]*>/g, ' '));
        if (t.length > best.length && !/cookie|parceiros/i.test(t)) best = t;
      }
    }
    return best;
  }
  const descLd = j?.description ? decode(String(j.description).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ')) : '';
  const descHtml = htmlDesc();
  const description = descHtml.length > descLd.length ? descHtml : descLd;

  const addr = j?.jobLocation?.address || {};
  const locParts = [addr.addressLocality, addr.addressRegion].filter(Boolean);
  const date = j?.datePosted ? j.datePosted.slice(0, 10) : null;

  // salary: not in JSON-LD on this page — regex the visible block
  const sal = (html.match(/(R\$\s?[\d.,]{2,12}(?:\s*a\s*R\$\s?[\d.,]{2,12})?|Sal[aá]rio a combinar)/) || [])[1];

  return {
    title: decode(j?.title) || job.title,
    company: decode(j?.hiringOrganization?.name) || job.company,
    location: job.location || (locParts.length ? locParts.join(' - ') : null),
    posted_date: job.posted_date || date,
    salary: job._salary || (sal ? decode(sal) : null),
    description,
    easy_apply: 0,
    apply_method: 'infojobs_native', // CANDIDATAR-ME → logged-in candidate profile flow
  };
}

export async function discover(queries, pacingMs) {
  const byId = new Map();
  let reqs = 0;
  for (const q of queries) {
    try {
      const cards = await searchOnce(q);
      reqs++;
      for (const c of cards) {
        if (!byId.has(c.id)) {
          byId.set(c.id, {
            source: 'infojobs', source_id: c.id, url: c.url, title: c.title,
            company: c.company, location: c.location, posted_date: c.posted_date,
            easy_apply: 0, apply_method: 'infojobs_native',
            found_by: [q.palabra + (q.poblacion ? ' @SP' : '')],
            _salary: c.salary || null,
          });
        }
      }
    } catch (e) { console.error('  infojobs search fail:', q.palabra, e.message); }
    await sleep(pacingMs);
  }
  return { jobs: [...byId.values()], requests: reqs, unique: byId.size };
}
