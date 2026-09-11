// server.js — Campaign Management System (Bank of Abyssinia)
// Generalized engine: any Branch, District, or HO can initiate a campaign
// with its own custom KPIs, duration, and reward. The org hierarchy that
// participates depends on who initiated it. Targets always cascade from
// whoever holds them down to the next level, set by the immediate parent.
const express = require('express');
const path = require('path');
const { Store } = require('./lib/store');
const { hash, makeToken, readToken, genPassword, genId, cumulativePlan, DISTRICTS, SAMPLE_BRANCHES, sampleCampaignSeed } = require('./lib/campaign');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authFrom(req) { const h = req.headers.authorization || ''; return readToken(h.replace(/^Bearer\s+/i, '')); }

// =====================================================================
// GENERIC HELPERS
// =====================================================================
function kpiKeys(campaign) { return campaign.kpis.map((k, i) => 'kpi' + i); }
function zeroKpis(campaign) { const z = {}; kpiKeys(campaign).forEach((k) => z[k] = 0); return z; }
function sumTotals(list, keys) { const t = {}; keys.forEach((k) => t[k] = 0); list.forEach((x) => keys.forEach((k) => t[k] += (x && x[k]) || 0)); return t; }

// Entry contributes to totals only when approved.
function entryTotals(entry, keys) {
  const t = {}; keys.forEach((k) => t[k] = 0);
  if (!entry || entry.status !== 'approved') return t;
  keys.forEach((k) => t[k] = Number((entry.values && entry.values[k]) || 0));
  return t;
}
function distinctApprovedDates(entries) { return new Set(entries.filter((e) => e.status === 'approved').map((e) => e.date)).size; }

// ---- Working-days engine (off-days excluded from the plan denominator) ----
function todayStr() { return new Date().toISOString().slice(0, 10); }
function isOffDay(campaign, dateStr) { return (campaign.offDays || []).includes(dateStr); }
function allDatesInRange(startDate, endDate) {
  const out = []; let d = new Date(startDate + 'T00:00:00Z'); const end = new Date(endDate + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
function workingDaysList(campaign) { return allDatesInRange(campaign.startDate, campaign.endDate).filter((d) => !isOffDay(campaign, d)); }
function computeWorkingDays(campaign) { return Math.max(1, workingDaysList(campaign).length); }
// Working days from campaign start through (and including) a given date, capped at campaign end.
function workingDaysElapsedThrough(campaign, throughDateStr) {
  if (throughDateStr < campaign.startDate) return 0;
  const cap = throughDateStr > campaign.endDate ? campaign.endDate : throughDateStr;
  return workingDaysList(campaign).filter((d) => d <= cap).length;
}
// Working days elapsed as of today (capped to the campaign window) — the live "where should we be" figure.
function workingDaysElapsed(campaign) { return workingDaysElapsedThrough(campaign, todayStr()); }

function pctToPlan(actual, fullTarget, daysElapsed, days) {
  const plan = cumulativePlan(fullTarget, daysElapsed, days);
  return plan > 0 ? (actual / plan * 100) : 0;
}
// PACE — actual vs cumulative plan-to-date (working days), weighted by KPI weight. Capped per-KPI at 200%.
function overallPct(totals, targets, campaign, daysElapsed) {
  let s = 0, w = 0;
  const wd = campaign.workingDays || campaign.days;
  campaign.kpis.forEach((k, i) => {
    const key = 'kpi' + i, tgt = targets[key];
    if (tgt && tgt > 0) { s += Math.min(200, pctToPlan(totals[key] || 0, tgt, daysElapsed, wd)) * k.weight; w += k.weight; }
  });
  return w > 0 ? (s / w) : 0;
}
// ACHIEVED — actual vs FULL target, weighted.
function overallAchieved(totals, targets, campaign) {
  let s = 0, w = 0;
  campaign.kpis.forEach((k, i) => {
    const key = 'kpi' + i, tgt = targets[key];
    if (tgt && tgt > 0) { s += Math.min(100, (totals[key] || 0) / tgt * 100) * k.weight; w += k.weight; }
  });
  return w > 0 ? (s / w) : 0;
}
// Per-KPI pace breakdown (for color-coded display)
function perKpiPace(totals, targets, campaign, daysElapsed) {
  const wd = campaign.workingDays || campaign.days;
  return campaign.kpis.map((k, i) => {
    const key = 'kpi' + i, tgt = targets[key] || 0;
    return { key, name: k.name, unit: k.unit, weight: k.weight, actual: totals[key] || 0, target: tgt, pace: tgt > 0 ? pctToPlan(totals[key] || 0, tgt, daysElapsed, wd) : 0 };
  });
}
// Each KPI's own plan-to-date figure (used by "My Plan" and cumulative reports)
function perKpiPlan(targets, campaign, daysElapsed) {
  const wd = campaign.workingDays || campaign.days;
  return campaign.kpis.map((k, i) => {
    const key = 'kpi' + i, tgt = targets[key] || 0;
    return { key, name: k.name, unit: k.unit, plan: tgt > 0 ? cumulativePlan(tgt, daysElapsed, wd) : 0, target: tgt };
  });
}
// Monday-anchored week index (1-based), relative to the Monday of the campaign's own start week.
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z'); const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
function inWeek(dateStr, campaignStart) {
  const firstMonday = mondayOf(campaignStart);
  const diff = Math.floor((new Date(dateStr + 'T00:00:00Z') - new Date(firstMonday + 'T00:00:00Z')) / 86400000);
  return diff >= 0 ? (Math.floor(diff / 7) + 1) : 0;
}
// Last calendar date of a given Monday-anchored week number, capped at campaign end.
function weekEndDate(weekNumber, campaign) {
  const firstMonday = mondayOf(campaign.startDate);
  const d = new Date(firstMonday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (weekNumber * 7 - 1));
  const endStr = d.toISOString().slice(0, 10);
  return endStr > campaign.endDate ? campaign.endDate : endStr;
}
// Last calendar date of a given "YYYY-MM" month, capped at campaign end/start.
function monthEndDate(yearMonth, campaign) {
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
  const endStr = d.toISOString().slice(0, 10);
  return endStr > campaign.endDate ? campaign.endDate : endStr;
}

// =====================================================================
// CAMPAIGN ENGINE — scope + effective-target resolution
// =====================================================================
async function computeScope(initiatorLevel, initiatorId) {
  if (initiatorLevel === 'ho') {
    const districts = await Store.listDistricts();
    const branches = await Store.listBranches();
    return { districtIds: districts.map((d) => d.id), branchIds: branches.map((b) => b.id) };
  }
  if (initiatorLevel === 'district') {
    const branches = await Store.listBranchesByDistrict(initiatorId);
    return { districtIds: [initiatorId], branchIds: branches.map((b) => b.id) };
  }
  const b = await Store.getBranch(initiatorId);
  return { districtIds: b ? [b.districtId] : [], branchIds: [initiatorId] };
}
async function districtEffectiveTarget(campaign, districtId) {
  if (campaign.initiatorLevel === 'district' && campaign.initiatorId === districtId) return campaign.targets;
  if (campaign.initiatorLevel === 'ho') { const rec = await Store._get('target:' + campaign.id + ':district:' + districtId); return rec || zeroKpis(campaign); }
  return zeroKpis(campaign);
}
async function branchEffectiveTarget(campaign, branchId) {
  if (campaign.initiatorLevel === 'branch' && campaign.initiatorId === branchId) return campaign.targets;
  const rec = await Store._get('target:' + campaign.id + ':branch:' + branchId);
  return rec || zeroKpis(campaign);
}
async function staffEffectiveTarget(campaign, branchId, staffId, activeStaffCount) {
  const rec = await Store._get('target:' + campaign.id + ':staff:' + branchId + ':' + staffId);
  if (rec) return rec;
  const bt = await branchEffectiveTarget(campaign, branchId);
  const n = Math.max(1, activeStaffCount || 1);
  const out = {}; Object.keys(bt).forEach((k) => out[k] = (bt[k] || 0) / n);
  return out;
}
function validateSum(children, parentTarget, keys) {
  const sums = {}; keys.forEach((k) => sums[k] = 0);
  children.forEach((c) => keys.forEach((k) => sums[k] += Number(c.values[k]) || 0));
  const perKpi = keys.map((k) => ({ key: k, sum: sums[k], target: parentTarget[k] || 0, matches: Math.abs(sums[k] - (parentTarget[k] || 0)) < 0.01 }));
  return { ok: perKpi.every((x) => x.matches), perKpi };
}

// =====================================================================
// NOTIFICATIONS
// =====================================================================
async function notify(recipientKey, message, meta) {
  const id = genId('nt');
  await Store._set('notif:' + recipientKey + ':' + id, { id, message, meta: meta || {}, createdAt: new Date().toISOString(), read: false });
}
async function notifyMany(recipientKeys, message, meta) { for (const k of recipientKeys) await notify(k, message, meta); }

// =====================================================================
// LOGIN
// =====================================================================
app.post('/api/login', async (req, res) => {
  let { role, scopeId, username, password } = req.body || {};
  if (typeof password === 'string') password = password.trim();
  if (typeof username === 'string') username = username.trim();
  if (!role || !password) return res.status(400).json({ error: 'Missing role or password' });
  const h = hash(password);

  if (role === 'ho') {
    const a = await Store.getHOAuth();
    if (!a || h !== a.passwordHash) return res.status(401).json({ error: 'Wrong password' });
    return res.json({ token: makeToken({ role: 'ho' }), role: 'ho', name: 'Head Office', mustChangePassword: !!a.mustChangePassword });
  }
  if (role === 'district') {
    const d = await Store.getDistrict(scopeId);
    if (!d || !d.auth) return res.status(404).json({ error: 'District not found' });
    if (h !== d.auth.passwordHash) return res.status(401).json({ error: 'Wrong password' });
    return res.json({ token: makeToken({ role: 'district', scopeId }), role: 'district', name: d.name, mustChangePassword: !!d.auth.mustChangePassword });
  }
  if (role === 'branch') {
    const b = await Store.getBranch(scopeId);
    if (!b || !b.auth) return res.status(404).json({ error: 'Branch not found' });
    if (h !== b.auth.passwordHash) return res.status(401).json({ error: 'Wrong password' });
    return res.json({ token: makeToken({ role: 'branch', scopeId, districtId: b.districtId }), role: 'branch', name: b.name, districtId: b.districtId, mustChangePassword: !!b.auth.mustChangePassword });
  }
  if (role === 'staff') {
    if (!scopeId || !username) return res.status(400).json({ error: 'Missing branch or username' });
    const b = await Store.getBranch(scopeId);
    if (!b) return res.status(404).json({ error: 'Branch not found' });
    const st = (b.staff || []).find((s) => s.active !== false && s.username.toLowerCase() === username.toLowerCase());
    if (!st) return res.status(401).json({ error: 'Staff ID/name not found, or access deactivated' });
    if (h !== st.passwordHash) return res.status(401).json({ error: 'Wrong password' });
    return res.json({ token: makeToken({ role: 'staff', staffId: st.id, scopeId: b.id, districtId: b.districtId }), role: 'staff', name: st.name, branchName: b.name, districtId: b.districtId, mustChangePassword: !!st.mustChangePassword });
  }
  if (role === 'officer') {
    if (!scopeId || !username) return res.status(400).json({ error: 'Missing district or username' });
    const officers = await Store._list('officer:' + scopeId + ':');
    const of = officers.find((o) => o.active !== false && o.username.toLowerCase() === username.toLowerCase());
    if (!of) return res.status(401).json({ error: 'Officer ID/name not found, or access deactivated' });
    if (h !== of.passwordHash) return res.status(401).json({ error: 'Wrong password' });
    const d = await Store.getDistrict(scopeId);
    return res.json({ token: makeToken({ role: 'officer', officerId: of.id, scopeId }), role: 'officer', name: of.name, districtName: d ? d.name : '', mustChangePassword: !!of.mustChangePassword });
  }
  return res.status(400).json({ error: 'Unknown role' });
});

// ---------- PUBLIC DIRECTORY ----------
app.get('/api/directory', async (req, res) => {
  const districts = await Store.listDistricts();
  const branches = await Store.listBranches();
  res.json({
    districts: districts.map((d) => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name)),
    branches: branches.map((b) => ({ id: b.id, name: b.name, districtId: b.districtId })).sort((a, b) => a.name.localeCompare(b.name))
  });
});

// =====================================================================
// /api/data — one endpoint, action-dispatched
// =====================================================================
app.all('/api/data', async (req, res) => {
  const session = authFrom(req);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  const action = req.query.action || '';

  // ---------------- PASSWORD: self-service change (any role) ----------------
  if (action === 'changeMyPassword') {
    const { password } = req.body || {};
    if (!password || String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const ph = hash(password);
    if (session.role === 'ho') {
      await Store.setHOAuth({ passwordHash: ph, mustChangePassword: false });
    } else if (session.role === 'district') {
      const d = await Store.getDistrict(session.scopeId); d.auth = { passwordHash: ph, mustChangePassword: false }; await Store.setDistrict(d);
    } else if (session.role === 'branch') {
      const b = await Store.getBranch(session.scopeId); b.auth = { passwordHash: ph, mustChangePassword: false }; await Store.setBranch(b);
    } else if (session.role === 'staff') {
      const b = await Store.getBranch(session.scopeId); const st = (b.staff || []).find((s) => s.id === session.staffId);
      if (!st) return res.status(404).json({ error: 'Staff record not found' });
      st.passwordHash = ph; st.mustChangePassword = false; await Store.setBranch(b);
    } else if (session.role === 'officer') {
      const of = await Store._get('officer:' + session.scopeId + ':' + session.officerId);
      if (!of) return res.status(404).json({ error: 'Officer record not found' });
      of.passwordHash = ph; of.mustChangePassword = false; await Store._set('officer:' + session.scopeId + ':' + session.officerId, of);
    } else return res.status(403).json({ error: 'Unknown role' });
    return res.json({ ok: true });
  }

  // ---------------- PASSWORD: hierarchical reset ----------------
  if (action === 'resetDistrictPassword') {
    if (session.role !== 'ho') return res.status(403).json({ error: 'HO only' });
    const { districtId } = req.body || {};
    const d = await Store.getDistrict(districtId); if (!d) return res.status(404).json({ error: 'District not found' });
    const pw = genPassword(8); d.auth = { passwordHash: hash(pw), mustChangePassword: true }; await Store.setDistrict(d);
    await notify('district:' + districtId, 'Your password was reset by Head Office.', { kind: 'password_reset' });
    return res.json({ ok: true, generatedPassword: pw });
  }
  if (action === 'resetBranchPassword') {
    if (session.role !== 'district') return res.status(403).json({ error: 'District only' });
    const { branchId } = req.body || {};
    const b = await Store.getBranch(branchId); if (!b || b.districtId !== session.scopeId) return res.status(404).json({ error: 'Branch not found' });
    const pw = genPassword(8); b.auth = { passwordHash: hash(pw), mustChangePassword: true }; await Store.setBranch(b);
    await notify('branch:' + branchId, 'Your password was reset by your District.', { kind: 'password_reset' });
    return res.json({ ok: true, generatedPassword: pw });
  }

  // ---------------- STAFF MANAGEMENT (branch) ----------------
  if (action === 'addStaff') {
    if (session.role !== 'branch') return res.status(403).json({ error: 'Branch only' });
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name or ID number is required' });
    const branch = await Store.getBranch(session.scopeId); branch.staff = branch.staff || [];
    if (branch.staff.some((s) => s.username.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A staff member with this name/ID already exists' });
    const pw = genPassword(8);
    const st = { id: genId('stf'), name, username: name, passwordHash: hash(pw), mustChangePassword: true, active: true, addedAt: new Date().toISOString() };
    branch.staff.push(st); await Store.setBranch(branch);
    return res.json({ ok: true, staff: { id: st.id, name: st.name, active: st.active, mustChangePassword: st.mustChangePassword }, generatedPassword: pw });
  }
  if (action === 'listStaff') {
    const branchId = session.role === 'branch' ? session.scopeId : req.query.branchId;
    if (session.role === 'staff' || session.role === 'officer') return res.status(403).json({ error: 'Forbidden' });
    const branch = await Store.getBranch(branchId); if (!branch) return res.status(404).json({ error: 'Branch not found' });
    if (session.role === 'district' && branch.districtId !== session.scopeId) return res.status(403).json({ error: 'Forbidden' });
    return res.json({ staff: (branch.staff || []).map((s) => ({ id: s.id, name: s.name, active: s.active !== false, mustChangePassword: !!s.mustChangePassword })) });
  }
  if (action === 'resetStaffPassword') {
    if (session.role !== 'branch') return res.status(403).json({ error: 'Branch only' });
    const { staffId } = req.body || {};
    const branch = await Store.getBranch(session.scopeId); const st = (branch.staff || []).find((s) => s.id === staffId);
    if (!st) return res.status(404).json({ error: 'Staff not found' });
    const pw = genPassword(8); st.passwordHash = hash(pw); st.mustChangePassword = true; await Store.setBranch(branch);
    await notify('staff:' + session.scopeId + ':' + staffId, 'Your password was reset by your branch manager.', { kind: 'password_reset' });
    return res.json({ ok: true, generatedPassword: pw });
  }
  if (action === 'setStaffActive') {
    if (session.role !== 'branch') return res.status(403).json({ error: 'Branch only' });
    const { staffId, active } = req.body || {};
    const branch = await Store.getBranch(session.scopeId); const st = (branch.staff || []).find((s) => s.id === staffId);
    if (!st) return res.status(404).json({ error: 'Staff not found' });
    st.active = !!active; await Store.setBranch(branch);
    return res.json({ ok: true });
  }

  // ---------------- DISTRICT OFFICER MANAGEMENT (district) ----------------
  if (action === 'addOfficer') {
    if (session.role !== 'district') return res.status(403).json({ error: 'District only' });
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name or ID number is required' });
    const existing = await Store._list('officer:' + session.scopeId + ':');
    if (existing.some((o) => o.username.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'An officer with this name/ID already exists' });
    const pw = genPassword(8);
    const of = { id: genId('ofc'), districtId: session.scopeId, name, username: name, passwordHash: hash(pw), mustChangePassword: true, active: true, branchIds: [], addedAt: new Date().toISOString() };
    await Store._set('officer:' + session.scopeId + ':' + of.id, of);
    return res.json({ ok: true, officer: { id: of.id, name: of.name, active: of.active, branchIds: of.branchIds }, generatedPassword: pw });
  }
  if (action === 'listOfficers') {
    if (session.role !== 'district') return res.status(403).json({ error: 'District only' });
    const officers = await Store._list('officer:' + session.scopeId + ':');
    return res.json({ officers: officers.map((o) => ({ id: o.id, name: o.name, active: o.active !== false, mustChangePassword: !!o.mustChangePassword, branchIds: o.branchIds || [] })) });
  }
  if (action === 'setOfficerBranches') {
    if (session.role !== 'district') return res.status(403).json({ error: 'District only' });
    const { officerId, branchIds } = req.body || {};
    const of = await Store._get('officer:' + session.scopeId + ':' + officerId); if (!of) return res.status(404).json({ error: 'Officer not found' });
    const validIds = await Store.listBranchesByDistrict(session.scopeId);
    const validSet = new Set(validIds.map((b) => b.id));
    of.branchIds = (Array.isArray(branchIds) ? branchIds : []).filter((id) => validSet.has(id));
    await Store._set('officer:' + session.scopeId + ':' + officerId, of);
    await notify('officer:' + session.scopeId + ':' + officerId, 'Your assigned branches were updated.', { kind: 'scope_change' });
    return res.json({ ok: true, branchIds: of.branchIds });
  }
  if (action === 'resetOfficerPassword') {
    if (session.role !== 'district') return res.status(403).json({ error: 'District only' });
    const { officerId } = req.body || {};
    const of = await Store._get('officer:' + session.scopeId + ':' + officerId); if (!of) return res.status(404).json({ error: 'Officer not found' });
    const pw = genPassword(8); of.passwordHash = hash(pw); of.mustChangePassword = true; await Store._set('officer:' + session.scopeId + ':' + officerId, of);
    return res.json({ ok: true, generatedPassword: pw });
  }
  if (action === 'setOfficerActive') {
    if (session.role !== 'district') return res.status(403).json({ error: 'District only' });
    const { officerId, active } = req.body || {};
    const of = await Store._get('officer:' + session.scopeId + ':' + officerId); if (!of) return res.status(404).json({ error: 'Officer not found' });
    of.active = !!active; await Store._set('officer:' + session.scopeId + ':' + officerId, of);
    return res.json({ ok: true });
  }

  // ---------------- CAMPAIGNS ----------------
  if (action === 'createCampaign') {
    if (!['ho', 'district', 'branch'].includes(session.role)) return res.status(403).json({ error: 'Only HO, District, or Branch can start a campaign' });
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const kpis = Array.isArray(b.kpis) ? b.kpis : [];
    if (!name) return res.status(400).json({ error: 'Campaign name is required' });
    if (!kpis.length) return res.status(400).json({ error: 'At least one KPI is required' });
    const totalWeight = kpis.reduce((s, k) => s + (Number(k.weight) || 0), 0);
    if (Math.abs(totalWeight - 100) > 0.5) return res.status(400).json({ error: 'KPI weights must total 100% (currently ' + totalWeight + '%)' });
    if (!b.startDate || !b.endDate) return res.status(400).json({ error: 'Start and end date are required' });
    if (b.endDate < b.startDate) return res.status(400).json({ error: 'End date must be after start date' });
    const days = Math.max(1, Math.round((new Date(b.endDate) - new Date(b.startDate)) / 86400000) + 1);
    const offDays = Array.isArray(b.offDays) ? Array.from(new Set(b.offDays)).filter((d) => d >= b.startDate && d <= b.endDate) : [];
    const targets = {}; kpis.forEach((k, i) => targets['kpi' + i] = Number((b.targets || {})['kpi' + i]) || 0);
    const initiatorId = session.role === 'ho' ? null : session.scopeId;
    const scope = await computeScope(session.role, initiatorId);
    const campaign = {
      id: genId('camp'), name,
      initiatorLevel: session.role, initiatorId,
      scope,
      kpis: kpis.map((k) => ({ name: String(k.name || '').trim(), unit: (k.unit === 'ETB' ? 'ETB' : 'count'), weight: Number(k.weight) || 0 })),
      startDate: b.startDate, endDate: b.endDate, days, offDays,
      targets,
      reward: b.reward && (b.reward.description || (b.reward.tiers || []).length) ? { description: String(b.reward.description || ''), tiers: Array.isArray(b.reward.tiers) ? b.reward.tiers : [] } : null,
      createdAt: new Date().toISOString(), createdBy: { role: session.role, id: initiatorId }
    };
    campaign.workingDays = computeWorkingDays(campaign);
    await Store._set('campaign:' + campaign.id, campaign);
    // notify one level down
    if (session.role === 'ho') await notifyMany(scope.districtIds.map((id) => 'district:' + id), 'New Head Office campaign: "' + name + '"', { kind: 'campaign_created', campaignId: campaign.id });
    else if (session.role === 'district') await notifyMany(scope.branchIds.map((id) => 'branch:' + id), 'Your district started a new campaign: "' + name + '"', { kind: 'campaign_created', campaignId: campaign.id });
    else { const br = await Store.getBranch(initiatorId); (br.staff || []).filter((s) => s.active !== false).forEach(() => {}); await notifyMany((br.staff || []).filter((s) => s.active !== false).map((s) => 'staff:' + initiatorId + ':' + s.id), 'Your branch started a new campaign: "' + name + '"', { kind: 'campaign_created', campaignId: campaign.id }); }
    return res.json({ ok: true, campaign });
  }

  if (action === 'listCampaigns') {
    const all = await Store._list('campaign:');
    let mine = [];
    if (session.role === 'ho') mine = all.filter((c) => c.initiatorLevel !== 'branch'); // HO oversees HO+District campaigns, not local branch ones
    else if (session.role === 'district') mine = all.filter((c) => c.scope.districtIds.includes(session.scopeId));
    else if (session.role === 'branch') mine = all.filter((c) => c.scope.branchIds.includes(session.scopeId));
    else if (session.role === 'staff') mine = all.filter((c) => c.scope.branchIds.includes(session.scopeId));
    else if (session.role === 'officer') { const of = await Store._get('officer:' + session.scopeId + ':' + session.officerId); const bIds = (of && of.branchIds) || []; mine = all.filter((c) => c.scope.branchIds.some((id) => bIds.includes(id))); }
    mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ campaigns: mine.map((c) => ({ id: c.id, name: c.name, initiatorLevel: c.initiatorLevel, initiatorId: c.initiatorId, startDate: c.startDate, endDate: c.endDate, days: c.days, workingDays: c.workingDays || c.days, offDays: c.offDays || [], kpis: c.kpis, reward: c.reward, mine: (session.role === c.initiatorLevel && (c.initiatorId === (session.scopeId || null))) })) });
  }

  if (action === 'getCampaign') {
    const c = await Store._get('campaign:' + (req.query.campaignId || ''));
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    return res.json({ campaign: c });
  }

  // ---------------- TARGET CASCADING ----------------
  if (action === 'setDistrictTargets') {
    if (session.role !== 'ho') return res.status(403).json({ error: 'HO only' });
    const { campaignId, rows } = req.body || {};
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (c.initiatorLevel !== 'ho') return res.status(400).json({ error: 'Only HO-initiated campaigns have a district-level breakdown' });
    const keys = kpiKeys(c);
    const saved = [];
    for (const r of (rows || [])) {
      if (!c.scope.districtIds.includes(r.districtId)) continue;
      const values = {}; keys.forEach((k) => values[k] = Number(r[k]) || 0);
      await Store._set('target:' + campaignId + ':district:' + r.districtId, values);
      saved.push({ districtId: r.districtId, values });
      await notify('district:' + r.districtId, 'Your target for "' + c.name + '" has been set.', { kind: 'target_set', campaignId });
    }
    const check = validateSum(saved.map((s) => ({ values: s.values })), c.targets, keys);
    return res.json({ ok: true, saved: saved.length, validation: check });
  }
  if (action === 'setBranchTargets') {
    if (session.role !== 'district') return res.status(403).json({ error: 'District only' });
    const { campaignId, rows } = req.body || {};
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (!c.scope.districtIds.includes(session.scopeId)) return res.status(403).json({ error: 'Your district is not part of this campaign' });
    const keys = kpiKeys(c);
    const myBranches = (await Store.listBranchesByDistrict(session.scopeId)).map((b) => b.id);
    const saved = [];
    for (const r of (rows || [])) {
      if (!myBranches.includes(r.branchId)) continue;
      const values = {}; keys.forEach((k) => values[k] = Number(r[k]) || 0);
      await Store._set('target:' + campaignId + ':branch:' + r.branchId, values);
      saved.push({ branchId: r.branchId, values });
      await notify('branch:' + r.branchId, 'Your target for "' + c.name + '" has been set.', { kind: 'target_set', campaignId });
    }
    const myTarget = await districtEffectiveTarget(c, session.scopeId);
    const check = validateSum(saved.map((s) => ({ values: s.values })), myTarget, keys);
    return res.json({ ok: true, saved: saved.length, validation: check, myTarget });
  }
  if (action === 'setStaffTargets') {
    if (session.role !== 'branch') return res.status(403).json({ error: 'Branch only' });
    const { campaignId, rows } = req.body || {};
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (!c.scope.branchIds.includes(session.scopeId)) return res.status(403).json({ error: 'Your branch is not part of this campaign' });
    const keys = kpiKeys(c);
    const branch = await Store.getBranch(session.scopeId);
    const staffIds = (branch.staff || []).map((s) => s.id);
    const saved = [];
    for (const r of (rows || [])) {
      if (!staffIds.includes(r.staffId)) continue;
      const values = {}; keys.forEach((k) => values[k] = Number(r[k]) || 0);
      await Store._set('target:' + campaignId + ':staff:' + session.scopeId + ':' + r.staffId, values);
      saved.push({ staffId: r.staffId, values });
      await notify('staff:' + session.scopeId + ':' + r.staffId, 'Your target for "' + c.name + '" has been set.', { kind: 'target_set', campaignId });
    }
    const myTarget = await branchEffectiveTarget(c, session.scopeId);
    const check = validateSum(saved.map((s) => ({ values: s.values })), myTarget, keys);
    return res.json({ ok: true, saved: saved.length, validation: check, myTarget });
  }
  // Read current breakdown + running-sum status for the "set targets" screens
  if (action === 'targetsView') {
    const { campaignId, level } = req.query;
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const keys = kpiKeys(c);
    if (level === 'district') {
      if (session.role !== 'ho') return res.status(403).json({ error: 'HO only' });
      const rows = []; for (const id of c.scope.districtIds) { const d = await Store.getDistrict(id); const t = await districtEffectiveTarget(c, id); rows.push({ id, name: d.name, values: t }); }
      return res.json({ campaign: c, keys, parentTarget: c.targets, rows });
    }
    if (level === 'branch') {
      if (session.role !== 'district') return res.status(403).json({ error: 'District only' });
      const branches = await Store.listBranchesByDistrict(session.scopeId);
      const rows = []; for (const b of branches) { if (!c.scope.branchIds.includes(b.id)) continue; const t = await branchEffectiveTarget(c, b.id); rows.push({ id: b.id, name: b.name, values: t }); }
      const parentTarget = await districtEffectiveTarget(c, session.scopeId);
      return res.json({ campaign: c, keys, parentTarget, rows });
    }
    if (level === 'staff') {
      if (session.role !== 'branch') return res.status(403).json({ error: 'Branch only' });
      const branch = await Store.getBranch(session.scopeId);
      const activeStaff = (branch.staff || []).filter((s) => s.active !== false);
      const rows = []; for (const s of activeStaff) { const t = await staffEffectiveTarget(c, session.scopeId, s.id, activeStaff.length); rows.push({ id: s.id, name: s.name, values: t }); }
      const parentTarget = await branchEffectiveTarget(c, session.scopeId);
      return res.json({ campaign: c, keys, parentTarget, rows });
    }
    return res.status(400).json({ error: 'Unknown level' });
  }

  // ---------------- STAFF ENTRY (campaign-scoped) ----------------
  if (action === 'submitEntry') {
    if (session.role !== 'staff') return res.status(403).json({ error: 'Only staff submit daily entries' });
    const { campaignId, date, values, visits, remark } = req.body || {};
    if (!campaignId || !date || !values) return res.status(400).json({ error: 'Missing campaign, date, or values' });
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (!c.scope.branchIds.includes(session.scopeId)) return res.status(403).json({ error: 'Your branch is not part of this campaign' });
    const branch = await Store.getBranch(session.scopeId);
    const staffRec = (branch.staff || []).find((s) => s.id === session.staffId);
    if (!staffRec || staffRec.active === false) return res.status(403).json({ error: 'Your access has been deactivated' });
    const visitList = Array.isArray(visits) ? visits.filter((v) => v && (v.account || v.customer)) : [];
    const vals = Object.assign({}, values);
    const entry = { campaignId, branchId: session.scopeId, districtId: session.districtId, staffId: session.staffId, staffName: staffRec.name, date, values: vals, visits: visitList, remark: remark || '', status: 'pending', rejectReason: '', submittedAt: new Date().toISOString() };
    await Store._set('entry:' + campaignId + ':' + session.scopeId + ':' + session.staffId + ':' + date, entry);
    return res.json({ ok: true, entry });
  }
  if (action === 'myEntries') {
    if (session.role !== 'staff') return res.status(403).json({ error: 'Staff only' });
    const campaignId = req.query.campaignId;
    const all = await Store._list('entry:' + campaignId + ':' + session.scopeId + ':');
    const mine = all.filter((e) => e.staffId === session.staffId).sort((a, b) => a.date < b.date ? 1 : -1);
    return res.json({ entries: mine });
  }
  if (action === 'staffView') {
    if (session.role !== 'staff') return res.status(403).json({ error: 'Staff only' });
    const campaignId = req.query.campaignId;
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const keys = kpiKeys(c);
    const branch = await Store.getBranch(session.scopeId);
    const staffRec = (branch.staff || []).find((s) => s.id === session.staffId);
    const activeStaff = (branch.staff || []).filter((s) => s.active !== false);
    const all = await Store._list('entry:' + campaignId + ':' + session.scopeId + ':');
    const mine = all.filter((e) => e.staffId === session.staffId);
    const elapsed = workingDaysElapsed(c);
    const myTargets = await staffEffectiveTarget(c, session.scopeId, session.staffId, activeStaff.length);
    const totals = sumTotals(mine.map((e) => entryTotals(e, keys)), keys);
    const pendingCount = mine.filter((e) => e.status === 'pending').length;
    return res.json({
      staffName: staffRec ? staffRec.name : 'Staff', mustChangePassword: !!(staffRec && staffRec.mustChangePassword),
      branch: { name: branch.name, districtName: branch.districtName }, campaign: c, keys, elapsed,
      targets: myTargets, totals, pendingCount,
      perKpi: perKpiPace(totals, myTargets, c, elapsed),
      pct: overallPct(totals, myTargets, c, elapsed), achieved: overallAchieved(totals, myTargets, c)
    });
  }

  // ---------------- APPROVALS (branch) ----------------
  if (action === 'pendingApprovals') {
    if (session.role !== 'branch') return res.status(403).json({ error: 'Branch only' });
    const campaignId = req.query.campaignId;
    const all = await Store._list('entry:' + campaignId + ':' + session.scopeId + ':');
    const pending = all.filter((e) => e.status === 'pending').sort((a, b) => a.date < b.date ? 1 : -1);
    const c = await Store._get('campaign:' + campaignId);
    return res.json({ pending, keys: c ? kpiKeys(c) : [], kpis: c ? c.kpis : [] });
  }
  if (action === 'decideApproval') {
    if (session.role !== 'branch') return res.status(403).json({ error: 'Branch only' });
    const { campaignId, staffId, date, decision, reason } = req.body || {};
    if (!campaignId || !staffId || !date || !['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Missing or invalid fields' });
    const key = 'entry:' + campaignId + ':' + session.scopeId + ':' + staffId + ':' + date;
    const entry = await Store._get(key); if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.status !== 'pending') return res.status(409).json({ error: 'Already reviewed' });
    entry.status = decision === 'approve' ? 'approved' : 'rejected';
    entry.rejectReason = decision === 'reject' ? String(reason || '').trim() : '';
    entry.decidedAt = new Date().toISOString();
    await Store._set(key, entry);
    if (decision === 'reject') await notify('staff:' + session.scopeId + ':' + staffId, 'Your submission for ' + date + ' was rejected' + (entry.rejectReason ? (': ' + entry.rejectReason) : '.'), { kind: 'entry_rejected', campaignId });
    return res.json({ ok: true, entry });
  }

  // ---------------- BRANCH DASHBOARD (campaign-scoped) ----------------
  if (action === 'branchView') {
    if (session.role === 'staff') return res.status(403).json({ error: 'Use staffView' });
    const campaignId = req.query.campaignId;
    const branchId = session.role === 'branch' ? session.scopeId : req.query.branchId;
    if (!branchId || !campaignId) return res.status(400).json({ error: 'Missing branchId or campaignId' });
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const branch = await Store.getBranch(branchId); if (!branch) return res.status(404).json({ error: 'Branch not found' });
    if (session.role === 'district' && branch.districtId !== session.scopeId) return res.status(403).json({ error: 'Forbidden' });
    if (session.role === 'officer') { const of = await Store._get('officer:' + session.scopeId + ':' + session.officerId); if (!of || !(of.branchIds || []).includes(branchId)) return res.status(403).json({ error: 'Not assigned to this branch' }); }
    const keys = kpiKeys(c);
    const entries = await Store._list('entry:' + campaignId + ':' + branchId + ':');
    const elapsed = workingDaysElapsed(c);
    const targets = await branchEffectiveTarget(c, branchId);
    const totals = sumTotals(entries.map((e) => entryTotals(e, keys)), keys);
    const activeStaff = (branch.staff || []).filter((s) => s.active !== false);
    const nStaff = Math.max(1, activeStaff.length);
    const byStaff = {};
    entries.filter((e) => e.status === 'approved').forEach((e) => {
      if (!byStaff[e.staffId]) byStaff[e.staffId] = { name: e.staffName, t: {}, dates: new Set() };
      keys.forEach((k) => byStaff[e.staffId].t[k] = (byStaff[e.staffId].t[k] || 0) + Number((e.values && e.values[k]) || 0));
      byStaff[e.staffId].dates.add(e.date);
    });
    const officers = []; for (const id of Object.keys(byStaff)) { const rec = byStaff[id]; const st = await staffEffectiveTarget(c, branchId, id, activeStaff.length); officers.push({ name: rec.name, totals: rec.t, pct: overallPct(rec.t, st, c, rec.dates.size), achieved: overallAchieved(rec.t, st, c) }); }
    officers.sort((a, b) => b.pct - a.pct);
    const visitsAll = []; entries.filter((e) => e.status === 'approved').forEach((e) => (e.visits || []).forEach((v) => visitsAll.push(Object.assign({ date: e.date, staff: e.staffName }, v))));
    return res.json({
      branch, campaign: c, keys, elapsed, targets, totals,
      perKpi: perKpiPace(totals, targets, c, elapsed),
      pct: overallPct(totals, targets, c, elapsed), achieved: overallAchieved(totals, targets, c),
      entries: entries.filter((e) => e.status === 'approved').sort((a, b) => a.date < b.date ? 1 : -1),
      officers, visits: visitsAll, staffCount: activeStaff.length
    });
  }

  // ---------------- DISTRICT DASHBOARD (campaign-scoped) ----------------
  if (action === 'districtView') {
    const campaignId = req.query.campaignId;
    const districtId = session.role === 'district' ? session.scopeId : req.query.districtId;
    if (!districtId || !campaignId) return res.status(400).json({ error: 'Missing districtId or campaignId' });
    if (session.role === 'district' && districtId !== session.scopeId) return res.status(403).json({ error: 'Forbidden' });
    if (session.role === 'branch' || session.role === 'staff') return res.status(403).json({ error: 'Forbidden' });
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (!c.scope.districtIds.includes(districtId)) return res.status(404).json({ error: 'This district is not part of this campaign' });
    const keys = kpiKeys(c);
    const elapsed = workingDaysElapsed(c);
    const district = await Store.getDistrict(districtId);
    const branches = (await Store.listBranchesByDistrict(districtId)).filter((b) => c.scope.branchIds.includes(b.id));
    const branchRows = [];
    const offMap = {};
    for (const b of branches) {
      const ent = await Store._list('entry:' + campaignId + ':' + b.id + ':');
      const totals = sumTotals(ent.map((e) => entryTotals(e, keys)), keys);
      const targets = await branchEffectiveTarget(c, b.id);
      branchRows.push({ id: b.id, name: b.name, type: b.type || 'Standard', supportOfficer: b.supportOfficer || '', totals, targets, pct: overallPct(totals, targets, c, elapsed), achieved: overallAchieved(totals, targets, c), reportedDays: distinctApprovedDates(ent) });
      const branchRec = await Store.getBranch(b.id); const activeStaff = (branchRec.staff || []).filter((s) => s.active !== false);
      ent.filter((e) => e.status === 'approved').forEach((e) => {
        const key = e.staffId + '@' + b.id;
        if (!offMap[key]) offMap[key] = { name: e.staffName, branch: b.name, t: {}, dates: new Set(), branchId: b.id, staffId: e.staffId, activeCount: activeStaff.length };
        keys.forEach((k) => offMap[key].t[k] = (offMap[key].t[k] || 0) + Number((e.values && e.values[k]) || 0));
        offMap[key].dates.add(e.date);
      });
    }
    branchRows.sort((a, b) => b.pct - a.pct);
    const officerRows = []; for (const o of Object.values(offMap)) { const st = await staffEffectiveTarget(c, o.branchId, o.staffId, o.activeCount); officerRows.push({ name: o.name, branch: o.branch, totals: o.t, pct: overallPct(o.t, st, c, elapsed), achieved: overallAchieved(o.t, st, c) }); }
    officerRows.sort((a, b) => b.pct - a.pct);
    const groups = {}; branchRows.forEach((b) => { const g = b.supportOfficer || 'Unassigned'; if (!groups[g]) groups[g] = { name: g, branches: 0, totals: {}, targets: {} }; groups[g].branches++; keys.forEach((k) => { groups[g].totals[k] = (groups[g].totals[k] || 0) + (b.totals[k] || 0); groups[g].targets[k] = (groups[g].targets[k] || 0) + (b.targets[k] || 0); }); });
    const groupRows = Object.values(groups).map((g) => ({ name: g.name, branches: g.branches, totals: g.totals, pct: overallPct(g.totals, g.targets, c, elapsed), achieved: overallAchieved(g.totals, g.targets, c) }));
    const distTargets = await districtEffectiveTarget(c, districtId);
    const distTotals = sumTotals(branchRows.map((b) => b.totals), keys);
    return res.json({ district, campaign: c, keys, elapsed, distTotals, distTargets, perKpi: perKpiPace(distTotals, distTargets, c, elapsed), distPct: overallPct(distTotals, distTargets, c, elapsed), distAchieved: overallAchieved(distTotals, distTargets, c), branchRows, officerRows, groupRows });
  }

  // ---------------- HO DASHBOARD (campaign-scoped) ----------------
  if (action === 'hoView') {
    if (session.role !== 'ho') return res.status(403).json({ error: 'HO only' });
    const campaignId = req.query.campaignId;
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const keys = kpiKeys(c);
    const allEntries = await Store._list('entry:' + campaignId + ':');
    const elapsed = workingDaysElapsed(c);
    const natTotals = sumTotals(allEntries.map((e) => entryTotals(e, keys)), keys);
    const districtRows = [];
    for (const id of c.scope.districtIds) {
      const d = await Store.getDistrict(id);
      const dEnt = allEntries.filter((e) => e.districtId === id);
      const totals = sumTotals(dEnt.map((e) => entryTotals(e, keys)), keys);
      const targets = await districtEffectiveTarget(c, id);
      districtRows.push({ id, name: d.name, totals, targets, pct: overallPct(totals, targets, c, elapsed), achieved: overallAchieved(totals, targets, c), reportedBranches: new Set(dEnt.filter((e) => e.status === 'approved').map((e) => e.branchId)).size });
    }
    districtRows.sort((a, b) => b.pct - a.pct);
    const branchRows = [];
    for (const bId of c.scope.branchIds) {
      const b = await Store.getBranch(bId); const ent = allEntries.filter((e) => e.branchId === bId);
      const totals = sumTotals(ent.map((e) => entryTotals(e, keys)), keys); const targets = await branchEffectiveTarget(c, bId);
      branchRows.push({ id: bId, name: b.name, district: b.districtName, totals, pct: overallPct(totals, targets, c, elapsed), achieved: overallAchieved(totals, targets, c) });
    }
    const topBranches = branchRows.filter((b) => b.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 20);
    const offMap = {};
    for (const bId of c.scope.branchIds) {
      const b = await Store.getBranch(bId); const activeStaff = (b.staff || []).filter((s) => s.active !== false);
      allEntries.filter((e) => e.branchId === bId && e.status === 'approved').forEach((e) => {
        const key = e.staffId + '@' + bId;
        if (!offMap[key]) offMap[key] = { name: e.staffName, branch: b.name, t: {}, dates: new Set(), branchId: bId, staffId: e.staffId, activeCount: activeStaff.length };
        keys.forEach((k) => offMap[key].t[k] = (offMap[key].t[k] || 0) + Number((e.values && e.values[k]) || 0));
        offMap[key].dates.add(e.date);
      });
    }
    const officerRows = []; for (const o of Object.values(offMap)) { const st = await staffEffectiveTarget(c, o.branchId, o.staffId, o.activeCount); officerRows.push({ name: o.name, branch: o.branch, totals: o.t, pct: overallPct(o.t, st, c, o.dates.size), achieved: overallAchieved(o.t, st, c) }); }
    officerRows.sort((a, b) => b.pct - a.pct);
    return res.json({
      campaign: c, keys, elapsed,
      national: { totals: natTotals, targets: c.targets, perKpi: perKpiPace(natTotals, c.targets, c, elapsed), pct: overallPct(natTotals, c.targets, c, elapsed), achieved: overallAchieved(natTotals, c.targets, c), totalBranches: c.scope.branchIds.length, reportedBranches: new Set(allEntries.filter((e) => e.status === 'approved').map((e) => e.branchId)).size },
      districtRows, branchRows: topBranches, officerRows: officerRows.slice(0, 20)
    });
  }

  // ---------------- REPORTS (campaign-scoped) ----------------
  if (action === 'report') {
    if (session.role === 'staff' || session.role === 'officer') return res.status(403).json({ error: 'Reports are available to Branch, District and HO' });
    const campaignId = req.query.campaignId;
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const keys = kpiKeys(c);
    const period = req.query.period || 'monthly'; const week = parseInt(req.query.week || '0', 10); const day = req.query.day || ''; const month = req.query.month || '';
    let allEntries, title, scopeTarget;
    if (session.role === 'branch') { allEntries = await Store._list('entry:' + campaignId + ':' + session.scopeId + ':'); const b = await Store.getBranch(session.scopeId); title = b.name; scopeTarget = await branchEffectiveTarget(c, session.scopeId); }
    else if (session.role === 'district') { allEntries = (await Store._list('entry:' + campaignId + ':')).filter((e) => e.districtId === session.scopeId); const d = await Store.getDistrict(session.scopeId); title = d.name; scopeTarget = await districtEffectiveTarget(c, session.scopeId); }
    else { allEntries = await Store._list('entry:' + campaignId + ':'); title = 'National'; scopeTarget = c.targets; }
    const approved = allEntries.filter((e) => e.status === 'approved');
    const dates = Array.from(new Set(approved.map((e) => e.date))).sort();

    // as-of date for this period selection (cumulative always runs from campaign start through here)
    let asOfDate = todayStr() > c.endDate ? c.endDate : todayStr();
    let periodEntries = approved;
    if (period === 'daily') { const d = day || (dates.length ? dates[dates.length - 1] : c.startDate); asOfDate = d; periodEntries = approved.filter((e) => e.date === d); }
    else if (period === 'weekly') { const w = week || inWeek(asOfDate, c.startDate); asOfDate = weekEndDate(w, c); periodEntries = approved.filter((e) => inWeek(e.date, c.startDate) === w); }
    else if (period === 'monthly') { const ym = month || asOfDate.slice(0, 7); asOfDate = monthEndDate(ym, c); periodEntries = approved.filter((e) => e.date.slice(0, 7) === ym); }
    // 'grand' uses the full campaign as-of today/end, periodEntries = everything (no extra filter)

    const periodTotals = sumTotals(periodEntries.map((e) => entryTotals(e, keys)), keys);
    const cumulativeEntries = approved.filter((e) => e.date <= asOfDate);
    const cumulativeTotals = sumTotals(cumulativeEntries.map((e) => entryTotals(e, keys)), keys);
    const elapsedThrough = workingDaysElapsedThrough(c, asOfDate);

    const byDate = {}; periodEntries.forEach((e) => { const t = entryTotals(e, keys); if (!byDate[e.date]) { byDate[e.date] = {}; keys.forEach((k) => byDate[e.date][k] = 0); } keys.forEach((k) => byDate[e.date][k] += t[k]); });
    const trend = Object.keys(byDate).sort().map((d) => ({ date: d, totals: byDate[d] }));

    return res.json({
      title, period, week, day, month, asOfDate, kpis: c.kpis, keys,
      totals: periodTotals, trend, days: c.days, workingDays: c.workingDays || c.days, dates, campaignName: c.name,
      cumulative: {
        totals: cumulativeTotals, target: scopeTarget,
        perKpi: perKpiPace(cumulativeTotals, scopeTarget, c, elapsedThrough),
        pct: overallPct(cumulativeTotals, scopeTarget, c, elapsedThrough),
        achieved: overallAchieved(cumulativeTotals, scopeTarget, c),
        plan: perKpiPlan(scopeTarget, c, elapsedThrough)
      }
    });
  }

  // ---------------- MY PLAN (branch & staff — daily/weekly/monthly/grand plan breakdown) ----------------
  if (action === 'myPlan') {
    if (!['branch', 'staff'].includes(session.role)) return res.status(403).json({ error: 'Branch and Staff only' });
    const campaignId = req.query.campaignId;
    const c = await Store._get('campaign:' + campaignId); if (!c) return res.status(404).json({ error: 'Campaign not found' });
    let targets;
    if (session.role === 'branch') targets = await branchEffectiveTarget(c, session.scopeId);
    else { const branch = await Store.getBranch(session.scopeId); const activeStaff = (branch.staff || []).filter((s) => s.active !== false); targets = await staffEffectiveTarget(c, session.scopeId, session.staffId, activeStaff.length); }
    const wd = c.workingDays || c.days;
    const today = todayStr() > c.endDate ? c.endDate : todayStr();
    const weekNum = inWeek(today, c.startDate);
    const monthKey = today.slice(0, 7);
    const dailyPerKpi = c.kpis.map((k, i) => { const key = 'kpi' + i, tgt = targets[key] || 0; const perDay = wd > 0 ? tgt / wd : 0; return { key, name: k.name, unit: k.unit, plan: isOffDay(c, today) ? 0 : perDay }; });
    const weeklyElapsed = workingDaysElapsedThrough(c, weekEndDate(weekNum, c));
    const monthlyElapsed = workingDaysElapsedThrough(c, monthEndDate(monthKey, c));
    return res.json({
      campaign: c, targets,
      daily: dailyPerKpi,
      weekly: perKpiPlan(targets, c, weeklyElapsed),
      monthly: perKpiPlan(targets, c, monthlyElapsed),
      grand: c.kpis.map((k, i) => ({ key: 'kpi' + i, name: k.name, unit: k.unit, plan: targets['kpi' + i] || 0 }))
    });
  }

  // ---------------- AUDIT / FEEDBACK (district officers) ----------------
  if (action === 'officerBranches') {
    if (session.role !== 'officer') return res.status(403).json({ error: 'Officer only' });
    const of = await Store._get('officer:' + session.scopeId + ':' + session.officerId); if (!of) return res.status(404).json({ error: 'Officer record not found' });
    const campaignId = req.query.campaignId;
    const c = campaignId ? await Store._get('campaign:' + campaignId) : null;
    const rows = [];
    for (const bId of (of.branchIds || [])) {
      const b = await Store.getBranch(bId); if (!b) continue;
      let pct = null, achieved = null;
      if (c && c.scope.branchIds.includes(bId)) {
        const keys = kpiKeys(c);
        const ent = await Store._list('entry:' + campaignId + ':' + bId + ':');
        const totals = sumTotals(ent.map((e) => entryTotals(e, keys)), keys);
        const targets = await branchEffectiveTarget(c, bId);
        pct = overallPct(totals, targets, c, workingDaysElapsed(c)); achieved = overallAchieved(totals, targets, c);
      }
      rows.push({ id: b.id, name: b.name, districtId: b.districtId, pct, achieved, needsJustification: pct != null && pct < 35 });
    }
    return res.json({ officerName: of.name, mustChangePassword: !!of.mustChangePassword, branches: rows });
  }
  if (action === 'postFeedback') {
    if (session.role !== 'officer') return res.status(403).json({ error: 'Officer only' });
    const { branchId, staffId, campaignId, period, message } = req.body || {};
    if (!branchId || !message) return res.status(400).json({ error: 'Missing branch or message' });
    const of = await Store._get('officer:' + session.scopeId + ':' + session.officerId);
    if (!of || !(of.branchIds || []).includes(branchId)) return res.status(403).json({ error: 'Not assigned to this branch' });
    const b = await Store.getBranch(branchId);
    const fb = {
      id: genId('fb'), districtId: session.scopeId, officerId: session.officerId, officerName: of.name,
      branchId, branchName: b.name, staffId: staffId || null, staffName: staffId ? ((b.staff || []).find((s) => s.id === staffId) || {}).name : null,
      campaignId: campaignId || null, period: period || null, createdAt: new Date().toISOString(),
      thread: [{ by: 'officer', name: of.name, message: String(message).trim(), at: new Date().toISOString() }]
    };
    await Store._set('feedback:' + session.scopeId + ':' + fb.id, fb);
    const recipient = staffId ? ('staff:' + branchId + ':' + staffId) : ('branch:' + branchId);
    await notify(recipient, 'New feedback from your district officer' + (staffId ? '' : ' on branch performance') + '.', { kind: 'feedback', feedbackId: fb.id, districtId: session.scopeId });
    return res.json({ ok: true, feedback: fb });
  }
  if (action === 'replyFeedback') {
    if (!['branch', 'staff'].includes(session.role)) return res.status(403).json({ error: 'Branch or Staff only' });
    const { feedbackId, districtId, message } = req.body || {};
    if (!feedbackId || !districtId || !message) return res.status(400).json({ error: 'Missing fields' });
    const fb = await Store._get('feedback:' + districtId + ':' + feedbackId); if (!fb) return res.status(404).json({ error: 'Feedback not found' });
    if (session.role === 'branch' && fb.branchId !== session.scopeId) return res.status(403).json({ error: 'Forbidden' });
    if (session.role === 'staff' && (fb.branchId !== session.scopeId || fb.staffId !== session.staffId)) return res.status(403).json({ error: 'Forbidden' });
    const name = session.role === 'branch' ? fb.branchName : fb.staffName;
    fb.thread.push({ by: session.role, name, message: String(message).trim(), at: new Date().toISOString() });
    await Store._set('feedback:' + districtId + ':' + feedbackId, fb);
    await notify('officer:' + districtId + ':' + fb.officerId, 'Reply received on your feedback to ' + fb.branchName + '.', { kind: 'feedback_reply', feedbackId });
    return res.json({ ok: true, feedback: fb });
  }
  if (action === 'listFeedback') {
    let items = [];
    if (session.role === 'officer') items = (await Store._list('feedback:' + session.scopeId + ':')).filter((f) => f.officerId === session.officerId);
    else if (session.role === 'district') items = await Store._list('feedback:' + session.scopeId + ':');
    else if (session.role === 'branch') items = (await Store._list('feedback:' + session.districtId + ':')).filter((f) => f.branchId === session.scopeId);
    else if (session.role === 'staff') items = (await Store._list('feedback:' + session.districtId + ':')).filter((f) => f.branchId === session.scopeId && (f.staffId === session.staffId || !f.staffId));
    else return res.status(403).json({ error: 'Forbidden' });
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ feedback: items });
  }

  // ---------------- NOTIFICATIONS ----------------
  if (action === 'listNotifications') {
    let key;
    if (session.role === 'ho') key = 'ho';
    else if (session.role === 'district') key = 'district:' + session.scopeId;
    else if (session.role === 'branch') key = 'branch:' + session.scopeId;
    else if (session.role === 'staff') key = 'staff:' + session.scopeId + ':' + session.staffId;
    else if (session.role === 'officer') key = 'officer:' + session.scopeId + ':' + session.officerId;
    const items = await Store._list('notif:' + key + ':');
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ notifications: items.slice(0, 50), unread: items.filter((n) => !n.read).length });
  }
  if (action === 'markNotificationRead') {
    let key;
    if (session.role === 'ho') key = 'ho';
    else if (session.role === 'district') key = 'district:' + session.scopeId;
    else if (session.role === 'branch') key = 'branch:' + session.scopeId;
    else if (session.role === 'staff') key = 'staff:' + session.scopeId + ':' + session.staffId;
    else if (session.role === 'officer') key = 'officer:' + session.scopeId + ':' + session.officerId;
    const { notifId } = req.body || {};
    const fullKey = 'notif:' + key + ':' + notifId;
    const n = await Store._get(fullKey); if (n) { n.read = true; await Store._set(fullKey, n); }
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
});

// =====================================================================
// SEED / BOOT
// =====================================================================
async function runSeed(reset) {
  // Org chart (districts + sample branches) — independent of any campaign.
  for (const d of DISTRICTS) {
    const cur = await Store.getDistrict(d.id);
    await Store.setDistrict({
      id: d.id, name: d.name, branchCount: d.branchCount,
      auth: (cur && cur.auth && !reset) ? cur.auth : { passwordHash: hash((process.env.DISTRICT_PASSWORD || 'BoA-District') + '-' + d.id), mustChangePassword: false }
    });
  }
  let count = 0; const TYPES = ['Standard', 'Corporate', 'Premium'];
  for (const d of DISTRICTS) {
    const names = SAMPLE_BRANCHES[d.id] || []; let ti = 0;
    for (const nm of names) {
      const id = d.id + '__' + nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const cur = await Store.getBranch(id);
      await Store.setBranch({
        id, name: nm, districtId: d.id, districtName: d.name,
        type: (cur && cur.type) || TYPES[ti++ % 3],
        supportOfficer: (cur && cur.supportOfficer) || '',
        auth: (cur && cur.auth && !reset) ? cur.auth : { passwordHash: hash(process.env.BRANCH_PASSWORD || 'BoA-Branch-2026'), mustChangePassword: false },
        staff: (cur && cur.staff) || []
      });
      count++;
    }
  }
  const curHO = await Store.getHOAuth();
  if (!curHO || reset) await Store.setHOAuth({ passwordHash: hash(process.env.HO_PASSWORD || 'BoA-HO-2026'), mustChangePassword: false });
  // Seed one sample HO campaign so a fresh deploy isn't empty.
  const existingCampaigns = await Store._list('campaign:');
  if (!existingCampaigns.length || reset) {
    const seed = sampleCampaignSeed();
    const scope = await computeScope('ho', null);
    const campaign = {
      id: 'camp_sample_dts', name: seed.name, initiatorLevel: 'ho', initiatorId: null, scope,
      kpis: seed.kpis, startDate: seed.startDate, endDate: seed.endDate,
      days: Math.max(1, Math.round((new Date(seed.endDate) - new Date(seed.startDate)) / 86400000) + 1),
      offDays: [],
      targets: seed.targets, reward: seed.reward, createdAt: new Date().toISOString(), createdBy: { role: 'ho', id: null }
    };
    campaign.workingDays = computeWorkingDays(campaign);
    await Store._set('campaign:' + campaign.id, campaign);
  }
  return { districts: DISTRICTS.length, branches: count };
}
app.get('/api/seed', async (req, res) => {
  if (process.env.SEED_TOKEN && req.query.token !== process.env.SEED_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const out = await runSeed(req.query.reset === '1');
  res.json({ ok: true, ...out });
});

const PORT = process.env.PORT || 3000;
async function boot() { await Store.init(); const r = await runSeed(false); console.log('Seed ready:', r); }
if (require.main === module) {
  boot().then(() => app.listen(PORT, () => console.log('Campaign Management System running on :' + PORT))).catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}
module.exports = { app, boot, runSeed };
