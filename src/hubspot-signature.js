'use strict';

/**
 * HubSpot webhook signature verification (X-HubSpot-Signature-v3).
 *
 * signature = base64( HMAC-SHA256( clientSecret, METHOD + URI + rawBody + timestamp ) )
 *
 * The URI is the full public URL HubSpot called, including any query string,
 * with a defined set of percent-encoded characters decoded.
 */

const crypto = require('crypto');

const URI_DECODE_MAP = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
  '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

function normalizeSignatureUri(uri) {
  return String(uri).replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => URI_DECODE_MAP[m.toUpperCase()]);
}

function computeSignatureV3({ method, uri, body, timestamp, clientSecret }) {
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body === undefined || body === null ? '' : body);
  const base = `${String(method || 'POST').toUpperCase()}${normalizeSignatureUri(uri)}${raw}${timestamp}`;
  return crypto.createHmac('sha256', clientSecret).update(base, 'utf8').digest('base64');
}

function verifySignatureV3({ method = 'POST', uri, body, timestamp, signature, clientSecret, now = Date.now(), maxAgeMs = 300000 }) {
  if (!clientSecret || /^REPLACE_WITH/.test(clientSecret)) return { valid: false, reason: 'client_secret_not_configured' };
  if (!uri) return { valid: false, reason: 'webhook_public_url_not_configured' };
  if (!signature) return { valid: false, reason: 'missing_signature_header' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { valid: false, reason: 'missing_or_invalid_timestamp' };
  if (now - ts > maxAgeMs) return { valid: false, reason: 'timestamp_too_old' };
  if (ts - now > 60000) return { valid: false, reason: 'timestamp_in_future' };

  const expected = Buffer.from(computeSignatureV3({ method, uri, body, timestamp: ts, clientSecret }), 'utf8');
  const received = Buffer.from(String(signature), 'utf8');
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true, reason: 'verified' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeSignatureUri, computeSignatureV3, verifySignatureV3 };
}
