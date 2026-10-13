CareLink.page('consultation', async () => {
  const { $, api, postJson, escapeHtml, fmtDate, statusBadge, emptyRow, showMessage, toast } = CareLink;
  const appointmentSelect = $('#consultation-appointment');
  let eligible = [];

  function renderContext() {
    const selected = eligible.find(item => String(item.id) === appointmentSelect.value);
    $('#consultation-context').innerHTML = selected
      ? `<strong>${escapeHtml(selected.patient_name)}</strong>
         <span>MRN ${escapeHtml(selected.mrn)}</span>
         <span>DOB ${escapeHtml(selected.date_of_birth || 'Not recorded')}</span>
         <span>Phone ${escapeHtml(selected.phone || 'Not recorded')}</span>
         <span>Visit: ${escapeHtml(selected.reason)}</span>`
      : 'Choose an appointment to view the linked patient details.';
  }

  async function loadAppointments() {
    const appointments = await api('/api/appointments');
    // Only checked-in visits without an existing record can take a new intake.
    eligible = appointments.filter(
      item => ['checked_in', 'in_consultation'].includes(item.status) && !item.consultation_id
    );
    appointmentSelect.innerHTML = eligible.length
      ? eligible
          .map(
            item =>
              `<option value="${item.id}">#${item.queue_number} · ${escapeHtml(item.patient_name)} · ${fmtDate(item.scheduled_at, { hour: '2-digit', minute: '2-digit' })}</option>`
          )
          .join('')
      : '<option value="">No checked-in appointments without intake</option>';
    renderContext();
  }

  function renderRevision(item) {
    return `
      <article class="review-card">
        <div class="review-card-top">
          <div>
            <h3>${escapeHtml(item.patient_name)} <span class="muted">· Consultation #${item.id} · revision ${item.revision}</span></h3>
            <p><strong>Doctor's request:</strong> ${escapeHtml(item.doctor_comment)}</p>
          </div>
          ${statusBadge(item.status)}
        </div>
        <form class="stack-form revision-form" data-id="${item.id}">
          <label>
            Symptoms
            <textarea name="symptoms" maxlength="4000" required>${escapeHtml(item.symptoms)}</textarea>
          </label>
          <label>
            Intake notes
            <textarea name="clinical_notes" maxlength="4000">${escapeHtml(item.clinical_notes)}</textarea>
          </label>
          <label>
            Note to the doctor (what changed)
            <textarea name="revision_note" maxlength="4000" placeholder="e.g. Blood pressure added."></textarea>
          </label>
          <div class="review-actions">
            <button class="button primary" type="submit">Resubmit for review</button>
            <a class="button secondary" href="/comments.html?type=consultation&id=${item.id}">Open comment thread</a>
          </div>
        </form>
      </article>`;
  }

  async function loadRecords() {
    const records = await api('/api/consultations');
    const revisions = records.filter(item => item.status === 'revision_requested');
    $('#revision-list').innerHTML = revisions.length
      ? revisions.map(renderRevision).join('')
      : '<p class="empty-cell">No revision requests are open.</p>';
    $('#consultation-rows').innerHTML = records.length
      ? records
          .map(
            item => `
              <tr>
                <td><strong>#${item.id}</strong><br /><span class="muted">rev ${item.revision}</span></td>
                <td>${escapeHtml(item.patient_name)}</td>
                <td>${fmtDate(item.scheduled_at)}</td>
                <td>${escapeHtml(item.symptoms)}</td>
                <td>${statusBadge(item.status)}</td>
                <td>${escapeHtml(item.doctor_comment || '—')}</td>
                <td><a class="table-link" href="/appointment.html?id=${item.appointment_id}">Open visit</a></td>
              </tr>`
          )
          .join('')
      : emptyRow(7, 'No consultation records yet.');
  }

  appointmentSelect.addEventListener('change', renderContext);

  $('#consultation-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const result = await postJson('/api/consultations', Object.fromEntries(new FormData(form).entries()));
      showMessage($('#consultation-result'), `Record #${result.id} submitted to the doctor.`);
      form.reset();
      await Promise.all([loadAppointments(), loadRecords()]);
    } catch (error) {
      showMessage($('#consultation-result'), error.message, true);
    }
  });

  $('#revision-list').addEventListener('submit', async event => {
    const form = event.target.closest('.revision-form');
    if (!form) return;
    event.preventDefault();
    try {
      const result = await postJson(
        `/api/consultations/${form.dataset.id}`,
        Object.fromEntries(new FormData(form).entries()),
        'PUT'
      );
      toast(`Consultation #${result.id} resubmitted as revision ${result.revision}.`);
      await loadRecords();
    } catch (error) {
      toast(error.message, true);
    }
  });

  await Promise.all([loadAppointments(), loadRecords()]);
});
