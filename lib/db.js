'use strict';

/**
 * Small PostgREST client for the members tables, using the service key.
 * (lib/ledger.js has its own minimal client for scan_events; this one is the
 * general-purpose version the native pass system uses.)
 */

class DbError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'DbError';
    this.status = status;
    this.body = body;
  }
}

function settings(env = process.env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_KEY || '';
  return { url, key, enabled: Boolean(url && key) };
}

function createDb({ fetchImpl = (...a) => fetch(...a), env = process.env, timeoutMs = 6000 } = {}) {
  async function rest(path, { method = 'GET', body, prefer, headers = {} } = {}) {
    const { url, key, enabled } = settings(env);
    if (!enabled) throw new DbError(0, 'database not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const h = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (prefer) h.Prefer = prefer;
      const resp = await fetchImpl(`${url}/rest/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      const text = await resp.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 300) };
      }
      if (!resp.ok) throw new DbError(resp.status, (data && (data.message || data.hint || data.details)) || `database ${resp.status}`, data);
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new DbError(0, 'database timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled: () => settings(env).enabled,
    rest,
    select: (table, query) => rest(`/${table}?${query}`),
    selectOne: async (table, query) => {
      const rows = await rest(`/${table}?${query}&limit=1`);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },
    insert: async (table, row) => {
      const rows = await rest(`/${table}`, { method: 'POST', body: row, prefer: 'return=representation' });
      return Array.isArray(rows) ? rows[0] : rows;
    },
    upsert: (table, rows, onConflict) => rest(`/${table}?on_conflict=${encodeURIComponent(onConflict)}`, { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=representation' }),
    update: (table, query, patch) => rest(`/${table}?${query}`, { method: 'PATCH', body: patch, prefer: 'return=representation' }),
    remove: (table, query) => rest(`/${table}?${query}`, { method: 'DELETE', prefer: 'return=minimal' }),
    rpc: (fn, args) => rest(`/rpc/${fn}`, { method: 'POST', body: args || {} }),
  };
}

const defaultDb = createDb();
module.exports = { createDb, DbError, db: defaultDb, settings };
