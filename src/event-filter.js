'use strict';

/**
 * Filter and deduplicate a HubSpot webhook batch.
 * HubSpot sends an array of up to 100 events per request and may retry deliveries.
 */

const SUPPORTED_SUBSCRIPTIONS = ['contact.creation', 'contact.propertyChange'];

function isSelfOriginated(event, appId) {
  if (!appId) return false;
  const source = String(event.sourceId === undefined || event.sourceId === null ? '' : event.sourceId);
  return source === String(appId) || source.endsWith(`:${appId}`);
}

function parseEvents(body, config) {
  const list = Array.isArray(body) ? body : body ? [body] : [];
  const watched = new Set(config.watchedProperties || []);
  const skipped = [];
  const latestByObject = new Map();

  for (const e of list) {
    const eventId = e && e.eventId !== undefined ? String(e.eventId) : null;
    if (!e || e.objectId === undefined || e.objectId === null || e.objectId === '') {
      skipped.push({ eventId, reason: 'invalid_event' });
      continue;
    }
    if (config.expectedPortalId && String(e.portalId) !== String(config.expectedPortalId)) {
      skipped.push({ eventId, reason: 'unexpected_portal' });
      continue;
    }
    if (!SUPPORTED_SUBSCRIPTIONS.includes(e.subscriptionType)) {
      skipped.push({ eventId, reason: 'unsupported_subscription' });
      continue;
    }
    if (e.subscriptionType === 'contact.propertyChange' && !watched.has(e.propertyName)) {
      skipped.push({ eventId, reason: 'unwatched_property' });
      continue;
    }
    if (isSelfOriginated(e, config.appId)) {
      skipped.push({ eventId, reason: 'self_originated' });
      continue;
    }

    const normalized = {
      eventId,
      objectId: String(e.objectId),
      portalId: e.portalId !== undefined ? String(e.portalId) : null,
      subscriptionType: e.subscriptionType,
      propertyName: e.propertyName || null,
      occurredAt: Number(e.occurredAt) || 0,
      attemptNumber: Number(e.attemptNumber) || 0,
    };
    const existing = latestByObject.get(normalized.objectId);
    if (existing) {
      const older = existing.occurredAt >= normalized.occurredAt ? normalized : existing;
      skipped.push({ eventId: older.eventId, reason: 'duplicate_object_in_batch' });
      if (older === existing) latestByObject.set(normalized.objectId, normalized);
    } else {
      latestByObject.set(normalized.objectId, normalized);
    }
  }

  return { events: Array.from(latestByObject.values()), skipped };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUPPORTED_SUBSCRIPTIONS, isSelfOriginated, parseEvents };
}
