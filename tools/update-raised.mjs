// Adds up Giving Tuesday gifts made through the GoHighLevel donation form, plus the
// offline total in offline.json (checks, staff and board gifts), and writes raised.json.
// The landing page reads raised.json to fill the meter.
// Runs in GitHub Actions (.github/workflows/raised.yml). Needs the GHL_TOKEN secret:
// a GoHighLevel Private Integration token that can only view payment transactions.
import { readFile, writeFile } from 'node:fs/promises';

const TOKEN = process.env.GHL_TOKEN;
const LOCATION = 'pcUHM2MDvoDgeO1iXSiT';            // Eden Valley Institute
// TEST_FORM_ID (optional) checks the counting against another form without saving anything.
const TEST = process.env.TEST_FORM_ID || '';
const FORM_ID = TEST || 'KsdUfOAakNQC9vXFIZuv';      // form "Giving Tuesday Donation"
const FORM_NAME = TEST ? 'no-name-match' : 'Giving Tuesday Donation';
const OUT = new URL('../raised.json', import.meta.url);
const OFFLINE = new URL('../offline.json', import.meta.url);

if (!TOKEN) { console.log('GHL_TOKEN is not set; leaving raised.json as it is.'); process.exit(0); }

async function page(offset) {
  const q = new URLSearchParams({ altId: LOCATION, altType: 'location', limit: '100', offset: String(offset) });
  const res = await fetch(`https://services.leadconnectorhq.com/payments/transactions?${q}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Version: '2021-07-28', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GoHighLevel answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Is this transaction a gift through the Giving Tuesday form?
function isGift(t) {
  const ids = [t.entitySourceId, t.entityId, t.meta?.formId, t.entitySource?.id].filter(Boolean);
  const names = [t.entitySourceName, t.entitySource?.name].filter(Boolean).join(' ');
  return ids.includes(FORM_ID) || names.includes(FORM_NAME);
}

const all = [];
for (let offset = 0; ; offset += 100) {
  const body = await page(offset);
  const list = body.data || body.transactions || [];
  all.push(...list);
  const total = Number(body.totalCount ?? body.total ?? 0);
  if (list.length < 100 || (total && all.length >= total) || offset > 20000) break;
}

const sources = {};
let online = 0, gifts = 0;
for (const t of all) {
  const src = `${t.entitySourceType || '?'} | ${t.entitySourceName || '?'} | ${t.entitySourceId || '?'}`;
  sources[src] = (sources[src] || 0) + 1;
  if (!isGift(t)) continue;
  if (TEST) console.log('  match:', JSON.stringify({ status: t.status, liveMode: t.liveMode, amount: t.amount, amountRefunded: t.amountRefunded, currency: t.currency, keys: Object.keys(t).join(',') }));
  if (t.liveMode === false) continue;              // Stripe test-mode payments
  if (!['succeeded', 'paid', 'partially_refunded'].includes(String(t.status).toLowerCase())) continue;
  const net = (Number(t.amount) || 0) - (Number(t.amountRefunded) || 0);
  if (net <= 0) continue;
  online += net; gifts += 1;
}
console.log(`Read ${all.length} transactions. Sources seen:`);
for (const [s, n] of Object.entries(sources)) console.log(`  ${n} × ${s}`);

if (TEST) { console.log(`TEST only, nothing saved: form ${TEST} has ${gifts} gifts totalling $${online.toFixed(2)}`); process.exit(0); }

let offline = 0;
try { offline = Number(JSON.parse(await readFile(OFFLINE, 'utf8')).offline) || 0; } catch {}

const out = { raised: Math.round((online + offline) * 100) / 100, online: Math.round(online * 100) / 100, offline, gifts };
let prev = {};
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
if (prev.raised === out.raised && prev.online === out.online && prev.offline === out.offline && prev.gifts === out.gifts) {
  console.log('No change:', out); process.exit(0);
}
out.updated = new Date().toISOString();
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('Wrote raised.json:', out);
