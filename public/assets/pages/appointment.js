CareLink.page('appointment', async () => {
  const { $, api, escapeHtml, fmtDate, humanize, statusBadge, emptyRow } = CareLink;

  const id = Number(new URLSearchParams(location.search).get('id'));
  if (!Number.isInteger(id) || id < 1) throw new Error('Open a visit from the appointments list.');
  const data = await api(`/api/appointments/${id}`);
  const { appointment: visit, consultation } = data;

  $('#visit-title').textContent = `${visit.patient_name} · Queue #${visit.queue_number ?? '—'}`;
  $('#visit-subtitle').textContent = `${visit.reason} · ${fmtDate(visit.scheduled_at)}`;
  $('#visit-status').innerHTML = statusBadge(visit.status);

  const details = [
    ['Patient', visit.patient_name],
    ['MRN', visit.mrn],
    ['Date of birth', visit.date_of_birth || 'Not recorded'],
    ['Phone', visit.phone || 'Not recorded'],
    ['Email', visit.email || 'Not recorded'],
    ['Scheduled', fmtDate(visit.scheduled_at)],
    ['Doctor', visit.doctor_name || 'Unassigned'],
    ['Booked by', visit.created_by_name || '—'],
    ['Visit reason', visit.reason]
  ];
  $('#visit-details').innerHTML = details
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');

  if (consultation) {
    $('#consultation-status').innerHTML = statusBadge(consultation.status);
    $('#consultation-body').innerHTML = `
      <dl class="detail-list">
        <div><dt>Record</dt><dd>#${consultation.id} · revision ${consultation.revision}</dd></div>
        <div><dt>Submitted by</dt><dd>${escapeHtml(consultation.submitter_name)}</dd></div>
        <div><dt>Reviewed by</dt><dd>${escapeHtml(consultation.reviewer_name || 'Not reviewed yet')}</dd></div>
      </dl>
      <p class="eyebrow section-label">SYMPTOMS</p>
      <div class="text-block">${escapeHtml(consultation.symptoms)}</div>
      <p class="eyebrow section-label">INTAKE NOTES</p>
      <div class="text-block">${escapeHtml(consultation.clinical_notes || 'None provided')}</div>`;
    const link = $('#comments-link');
    link.href = `/comments.html?type=consultation&id=${consultation.id}`;
    link.classList.remove('hidden');
  } else {
    $('#consultation-body').innerHTML = '<p class="empty-cell">No intake has been submitted for this visit yet.</p>';
  }

  $('#comment-list').innerHTML = data.comments.length
    ? data.comments
        .map(
          comment => `
            <article class="comment ${comment.kind === 'review' ? 'review' : ''}">
              <header>
                <strong>${escapeHtml(comment.author_name)}</strong>
                <span>${escapeHtml(comment.author_role)} · ${fmtDate(comment.created_at)}</span>
                ${comment.decision ? statusBadge(comment.decision) : ''}
              </header>
              <p>${escapeHtml(comment.body)}</p>
            </article>`
        )
        .join('')
    : '<p class="empty-cell">No comments yet.</p>';

  $('#file-rows').innerHTML = data.files.length
    ? data.files
        .map(
          file => `
            <tr>
              <td><strong>#${file.asset_id}</strong> ${escapeHtml(file.original_name)}</td>
              <td>${escapeHtml(file.category)}</td>
              <td>v${file.version_number}${file.version_number === file.current_version ? ' <span class="muted">(current)</span>' : ''}</td>
              <td>${statusBadge(file.status)}</td>
              <td>${escapeHtml(file.uploader_name)}</td>
              <td>${fmtDate(file.version_created_at)}</td>
            </tr>`
        )
        .join('')
    : emptyRow(6, 'No files for this patient.');

  const timeline = (items, label) =>
    items.length
      ? items
          .map(
            item =>
              `<li><strong>${escapeHtml(humanize(label(item)))}</strong><small>${escapeHtml(item.actor_name || 'System')} · ${fmtDate(item.created_at)}</small></li>`
          )
          .join('')
      : '<li><small>No entries recorded.</small></li>';
  $('#queue-timeline').innerHTML = timeline(data.queue_events, item => item.event_type);
  if (data.audit) $('#audit-timeline').innerHTML = timeline(data.audit, item => item.action);
  else $('#audit-panel').classList.add('hidden');
});
