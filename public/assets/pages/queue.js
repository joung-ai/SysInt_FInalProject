CareLink.page('queue', async ({ user }) => {
  const { $, api, postJson, escapeHtml, fmtDate, dayString, localDateTimeValue, humanize, statusBadge, emptyRow } =
    CareLink;
  const { showMessage, toast, loadPatients } = CareLink;

  const NEXT_STATUS = {
    booked: ['checked_in', 'cancelled'],
    checked_in: ['in_consultation', 'cancelled'],
    in_consultation: ['completed']
  };
  const canChangeStatus = ['Admin', 'Clinic Staff', 'Doctor'].includes(user.role);
  const dateInput = $('#queue-date');
  const doctorFilter = $('#doctor-filter');
  const patientSelect = $('#appointment-patient');
  const rowsHost = $('#appointment-rows');

  dateInput.value = dayString();
  if (user.role === 'Doctor') $('#booking-panel').classList.add('hidden');
  if (user.role === 'Patient') $('#doctor-filter-label').classList.add('hidden');

  const patients = await loadPatients(patientSelect, true);
  const resetPatient = () => {
    if (user.role === 'Patient') patientSelect.value = String(user.patient_id || patients[0]?.id || '');
  };
  if (user.role === 'Patient') $('.patient-field').classList.add('hidden');
  resetPatient();

  const doctors = await api('/api/doctors');
  const doctorOptions = doctors
    .map(doctor => `<option value="${doctor.id}">${escapeHtml(doctor.display_name)}</option>`)
    .join('');
  $('#appointment-doctor').innerHTML = `<option value="">Assign later</option>${doctorOptions}`;
  doctorFilter.innerHTML = `<option value="">All doctors</option>${doctorOptions}`;
  // Doctors open on their own schedule.
  if (user.role === 'Doctor') doctorFilter.value = String(user.id);

  $('input[name="scheduled_at"]').value = localDateTimeValue(new Date(Date.now() + 3_600_000));

  function renderRow(item) {
    const actions = canChangeStatus
      ? (NEXT_STATUS[item.status] || [])
          .map(
            status => `
              <button class="button small-button ${status === 'cancelled' ? 'danger' : 'secondary'}"
                data-appointment-action="${status}" data-id="${item.id}">${humanize(status)}</button>`
          )
          .join('')
      : '';
    const record = item.consultation_status
      ? statusBadge(item.consultation_status)
      : '<span class="muted">No intake</span>';
    return `
      <tr>
        <td><strong>#${item.queue_number ?? '—'}</strong></td>
        <td><strong>${escapeHtml(item.patient_name)}</strong><br /><span class="muted">${escapeHtml(item.mrn)}</span></td>
        <td>${fmtDate(item.scheduled_at, { hour: '2-digit', minute: '2-digit' })}</td>
        <td>${escapeHtml(item.doctor_name || 'Unassigned')}</td>
        <td>${escapeHtml(item.reason)}</td>
        <td>${statusBadge(item.status)}</td>
        <td>${record}<br /><a class="table-link" href="/appointment.html?id=${item.id}">Open visit</a></td>
        <td><div class="status-action">${actions || '—'}</div></td>
      </tr>`;
  }

  async function refresh() {
    const params = new URLSearchParams({ date: dateInput.value });
    if (doctorFilter.value) params.set('doctor_id', doctorFilter.value);
    const rows = await api(`/api/appointments?${params}`);
    rowsHost.innerHTML = rows.length ? rows.map(renderRow).join('') : emptyRow(8, 'No appointments for this date.');
  }

  rowsHost.addEventListener('click', async event => {
    const button = event.target.closest('[data-appointment-action]');
    if (!button) return;
    button.disabled = true;
    try {
      await postJson(
        `/api/appointments/${button.dataset.id}/status`,
        { status: button.dataset.appointmentAction },
        'PATCH'
      );
      await refresh();
      toast('Appointment status updated.');
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  });

  for (const control of [dateInput, doctorFilter]) {
    control.addEventListener('change', () => refresh().catch(error => toast(error.message, true)));
  }

  $('#appointment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.doctor_id) delete data.doctor_id;
    try {
      const result = await postJson('/api/appointments', data);
      showMessage($('#booking-result'), `Appointment booked. Queue number: ${result.queue_number}.`);
      form.reset();
      resetPatient();
      await refresh();
    } catch (error) {
      showMessage($('#booking-result'), error.message, true);
    }
  });

  await refresh();
  setInterval(() => refresh().catch(() => {}), 5000);
});
