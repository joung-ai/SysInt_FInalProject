// Delivers patient messages through the external gateway (SMS and email) and staff alerts through the
// in-app notification inbox. Every attempt is recorded in notification_logs and integration_logs.
module.exports = function createNotifier({ db, logNotification, logIntegration, smsUrl, emailUrl }) {
  async function postToGateway(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Gateway responded ${response.status}: ${text}`);
    return text;
  }

  async function deliver({ channel, url, destination, patientId, eventType, message, recordId, transactionId }) {
    let status = 'failed';
    let responseBody = '';
    try {
      if (!destination) throw new Error(`Patient ${channel === 'sms' ? 'phone number' : 'email'} is not on file.`);
      responseBody = await postToGateway(url, { to: destination, message, eventType, recordId, transactionId });
      status = 'sent';
    } catch (error) {
      responseBody = error.message;
    }
    logNotification({
      patientId,
      channel,
      eventType,
      message,
      destination,
      status,
      responseBody,
      recipientRole: 'Patient',
      transactionId
    });
    logIntegration({
      transactionId,
      integration: `${channel}_gateway`,
      action: eventType,
      status: status === 'sent' ? 'success' : 'failed',
      recordRef: String(recordId),
      payload: { to: destination, eventType },
      errorMessage: status === 'sent' ? null : responseBody
    });
    return { status, responseBody };
  }

  // SMS is always attempted (a missing phone is logged as a failure); email is sent only when an address exists.
  async function notifyPatient({ patientId, eventType, message, recordId, transactionId, email = true }) {
    const patient = db.prepare('SELECT full_name, phone, email FROM patients WHERE id = ?').get(patientId);
    const text = message.replace('{name}', patient?.full_name || 'patient');
    const sms = await deliver({
      channel: 'sms',
      url: smsUrl,
      destination: patient?.phone,
      patientId,
      eventType,
      message: text,
      recordId,
      transactionId
    });
    db.prepare(
      `INSERT INTO audit_logs(actor_id, actor_role, action, entity_type, entity_id, details_json)
       VALUES(NULL, 'System', 'sms_triggered', 'notification', ?, ?)`
    ).run(String(recordId), JSON.stringify({ status: sms.status, eventType, transactionId }));

    let emailResult = null;
    if (email && patient?.email) {
      emailResult = await deliver({
        channel: 'email',
        url: emailUrl,
        destination: patient.email,
        patientId,
        eventType,
        message: text,
        recordId,
        transactionId
      });
    }
    return { sms: sms.status, email: emailResult?.status || null };
  }

  function notifyRole({ role, patientId = null, eventType, message, transactionId }) {
    logNotification({
      patientId,
      channel: 'in_app',
      eventType,
      message,
      destination: `role:${role}`,
      status: 'sent',
      recipientRole: role,
      transactionId
    });
    return { status: 'sent' };
  }

  return { notifyPatient, notifyRole };
};
