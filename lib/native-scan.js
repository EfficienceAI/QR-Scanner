'use strict';

/**
 * The scanner's path for our own passes.
 *
 * A native pass carries "LBM:<member uuid>" in its QR. Its balance lives in
 * the members table (adjust_member_points is atomic), its visit history in
 * our own scan ledger, and after a change the phone is told to re-fetch the
 * pass over APNs. Same discipline as the PassKit path in api/loyalty.js: the
 * reply goes out first, the ledger write and the push happen after it, and
 * neither can fail a scan.
 *
 * Two bridges keep both systems in step while both run:
 *  - mirrorLegacy: a PassKit pass is scanned and that person has been
 *    imported, so their row here is set to the balance PassKit reported;
 *  - writeBack: one of our passes is scanned and that member is linked to a
 *    PassKit record, so the same earn or burn is sent to PassKit. Only where
 *    PassKit keys are configured; otherwise skipped silently.
 */

const members = require('./members');
const ledger = require('./ledger');
const apns = require('./apns');
const passkit = require('./passkit');
const gwallet = require('./gwallet');
const { after } = require('./after');
const { db: defaultDb, DbError } = require('./db');

const SOURCE_TAG = 'loyalty-scanner';

const HISTORY_LIMIT = 1000;

/**
 * How long a lookup will wait for the visit history, and no longer.
 *
 * CLAUDE.md: "the ledger must never delay or break a scan ... do not move a
 * ledger call in front of a response." A lookup has to wait for the member
 * row -- that row *is* the balance -- but the history is decoration read from
 * scan_events, which is analytics. It cannot simply be read in parallel with
 * the member row, because the query needs the PassKit id that lives on that
 * row, so it is held to a tight deadline instead: a degraded Supabase costs
 * a scan this much and no more, rather than the ledger's full 4 s default on
 * top of the member read. history() already degrades to "not recorded", so
 * the reply is complete either way -- staff see the balance and the buttons,
 * just not the visit count.
 */
const HISTORY_TIMEOUT_MS = 1200;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}
function positiveInt(value, fallback) {
  const n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function plural(n) {
  return n === 1 ? '' : 's';
}

/** Same shape the page already reads for a PassKit member. */
function summarizeMember(m) {
  return {
    id: m.id,
    externalId: m.passkit_member_id || null,
    name: m.full_name || null,
    tier: null,
    tierName: null,
    status: m.status || null,
    points: num(m.points),
    joined: m.created_at || null,
    photo: null,
    native: true,
    serial: m.pass_serial || null,
  };
}

/**
 * Visit history from our own ledger: one visit is one Add Points tap. A
 * member with no adds and no points has never bought anything; no rows but a
 * balance means the history predates the ledger (an imported member).
 */
function summarizeHistory(rows, points, meta = {}) {
  if (!Array.isArray(rows)) {
    return { recorded: false, visits: 0, lastVisit: null, firstVisitOn: null, redemptions: 0, lastRedeem: null, firstVisit: false, retentionDays: null, partial: false };
  }
  const adds = [];
  const redeems = [];
  for (const r of rows) {
    const at = Date.parse((r && r.occurred_at) || '');
    if (!Number.isFinite(at)) continue;
    if (r.action === 'add') adds.push(at);
    else if (r.action === 'redeem') redeems.push(at);
  }
  adds.sort((a, b) => b - a);
  redeems.sort((a, b) => b - a);
  const iso = (ms) => new Date(ms).toISOString();
  return {
    recorded: true,
    partial: Boolean(meta.partial),
    retentionDays: null,
    visits: adds.length,
    lastVisit: adds.length ? iso(adds[0]) : null,
    firstVisitOn: adds.length ? iso(adds[adds.length - 1]) : null,
    redemptions: redeems.length,
    lastRedeem: redeems.length ? iso(redeems[0]) : null,
    firstVisit: adds.length === 0 && num(points) === 0,
  };
}

function createHandler(deps = {}) {
  const m = deps.members || members;
  const l = deps.ledger || ledger;
  const db = deps.db || defaultDb;
  const push = deps.pushPassUpdate || apns.pushPassUpdate;
  const pk = deps.passkit || passkit;
  const gw = deps.gwallet || gwallet;
  const env = deps.env || process.env;

  async function pushQuietly(serial, log) {
    try {
      await push(serial, { log });
    } catch (err) {
      log({ warn: 'push_failed', message: err.message });
    }
  }
  function record(event, log) {
    return l.recordEvent(event, { log });
  }
  /** Send a native change on to the member's PassKit record (overlap period only). Never throws. */
  async function writeBack(member, action, points, log) {
    if (!member.passkit_member_id || !env.PASSKIT_API_KEY || !env.PASSKIT_API_SECRET) return false;
    try {
      const sign = action === 'add' ? '+' : '-';
      const details = {
        externalServiceId: SOURCE_TAG,
        notes: `Loyalty Scanner: ${sign}${points} point${points === 1 ? '' : 's'} (our pass)`,
        metaData: { source: SOURCE_TAG, action, origin: 'native' },
      };
      const r = await (action === 'add' ? pk.earnPoints : pk.burnPoints)({ id: member.passkit_member_id }, points, details);
      log({ passkit_mirror: action, points, passkitPoints: num(r && r.points) });
      return true;
    } catch (err) {
      log({ warn: 'passkit_mirror_failed', action, points, status: err.status, message: err.message });
      return false;
    }
  }
  /**
   * Everything that follows a balance change: the ledger row, the Wallet push,
   * the PassKit write-back and the Google Wallet patch.
   *
   * Call this *before* send(), and return what it gives you. Two details
   * matter and both have tests that fail if they are undone:
   *
   * - Registering before the response means the guarantee does not rest on
   *   nobody ever putting an `await` between the two statements. Four jobs
   *   across four modules ride on it, one of which makes two sequential
   *   network calls, and losing it means a Wallet pass stuck at the old
   *   balance -- the "13 points" symptom this whole path exists to fix.
   * - The work still starts *after* the reply: Promise.resolve().then defers
   *   it to a microtask, which drains once the handler has returned and
   *   res.end() has flushed.
   *
   * allSettled, not all: all rejects on the first rejection, after() catches
   * that, its promise resolves and the platform may freeze the invocation
   * while the other three jobs are still in flight. Every job happens to
   * catch its own errors today, so the two are equivalent -- but that is an
   * undocumented invariant spanning four modules, and the weakest link is
   * record(), a bare delegation whose safety is a contract written in another
   * file.
   */
  function settle(member, event, log, newBalance) {
    return after(Promise.resolve().then(() => Promise.allSettled([
      record(event, log),
      pushQuietly(member.pass_serial, log),
      writeBack(member, event.action, event.points, log),
      gw.syncAfterChange({ ...member, points: newBalance }, { log, env }),
    ])), { log });
  }
  async function history(member, log) {
    try {
      const rows = await l.listMemberEvents([member.id, member.passkit_member_id], { limit: HISTORY_LIMIT, timeoutMs: HISTORY_TIMEOUT_MS });
      return summarizeHistory(rows, member.points, { partial: rows.length >= HISTORY_LIMIT });
    } catch (err) {
      log({ warn: 'history_unavailable', message: err.message });
      return summarizeHistory(null, member.points);
    }
  }
  const invalidPoints = (res, cfg) =>
    send(res, 400, { ok: false, error: 'invalid_points', message: `points must be a whole number between 1 and ${cfg.maxPointsPerScan}.` });

  /** Handle one scanner action for the member behind an "LBM:" QR. */
  async function handle(memberId, { action, body = {}, cfg, res, requestId = null, log = () => {} }) {
    try {
      const member = await m.getById(memberId);
      if (!member) {
        log({ native: true, error: 'member_not_found' });
        return send(res, 404, { ok: false, error: 'member_not_found', message: 'No loyalty member matches this QR code.' });
      }
      if (member.status !== 'active') {
        log({ native: true, denied: 'inactive', status: member.status });
        return send(res, 403, { ok: false, error: 'member_inactive', message: 'This pass has been deactivated.', points: num(member.points) });
      }
      const base = { memberId: member.id, requestId };
      const balance = num(member.points);

      if (action === 'lookup_customer') {
        const hist = await history(member, log);
        log({ native: true, points: balance, visits: hist.visits, lastVisit: hist.lastVisit });
        const recorded = after(Promise.resolve().then(() => record({ action: 'lookup', ...base }, log)), { log });
        send(res, 200, {
          ok: true,
          action,
          points: balance,
          member: summarizeMember(member),
          history: hist,
          settings: { redeemCost: cfg.redeemCost, maxPointsPerScan: cfg.maxPointsPerScan },
        });
        return recorded;
      }

      if (action === 'add_points') {
        const points = positiveInt(body.points, 0);
        if (!points || points > cfg.maxPointsPerScan) return invalidPoints(res, cfg);
        const newBalance = await m.adjustPoints(member.id, points);
        log({ native: true, added: points, points: newBalance });
        const settled = settle(member, { action: 'add', points, ...base }, log, newBalance);
        send(res, 200, { ok: true, action, added: points, points: newBalance });
        return settled;
      }

      if (action === 'remove_points') {
        const points = positiveInt(body.points, 0);
        if (!points || points > cfg.maxPointsPerScan) return invalidPoints(res, cfg);
        if (balance < points) {
          log({ native: true, denied: 'insufficient_points', balance, remove: points });
          return send(res, 409, { ok: false, error: 'insufficient_points', message: `Customer has ${balance} point${plural(balance)}, cannot remove ${points}.`, points: balance });
        }
        const newBalance = await m.adjustPoints(member.id, -points);
        log({ native: true, removed: points, points: newBalance });
        const settled = settle(member, { action: 'remove', points, ...base }, log, newBalance);
        send(res, 200, { ok: true, action, removed: points, points: newBalance });
        return settled;
      }

      if (action === 'redeem_points') {
        const cost = cfg.redeemCost;
        const requested = positiveInt(body.points_to_remove, null);
        if (balance < cost) {
          log({ native: true, denied: 'insufficient_points', balance, cost, requested });
          return send(res, 409, { ok: false, error: 'insufficient_points', message: `Customer has ${balance} point${plural(balance)}, needs ${cost} to redeem.`, points: balance, required: cost });
        }
        const newBalance = await m.adjustPoints(member.id, -cost);
        log({ native: true, redeemed: cost, requested, points: newBalance });
        const settled = settle(member, { action: 'redeem', points: cost, ...base }, log, newBalance);
        send(res, 200, { ok: true, action, redeemed: cost, points: newBalance });
        return settled;
      }

      return send(res, 400, { ok: false, error: 'unknown_action', message: 'action must be lookup_customer, add_points, remove_points or redeem_points.' });
    } catch (err) {
      if (err instanceof members.InsufficientPointsError) {
        // The balance moved between our read and the atomic update.
        log({ native: true, denied: 'insufficient_points', raced: true });
        return send(res, 409, { ok: false, error: 'insufficient_points', message: 'Not enough points for that.' });
      }
      if (err instanceof members.NotFoundError) {
        return send(res, 404, { ok: false, error: 'member_not_found', message: 'No loyalty member matches this QR code.' });
      }
      if (err instanceof DbError) {
        log({ native: true, error: 'db', status: err.status, code: err.code, message: err.message });
        // A stall and a missing environment variable both arrive as status 0.
        // Telling staff mid-shift that the deployment is broken when Supabase
        // is merely slow sends them to the wrong place: one is retryable and
        // the other is not, so say which.
        if (err.code === 'timeout') return send(res, 503, { ok: false, error: 'db_timeout', message: 'The members database did not answer in time. Try again.', retryable: true });
        if (err.status === 0) return send(res, 503, { ok: false, error: 'not_configured', message: 'The members database is not configured on this deployment.' });
        return send(res, 502, { ok: false, error: 'db_error', message: 'The members database did not answer. Try again.' });
      }
      console.error(err);
      return send(res, 500, { ok: false, error: 'internal', message: 'Unexpected error.' });
    }
  }

  /**
   * After a PassKit scan has been answered: if that PassKit member has been
   * imported, set their row to the balance PassKit reported. Skipped when the
   * members database is not configured on this deployment. Never throws.
   */
  async function mirrorLegacy({ passkitMemberId, balance, visited = false, log = () => {} }) {
    if (!passkitMemberId || !db.enabled()) return false;
    // A balance we cannot read is not a balance. syncPoints is an absolute
    // SET, so mirroring an unreadable one would zero an imported member --
    // silently: the ledger records the action's delta, not the overwrite, so
    // the old balance cannot be reconstructed afterwards, the scan still
    // answers ok, and the zero is pushed to the customer's phone. Skipping
    // leaves their row at the last balance we did read, which is right.
    // members.readAmount, not m.readAmount: a pure predicate, not one of the
    // database calls deps.members exists to stub.
    if (members.readAmount(balance) === null) {
      log({ warn: 'mirror_skipped_unreadable_balance', passkitMemberId });
      return false;
    }
    try {
      const member = await m.findByPasskitId(passkitMemberId);
      if (!member) return false;
      await m.syncPoints(member.id, balance, { visited });
      log({ mirrored: true, member: member.id, points: num(balance) });
      await Promise.all([pushQuietly(member.pass_serial, log), gw.syncAfterChange({ ...member, points: balance }, { log, env })]);
      return true;
    } catch (err) {
      log({ warn: 'mirror_failed', message: err.message });
      return false;
    }
  }

  return { handle, mirrorLegacy };
}

const defaultHandler = createHandler();
module.exports = {
  handle: (...a) => defaultHandler.handle(...a),
  mirrorLegacy: (...a) => defaultHandler.mirrorLegacy(...a),
  createHandler,
  _internals: { summarizeMember, summarizeHistory },
};
