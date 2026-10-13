CareLink.page('users', async ({ user: me }) => {
  const { $, api, postJson, escapeHtml, fmtDate, statusBadge, emptyRow, showMessage, toast, loadPatients } = CareLink;
  const patientField = $('#user-patient-field');
  const roleSelect = $('#user-role');

  await loadPatients($('#user-patient'), true);
  roleSelect.addEventListener('change', () => patientField.classList.toggle('hidden', roleSelect.value !== 'Patient'));

  function renderRow(user) {
    const action =
      user.id === me.id
        ? '<span class="muted">You</span>'
        : `<button class="button small-button ${user.active ? 'danger' : 'secondary'}" data-user="${user.id}"
             data-active="${user.active ? 'false' : 'true'}">${user.active ? 'Deactivate' : 'Activate'}</button>`;
    return `
      <tr>
        <td><strong>${escapeHtml(user.display_name)}</strong><br /><span class="muted">${escapeHtml(user.username)}</span></td>
        <td>${escapeHtml(user.role)}</td>
        <td>${user.patient_id ? `${escapeHtml(user.patient_name)} · ${escapeHtml(user.mrn)}` : '—'}</td>
        <td>${statusBadge(user.active ? 'active' : 'inactive')}</td>
        <td>${fmtDate(user.created_at)}</td>
        <td>${action}</td>
      </tr>`;
  }

  async function refresh() {
    const users = await api('/api/users');
    $('#user-rows').innerHTML = users.length
      ? users.map(renderRow).join('')
      : emptyRow(6, 'No user accounts have been created.');
  }

  $('#user-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.role !== 'Patient') delete data.patient_id;
    try {
      await postJson('/api/users', data);
      showMessage($('#user-result'), 'Account created successfully.');
      form.reset();
      patientField.classList.add('hidden');
      await refresh();
    } catch (error) {
      showMessage($('#user-result'), error.message, true);
    }
  });

  $('#user-rows').addEventListener('click', async event => {
    const button = event.target.closest('[data-user]');
    if (!button) return;
    button.disabled = true;
    try {
      const active = button.dataset.active === 'true';
      await postJson(`/api/users/${button.dataset.user}/status`, { active }, 'PATCH');
      toast(active ? 'Account activated.' : 'Account deactivated; existing sessions are signed out.');
      await refresh();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  });

  $('#refresh-users').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));
  await refresh();
});
