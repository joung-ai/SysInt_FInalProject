const crypto = require('node:crypto');

// In-process publish/subscribe hub. Route modules publish workflow events ("consultation.approved",
// "asset.revision_requested", ...) without knowing which integrations react to them. Every event and
// every subscriber outcome is written to integration_logs under one transaction ID.
module.exports = function createEventBus({ logIntegration }) {
  const subscribers = new Map();

  function subscribe(eventType, name, handler) {
    if (!subscribers.has(eventType)) subscribers.set(eventType, []);
    subscribers.get(eventType).push({ name, handler });
  }

  // Never rejects: routes may publish without awaiting, and a failed subscriber must not undo the
  // business transaction that already committed.
  async function publish(eventType, payload = {}) {
    const transactionId = crypto.randomUUID();
    const event = { type: eventType, payload, transactionId, occurredAt: new Date().toISOString() };
    const results = {};
    const record = entry => {
      try {
        logIntegration({ transactionId, integration: 'event_bus', recordRef: payload.recordRef, payload, ...entry });
      } catch (error) {
        console.error(`Could not record integration log for ${eventType}:`, error);
      }
    };

    record({ action: eventType, status: 'success' });
    for (const { name, handler } of subscribers.get(eventType) || []) {
      try {
        results[name] = await handler(event);
      } catch (error) {
        results[name] = { status: 'failed', error: error.message };
        record({ action: `${eventType} -> ${name}`, status: 'failed', errorMessage: error.message });
      }
    }
    return { transactionId, results };
  }

  return { subscribe, publish };
};
