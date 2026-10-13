// Wires workflow events to their reactions. This is the single place that answers
// "what happens when ...?" for notifications, so route modules stay focused on their own records.
module.exports = function registerWorkflowSubscribers({ bus, notifier }) {
  const toRole = (role, buildMessage) => event =>
    notifier.notifyRole({
      role,
      patientId: event.payload.patientId,
      eventType: event.type.replace('.', '_'),
      message: buildMessage(event.payload),
      transactionId: event.transactionId
    });

  const toPatient =
    (buildMessage, options = {}) =>
    event =>
      notifier.notifyPatient({
        patientId: event.payload.patientId,
        eventType: event.type.replace('.', '_'),
        message: buildMessage(event.payload),
        recordId: event.payload.recordId,
        transactionId: event.transactionId,
        ...options
      });

  // New submissions and pending approvals go to doctors.
  bus.subscribe(
    'consultation.submitted',
    'doctorInbox',
    toRole('Doctor', p => `Consultation #${p.recordId} for ${p.patientName} is waiting for review.`)
  );
  bus.subscribe(
    'consultation.resubmitted',
    'doctorInbox',
    toRole(
      'Doctor',
      p =>
        `Consultation #${p.recordId} for ${p.patientName} was revised (revision ${p.revision}) and is waiting for review.`
    )
  );
  bus.subscribe(
    'asset.uploaded',
    'doctorInbox',
    toRole('Doctor', p => `File #${p.recordId} v${p.version} for ${p.patientName} is waiting for review.`)
  );
  bus.subscribe(
    'asset.revised',
    'doctorInbox',
    toRole('Doctor', p => `File #${p.recordId} was revised to v${p.version} for ${p.patientName}.`)
  );

  // Revision requests and rejections go back to the clinic staff who prepare records.
  bus.subscribe(
    'consultation.revision_requested',
    'staffInbox',
    toRole('Clinic Staff', p => `Revision requested on consultation #${p.recordId}: ${p.comment}`)
  );
  bus.subscribe(
    'consultation.rejected',
    'staffInbox',
    toRole('Clinic Staff', p => `Consultation #${p.recordId} was rejected: ${p.comment}`)
  );
  bus.subscribe(
    'asset.revision_requested',
    'staffInbox',
    toRole('Clinic Staff', p => `Revision requested on file #${p.recordId} v${p.version}: ${p.comment}`)
  );
  bus.subscribe(
    'asset.rejected',
    'staffInbox',
    toRole('Clinic Staff', p => `File #${p.recordId} v${p.version} was rejected: ${p.comment}`)
  );
  bus.subscribe(
    'appointment.booked',
    'staffInbox',
    toRole('Clinic Staff', p => `Appointment #${p.recordId} booked for ${p.patientName} (queue #${p.queueNumber}).`)
  );
  bus.subscribe('comment.added', 'staffInbox', event => {
    if (event.payload.authorRole !== 'Patient') return { status: 'skipped' };
    return toRole('Clinic Staff', p => `Patient feedback on ${p.entityType} #${p.recordId}: ${p.body}`)(event);
  });

  // Approvals and queue calls reach the patient through the external SMS/email gateway.
  bus.subscribe(
    'consultation.approved',
    'patientGateway',
    toPatient(p => `Hello {name}, your consultation (record ${p.recordId}) has been approved by your care team.`)
  );
  bus.subscribe(
    'asset.approved',
    'patientGateway',
    toPatient(p => `Hello {name}, your file (record ${p.recordId}) has been approved by your care team.`)
  );
  bus.subscribe('queue.patient_called', 'patientGateway', event => {
    if (!event.payload.hasPhone) return { status: 'skipped' };
    return toPatient(
      p => `Hello {name}, ticket ${p.ticket} is now being served. Please proceed to the consultation room.`,
      { email: false }
    )(event);
  });
};
