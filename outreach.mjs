// Outreach: extract contact info from stored JDs, build tailored messages,
// and send via WAHA (WhatsApp) / email. Every send is logged in the ledger.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

// ---- extraction -----------------------------------------------------------
const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_JUNK = /example|sentry|wix|test@|no-?reply|donotreply|linkedin\.com|infojobs|sentry\.io|@2x|\.png|\.jpg|\.webp|schema\.org|w3\.org/i;
// Brazilian phones: +55 11 00000-0000 | (11) 00000-0000 | 11 000000000 | 00000000000
const PHONE_RX = /(?:\+?55\s?)?\(?\b([1-9]{2})\)?\s?9?\s?([4-9]\d{3})-?\s?(\d{4})\b/g;
const WA_LINK_RX = /(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\+?\d{8,15})/i;

export function extractContacts(text = '') {
  const t = String(text);
  const out = { contact_email: null, contact_phone: null, contact_whatsapp: null };

  // whatsapp: strongest signal is a wa.me link
  const wl = t.match(WA_LINK_RX);
  if (wl) {
    let n = wl[1].replace(/\D/g, '');
    if (n.length <= 11) n = '55' + n; // missing country code -> BR
    out.contact_whatsapp = n;
  }

  // email: first non-junk address (prefer recruiting-looking ones)
  const emails = [...new Set((t.match(EMAIL_RX) || []).map(e => e.toLowerCase().trim()))]
    .filter(e => !EMAIL_JUNK.test(e));
  const pref = emails.find(e => /(rh|recrut|vaga|job|carreira|talento|curricul|cvs?|selecao|people|hr|contato)/.test(e));
  out.contact_email = pref || emails[0] || null;

  // phone: only when the word whatsapp/whats/zap or telefone/contato is near,
  // or when a wa.me link already confirmed a number
  const phones = [...new Set((t.match(PHONE_RX) || []).map(m => m[0]))];
  if (out.contact_whatsapp || /(whats|zap|telefone|contato|ligue|fale com)/i.test(t)) {
    if (phones.length && !out.contact_whatsapp) {
      const digits = phones[0].replace(/\D/g, '');
      out.contact_whatsapp = digits.startsWith('55') ? digits : '55' + digits;
    }
    if (phones.length) {
      const d = phones[0].replace(/\D/g, '');
      out.contact_phone = d.startsWith('55') ? d : '55' + d;
    }
  }
  return out;
}

// ---- message building ------------------------------------------------------
const CV = 'Currículo em anexo (link sob pedido)';

export function buildMessage(job) {
  const first = 'Olá! Vi a vaga de ' + (job.title || 'desenvolvedor') +
    (job.company ? ' na ' + job.company : '') + ' e tenho muito interesse.';
  const match = 'Tenho experiência sólida com C#, .NET, SQL Server e Python — automação de ' +
    'processos, integrações de dados e dashboards (Power BI), atuando tanto em backend quanto no suporte a sistemas corporativos.';
  const fit = ' Acho que meu perfil conversa bem com o que a vaga pede.';
  const close = ' Segue meu currículo; ficarei feliz em conversar. Obrigado! ' +
    '— ' + (process.env.CANDIDATE_NAME || 'Example Candidate') + ', ' + (process.env.CANDIDATE_LOCATION || 'São Paulo SP') + '.';
  return (first + fit + ' ' + match + close).replace(/\s+/g, ' ').trim();
}

// ---- send: WhatsApp (WAHA) -------------------------------------------------
export function wahaBase() {
  // key lives in the compose file; read at runtime, never log
  const y = fs.readFileSync(process.env.WAHA_COMPOSE || './waha/docker-compose.yml', 'utf8');
  const k = (y.match(/WAHA_API_KEY=\s*(\S+)/) || [])[1];
  return { url: 'http://127.0.0.1:3000/api', key: (k || '').replace(/["']/g, '') };
}

export async function sendWhatsapp(to, text, session = 'Session_1') {
  const { url, key } = wahaBase();
  const chatId = String(to).replace(/\D/g, '') + '@c.us';
  const res = await fetch(url + '/sendText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify({ session, chatId, text }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
}

// ---- ledger logging --------------------------------------------------------
export function logOutreach(db, source, source_id, channel, detail) {
  db.prepare(`UPDATE jobs SET outreach_status=?, outreach_channels=COALESCE(outreach_channels,'')||?, outreach_at=? WHERE source=? AND source_id=?`)
    .run(channel, (channel + ';'), new Date().toISOString(), source, source_id);
}
