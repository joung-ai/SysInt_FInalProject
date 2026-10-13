CareLink.page('dashboard', async ({ user }) => {
  const { $, api, escapeHtml } = CareLink;

  $('#today-label').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const data = await api('/api/dashboard');
  const metrics = [
    ['Appointments today', data.appointment_count, 'All scheduled visits', '◷'],
    ['Active queue', data.active_queue_count, 'Checked in or in consultation', '↗'],
    [
      'Pending reviews',
      data.pending_reviews + data.pending_file_reviews,
      'Consultations and files awaiting a doctor',
      '✳'
    ],
    ['Patient records', data.patients, 'Connected patient profiles', '♡']
  ];
  $('#metrics').innerHTML = metrics
    .map(
      ([label, value, sub, icon]) => `
        <article class="metric-card">
          <span class="metric-icon">${icon}</span>
          <span class="metric-label">${label}</span>
          <strong>${value}</strong>
          <small>${sub}</small>
        </article>`
    )
    .join('');

  // Role-specific work items, each linking to the screen where the work is done.
  const tasks = {
    Doctor: [
      ['Consultations waiting for your review', data.pending_reviews, '/approval.html'],
      ['File versions waiting for your review', data.pending_file_reviews, '/approval.html'],
      ['Reviews waiting more than 24 hours', data.overdue_reviews, '/reports.html']
    ],
    'Clinic Staff': [
      ['Revision requests to answer', data.revision_requests, '/consultation.html'],
      ['Patients in today’s queue', data.active_queue_count, '/queue-control.html'],
      ['Records awaiting doctor review', data.pending_reviews, '/consultation.html']
    ],
    Admin: [
      ['Failed integrations (last 24 hours)', data.failed_integrations_24h, '/integrations.html'],
      ['Reviews waiting more than 24 hours', data.overdue_reviews, '/reports.html'],
      ['Revision requests open', data.revision_requests, '/consultation.html']
    ],
    Patient: [
      ['Your visits today', data.appointment_count, '/queue.html'],
      ['Your records under review', data.pending_reviews, '/notifications.html'],
      ['Your files under review', data.pending_file_reviews, '/files.html']
    ]
  }[user.role];
  $('#task-list').innerHTML = tasks
    .map(([label, count, href]) => `<li><a href="${href}"><span>${escapeHtml(label)}</span><b>${count}</b></a></li>`)
    .join('');

  const services = [
    ['REST API', data.api === 'online' ? 'Online' : 'Offline'],
    ['SQLite database', data.database === 'connected' ? 'Connected' : 'Offline'],
    ['SMS / email gateway', 'Loopback mock'],
    ['Workflow event bus', 'Running'],
    ['CSV import (ETL)', 'Ready'],
    ['PhilHealth export (ETL)', 'Ready']
  ];
  $('#service-status').innerHTML = services
    .map(([label, status]) => `<div class="service-row"><span>${label}</span><span>● ${status}</span></div>`)
    .join('');
});
