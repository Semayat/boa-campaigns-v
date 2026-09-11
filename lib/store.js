// lib/store.js — Postgres-backed key/value data layer.
// A single kv(key, value jsonb) table backs everything. Org-chart entities
// (districts/branches) get named helpers since they're used everywhere;
// everything newer (campaigns, targets, entries, notifications, feedback,
// district officers) is addressed directly via the generic _get/_set/_list
// so the schema can grow without touching this file.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

async function init() {
  await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
}

async function get(key) {
  const r = await pool.query('SELECT value FROM kv WHERE key=$1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function set(key, value) {
  await pool.query(
    'INSERT INTO kv(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
    [key, value]
  );
  return value;
}
async function del(key) { await pool.query('DELETE FROM kv WHERE key=$1', [key]); }
async function list(prefix) {
  const r = await pool.query('SELECT value FROM kv WHERE key LIKE $1', [prefix + '%']);
  return r.rows.map((x) => x.value);
}

const Store = {
  init,

  getDistrict: (id) => get('district:' + id),
  listDistricts: () => list('district:'),
  setDistrict: (d) => set('district:' + d.id, d),

  getBranch: (id) => get('branch:' + id),
  listBranches: () => list('branch:'),
  listBranchesByDistrict: async (districtId) =>
    (await list('branch:')).filter((b) => b.districtId === districtId),
  setBranch: (b) => set('branch:' + b.id, b),

  getHOAuth: () => get('ho:auth'),
  setHOAuth: (a) => set('ho:auth', a),

  _get: get, _set: set, _del: del, _list: list
};

module.exports = { Store };
