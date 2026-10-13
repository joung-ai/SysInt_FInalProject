CareLink.page('notifications', async ({ user }) => {
  const { $, api, escapeHtml, fmtDate, humanize, statusBadge, emptyRow, toast } = CareLink;
  const channelFilter = $('#channel-filter');
  let rows = [];

  $('#notification-scope').textContent = {
    Admin: 'Every SMS, email, in-app alert, and system event.',
    Patient: 'SMS and email messages sent to you.',
    Doctor: 'In-app alerts for doctors: new submissions and resubmitted records.',
    'Clinic Staff': 'In-app alerts for clinic staff: revision requests, rejections, bookings and imports.'
  }[user.role];

  function render() {
    const visible = channelFilter.value ? rows.filter(row => row.channel === channelFilter.value) : rows;
    $('#notification-rows').innerHTML = visible.length
      ? visible
          .map(
            item => `
              <tr>
                <td>${fmtDate(item.created_at)}</td>
                <td>${escapeHtml(humanize(item.channel).toUpperCase())}</td>
                <td>${escapeHtml(humanize(item.event_type))}</td>
                <td>${escapeHtml(item.message)}</td>
                <td>${escapeHtml(item.destination || item.recipient_role || '—')}</td>
                <td>${statusBadge(item.status)}</td>
                <td class="mono">${escapeHtml(item.response_body || '—')}</td>
              </tr>`
          )
          .join('')
      : emptyRow(7, 'No notification events.');
  }

  async function refresh() {
    rows = await api('/api/notifications');
    render();
  }

  channelFilter.addEventListener('change', render);
  $('#refresh-notifications').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));
  await refresh();
});
