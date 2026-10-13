CareLink.page('comments', async () => {
  const { $, api, postJson, escapeHtml, fmtDate, humanize, statusBadge, showMessage } = CareLink;
  const params = new URLSearchParams(location.search);
  const selected = { type: params.get('type'), id: Number(params.get('id')) };
  const hasSelection =
    ['consultation', 'asset'].includes(selected.type) && Number.isInteger(selected.id) && selected.id > 0;

  const commentHtml = comment => `
    <article class="comment ${comment.kind === 'review' ? 'review' : ''}">
      <header>
        <strong>${escapeHtml(comment.author_name)}</strong>
        <span>${escapeHtml(comment.author_role)} · ${fmtDate(comment.created_at)}${comment.version_number ? ` · v${comment.version_number}` : ''}</span>
        ${comment.decision ? statusBadge(comment.decision) : comment.kind !== 'comment' ? statusBadge(comment.kind) : ''}
      </header>
      <p>${escapeHtml(comment.body)}</p>
    </article>`;

  async function loadRecentRecords() {
    const { comments } = await api('/api/comments');
    // One entry per record, newest activity first.
    const records = new Map();
    for (const comment of comments) {
      const key = `${comment.entity_type}:${comment.entity_id}`;
      if (!records.has(key)) records.set(key, comment);
    }
    $('#record-list').innerHTML = records.size
      ? [...records.values()]
          .map(comment => {
            const active = hasSelection && comment.entity_type === selected.type && comment.entity_id === selected.id;
            const label = comment.entity_type === 'consultation' ? 'Consultation' : 'File';
            return `
              <a href="?type=${comment.entity_type}&id=${comment.entity_id}" class="${active ? 'active' : ''}">
                <strong>${label} #${comment.entity_id}</strong> · ${escapeHtml(comment.patient_name)}
                <small>${escapeHtml(comment.author_name)}: ${escapeHtml(comment.body.slice(0, 70))}</small>
              </a>`;
          })
          .join('')
      : '<p class="empty-cell">No comments yet.</p>';
  }

  async function loadThread() {
    const data = await api(`/api/comments?entity_type=${selected.type}&entity_id=${selected.id}`);
    $('#thread-eyebrow').textContent = `${selected.type.toUpperCase()} · ${data.entity.patient_name.toUpperCase()}`;
    $('#thread-title').textContent = data.entity.label;
    $('#thread-status').innerHTML = statusBadge(data.entity.status);
    $('#thread').innerHTML = data.comments.length
      ? data.comments.map(commentHtml).join('')
      : `<p class="empty-cell">No comments on this ${humanize(selected.type)} yet.</p>`;
    $('#comment-form').classList.remove('hidden');
  }

  $('#comment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await postJson('/api/comments', {
        entity_type: selected.type,
        entity_id: selected.id,
        body: new FormData(form).get('body')
      });
      form.reset();
      showMessage($('#comment-result'), 'Comment posted.');
      await Promise.all([loadThread(), loadRecentRecords()]);
    } catch (error) {
      showMessage($('#comment-result'), error.message, true);
    }
  });

  await Promise.all([loadRecentRecords(), hasSelection ? loadThread() : null]);
});
