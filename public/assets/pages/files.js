CareLink.page('files', async ({ user }) => {
  const { $, api, download, escapeHtml, fmtDate, statusBadge, emptyRow, showMessage, toast, loadPatients } = CareLink;
  const patientSelect = $('#file-patient');
  const patients = await loadPatients(patientSelect, true);
  const resetPatient = () => {
    if (user.role === 'Patient') patientSelect.value = String(user.patient_id || patients[0]?.id || '');
  };
  if (user.role === 'Patient') $('.patient-field').classList.add('hidden');
  resetPatient();

  function renderRow(item) {
    const isCurrent = item.current_version === item.version_number;
    const versionLabel =
      isCurrent && item.status === 'approved'
        ? ' <span class="muted">(final)</span>'
        : isCurrent
          ? ' <span class="muted">(current)</span>'
          : '';
    const reviseButton =
      isCurrent && ['revision_requested', 'rejected'].includes(item.status)
        ? `<button class="table-link" data-revise="${item.asset_id}" data-patient="${item.patient_id}">Upload revision</button><br />`
        : '';
    return `
      <tr>
        <td><strong>#${item.asset_id}</strong><br /><span class="muted">${escapeHtml(item.category)}</span></td>
        <td>${escapeHtml(item.patient_name)}</td>
        <td>${escapeHtml(item.original_name)}</td>
        <td>v${item.version_number}${versionLabel}</td>
        <td>${statusBadge(item.status)}</td>
        <td>${escapeHtml(item.comment || '—')}${item.reviewer_name ? `<br /><span class="muted">${escapeHtml(item.reviewer_name)}</span>` : ''}</td>
        <td>${escapeHtml(item.uploader_name)}<br /><span class="muted">${fmtDate(item.version_created_at)}</span></td>
        <td>
          ${reviseButton}
          <button class="table-link" data-download="${item.asset_id}" data-version="${item.version_number}"
            data-name="${escapeHtml(item.original_name)}">Download</button><br />
          <a class="table-link" href="/comments.html?type=asset&id=${item.asset_id}">Comments</a>
        </td>
      </tr>`;
  }

  async function refresh() {
    const rows = await api('/api/assets');
    $('#file-rows').innerHTML = rows.length
      ? rows.map(renderRow).join('')
      : emptyRow(8, 'No files have been submitted.');
  }

  $('#refresh-files').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));

  $('#file-rows').addEventListener('click', async event => {
    const revise = event.target.closest('[data-revise]');
    if (revise) {
      $('#file-asset-id').value = revise.dataset.revise;
      if (user.role !== 'Patient') patientSelect.value = revise.dataset.patient;
      $('#file-form').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const button = event.target.closest('[data-download]');
    if (!button) return;
    try {
      await download(`/api/assets/${button.dataset.download}/download/${button.dataset.version}`, button.dataset.name);
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#file-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      const result = await api('/api/assets', { method: 'POST', body: new FormData(form) });
      showMessage(
        $('#file-result'),
        `Uploaded as file #${result.asset_id}, version ${result.version_number} (${result.status}).`
      );
      form.reset();
      resetPatient();
      await refresh();
    } catch (error) {
      showMessage($('#file-result'), error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  await refresh();
});
