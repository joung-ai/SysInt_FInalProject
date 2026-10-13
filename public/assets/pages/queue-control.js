CareLink.page('queue-control', async ({ user }) => {
  const { $, $$, api, postJson, escapeHtml, toast } = CareLink;
  const waitingHost = $('#terminal-waiting');
  const confirmBox = $('#reset-confirm');

  if (user.role !== 'Admin') $('#reset-queue').classList.add('hidden');

  async function refresh() {
    const data = await api('/api/queue/control');
    const current = data.now_serving;
    $('#terminal-current-ticket').textContent = current?.ticket || 'A---';
    $('#terminal-current-patient').textContent = current
      ? `${current.patient_name} · ${current.service}`
      : 'No patient is being served.';
    $('#terminal-count').textContent = `${data.waiting.length} waiting`;
    waitingHost.innerHTML = data.waiting.length
      ? data.waiting
          .map(
            (patient, index) => `
              <article class="terminal-patient">
                <div>
                  <strong>${index + 1}. ${escapeHtml(patient.patient_name)}</strong>
                  <small>${escapeHtml(patient.mrn)} · ${escapeHtml(patient.service)}</small>
                </div>
                <span class="terminal-ticket">${escapeHtml(patient.ticket)}</span>
              </article>`
          )
          .join('')
      : '<p class="empty-cell">There are no patients waiting.</p>';
  }

  const messages = {
    next: result =>
      result.current ? `Now serving ${result.current}. SMS sent if a phone is on file.` : 'No patients are waiting.',
    skip: result => `Ticket ${result.skipped_to_end} moved to the end of the line.`,
    recall: result => `Ticket ${result.recalled} recalled.`,
    reset: result => `Queue reset. ${result.closed_records} active records closed; history retained.`
  };

  async function performAction(action, button) {
    button.disabled = true;
    try {
      const result = await postJson(`/api/queue/control/${action}`, {});
      toast(messages[action](result));
      await refresh();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  for (const button of $$('[data-queue-action]')) {
    button.addEventListener('click', () => performAction(button.dataset.queueAction, button));
  }

  // Reset is destructive, so it asks for an in-page confirmation first.
  $('#reset-queue').addEventListener('click', () => confirmBox.classList.remove('hidden'));
  $('#reset-confirm-no').addEventListener('click', () => confirmBox.classList.add('hidden'));
  $('#reset-confirm-yes').addEventListener('click', async event => {
    confirmBox.classList.add('hidden');
    await performAction('reset', event.currentTarget);
  });

  await refresh();
  setInterval(() => refresh().catch(() => {}), 2000);
});
