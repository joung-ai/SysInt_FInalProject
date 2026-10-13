CareLink.page('integrations', async ({ user }) => {
  const { $, api, postJson, download, escapeHtml, fmtDate, humanize, statusBadge, emptyRow, showMessage, toast } =
    CareLink;
  const isAdmin = user.role === 'Admin';
  let transactionFilter = '';

  if (!isAdmin) {
    $('#export-panel').classList.add('hidden');
    $('#log-panel').classList.add('hidden');
  }

  async function refreshLogs() {
    if (!isAdmin) return;
    const params = new URLSearchParams();
    if ($('#log-integration').value) params.set('integration', $('#log-integration').value);
    if ($('#log-status').value) params.set('status', $('#log-status').value);
    if (transactionFilter) params.set('transaction_id', transactionFilter);
    $('#clear-transaction').classList.toggle('hidden', !transactionFilter);
    const rows = await api(`/api/integrations/logs?${params}`);
    $('#log-rows').innerHTML = rows.length
      ? rows
          .map(
            row => `
              <tr>
                <td>${fmtDate(row.created_at)}</td>
                <td><button class="table-link mono" data-transaction="${escapeHtml(row.transaction_id)}"
                  title="Show every step of this transaction">${escapeHtml(row.transaction_id.slice(0, 8))}…</button></td>
                <td>${escapeHtml(humanize(row.integration))}</td>
                <td>${escapeHtml(row.action)}</td>
                <td>${escapeHtml(row.record_ref || '—')}</td>
                <td>${statusBadge(row.status)}</td>
                <td>${escapeHtml(row.error_message || '—')}</td>
              </tr>`
          )
          .join('')
      : emptyRow(7, 'No integration log entries match.');
  }

  $('#import-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.file.files[0];
    if (!file) return;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      const result = await postJson('/api/integrations/appointments/import', {
        filename: file.name,
        csv: await file.text()
      });
      showMessage(
        $('#import-result'),
        `${result.imported} imported, ${result.skipped} skipped, ${result.failed} rejected (transaction ${result.transaction_id.slice(0, 8)}…).`,
        result.status === 'failed'
      );
      $('#import-summary').innerHTML = statusBadge(result.status);
      $('#import-rows').innerHTML = result.rows
        .map(
          row => `
            <tr>
              <td>${row.row}</td>
              <td>${statusBadge(row.status === 'imported' ? 'success' : row.status)}</td>
              <td>${row.status === 'imported' ? `Appointment #${row.appointment_id}, queue #${row.queue_number}` : escapeHtml(row.message)}</td>
            </tr>`
        )
        .join('');
      $('#import-rows-panel').classList.remove('hidden');
      form.reset();
      await refreshLogs();
    } catch (error) {
      showMessage($('#import-result'), error.message, true);
      await refreshLogs().catch(() => {});
    } finally {
      button.disabled = false;
    }
  });

  $('#export-button').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    showMessage($('#export-result'), 'Preparing approved records…');
    try {
      const result = await postJson('/api/integrations/philhealth/export', {});
      showMessage($('#export-result'), `${result.records} approved records exported to ${result.path}`);
      await refreshLogs();
    } catch (error) {
      showMessage($('#export-result'), error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('#download-latest').addEventListener('click', () =>
    download('/api/integrations/philhealth/latest', 'philhealth-approved-latest.csv').catch(error =>
      toast(error.message, true)
    )
  );

  $('#log-rows').addEventListener('click', event => {
    const button = event.target.closest('[data-transaction]');
    if (!button) return;
    transactionFilter = button.dataset.transaction;
    refreshLogs().catch(error => toast(error.message, true));
  });
  $('#clear-transaction').addEventListener('click', () => {
    transactionFilter = '';
    refreshLogs().catch(error => toast(error.message, true));
  });
  for (const control of [$('#log-integration'), $('#log-status')]) {
    control.addEventListener('change', () => refreshLogs().catch(error => toast(error.message, true)));
  }
  $('#refresh-logs').addEventListener('click', () => refreshLogs().catch(error => toast(error.message, true)));

  await refreshLogs();
});
