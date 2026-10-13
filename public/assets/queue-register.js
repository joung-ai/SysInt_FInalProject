(() => {
  const form = document.querySelector('#public-ticket-form');
  const error = document.querySelector('#ticket-error');
  const result = document.querySelector('#ticket-result');
  const submit = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    error.classList.remove('error');
    result.classList.add('hidden');
    submit.disabled = true;
    submit.textContent = 'Creating your ticket…';
    const formData = new FormData(form);
    try {
      const response = await fetch('/api/public/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          full_name: formData.get('full_name'),
          phone: formData.get('phone'),
          service: formData.get('service')
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not create a queue ticket.');
      document.querySelector('#ticket-number').textContent = data.ticket;
      document.querySelector('#ticket-details').textContent =
        `${data.service} · position ${data.position} in today’s waiting line`;
      result.classList.remove('hidden');
      error.textContent = '';
      form.reset();
      result.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (requestError) {
      error.textContent = requestError.message;
      error.classList.add('error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Get queue ticket';
    }
  });
})();
