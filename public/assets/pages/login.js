CareLink.page('login', () => {
  const { $, postJson, saveSession, showMessage } = CareLink;
  const form = $('#login-form');
  const message = $('#login-error');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    showMessage(message, 'Signing in…');
    try {
      saveSession(await postJson('/api/auth/login', data));
      location.href = '/dashboard.html';
    } catch (error) {
      showMessage(message, error.message, true);
      button.disabled = false;
    }
  });
});
