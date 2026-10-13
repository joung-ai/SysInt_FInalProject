CareLink.page('approval', async () => {
  const { $, api, postJson, escapeHtml, fmtDate, humanize, statusBadge, toast } = CareLink;

  const decisionButtons = `
    <div class="review-actions">
      <button class="button primary" name="decision" value="approved">Approve</button>
      <button class="button secondary" name="decision" value="revision_requested">Request revision</button>
      <button class="button danger" name="decision" value="rejected">Reject</button>
    </div>`;

  const consultationCard = item => `
    <article class="review-card">
      <div class="review-card-top">
        <div>
          <h3>${escapeHtml(item.patient_name)} <span class="muted">· ${escapeHtml(item.mrn)}</span></h3>
          <p>Consultation #${item.id} · revision ${item.revision} · Queue #${item.queue_number} · ${fmtDate(item.scheduled_at)}</p>
          <p><strong>Reported symptoms:</strong> ${escapeHtml(item.symptoms)}</p>
          <p><strong>Intake notes:</strong> ${escapeHtml(item.clinical_notes || 'None provided')}</p>
          <p><a class="table-link" href="/appointment.html?id=${item.appointment_id}">Open visit</a> ·
             <a class="table-link" href="/comments.html?type=consultation&id=${item.id}">Comment thread</a></p>
        </div>
        ${statusBadge(item.status)}
      </div>
      <form class="stack-form review-form" data-url="/api/consultations/${item.id}/review" data-label="Consultation #${item.id}">
        <label>
          Doctor comment
          <textarea name="comment" maxlength="4000" required placeholder="Decision note or what needs to change."></textarea>
        </label>
        ${decisionButtons}
      </form>
    </article>`;

  const assetCard = item => `
    <article class="review-card">
      <div class="review-card-top">
        <div>
          <h3>${escapeHtml(item.patient_name)} <span class="muted">· File #${item.asset_id} · ${escapeHtml(item.category)}</span></h3>
          <p>${escapeHtml(item.original_name)} · version ${item.version_number} · submitted by ${escapeHtml(item.uploader_name)}</p>
          <p><a class="table-link" href="/files.html">File history</a> ·
             <a class="table-link" href="/comments.html?type=asset&id=${item.asset_id}">Comment thread</a></p>
        </div>
        ${statusBadge(item.status)}
      </div>
      <form class="stack-form review-form" data-url="/api/assets/${item.asset_id}/review" data-label="File #${item.asset_id}">
        <label>
          Doctor comment
          <textarea name="comment" maxlength="4000" required placeholder="Decision note for this file version."></textarea>
        </label>
        ${decisionButtons}
      </form>
    </article>`;

  async function refresh() {
    const [consultations, assets] = await Promise.all([api('/api/consultations?status=submitted'), api('/api/assets')]);
    const pendingAssets = assets.filter(
      item => item.current_version === item.version_number && ['uploaded', 'revised'].includes(item.status)
    );
    $('#pending-consultations').innerHTML = consultations.length
      ? consultations.map(consultationCard).join('')
      : '<p class="empty-cell">No consultations are waiting for review.</p>';
    $('#pending-assets').innerHTML = pendingAssets.length
      ? pendingAssets.map(assetCard).join('')
      : '<p class="empty-cell">No current file versions are waiting for review.</p>';
  }

  // One handler serves both lists; the clicked button supplies the decision.
  for (const host of [$('#pending-consultations'), $('#pending-assets')]) {
    host.addEventListener('submit', async event => {
      const form = event.target.closest('.review-form');
      if (!form) return;
      event.preventDefault();
      const decision = event.submitter?.value;
      try {
        const result = await postJson(form.dataset.url, { decision, comment: new FormData(form).get('comment') });
        const delivery = result.sms ? ` SMS ${result.sms}${result.email ? `, email ${result.email}` : ''}.` : '';
        toast(`${form.dataset.label}: ${humanize(result.status)}.${delivery}`);
        await refresh();
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  $('#refresh-approvals').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));
  await refresh();
});
