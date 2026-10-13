(() => {
  const dateNode = document.querySelector('#display-date');
  const nowNode = document.querySelector('#now-serving');
  const nextNode = document.querySelector('#next-in-line');
  const servingService = document.querySelector('#serving-service');
  const nextService = document.querySelector('#next-service');
  const waitingList = document.querySelector('#waiting-list');
  const updatedNode = document.querySelector('#display-updated');

  function renderList(items) {
    waitingList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'display-empty';
      empty.textContent = 'The queue is clear.';
      waitingList.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('li');
      row.className = 'display-waiting-item';
      const ticket = document.createElement('strong');
      ticket.textContent = item.ticket;
      const service = document.createElement('span');
      service.textContent = item.service;
      row.append(ticket, service);
      waitingList.append(row);
    }
  }

  async function refresh() {
    try {
      const response = await fetch('/api/public/queue-display', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Queue service is unavailable.');
      nowNode.textContent = data.now_serving?.ticket || 'A---';
      nextNode.textContent = data.next_in_line?.ticket || 'A---';
      servingService.textContent = data.now_serving?.service || 'Waiting for the next patient';
      nextService.textContent = data.next_in_line?.service || 'No one is waiting';
      dateNode.textContent = new Date(`${data.date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
      });
      updatedNode.textContent = `Updated ${new Date(data.updated_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      renderList(data.waiting || []);
    } catch {
      updatedNode.textContent = 'Reconnecting to queue…';
    }
  }

  refresh();
  window.setInterval(refresh, 2000);
})();
