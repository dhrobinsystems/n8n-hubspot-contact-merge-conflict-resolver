'use strict';

const r = require('../src/conflict-resolver');
const { computeSignatureV3, verifySignatureV3, normalizeSignatureUri } = require('../src/hubspot-signature');
const { parseEvents } = require('../src/event-filter');

const NOW = '2026-01-15T12:00:00.000Z';
const T = (iso) => new Date(iso).getTime();

/** Build a mock HubSpot v3 contact. Dummy data only: example.com domains, safe IDs. */
function contact(id, properties = {}, history = undefined) {
  const rec = {
    id: String(id),
    properties: {
      hs_object_id: String(id),
      createdate: '2025-06-01T00:00:00.000Z',
      lastmodifieddate: '2025-06-01T00:00:00.000Z',
      ...properties,
    },
    archived: false,
  };
  if (history) rec.propertiesWithHistory = history;
  return rec;
}

function config(overrides = {}) {
  return { ...r.loadConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'true' }), ...overrides };
}

const FULL = {
  email: 'alex.sample@example.com', firstname: 'Alex', lastname: 'Sample', phone: '+1 555 010 0001',
  mobilephone: '+1 555 010 0002', company: 'Example Co', jobtitle: 'Ops Lead', website: 'https://example.com',
  address: '1 Example St', city: 'Exampleville', state: 'EX', zip: '00001', country: 'Exampleland',
  lifecyclestage: 'customer', hubspot_owner_id: '901',
};

// ---------------------------------------------------------------------------
describe('configuration', () => {
  test('defaults are safe: dry run and sandbox on', () => {
    const c = r.loadConfig({});
    expect(c.dryRun).toBe(true);
    expect(c.sandboxMode).toBe(true);
    expect(c.skipSignatureCheck).toBe(false);
    expect(c.maxCandidates).toBe(10);
  });

  test('parses env overrides and clamps numeric ranges', () => {
    const c = r.loadConfig({ DRY_RUN: 'false', SANDBOX_MODE: '0', MAX_CANDIDATES: '999', SIGNATURE_MAX_AGE_MS: '5', EXPECTED_PORTAL_ID: ' 1234567 ' });
    expect(c.dryRun).toBe(false);
    expect(c.sandboxMode).toBe(false);
    expect(c.maxCandidates).toBe(50);
    expect(c.signatureMaxAgeMs).toBe(60000);
    expect(c.expectedPortalId).toBe('1234567');
  });

  test('signature skip only honoured in sandbox mode', () => {
    expect(r.shouldSkipSignature(r.loadConfig({ SANDBOX_MODE: 'true', HUBSPOT_SKIP_SIGNATURE_CHECK: 'true' }))).toBe(true);
    expect(r.shouldSkipSignature(r.loadConfig({ SANDBOX_MODE: 'false', HUBSPOT_SKIP_SIGNATURE_CHECK: 'true' }))).toBe(false);
  });

  test('protected and system properties are never writable', () => {
    const writable = r.writableProperties(config());
    for (const p of ['email', 'hs_additional_emails', 'lifecyclestage', 'hubspot_owner_id', 'hs_email_optout', 'createdate']) {
      expect(writable.has(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('normalisation', () => {
  test.each([
    ['  Alex.Sample@Example.com ', 'alex.sample@example.com'],
    ['not-an-email', null],
    ['', null],
    [null, null],
  ])('normalizeEmail(%p)', (input, expected) => expect(r.normalizeEmail(input)).toBe(expected));

  test.each([
    ['alex+promo@example.com', 'alex@example.com'],
    ['a.l.e.x@gmail.com', 'alex@gmail.com'],
    ['a.lex+x@googlemail.com', 'alex@gmail.com'],
    ['a.lex@example.com', 'a.lex@example.com'],
    ['+tag@example.com', null],
  ])('canonicalEmail(%p)', (input, expected) => expect(r.canonicalEmail(input)).toBe(expected));

  test.each([
    ['+1 (555) 010-0001', '5550100001'],
    ['0015550100001', '5550100001'],
    ['555-0100', '5550100'],
    ['12345', null],
  ])('normalizePhone(%p)', (input, expected) => expect(r.normalizePhone(input)).toBe(expected));

  test('normalizeName strips accents and punctuation', () => {
    expect(r.normalizeName('  Zoë-Ann ')).toBe('zoeann');
  });

  test('normalizeCompany strips legal suffixes', () => {
    expect(r.normalizeCompany('Example Co., Inc.')).toBe('example');
    expect(r.normalizeCompany('Example LLC')).toBe('example');
  });

  test('toMs accepts ISO strings, epoch strings and numbers', () => {
    expect(r.toMs('2026-01-01T00:00:00.000Z')).toBe(T('2026-01-01T00:00:00.000Z'));
    expect(r.toMs('1767225600000')).toBe(1767225600000);
    expect(r.toMs(5)).toBe(5);
    expect(r.toMs('garbage')).toBe(0);
    expect(r.toMs(null)).toBe(0);
  });

  test('valuesEquivalent understands phone and website formatting', () => {
    expect(r.valuesEquivalent('phone', '+1 555 010 0001', '(555) 010-0001')).toBe(true);
    expect(r.valuesEquivalent('website', 'https://www.example.com/', 'example.com')).toBe(true);
    expect(r.valuesEquivalent('company', 'Example', 'example ')).toBe(true);
    expect(r.valuesEquivalent('company', 'Example', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('completeness scoring', () => {
  const { weights } = config();

  test('fully populated record scores 100', () => {
    expect(r.completenessScore(contact(1001, FULL), weights)).toBe(100);
  });

  test('empty record scores 0; whitespace counts as empty', () => {
    expect(r.completenessScore(contact(1001, { firstname: '   ' }), weights)).toBe(0);
  });

  test('partial record scores weighted percentage', () => {
    // email 20 + firstname 10 + lastname 10 = 40
    expect(r.completenessScore(contact(1001, { email: 'a@example.com', firstname: 'A', lastname: 'B' }), weights)).toBe(40);
  });

  test('zero total weight yields zero', () => {
    expect(r.completenessScore(contact(1001, FULL), {})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('precedence ranking', () => {
  const { weights } = config();

  test('higher completeness wins regardless of recency', () => {
    const rich = contact(1002, { ...FULL, lastmodifieddate: '2025-01-01T00:00:00Z' });
    const sparse = contact(1001, { email: 'x@example.com', lastmodifieddate: '2026-01-01T00:00:00Z' });
    expect(r.rankRecords([sparse, rich], weights)[0].id).toBe('1002');
  });

  test('equal completeness: most recently modified wins', () => {
    const older = contact(1001, { email: 'a@example.com', lastmodifieddate: '2025-01-01T00:00:00Z' });
    const newer = contact(1002, { email: 'b@example.com', lastmodifieddate: '2025-12-01T00:00:00Z' });
    expect(r.rankRecords([older, newer], weights)[0].id).toBe('1002');
  });

  test('equal completeness and recency: oldest createdate wins', () => {
    const a = contact(1002, { email: 'a@example.com', createdate: '2024-01-01T00:00:00Z' });
    const b = contact(1001, { email: 'b@example.com', createdate: '2025-01-01T00:00:00Z' });
    expect(r.rankRecords([b, a], weights)[0].id).toBe('1002');
  });

  test('full tie: lowest numeric ID wins (deterministic across concurrent runs)', () => {
    const a = contact(901, { email: 'a@example.com' });
    const b = contact(1001, { email: 'b@example.com' });
    expect(r.rankRecords([b, a], weights)[0].id).toBe('901');
    expect(r.rankRecords([a, b], weights)[0].id).toBe('901');
  });
});

// ---------------------------------------------------------------------------
describe('matching tiers', () => {
  test('exact: canonical email match (plus-tag variant)', () => {
    const m = r.matchRecords(
      contact(1001, { email: 'alex+webinar@example.com', firstname: 'Alex' }),
      contact(1002, { email: 'alex@example.com', firstname: 'Alex' }),
    );
    expect(m.tier).toBe('exact');
    expect(m.signals).toContain('email_match');
  });

  test('exact: email found in other record\'s additional emails', () => {
    const m = r.matchRecords(
      contact(1001, { email: 'alex@example.com' }),
      contact(1002, { email: 'alex@example.org', hs_additional_emails: 'old@example.net;alex@example.com' }),
    );
    expect(m.tier).toBe('exact');
  });

  test('email match downgraded to probable when names conflict', () => {
    const m = r.matchRecords(
      contact(1001, { email: 'shared@example.com', firstname: 'Alex' }),
      contact(1002, { email: 'shared@example.com', firstname: 'Sam' }),
    );
    expect(m).toEqual({ tier: 'probable', signals: ['email_match', 'name_mismatch'] });
  });

  test('role address is never auto-merged', () => {
    const m = r.matchRecords(contact(1001, { email: 'info@example.com' }), contact(1002, { email: 'INFO@example.com' }));
    expect(m.tier).toBe('probable');
    expect(m.signals).toContain('role_address');
  });

  test('probable: phone + last name', () => {
    const m = r.matchRecords(
      contact(1001, { phone: '+1 555 010 0001', lastname: 'Sample', email: 'a@example.com' }),
      contact(1002, { mobilephone: '(555) 010-0001', lastname: 'sample', email: 'b@example.org' }),
    );
    expect(m.tier).toBe('probable');
  });

  test('probable: full name + same company', () => {
    const m = r.matchRecords(
      contact(1001, { firstname: 'Alex', lastname: 'Sample', company: 'Example Inc' }),
      contact(1002, { firstname: 'alex', lastname: 'SAMPLE', company: 'Example, Inc.' }),
    );
    expect(m).toEqual({ tier: 'probable', signals: ['fullname_match', 'company_match'] });
  });

  test('probable: full name + same corporate email domain', () => {
    const m = r.matchRecords(
      contact(1001, { firstname: 'Alex', lastname: 'Sample', email: 'alex@example.com' }),
      contact(1002, { firstname: 'Alex', lastname: 'Sample', email: 'a.sample@example.com' }),
    );
    expect(m.signals).toContain('corporate_domain_match');
  });

  test('full name on a free-mail domain alone is not a match', () => {
    const m = r.matchRecords(
      contact(1001, { firstname: 'Alex', lastname: 'Sample', email: 'alex1@gmail.com' }),
      contact(1002, { firstname: 'Alex', lastname: 'Sample', email: 'alex2@gmail.com' }),
    );
    expect(m.tier).toBe('none');
  });
});

// ---------------------------------------------------------------------------
describe('backfill plan (secondary property preservation)', () => {
  test('fills empty primary properties from the secondary without overwriting populated ones', () => {
    const primary = contact(1001, { firstname: 'Alex', lastname: '', website: 'https://example.com' });
    const secondary = contact(1002, { firstname: 'Alexander', lastname: 'Sample', website: 'https://example.org' });
    const plan = r.buildBackfill(primary, [secondary], config());
    expect(plan.properties).toEqual({ lastname: 'Sample' });
    expect(plan.decisions).toEqual([{ property: 'lastname', rule: 'fill_empty', sourceId: '1002', previousValue: null }]);
  });

  test('recency rule: newer secondary value wins and the overwritten value is recorded', () => {
    const primary = contact(1001, { jobtitle: 'Analyst' }, { jobtitle: [{ value: 'Analyst', timestamp: '2025-01-01T00:00:00Z' }] });
    const secondary = contact(1002, { jobtitle: 'Director' }, { jobtitle: [{ value: 'Director', timestamp: '2025-09-01T00:00:00Z' }] });
    const plan = r.buildBackfill(primary, [secondary], config());
    expect(plan.properties.jobtitle).toBe('Director');
    expect(plan.decisions[0]).toMatchObject({
      property: 'jobtitle', rule: 'newer_value_wins', previousValue: 'Analyst', timestampBasis: 'property_history',
    });
  });

  test('recency rule: primary keeps its value when it is newer', () => {
    const primary = contact(1001, { jobtitle: 'Director' }, { jobtitle: [{ value: 'Director', timestamp: '2025-09-01T00:00:00Z' }] });
    const secondary = contact(1002, { jobtitle: 'Analyst' }, { jobtitle: [{ value: 'Analyst', timestamp: '2025-01-01T00:00:00Z' }] });
    expect(r.buildBackfill(primary, [secondary], config()).properties).toEqual({});
  });

  test('recency rule: equal timestamps favour the primary', () => {
    const h = (v) => ({ company: [{ value: v, timestamp: '2025-05-05T00:00:00Z' }] });
    const plan = r.buildBackfill(contact(1001, { company: 'A' }, h('A')), [contact(1002, { company: 'B' }, h('B'))], config());
    expect(plan.properties).toEqual({});
  });

  test('recency rule: falls back to record lastmodifieddate when history is absent', () => {
    const primary = contact(1001, { company: 'Old Example', lastmodifieddate: '2025-01-01T00:00:00Z' });
    const secondary = contact(1002, { company: 'New Example', lastmodifieddate: '2025-10-01T00:00:00Z' });
    const plan = r.buildBackfill(primary, [secondary], config());
    expect(plan.properties.company).toBe('New Example');
    expect(plan.decisions[0].timestampBasis).toBe('record_lastmodifieddate');
  });

  test('recency rule: formatting-only phone differences are not rewritten', () => {
    const primary = contact(1001, { phone: '+1 555 010 0001', lastmodifieddate: '2025-01-01T00:00:00Z' });
    const secondary = contact(1002, { phone: '(555) 010-0001', lastmodifieddate: '2025-10-01T00:00:00Z' });
    expect(r.buildBackfill(primary, [secondary], config()).properties).toEqual({});
  });

  test('address group is copied atomically and never mixed', () => {
    const primary = contact(1001, {});
    const secondary = contact(1002, { address: '1 Example St', city: 'Exampleville', zip: '00001' });
    const plan = r.buildBackfill(primary, [secondary], config());
    expect(plan.properties).toEqual({ address: '1 Example St', city: 'Exampleville', zip: '00001' });
    expect(plan.decisions[0]).toMatchObject({ property: 'postal_address', rule: 'group_fill' });

    const partialPrimary = contact(1001, { city: 'Othertown' });
    expect(r.buildBackfill(partialPrimary, [secondary], config()).properties).toEqual({});
  });

  test('conflicting owner IDs are flagged as review conflicts', () => {
    const plan = r.buildBackfill(
      contact(1001, { hubspot_owner_id: '901' }),
      [contact(1002, { hubspot_owner_id: '902' })],
      config(),
    );
    expect(plan.conflicts).toEqual([{ property: 'hubspot_owner_id', values: [{ id: '1001', value: '901' }, { id: '1002', value: '902' }] }]);
  });

  test('never writes identity, lifecycle or system properties', () => {
    const plan = r.buildBackfill(contact(1001, {}), [contact(1002, FULL)], config());
    for (const p of ['email', 'lifecyclestage', 'hubspot_owner_id', 'createdate', 'hs_object_id']) {
      expect(plan.properties).not.toHaveProperty(p);
    }
  });

  test('refuses misconfigured rules that would write a protected property', () => {
    const bad = config();
    bad.rules = { ...bad.rules, fill: [...bad.rules.fill, 'email'] };
    expect(() => r.buildBackfill(contact(1001, {}), [contact(1002, { email: 'x@example.com' })], bad))
      .toThrow(/non-allowlisted property: email/);
  });
});

// ---------------------------------------------------------------------------
describe('resolveCluster decisions', () => {
  const trigger = contact(1002, { email: 'alex+new@example.com', firstname: 'Alex', jobtitle: 'Director', lastmodifieddate: '2026-01-10T00:00:00Z' },
    { jobtitle: [{ value: 'Director', timestamp: '2026-01-10T00:00:00Z' }] });
  const existing = contact(1001, { ...FULL, email: 'alex@example.com', firstname: 'Alex', jobtitle: 'Analyst', lastmodifieddate: '2025-06-01T00:00:00Z' },
    { jobtitle: [{ value: 'Analyst', timestamp: '2025-06-01T00:00:00Z' }] });

  test('exact match produces a merge with the richer record as primary and a correct payload', () => {
    const d = r.resolveCluster({ triggerId: '1002', records: [trigger, existing], searchTotal: 1, config: config(), now: NOW });
    expect(d.action).toBe('merge');
    expect(d.mergePayload).toEqual({ primaryObjectId: '1001', objectIdToMerge: '1002' });
    expect(d.primaryId).toBe('1001');
    expect(d.secondaryId).toBe('1002');
    expect(d.backfill.properties).toEqual({ jobtitle: 'Director' });
    expect(d.hasBackfill).toBe(true);
    expect(d.scores.map((s) => s.id)).toEqual(['1001', '1002']);
    expect(d.decidedAt).toBe(NOW);
    expect(Object.keys(d.mergePayload).sort()).toEqual(['objectIdToMerge', 'primaryObjectId']);
    expect(typeof d.mergePayload.primaryObjectId).toBe('string');
  });

  test('DRY_RUN produces the same plan but action dry_run', () => {
    const d = r.resolveCluster({ triggerId: '1002', records: [trigger, existing], searchTotal: 1, config: r.loadConfig({}), now: NOW });
    expect(d.action).toBe('dry_run');
    expect(d.mergePayload).toEqual({ primaryObjectId: '1001', objectIdToMerge: '1002' });
  });

  test('merge with nothing to backfill has hasBackfill=false', () => {
    const a = contact(1001, { email: 'sam@example.com', firstname: 'Sam' });
    const b = contact(1002, { email: 'Sam@Example.com ' });
    const d = r.resolveCluster({ triggerId: '1002', records: [a, b], searchTotal: 1, config: config(), now: NOW });
    expect(d.action).toBe('merge');
    expect(d.hasBackfill).toBe(false);
    expect(d.backfill.properties).toEqual({});
  });

  test('skip when the trigger record is absent (already merged or deleted)', () => {
    const d = r.resolveCluster({ triggerId: '1999', records: [existing], searchTotal: 1, config: config(), now: NOW });
    expect(d.action).toBe('skip');
    expect(d.reasons).toEqual(['trigger_not_found_or_already_merged']);
  });

  test('none when candidates do not actually match', () => {
    const other = contact(1003, { email: 'someone.else@example.org', firstname: 'Pat' });
    const d = r.resolveCluster({ triggerId: '1002', records: [trigger, other], searchTotal: 1, config: config(), now: NOW });
    expect(d.action).toBe('none');
  });

  test('probable match routes to review, never merge', () => {
    const a = contact(1001, { firstname: 'Alex', lastname: 'Sample', phone: '555 010 0001' });
    const b = contact(1002, { firstname: 'Alex', lastname: 'Sample', mobilephone: '+1 555 010 0001' });
    const d = r.resolveCluster({ triggerId: '1002', records: [a, b], searchTotal: 1, config: config(), now: NOW });
    expect(d.action).toBe('review');
    expect(d.reasons).toEqual(['probable_match_requires_human_review']);
    expect(d.mergePayload).toBeNull();
  });

  test('clusters larger than one pair route to review', () => {
    const third = contact(1003, { email: 'alex@example.com', firstname: 'Alex' });
    const d = r.resolveCluster({ triggerId: '1002', records: [trigger, existing, third], searchTotal: 2, config: config(), now: NOW });
    expect(d.action).toBe('review');
    expect(d.reasons).toEqual(['cluster_exceeds_pairwise_limit']);
  });

  test('too many search candidates routes to review', () => {
    const d = r.resolveCluster({ triggerId: '1002', records: [trigger, existing], searchTotal: 500, config: config(), now: NOW });
    expect(d.action).toBe('review');
    expect(d.reasons).toEqual(['too_many_candidates']);
  });

  test('owner conflict routes to review with conflict details', () => {
    const a = contact(1001, { email: 'kim@example.com', hubspot_owner_id: '901' });
    const b = contact(1002, { email: 'kim@example.com', hubspot_owner_id: '902' });
    const d = r.resolveCluster({ triggerId: '1002', records: [a, b], searchTotal: 1, config: config(), now: NOW });
    expect(d.action).toBe('review');
    expect(d.reasons).toEqual(['protected_property_conflict']);
    expect(d.conflicts[0].property).toBe('hubspot_owner_id');
  });

  test('handles null/malformed record lists safely', () => {
    expect(r.resolveCluster({ triggerId: '1', records: null, config: config(), now: NOW }).action).toBe('skip');
    expect(r.resolveCluster({ triggerId: '1', records: [null, {}], config: config(), now: NOW }).action).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
describe('HubSpot request builders', () => {
  test('search request: OR groups exclude the trigger and carry the property list', () => {
    const body = r.buildSearchRequest(
      contact(1002, { email: 'Alex+x@Example.com', firstname: 'Alex', lastname: 'Sample', phone: '+1 555 010 0001' }),
      config(),
    );
    expect(body.filterGroups.length).toBeLessThanOrEqual(5);
    for (const g of body.filterGroups) {
      expect(g.filters).toContainEqual({ propertyName: 'hs_object_id', operator: 'NEQ', value: '1002' });
      expect(g.filters.length).toBeLessThanOrEqual(6);
    }
    expect(body.filterGroups[0].filters[0]).toEqual({ propertyName: 'email', operator: 'EQ', value: 'alex@example.com' });
    expect(body.properties).toEqual(expect.arrayContaining(['email', 'hs_additional_emails', 'lastmodifieddate']));
    expect(body.limit).toBe(10);
  });

  test('search request is null when there is nothing to search on', () => {
    expect(r.buildSearchRequest(contact(1002, { email: 'plain@example.com' }), config())).toBeNull();
    expect(r.buildSearchRequest(null, config())).toBeNull();
  });

  test('cluster read request includes trigger first, dedupes IDs and asks for history', () => {
    const body = r.buildClusterReadRequest(contact(1002), { total: 2, results: [{ id: '1001' }, { id: '1001' }, { id: '1002' }] }, config());
    expect(body.inputs).toEqual([{ id: '1002' }, { id: '1001' }]);
    expect(body.propertiesWithHistory).toEqual(['phone', 'mobilephone', 'company', 'jobtitle']);
    expect(r.buildClusterReadRequest(contact(1002), { total: 0, results: [] }, config())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('post-merge verification, audit and tickets', () => {
  const decision = r.resolveCluster({
    triggerId: '1002',
    records: [
      // 1001 scores 40 (email + firstname + phone), 1002 scores 35 (email + lastname + website)
      contact(1001, { email: 'lee@example.com', firstname: 'Lee', phone: '+1 555 010 0009' }),
      contact(1002, { email: 'lee+x@example.com', lastname: 'Sample', website: 'example.com' }),
    ],
    searchTotal: 1, config: config(), now: NOW,
  });

  test('verification passes when the merged record holds the chosen values', () => {
    const v = r.verifyMergeOutcome(decision, { id: '1001', properties: { email: 'LEE@example.com', lastname: 'Sample', website: 'https://www.example.com/' } }, 'lee@example.com');
    expect(v).toEqual({ ok: true, mergedId: '1001', mismatches: [] });
  });

  test('verification reports mismatches', () => {
    const v = r.verifyMergeOutcome(decision, { id: '1001', properties: { email: 'other@example.com' } }, 'lee@example.com');
    expect(v.ok).toBe(false);
    expect(v.mismatches.map((m) => m.property).sort()).toEqual(['email', 'lastname', 'website']);
    const ticket = r.buildVerificationTicket(decision, v, { event: { portalId: 1234567 }, now: NOW });
    expect(ticket).toMatchObject({ type: 'merge_verification_mismatch', severity: 'high', mergedId: '1001', portalId: '1234567' });
  });

  test('audit entry captures backfill, scores and outcome', () => {
    const a = r.buildAuditEntry(decision, { event: { portalId: 1234567, eventId: 5001 }, outcome: 'merged', now: NOW });
    expect(a).toMatchObject({ type: 'merge_audit', outcome: 'merged', portalId: '1234567', eventId: '5001', primaryId: '1001', secondaryId: '1002', loggedAt: NOW });
    expect(a.backfill.properties).toEqual({ lastname: 'Sample', website: 'example.com' });
  });

  test('review ticket severity reflects the reason', () => {
    const d = r.resolveCluster({
      triggerId: '1002',
      records: [contact(1001, { email: 'kim@example.com', hubspot_owner_id: '901' }), contact(1002, { email: 'kim@example.com', hubspot_owner_id: '902' })],
      searchTotal: 1, config: config(), now: NOW,
    });
    expect(r.buildReviewTicket(d, { now: NOW })).toMatchObject({ type: 'merge_review', severity: 'medium', suggestedPrimaryId: '1001' });
  });
});

// ---------------------------------------------------------------------------
describe('error classification', () => {
  const event = { objectId: '1002', portalId: '1234567' };

  test.each([
    [{ httpCode: '404' }, 404],
    [{ statusCode: 429 }, 429],
    [{ message: '503 - Service Unavailable' }, 503],
    ['Request failed with status code 401', 401],
    [{ message: 'socket hang up' }, null],
    [null, null],
  ])('extractStatusCode(%p) = %p', (err, code) => expect(r.extractStatusCode(err)).toBe(code));

  test('404 on trigger fetch is ignorable (already merged / deleted)', () => {
    expect(r.buildErrorTicket({ stage: r.STAGES.FETCH_TRIGGER, error: { httpCode: '404' }, event })).toBeNull();
  });

  test('auth errors are critical', () => {
    expect(r.buildErrorTicket({ stage: r.STAGES.SEARCH, error: { httpCode: '403' }, event, now: NOW }))
      .toMatchObject({ severity: 'critical', category: 'auth_or_scope', statusCode: 403 });
  });

  test('rate limits and 5xx are categorised', () => {
    expect(r.buildErrorTicket({ stage: r.STAGES.SEARCH, error: { httpCode: 429 }, event }).category).toBe('rate_limited');
    expect(r.buildErrorTicket({ stage: r.STAGES.READ_CLUSTER, error: { httpCode: 502 }, event }).category).toBe('hubspot_unavailable');
  });

  test('merge 404 after backfill is low severity and notes the partial state', () => {
    const t = r.buildErrorTicket({ stage: r.STAGES.MERGE, error: { message: '404 - not found' }, event, decision: { hasBackfill: true } });
    expect(t).toMatchObject({ severity: 'low', category: 'possible_concurrent_merge' });
    expect(t.notes[0]).toMatch(/backfill_applied_before_merge_failure/);
  });

  test('post-merge fetch failure is medium', () => {
    expect(r.buildErrorTicket({ stage: r.STAGES.FETCH_MERGED, error: 'timeout', event }).category).toBe('post_merge_verification_unavailable');
  });

  test('workflow failure ticket from Error Trigger payload', () => {
    const t = r.buildWorkflowFailureTicket({
      execution: { id: '77', url: 'https://your-n8n-domain.example.com/execution/77', lastNodeExecuted: 'Resolve Conflict', error: { message: 'boom' } },
      workflow: { name: 'HubSpot Contact Merge Conflict Resolver' },
    }, NOW);
    expect(t).toMatchObject({ type: 'workflow_failure', severity: 'critical', executionId: '77', message: 'boom' });
  });
});

// ---------------------------------------------------------------------------
describe('webhook event filtering', () => {
  const cfg = { ...r.loadConfig({ HUBSPOT_APP_ID: '7001', EXPECTED_PORTAL_ID: '1234567' }) };
  const base = { portalId: 1234567, occurredAt: 1000, subscriptionType: 'contact.creation' };

  test('keeps creation and watched property changes, newest per object', () => {
    const { events, skipped } = parseEvents([
      { ...base, eventId: 1, objectId: 1001, occurredAt: 1000 },
      { ...base, eventId: 2, objectId: 1001, occurredAt: 2000, subscriptionType: 'contact.propertyChange', propertyName: 'email' },
      { ...base, eventId: 3, objectId: 1002 },
    ], cfg);
    expect(events.map((e) => e.eventId)).toEqual(['2', '3']);
    expect(skipped).toEqual([{ eventId: '1', reason: 'duplicate_object_in_batch' }]);
  });

  test('keeps the newer event when the older one arrives second', () => {
    const { events } = parseEvents([
      { ...base, eventId: 2, objectId: 1001, occurredAt: 2000 },
      { ...base, eventId: 1, objectId: 1001, occurredAt: 1000 },
    ], cfg);
    expect(events.map((e) => e.eventId)).toEqual(['2']);
  });

  test.each([
    [{ ...base, eventId: 9, objectId: 1001, portalId: 999 }, 'unexpected_portal'],
    [{ ...base, eventId: 9, objectId: 1001, subscriptionType: 'contact.deletion' }, 'unsupported_subscription'],
    [{ ...base, eventId: 9, objectId: 1001, subscriptionType: 'contact.propertyChange', propertyName: 'jobtitle' }, 'unwatched_property'],
    [{ ...base, eventId: 9, objectId: 1001, sourceId: '7001' }, 'self_originated'],
    [{ ...base, eventId: 9, objectId: 1001, sourceId: 'app:7001' }, 'self_originated'],
    [{ ...base, eventId: 9 }, 'invalid_event'],
  ])('skips %p as %s', (event, reason) => {
    expect(parseEvents([event], cfg).skipped[0].reason).toBe(reason);
  });

  test('accepts a single object body and empty bodies', () => {
    expect(parseEvents({ ...base, eventId: 1, objectId: 1001 }, cfg).events).toHaveLength(1);
    expect(parseEvents(null, cfg)).toEqual({ events: [], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
describe('HubSpot v3 signature verification', () => {
  const secret = 'test-client-secret-not-real';
  const uri = 'https://your-n8n-webhook-domain.com/webhook/hubspot/contact-merge-resolver';
  const body = JSON.stringify([{ eventId: 1, objectId: 1001 }]);
  const now = 1767225600000;
  const sign = (overrides = {}) => computeSignatureV3({ method: 'POST', uri, body, timestamp: now, clientSecret: secret, ...overrides });

  test('valid signature verifies', () => {
    expect(verifySignatureV3({ uri, body, timestamp: String(now), signature: sign(), clientSecret: secret, now })).toEqual({ valid: true, reason: 'verified' });
  });

  test('accepts a Buffer body', () => {
    expect(verifySignatureV3({ uri, body: Buffer.from(body), timestamp: now, signature: sign(), clientSecret: secret, now }).valid).toBe(true);
  });

  test.each([
    ['tampered body', { body: body.replace('1001', '1002') }, 'signature_mismatch'],
    ['stale timestamp', { now: now + 300001 }, 'timestamp_too_old'],
    ['future timestamp', { now: now - 120000 }, 'timestamp_in_future'],
    ['missing signature', { signature: '' }, 'missing_signature_header'],
    ['bad timestamp', { timestamp: 'abc' }, 'missing_or_invalid_timestamp'],
    ['placeholder secret', { clientSecret: 'REPLACE_WITH_HUBSPOT_APP_CLIENT_SECRET' }, 'client_secret_not_configured'],
    ['missing uri', { uri: null }, 'webhook_public_url_not_configured'],
  ])('rejects %s', (_label, overrides, reason) => {
    const args = { uri, body, timestamp: now, signature: sign(), clientSecret: secret, now, ...overrides };
    expect(verifySignatureV3(args)).toEqual({ valid: false, reason });
  });

  test('URI percent-encoding is normalised before signing', () => {
    expect(normalizeSignatureUri('https://x.example.com/a%3Ab%2Fc?d=%40e')).toBe('https://x.example.com/a:b/c?d=@e');
    expect(sign({ uri: 'https://x.example.com/a%3Ab' })).toBe(sign({ uri: 'https://x.example.com/a:b' }));
  });
});
