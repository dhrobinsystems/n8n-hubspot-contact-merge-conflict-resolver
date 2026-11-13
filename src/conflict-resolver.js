'use strict';

/**
 * n8n-hubspot-contact-merge-conflict-resolver: core decision engine.
 *
 * Pure functions only: no network or file I/O, and no n8n globals.
 * scripts/build-workflow.js embeds this file verbatim into the workflow's
 * Code nodes, so the logic that runs in n8n is the same logic the tests cover.
 */

// The merge API is pairwise. Clusters larger than one pair go to human review.
const MAX_CLUSTER_SIZE = 2;

// n8n node names. Shared with the build script and error classification.
const STAGES = {
  FETCH_TRIGGER: 'Fetch Trigger Contact',
  SEARCH: 'Search Duplicate Candidates',
  READ_CLUSTER: 'Read Cluster With History',
  BACKFILL: 'Backfill Primary Properties',
  MERGE: 'Merge Contacts',
  FETCH_MERGED: 'Fetch Merged Record',
};

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com',
]);

const ROLE_LOCAL_PARTS = new Set([
  'info', 'sales', 'support', 'admin', 'hello', 'contact', 'office', 'team',
  'billing', 'marketing', 'noreply', 'no-reply', 'hr', 'jobs', 'careers', 'accounts',
]);

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|plc|pty|sa|bv)\b/g;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function defaultConfig() {
  return {
    dryRun: true,
    sandboxMode: true,
    skipSignatureCheck: false,
    signatureMaxAgeMs: 300000,
    expectedPortalId: null,
    appId: null,
    webhookPublicUrl: null,
    maxCandidates: 10,
    watchedProperties: ['email', 'phone', 'mobilephone', 'firstname', 'lastname'],
    // Completeness weights. They add up to 100, so the score reads as a percentage.
    weights: {
      email: 20, firstname: 10, lastname: 10, phone: 10, mobilephone: 5,
      company: 10, jobtitle: 5, website: 5, address: 3, city: 3, state: 3,
      zip: 3, country: 3, lifecyclestage: 5, hubspot_owner_id: 5,
    },
    rules: {
      // Primary keeps its value. A secondary's value is used only when the primary is empty.
      fill: ['firstname', 'lastname', 'website'],
      // All-or-nothing groups. Copied only when every primary field in the group is empty.
      fieldGroups: [{ name: 'postal_address', properties: ['address', 'city', 'state', 'zip', 'country'] }],
      // The newest value wins, judged by property history timestamps.
      recency: ['phone', 'mobilephone', 'company', 'jobtitle'],
      // Differing non-empty values block auto-merge and go to review.
      review: ['hubspot_owner_id', 'hs_email_optout'],
      // Never written by this resolver. HubSpot's native merge handles these.
      never: [
        'email', 'hs_additional_emails', 'lifecyclestage', 'hs_lead_status', 'createdate',
        'lastmodifieddate', 'hs_object_id', 'hs_merged_object_ids', 'hs_email_optout', 'hubspot_owner_id',
      ],
    },
  };
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseIntInRange(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function blankToNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Build the runtime config from environment variables (n8n `$env` or `process.env`). */
function loadConfig(env) {
  const e = env || {};
  const c = defaultConfig();
  c.dryRun = parseBool(e.DRY_RUN, true);
  c.sandboxMode = parseBool(e.SANDBOX_MODE, true);
  c.skipSignatureCheck = parseBool(e.HUBSPOT_SKIP_SIGNATURE_CHECK, false);
  c.signatureMaxAgeMs = parseIntInRange(e.SIGNATURE_MAX_AGE_MS, 300000, 60000, 600000);
  c.maxCandidates = parseIntInRange(e.MAX_CANDIDATES, 10, 1, 50);
  c.expectedPortalId = blankToNull(e.EXPECTED_PORTAL_ID);
  c.appId = blankToNull(e.HUBSPOT_APP_ID);
  c.webhookPublicUrl = blankToNull(e.WEBHOOK_PUBLIC_URL);
  return c;
}

/** Signature checks may be skipped only when SANDBOX_MODE is also on. */
function shouldSkipSignature(config) {
  return Boolean(config.sandboxMode && config.skipSignatureCheck);
}

function readProperties(config) {
  const r = config.rules;
  const set = new Set([
    ...Object.keys(config.weights),
    ...r.fill, ...r.recency, ...r.review, ...r.never,
    ...r.fieldGroups.flatMap((g) => g.properties),
  ]);
  return Array.from(set).sort();
}

function writableProperties(config) {
  const r = config.rules;
  const set = new Set([...r.fill, ...r.recency, ...r.fieldGroups.flatMap((g) => g.properties)]);
  for (const p of r.never) set.delete(p);
  return set;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function isEmpty(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function prop(record, name) {
  return record && record.properties ? record.properties[name] : undefined;
}

function normalizeEmail(email) {
  if (isEmpty(email)) return null;
  const s = String(email).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Remove plus-tags. For Gmail addresses, also remove dots and map googlemail.com to gmail.com. */
function canonicalEmail(email) {
  const n = normalizeEmail(email);
  if (!n) return null;
  let [local, domain] = n.split('@');
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

function emailDomain(email) {
  const n = normalizeEmail(email);
  return n ? n.split('@')[1] : null;
}

function isRoleAddress(email) {
  const n = normalizeEmail(email);
  return n ? ROLE_LOCAL_PARTS.has(n.split('@')[0].split('+')[0]) : false;
}

function splitList(value) {
  if (isEmpty(value)) return [];
  return String(value).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

/** Keep digits only, drop an international 00 prefix, and compare the last 10 digits. */
function normalizePhone(phone) {
  if (isEmpty(phone)) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 7) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeName(name) {
  if (isEmpty(name)) return null;
  const s = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return s || null;
}

function normalizeCompany(company) {
  if (isEmpty(company)) return null;
  const s = String(company).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ').trim();
  return s || null;
}

function normalizeWebsite(url) {
  if (isEmpty(url)) return null;
  return String(url).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function toMs(value) {
  if (isEmpty(value)) return 0;
  if (typeof value === 'number') return value;
  if (/^\d+$/.test(String(value))) return Number(value);
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function valuesEquivalent(property, a, b) {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (isEmpty(a) || isEmpty(b)) return false;
  if (property === 'phone' || property === 'mobilephone') return normalizePhone(a) === normalizePhone(b);
  if (property === 'email') return normalizeEmail(a) === normalizeEmail(b);
  if (property === 'website') return normalizeWebsite(a) === normalizeWebsite(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function emailSet(record) {
  const list = [prop(record, 'email'), ...splitList(prop(record, 'hs_additional_emails'))];
  return new Set(list.map(canonicalEmail).filter(Boolean));
}

function phoneSet(record) {
  return new Set([prop(record, 'phone'), prop(record, 'mobilephone')].map(normalizePhone).filter(Boolean));
}

/**
 * Classify how strongly two contacts match.
 *  - exact:    same canonical email, including additional emails. Can auto-merge.
 *  - probable: phone plus last name, or full name plus company/corporate domain. Review only.
 *  - none:     not a duplicate.
 */
function matchRecords(a, b) {
  const signals = [];
  const aEmails = emailSet(a);
  const bEmails = emailSet(b);
  const emailOverlap = [...aEmails].some((e) => bEmails.has(e));

  const aFirst = normalizeName(prop(a, 'firstname'));
  const bFirst = normalizeName(prop(b, 'firstname'));
  const aLast = normalizeName(prop(a, 'lastname'));
  const bLast = normalizeName(prop(b, 'lastname'));
  const sameLast = Boolean(aLast && aLast === bLast);
  const sameFull = Boolean(sameLast && aFirst && aFirst === bFirst);
  const namesConflict = Boolean(
    (aFirst && bFirst && aFirst !== bFirst) || (aLast && bLast && aLast !== bLast),
  );

  const bPhones = phoneSet(b);
  const phoneMatch = [...phoneSet(a)].some((p) => bPhones.has(p));
  const aCompany = normalizeCompany(prop(a, 'company'));
  const sameCompany = Boolean(aCompany && aCompany === normalizeCompany(prop(b, 'company')));
  const aDomain = emailDomain(prop(a, 'email'));
  const sameCorpDomain = Boolean(aDomain && !FREEMAIL_DOMAINS.has(aDomain) && aDomain === emailDomain(prop(b, 'email')));

  if (emailOverlap) {
    signals.push('email_match');
    if (isRoleAddress(prop(a, 'email')) || isRoleAddress(prop(b, 'email'))) {
      signals.push('role_address');
      return { tier: 'probable', signals };
    }
    if (namesConflict) {
      signals.push('name_mismatch');
      return { tier: 'probable', signals };
    }
    return { tier: 'exact', signals };
  }

  if (phoneMatch && sameLast) {
    signals.push('phone_match', 'lastname_match');
    return { tier: 'probable', signals };
  }
  if (sameFull && (sameCompany || sameCorpDomain)) {
    signals.push('fullname_match', sameCompany ? 'company_match' : 'corporate_domain_match');
    return { tier: 'probable', signals };
  }
  return { tier: 'none', signals };
}

// ---------------------------------------------------------------------------
// Scoring and ranking
// ---------------------------------------------------------------------------

function completenessScore(record, weights) {
  let total = 0;
  let filled = 0;
  for (const [name, weight] of Object.entries(weights)) {
    total += weight;
    if (!isEmpty(prop(record, name))) filled += weight;
  }
  return total === 0 ? 0 : Math.round((filled / total) * 10000) / 100;
}

/**
 * Deterministic precedence, so concurrent runs pick the same primary:
 *  1. Highest completeness score
 *  2. Most recent lastmodifieddate
 *  3. Oldest createdate
 *  4. Lowest record ID
 */
function rankRecords(records, weights) {
  return records
    .map((record) => ({
      record,
      id: String(record.id),
      score: completenessScore(record, weights),
      lastModified: toMs(prop(record, 'lastmodifieddate')),
      created: toMs(prop(record, 'createdate')),
    }))
    .sort((a, b) => b.score - a.score
      || b.lastModified - a.lastModified
      || a.created - b.created
      || compareIds(a.id, b.id));
}

// ---------------------------------------------------------------------------
// Property backfill plan
// ---------------------------------------------------------------------------

function valueWithTimestamp(record, property) {
  const value = prop(record, property);
  if (isEmpty(value)) return null;
  let ts = 0;
  const history = record.propertiesWithHistory && record.propertiesWithHistory[property];
  if (Array.isArray(history)) {
    for (const h of history) {
      if (h && String(h.value) === String(value)) ts = Math.max(ts, toMs(h.timestamp));
    }
  }
  const fromHistory = ts > 0;
  if (!fromHistory) ts = toMs(prop(record, 'lastmodifieddate'));
  return { id: String(record.id), value: String(value), timestamp: ts, fromHistory };
}

/**
 * Work out which properties to PATCH onto the primary before the merge, so no
 * information from the secondary is lost. Only allowlisted properties are written.
 */
function buildBackfill(primary, secondaries, config) {
  const rules = config.rules;
  const changes = {};
  const decisions = [];
  const conflicts = [];
  const pp = primary.properties || {};
  const groupProps = new Set();

  for (const group of rules.fieldGroups) {
    group.properties.forEach((p) => groupProps.add(p));
    if (!group.properties.every((p) => isEmpty(pp[p]))) continue;
    const donor = secondaries.find((s) => group.properties.some((p) => !isEmpty(prop(s, p))));
    if (!donor) continue;
    for (const p of group.properties) {
      if (!isEmpty(prop(donor, p))) changes[p] = String(prop(donor, p));
    }
    decisions.push({ property: group.name, rule: 'group_fill', sourceId: String(donor.id), previousValue: null });
  }

  for (const p of rules.fill) {
    if (groupProps.has(p) || !isEmpty(pp[p])) continue;
    const donor = secondaries.find((s) => !isEmpty(prop(s, p)));
    if (!donor) continue;
    changes[p] = String(prop(donor, p));
    decisions.push({ property: p, rule: 'fill_empty', sourceId: String(donor.id), previousValue: null });
  }

  for (const p of rules.recency) {
    let winner = null;
    for (const r of [primary, ...secondaries]) {
      const v = valueWithTimestamp(r, p);
      if (v && (!winner || v.timestamp > winner.timestamp)) winner = v;
    }
    if (!winner || winner.id === String(primary.id)) continue;
    if (valuesEquivalent(p, winner.value, pp[p])) continue;
    changes[p] = winner.value;
    decisions.push({
      property: p,
      rule: isEmpty(pp[p]) ? 'fill_empty' : 'newer_value_wins',
      sourceId: winner.id,
      previousValue: isEmpty(pp[p]) ? null : String(pp[p]),
      timestampBasis: winner.fromHistory ? 'property_history' : 'record_lastmodifieddate',
    });
  }

  for (const p of rules.review) {
    const values = [];
    for (const r of [primary, ...secondaries]) {
      const v = prop(r, p);
      if (isEmpty(v)) continue;
      if (!values.some((x) => valuesEquivalent(p, x.value, v))) values.push({ id: String(r.id), value: String(v) });
    }
    if (values.length > 1) conflicts.push({ property: p, values });
  }

  assertWritable(changes, config);
  return { properties: changes, decisions, conflicts };
}

function assertWritable(changes, config) {
  const allowed = writableProperties(config);
  for (const key of Object.keys(changes)) {
    if (!allowed.has(key)) throw new Error(`Refusing to write non-allowlisted property: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// HubSpot request builders
// ---------------------------------------------------------------------------

/** Build the CRM search request that finds possible duplicates (recall), excluding the trigger record. */
function buildSearchRequest(contact, config) {
  if (!contact || isEmpty(contact.id)) return null;
  const id = String(contact.id);
  const p = contact.properties || {};
  const groups = [];
  const seen = new Set();
  const add = (filters) => {
    const key = JSON.stringify(filters);
    if (!seen.has(key)) { seen.add(key); groups.push(filters); }
  };

  const email = normalizeEmail(p.email);
  const canonical = canonicalEmail(email);
  if (canonical && canonical !== email) add([{ propertyName: 'email', operator: 'EQ', value: canonical }]);
  if (!isEmpty(p.firstname) && !isEmpty(p.lastname)) {
    add([
      { propertyName: 'firstname', operator: 'EQ', value: String(p.firstname).trim() },
      { propertyName: 'lastname', operator: 'EQ', value: String(p.lastname).trim() },
    ]);
  }
  for (const raw of [p.phone, p.mobilephone]) {
    if (normalizePhone(raw)) {
      add([{ propertyName: 'phone', operator: 'EQ', value: String(raw).trim() }]);
      add([{ propertyName: 'mobilephone', operator: 'EQ', value: String(raw).trim() }]);
    }
  }
  if (!groups.length) return null;

  const notSelf = { propertyName: 'hs_object_id', operator: 'NEQ', value: id };
  return {
    filterGroups: groups.slice(0, 5).map((filters) => ({ filters: [...filters, notSelf] })),
    properties: readProperties(config),
    sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
    limit: Math.min(config.maxCandidates, 100),
  };
}

/** Build the batch-read request for the trigger plus its candidates, including property history. */
function buildClusterReadRequest(trigger, searchResponse, config) {
  const results = (searchResponse && searchResponse.results) || [];
  if (!trigger || !results.length) return null;
  const ids = [String(trigger.id)];
  for (const r of results) {
    const id = String(r.id);
    if (!ids.includes(id)) ids.push(id);
  }
  return {
    properties: readProperties(config),
    propertiesWithHistory: config.rules.recency.slice(),
    inputs: ids.slice(0, config.maxCandidates + 1).map((id) => ({ id })),
  };
}

// ---------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------

function baseDecision(action, triggerId, reasons, config, now) {
  return {
    action,
    triggerObjectId: String(triggerId),
    primaryId: null,
    secondaryId: null,
    mergePayload: null,
    backfill: { properties: {}, decisions: [] },
    hasBackfill: false,
    conflicts: [],
    matches: [],
    scores: [],
    reasons,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
    decidedAt: now || new Date().toISOString(),
  };
}

/**
 * Decide what to do with the trigger contact and the records that may duplicate it.
 * Returns one of: merge | dry_run | review | none | skip.
 */
function resolveCluster({ triggerId, records, searchTotal, config, now }) {
  const list = Array.isArray(records) ? records.filter((r) => r && !isEmpty(r.id)) : [];
  const trigger = list.find((r) => String(r.id) === String(triggerId));
  if (!trigger) return baseDecision('skip', triggerId, ['trigger_not_found_or_already_merged'], config, now);

  const others = list.filter((r) => String(r.id) !== String(trigger.id));
  const matches = others
    .map((record) => ({ record, ...matchRecords(trigger, record) }))
    .filter((m) => m.tier !== 'none');
  const summary = matches.map((m) => ({ id: String(m.record.id), tier: m.tier, signals: m.signals }));

  if (!matches.length) {
    return baseDecision('none', triggerId, ['no_duplicate_detected'], config, now);
  }

  const cluster = [trigger, ...matches.map((m) => m.record)];
  const ranked = rankRecords(cluster, config.weights);
  const scores = ranked.map((r) => ({
    id: r.id, score: r.score,
    lastmodifieddate: prop(r.record, 'lastmodifieddate') || null,
    createdate: prop(r.record, 'createdate') || null,
  }));
  const review = (reasons, extra) => Object.assign(
    baseDecision('review', triggerId, reasons, config, now),
    { matches: summary, scores, primaryId: ranked[0].id },
    extra || {},
  );

  if (Number(searchTotal) > config.maxCandidates) return review(['too_many_candidates']);
  if (matches.some((m) => m.tier === 'probable')) return review(['probable_match_requires_human_review']);
  if (cluster.length > MAX_CLUSTER_SIZE) return review(['cluster_exceeds_pairwise_limit']);

  const primary = ranked[0].record;
  const secondaries = ranked.slice(1).map((r) => r.record);
  const backfill = buildBackfill(primary, secondaries, config);
  if (backfill.conflicts.length) {
    return review(['protected_property_conflict'], { conflicts: backfill.conflicts });
  }

  const decision = baseDecision(config.dryRun ? 'dry_run' : 'merge', triggerId, ['exact_match_safe_to_merge'], config, now);
  decision.primaryId = String(primary.id);
  decision.secondaryId = String(secondaries[0].id);
  decision.mergePayload = { primaryObjectId: String(primary.id), objectIdToMerge: String(secondaries[0].id) };
  decision.backfill = { properties: backfill.properties, decisions: backfill.decisions };
  decision.hasBackfill = Object.keys(backfill.properties).length > 0;
  decision.matches = summary;
  decision.scores = scores;
  return decision;
}

// ---------------------------------------------------------------------------
// Post-merge verification, audit entries, review tickets
// ---------------------------------------------------------------------------

/** Check that the merged record holds the values chosen before the merge. */
function verifyMergeOutcome(decision, mergedRecord, expectedEmail) {
  const mismatches = [];
  const props = (mergedRecord && mergedRecord.properties) || {};
  for (const [name, expected] of Object.entries(decision.backfill.properties || {})) {
    if (!valuesEquivalent(name, expected, props[name])) {
      mismatches.push({ property: name, expected, actual: props[name] === undefined ? null : props[name] });
    }
  }
  if (expectedEmail && !valuesEquivalent('email', expectedEmail, props.email)) {
    mismatches.push({ property: 'email', expected: expectedEmail, actual: props.email || null });
  }
  return { ok: mismatches.length === 0, mergedId: mergedRecord ? String(mergedRecord.id) : null, mismatches };
}

function buildAuditEntry(decision, ctx) {
  const c = ctx || {};
  return {
    type: 'merge_audit',
    outcome: c.outcome || decision.action,
    portalId: c.event ? String(c.event.portalId) : null,
    eventId: c.event ? String(c.event.eventId) : null,
    triggerObjectId: decision.triggerObjectId,
    primaryId: decision.primaryId,
    secondaryId: decision.secondaryId,
    mergedId: c.verification ? c.verification.mergedId : null,
    backfill: decision.backfill,
    scores: decision.scores,
    matches: decision.matches,
    reasons: decision.reasons,
    verification: c.verification || null,
    dryRun: decision.dryRun,
    sandboxMode: decision.sandboxMode,
    loggedAt: c.now || new Date().toISOString(),
  };
}

function buildReviewTicket(decision, ctx) {
  const c = ctx || {};
  return {
    type: 'merge_review',
    severity: decision.reasons.includes('protected_property_conflict') ? 'medium' : 'low',
    summary: `Contact ${decision.triggerObjectId}: possible duplicate needs human review (${decision.reasons.join(', ')})`,
    portalId: c.event ? String(c.event.portalId) : null,
    triggerObjectId: decision.triggerObjectId,
    suggestedPrimaryId: decision.primaryId,
    reasons: decision.reasons,
    matches: decision.matches,
    scores: decision.scores,
    conflicts: decision.conflicts,
    sandboxMode: decision.sandboxMode,
    createdAt: c.now || new Date().toISOString(),
  };
}

function buildVerificationTicket(decision, verification, ctx) {
  const c = ctx || {};
  return {
    type: 'merge_verification_mismatch',
    severity: 'high',
    summary: `Merged contact ${verification.mergedId} does not hold ${verification.mismatches.length} expected value(s)`,
    portalId: c.event ? String(c.event.portalId) : null,
    triggerObjectId: decision.triggerObjectId,
    primaryId: decision.primaryId,
    secondaryId: decision.secondaryId,
    mergedId: verification.mergedId,
    mismatches: verification.mismatches,
    backfill: decision.backfill,
    createdAt: c.now || new Date().toISOString(),
  };
}

function extractStatusCode(error) {
  if (!error) return null;
  if (typeof error === 'object') {
    for (const key of ['httpCode', 'statusCode', 'status']) {
      const n = parseInt(error[key], 10);
      if (n >= 100 && n <= 599) return n;
    }
  }
  const text = typeof error === 'string' ? error : `${error.message || ''} ${error.description || ''}`;
  const m = text.match(/\b([45]\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/** Turn an API error into a review ticket. Returns null when the error is expected and harmless. */
function buildErrorTicket({ stage, error, event, decision, now }) {
  const status = extractStatusCode(error);
  if (stage === STAGES.FETCH_TRIGGER && status === 404) return null; // contact deleted or already merged

  let severity = 'high';
  let category = 'api_error';
  if (status === 401 || status === 403) { severity = 'critical'; category = 'auth_or_scope'; }
  else if (status === 429) category = 'rate_limited';
  else if (status && status >= 500) category = 'hubspot_unavailable';
  else if (stage === STAGES.MERGE && (status === 404 || status === 409)) { severity = 'low'; category = 'possible_concurrent_merge'; }
  else if (stage === STAGES.FETCH_MERGED) { severity = 'medium'; category = 'post_merge_verification_unavailable'; }

  const notes = [];
  if (stage === STAGES.MERGE && decision && decision.hasBackfill) {
    notes.push('backfill_applied_before_merge_failure: primary was updated but the records were not merged');
  }
  const message = typeof error === 'string' ? error : (error && (error.message || error.description)) || 'Unknown error';
  return {
    type: 'api_error',
    severity,
    category,
    stage,
    statusCode: status,
    summary: `${stage} failed${status ? ` (HTTP ${status})` : ''} for contact ${event ? event.objectId : 'unknown'}`,
    message: String(message).slice(0, 2000),
    portalId: event ? String(event.portalId) : null,
    triggerObjectId: event ? String(event.objectId) : null,
    decision: decision || null,
    notes,
    createdAt: now || new Date().toISOString(),
  };
}

function buildWorkflowFailureTicket(errorTriggerJson, now) {
  const j = errorTriggerJson || {};
  const ex = j.execution || {};
  const err = ex.error || {};
  return {
    type: 'workflow_failure',
    severity: 'critical',
    category: 'unhandled_exception',
    summary: `Workflow "${(j.workflow && j.workflow.name) || 'unknown'}" failed at node "${ex.lastNodeExecuted || 'unknown'}"`,
    message: String(err.message || 'Unknown error').slice(0, 2000),
    executionId: ex.id || null,
    executionUrl: ex.url || null,
    createdAt: now || new Date().toISOString(),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_CLUSTER_SIZE, STAGES,
    defaultConfig, loadConfig, shouldSkipSignature, readProperties, writableProperties,
    isEmpty, normalizeEmail, canonicalEmail, normalizePhone, normalizeName, normalizeCompany,
    normalizeWebsite, toMs, valuesEquivalent,
    matchRecords, completenessScore, rankRecords, buildBackfill,
    buildSearchRequest, buildClusterReadRequest, resolveCluster,
    verifyMergeOutcome, buildAuditEntry, buildReviewTicket, buildVerificationTicket,
    extractStatusCode, buildErrorTicket, buildWorkflowFailureTicket,
  };
}
