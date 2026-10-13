CareLink.page('reports', async () => {
  const { $, api, escapeHtml, fmtDate, dayString, humanize, statusBadge, toast } = CareLink;
  const form = $('#range-form');
  form.from.value = dayString(new Date(Date.now() - 6 * 86_400_000));
  form.to.value = dayString();

  // A small table with a proportional bar per row, so counts can be compared at a glance.
  function countTable(rows, columns, valueKey = 'count') {
    if (!rows.length) return '<p class="empty-cell">No records in this range.</p>';
    const max = Math.max(...rows.map(row => Number(row[valueKey]) || 0), 1);
    const head = columns.map(([label, , numeric]) => `<th class="${numeric ? 'num' : ''}">${label}</th>`).join('');
    const body = rows
      .map(row => {
        const cells = columns
          .map(([, render, numeric]) => `<td class="${numeric ? 'num' : ''}">${render(row)}</td>`)
          .join('');
        const width = Math.round(((Number(row[valueKey]) || 0) / max) * 100);
        return `<tr>${cells}<td class="bar-cell"><div class="bar" style="width: ${width}%"></div></td></tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table class="compact"><thead><tr>${head}<th></th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  const listTable = (rows, columns, empty) =>
    rows.length
      ? `<div class="table-wrap"><table class="compact"><thead><tr>${columns.map(([label]) => `<th>${label}</th>`).join('')}</tr></thead>
         <tbody>${rows.map(row => `<tr>${columns.map(([, render]) => `<td>${render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<p class="empty-cell">${empty}</p>`;

  const status = row => statusBadge(row.status);
  const count = row => `<strong>${row.count}</strong>`;
  const sum = (rows, predicate = () => true) => rows.filter(predicate).reduce((total, row) => total + row.count, 0);

  async function load() {
    const data = await api(`/api/reports?from=${form.from.value}&to=${form.to.value}`);
    const approved = sum(data.consultations_by_status, row => row.status === 'approved');
    const reviewed = sum(data.consultations_by_status, row =>
      ['approved', 'rejected', 'revision_requested'].includes(row.status)
    );
    const delivered = sum(
      data.notifications_by_channel,
      row => ['sms', 'email'].includes(row.channel) && row.status === 'sent'
    );
    const attempted = sum(data.notifications_by_channel, row => ['sms', 'email'].includes(row.channel));
    const failedIntegrations = sum(data.integrations_by_status, row => row.status === 'failed');
    const metrics = [
      ['Appointments', sum(data.appointments_by_status), `${data.from} to ${data.to}`],
      [
        'Approval rate',
        reviewed ? `${Math.round((approved / reviewed) * 100)}%` : '—',
        `${approved} of ${reviewed} reviewed records`
      ],
      [
        'Message delivery',
        attempted ? `${Math.round((delivered / attempted) * 100)}%` : '—',
        `${delivered} of ${attempted} SMS/email sent`
      ],
      ['Failed integration steps', failedIntegrations, 'See Integrations for details']
    ];
    $('#report-metrics').innerHTML = metrics
      .map(
        ([label, value, sub]) =>
          `<article class="metric-card"><span class="metric-label">${label}</span><strong>${value}</strong><small>${escapeHtml(sub)}</small></article>`
      )
      .join('');

    $('#appointments-by-status').innerHTML = countTable(data.appointments_by_status, [
      ['Status', status],
      ['Count', count, true]
    ]);
    $('#consultations-by-status').innerHTML = countTable(data.consultations_by_status, [
      ['Status', status],
      ['Count', count, true]
    ]);
    $('#files-by-status').innerHTML = countTable(data.files_by_status, [
      ['Status', status],
      ['Count', count, true]
    ]);
    $('#doctor-workload').innerHTML = countTable(
      data.doctor_workload,
      [
        ['Doctor', row => escapeHtml(row.doctor)],
        ['Visits', row => row.appointments, true],
        ['Reviews', row => `<strong>${row.reviews}</strong>`, true]
      ],
      'appointments'
    );
    $('#notifications-by-channel').innerHTML = countTable(data.notifications_by_channel, [
      ['Channel', row => escapeHtml(humanize(row.channel))],
      ['Status', status],
      ['Count', count, true]
    ]);
    $('#integrations-by-status').innerHTML = countTable(data.integrations_by_status, [
      ['Integration', row => escapeHtml(humanize(row.integration))],
      ['Status', status],
      ['Count', count, true]
    ]);
    $('#appointments-by-day').innerHTML = countTable(data.appointments_by_day, [
      ['Day', row => escapeHtml(row.day)],
      ['Visits', count, true],
      ['Completed', row => row.completed, true],
      ['Cancelled', row => row.cancelled, true]
    ]);
    $('#overdue-reviews').innerHTML = listTable(
      data.overdue_reviews,
      [
        ['Record', row => `<a class="table-link" href="/comments.html?type=consultation&id=${row.id}">#${row.id}</a>`],
        ['Patient', row => escapeHtml(row.patient_name)],
        ['Waiting', row => `${row.hours_waiting} h`]
      ],
      'No overdue reviews.'
    );
    $('#missed-appointments').innerHTML = listTable(
      data.missed_appointments,
      [
        ['Visit', row => `<a class="table-link" href="/appointment.html?id=${row.id}">#${row.id}</a>`],
        ['Patient', row => escapeHtml(row.patient_name)],
        ['Scheduled', row => fmtDate(row.scheduled_at)]
      ],
      'No missed appointments.'
    );
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    load().catch(error => toast(error.message, true));
  });
  $('#print-report').addEventListener('click', () => window.print());
  await load();
});
