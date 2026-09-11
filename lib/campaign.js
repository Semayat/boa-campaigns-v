// lib/campaign.js — generic helpers + org-chart reference data.
// Campaigns themselves are no longer hardcoded here — any Branch, District,
// or HO can create one at runtime (see server.js). This file only holds:
// (1) auth/crypto helpers, (2) the bank's org chart (districts + sample branches).
const crypto = require('crypto');

function hash(pw, salt) { return crypto.createHmac('sha256', salt || 'boa-dts-2026').update(String(pw)).digest('hex'); }
function makeToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(body).digest('base64url');
  return body + '.' + sig;
}
function readToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(body).digest('base64url');
  if (sig !== expect) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
}
// Random temporary password for new/reset accounts — no ambiguous chars (0/O, 1/l/I)
function genPassword(len) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len || 8);
  let out = '';
  for (let i = 0; i < (len || 8); i++) out += chars[bytes[i] % chars.length];
  return out;
}
function genId(prefix) { return prefix + '_' + crypto.randomBytes(5).toString('hex'); }

// Cumulative plan to date: target / totalDays * daysElapsed (capped at totalDays)
function cumulativePlan(fullTarget, daysElapsed, totalDays) {
  const D = totalDays || 30;
  const used = Math.max(0, Math.min(daysElapsed || 0, D));
  return (fullTarget || 0) / D * used;
}

// ---- Bank org chart (independent of any campaign) ----
const DISTRICTS = [
  { id: 'central_addis', name: 'Central Addis District', branchCount: 104 },
  { id: 'east_addis',    name: 'East Addis District',    branchCount: 150 },
  { id: 'west_addis',    name: 'West Addis District',    branchCount: 128 },
  { id: 'hawassa',       name: 'Hawassa District',       branchCount: 91 },
  { id: 'jimma',         name: 'Jimma District',         branchCount: 72 },
  { id: 'dire_dawa',     name: 'Dire Dawa District',     branchCount: 77 },
  { id: 'adama',         name: 'Adama District',         branchCount: 78 },
  { id: 'bahir_dar',     name: 'Bahir Dar District',     branchCount: 121 },
  { id: 'dessie',        name: 'Dessie District',        branchCount: 94 },
  { id: 'mekelle',       name: 'Mekelle District',       branchCount: 62 },
  { id: 'digital',       name: 'Digital Banking District', branchCount: 1 },
  { id: 'int_banking',   name: 'Int. Banking Special Br.', branchCount: 1 }
];

const SAMPLE_BRANCHES = {
  central_addis: ['Piassa','Arat Kilo','Sidist Kilo','Mexico','Legehar','Churchill Avenue','Tewodros Square','National Theatre','Stadium','Meskel Square','Kazanchis','Bambis','Lideta','Kirkos','Kera','Gofa','Saris','Akaki','Kaliti','Kilinto','Koye Feche','Tulu Dimtu','Gelan','Dukem','Bishoftu','Sululta','Gotera'],
  east_addis: ['Bole','Bole Medhanialem','Bole Arabsa','Bole Bulbula','Gerji','CMC','Ayat','Summit','Megenagna','Kotebe','Kara Kore','Yeka','Wosen','Hayat','Figa','Shola','Ruwanda','Goro','Gurd Shola','Sealite Mihiret','Meri Loki','Jackros','Yeka Abado','Gerji Mebrat','Debre Berhan'],
  west_addis: ['Mercato','Kolfe','Kolfe Keranio','Ayer Tena','Tor Hailoch','Wingate','Asko','Atikilt Tera','Addis Ketema','Menalesh Tera','Coca','Anfo','Bethel','Lebu','Jemo','Jemo Michael','Alem Bank','Lafto','Mebrathail','Keraniyo','Repi','Kessemate','Tafo','Sheger City West','Sebeta','Alem Gena','Burayu','Gefersa'],
  hawassa: ['Hawassa Main','Tabor','Piazza Hawassa'],
  jimma: ['Jimma Main','Hermata','Ginjo'],
  dire_dawa: ['Dire Dawa Main','Kezira','Sabian'],
  adama: ['Adama Main','Franko','Dabe'],
  bahir_dar: ['Bahir Dar Main','Kebele 14','Tana'],
  dessie: ['Dessie Main','Piassa Dessie','Robit'],
  mekelle: ['Mekelle Main','Hadnet','Adi Haki'],
  digital: ['Digital Banking Center'],
  int_banking: ['International Banking Special Branch']
};

// The one campaign seeded at first boot, expressed through the new generic
// engine (proves the engine is genuinely generic, not special-cased).
function sampleCampaignSeed() {
  return {
    name: '4th Dare to Serve Campaign',
    initiatorLevel: 'ho',
    initiatorId: null,
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    kpis: [
      { name: 'Deposit Mobilized', unit: 'ETB', weight: 35 },
      { name: 'New Accounts (>1,000 Birr)', unit: 'count', weight: 20 },
      { name: 'Deposit from Referral', unit: 'ETB', weight: 15 },
      { name: 'HVC Conversions', unit: 'count', weight: 12 },
      { name: 'School Fee Accounts', unit: 'count', weight: 10 },
      { name: 'Field Visits', unit: 'count', weight: 8 }
    ],
    targets: { kpi0: 24010029024, kpi1: 17010, kpi2: 2401002902, kpi3: 12000, kpi4: 6000, kpi5: 90000 },
    reward: { description: 'Top districts, branches and merchant RMs receive cash rewards.', tiers: [
      { rank: '1st District', etb: 500000 }, { rank: '1st Branch', etb: 75000 }, { rank: '1st Merchant RM', etb: 30000 }
    ] }
  };
}

module.exports = { hash, makeToken, readToken, genPassword, genId, cumulativePlan, DISTRICTS, SAMPLE_BRANCHES, sampleCampaignSeed };
