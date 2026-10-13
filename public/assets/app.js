// Shared browser core for every signed-in CareLink page: API client, helpers, role-based
// navigation, and a page registry. Each page script calls CareLink.page(name, init).
(() => {
  const TOKEN_KEY = 'carelink_token';
  const USER_KEY = 'carelink_user';
  const ALL = ['Admin', 'Doctor', 'Clinic Staff', 'Patient'];
  const STAFF = ['Admin', 'Doctor', 'Clinic Staff'];

  // Which roles may open each page. The API enforces the same rules independently.
  const ACCESS = {
    dashboard: ALL,
    reports: STAFF,
    queue: ALL,
    appointment: ALL,
    'queue-control': STAFF,
    consultation: ['Admin', 'Clinic Staff'],
    files: ALL,
    approval: ['Doctor'],
    comments: ALL,
    notifications: ALL,
    integrations: ['Admin', 'Clinic Staff'],
    audit: ['Admin'],
    users: ['Admin']
  };

  const NAV = [
    [
      'Overview',
      [
        ['dashboard', 'Dashboard'],
        ['reports', 'Reports']
      ]
    ],
    [
      'Patient flow',
      [
        ['queue', 'Appointments'],
        ['queue-control', 'Queue terminal'],
        ['consultation', 'Intake']
      ]
    ],
    [
      'Records',
      [
        ['files', 'Files'],
        ['approval', 'Doctor review'],
        ['comments', 'Feedback']
      ]
    ],
    [
      'System',
      [
        ['notifications', 'Notifications'],
        ['integrations', 'Integrations'],
        ['audit', 'Audit trail'],
        ['users', 'Users']
      ]
    ]
  ];

  const page = document.body.dataset.page;
  const pages = {};
  let token = sessionStorage.getItem(TOKEN_KEY);

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const escapeHtml = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );

  const pad = value => String(value).padStart(2, '0');
  const dayString = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const localDateTimeValue = date => `${dayString(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

  // SQLite datetime('now') values are UTC without a zone marker; appointment times are local.
  function fmtDate(value, options = {}) {
    if (!value) return '—';
    const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    return new Date(utc).toLocaleString(undefined, options);
  }

  const humanize = value => String(value || '').replaceAll('_', ' ');

  const statusBadge = status => {
    const key = escapeHtml(String(status || '').toLowerCase());
    return `<span class="status-pill status-${key}">${escapeHtml(humanize(status))}</span>`;
  };

  const emptyRow = (columns, message) =>
    `<tr><td colspan="${columns}" class="empty-cell">${escapeHtml(message)}</td></tr>`;

  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const response = await fetch(url, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 && page !== 'login') {
        sessionStorage.clear();
        location.href = '/login.html';
      }
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  const postJson = (url, body, method = 'POST') => api(url, { method, body: JSON.stringify(body) });

  function showMessage(element, message, error = false) {
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('error', Boolean(error));
  }

  function toast(message, error = false) {
    const element = $('#toast');
    if (!element) return;
    element.textContent = message;
    element.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 5000);
  }

  async function loadPatients(select, includeBlank = false) {
    const patients = await api('/api/patients');
    const options = patients.map(
      patient => `<option value="${patient.id}">${escapeHtml(patient.full_name)} · ${escapeHtml(patient.mrn)}</option>`
    );
    select.innerHTML = patients.length
      ? `${includeBlank ? '<option value="">Select patient</option>' : ''}${options.join('')}`
      : '<option value="">No patient records</option>';
    return patients;
  }

  // Downloads an authenticated file (the bearer token cannot ride on a plain link).
  async function download(url, filename) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Download failed.');
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob());
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  const canAccess = (role, key) => (ACCESS[key] || []).includes(role);

  function renderSidebar(user) {
    const current = page === 'appointment' ? 'queue' : page;
    const groups = NAV.map(([label, items]) => {
      const links = items
        .filter(([key]) => canAccess(user.role, key))
        .map(([key, text]) => `<a href="/${key}.html" class="${key === current ? 'active' : ''}">${text}</a>`)
        .join('');
      return links ? `<div class="nav-group"><p>${label}</p>${links}</div>` : '';
    }).join('');
    const initials = user.display_name
      .split(/\s+/)
      .map(part => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();

    $('#app-header').innerHTML = `
      <aside class="sidebar">
        <a class="brand" href="/dashboard.html">
          <img class="brand-logo" src="/assets/alagaq-logo.png" alt="">
          <span>CareLink <small>ALAGAQ INTEGRATION PORTAL</small></span>
        </a>
        <nav class="nav-groups" aria-label="Main">${groups}</nav>
        <div class="user-card">
          <span class="avatar">${escapeHtml(initials)}</span>
          <div><strong>${escapeHtml(user.display_name)}</strong><span>${escapeHtml(user.role)}</span></div>
          <button id="sign-out" class="icon-button" type="button">Sign out</button>
        </div>
      </aside>`;
    document.body.classList.add('has-sidebar');
    $('#sign-out').addEventListener('click', () => {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
      location.href = '/login.html';
    });
  }

  function saveSession(result) {
    token = result.token;
    sessionStorage.setItem(TOKEN_KEY, result.token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(result.user));
  }

  async function boot() {
    if (page === 'login') {
      if (token) {
        try {
          await api('/api/auth/me');
          location.replace('/dashboard.html');
          return;
        } catch {
          sessionStorage.removeItem(TOKEN_KEY);
          token = null;
        }
      }
      return pages.login?.({});
    }
    if (!token) {
      location.replace('/login.html');
      return;
    }
    const { user } = await api('/api/auth/me');
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    if (!canAccess(user.role, page)) {
      location.replace('/dashboard.html');
      return;
    }
    CareLink.user = user;
    renderSidebar(user);
    if (pages[page]) await pages[page]({ user });
  }

  const CareLink = {
    user: null,
    page: (name, init) => {
      pages[name] = init;
    },
    api,
    postJson,
    download,
    saveSession,
    $,
    $$,
    escapeHtml,
    fmtDate,
    dayString,
    localDateTimeValue,
    humanize,
    statusBadge,
    emptyRow,
    showMessage,
    toast,
    loadPatients,
    canAccess
  };
  window.CareLink = CareLink;

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch(error => {
      console.error(error);
      if (page === 'login') showMessage($('#login-error'), error.message, true);
      else toast(error.message, true);
    });
  });
})();
