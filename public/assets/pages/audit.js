CareLink.page('audit', async () => {
  const { $, api, escapeHtml, fmtDate, emptyRow, toast } = CareLink;
  const filter = $('#audit-filter');

  async function refresh() {
    const params = new URLSearchParams({ limit: '500' });
    if (filter.action.value.trim()) params.set('action', filter.action.value.trim());
    const rows = await api(`/api/audit?${params}`);
    $('#audit-rows').innerHTML = rows.length
      ? rows
          .map(
            item => `
              <tr>
                <td>${fmtDate(item.created_at)}</td>
                <td>${escapeHtml(item.display_name || item.username || 'System')}</td>
                <td>${escapeHtml(item.actor_role || 'System')}</td>
                <td><strong>${escapeHtml(item.action)}</strong></td>
                <td>${escapeHtml(item.entity_type)} ${escapeHtml(item.entity_id || '')}</td>
                <td class="mono">${escapeHtml(item.details_json)}</td>
                <td>${escapeHtml(item.ip_address || '—')}</td>
              </tr>`
          )
          .join('')
      : emptyRow(7, 'No audit entries match.');
  }

  filter.addEventListener('submit', event => {
    event.preventDefault();
    refresh().catch(error => toast(error.message, true));
  });
  await refresh();
});
