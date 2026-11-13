#!/usr/bin/env node
'use strict';

/**
 * Sends a signed, HubSpot-style webhook batch to your n8n instance.
 *
 *   npm run send:test-webhook                         uses test/fixtures/hubspot-webhook-batch.json
 *   npm run send:test-webhook -- path/to/batch.json   uses your own fixture
 *
 * Reads WEBHOOK_PUBLIC_URL and HUBSPOT_CLIENT_SECRET from .env or the shell.
 * Point it at a STAGING n8n instance connected to a HubSpot developer test
 * account, and use contact IDs that exist in that test account.
 */

const fs = require('fs');
const path = require('path');
const { computeSignatureV3 } = require('../src/hubspot-signature');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  loadDotEnv(path.resolve(__dirname, '..', '.env'));
  const url = process.env.WEBHOOK_PUBLIC_URL;
  const secret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!url || /your-n8n-webhook-domain/.test(url)) throw new Error('Set WEBHOOK_PUBLIC_URL to your staging webhook URL.');
  if (!secret || /^REPLACE_WITH/.test(secret)) throw new Error('Set HUBSPOT_CLIENT_SECRET (test app secret).');

  const fixture = process.argv[2] || path.resolve(__dirname, '..', 'test', 'fixtures', 'hubspot-webhook-batch.json');
  const now = Date.now();
  const events = JSON.parse(fs.readFileSync(fixture, 'utf8')).map((e) => ({ ...e, occurredAt: now }));
  const body = JSON.stringify(events);
  const timestamp = String(now);
  const signature = computeSignatureV3({ method: 'POST', uri: url, body, timestamp, clientSecret: secret });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-HubSpot-Signature-v3': signature,
      'X-HubSpot-Request-Timestamp': timestamp,
    },
    body,
  });
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
