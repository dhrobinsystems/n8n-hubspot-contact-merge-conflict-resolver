'use strict';

const fs = require('fs');
const path = require('path');
const { render } = require('../scripts/build-workflow');
const { STAGES } = require('../src/conflict-resolver');

const ROOT = path.resolve(__dirname, '..');
const raw = fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8');
const wf = JSON.parse(raw);
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

describe('workflow.json integrity', () => {
  test('is in sync with src/ (run npm run build:workflow if this fails)', () => {
    expect(raw).toBe(render());
  });

  test('node names and IDs are unique', () => {
    expect(new Set(wf.nodes.map((n) => n.name)).size).toBe(wf.nodes.length);
    expect(new Set(wf.nodes.map((n) => n.id)).size).toBe(wf.nodes.length);
  });

  test('every connection points at an existing node', () => {
    for (const [source, { main }] of Object.entries(wf.connections)) {
      expect(byName[source]).toBeDefined();
      for (const output of main) for (const c of output) expect(byName[c.node]).toBeDefined();
    }
  });

  test('ships inactive with the webhook answering through Respond nodes', () => {
    expect(wf.active).toBe(false);
    expect(byName['HubSpot Webhook'].parameters).toMatchObject({ responseMode: 'responseNode', options: { rawBody: true } });
  });

  test('every Code node compiles', () => {
    const code = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
    expect(code.length).toBeGreaterThanOrEqual(8);
    for (const n of code) expect(() => new AsyncFunction('$input', '$env', '$', '$prevNode', n.parameters.jsCode)).not.toThrow();
  });

  test('every HubSpot API node retries and routes failures to the error classifier', () => {
    for (const stage of Object.values(STAGES)) {
      const node = byName[stage];
      expect(node).toBeDefined();
      expect(node).toMatchObject({ retryOnFail: true, onError: 'continueErrorOutput', parameters: { nodeCredentialType: 'hubspotAppToken' } });
      expect(wf.connections[stage].main[1]).toEqual([{ node: 'Classify API Error', type: 'main', index: 0 }]);
    }
  });

  test('merge only happens after the decision switch "merge" output', () => {
    expect(wf.connections['Route Decision'].main[0][0].node).toBe('Has Backfill?');
    expect(byName[STAGES.MERGE].parameters.url).toContain('/crm/v3/objects/contacts/merge');
  });

  test('contains no secrets, real tokens or non-placeholder endpoints', () => {
    expect(raw).not.toMatch(/pat-(na|eu)\d-[0-9a-f-]{8,}/i);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    const emails = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    for (const e of emails) expect(e).toMatch(/@(example\.(com|org|net)|gmail\.com|googlemail\.com)$/);
    expect(byName['HubSpot Webhook'].credentials).toBeUndefined();
    expect(byName[STAGES.MERGE].credentials.hubspotAppToken.id).toBe('REPLACE_WITH_N8N_CREDENTIAL_ID');
  });
});
