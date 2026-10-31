'use strict';
// Redirect if already signed in
if (localStorage.getItem('bs_token')) location.href = '/';

// When the app bounces us here because a session was revoked or expired, it passes
// the reason as ?msg= — show it so being logged out isn't silent and confusing.
// (textContent, never innerHTML: the value comes from the URL bar.)
(() => {
  const msg = new URLSearchParams(location.search).get('msg');
  if (!msg) return;
  const err = document.getElementById('err');
  if (!err) return;
  err.textContent = msg;
  err.style.display = 'block';
  history.replaceState(null, '', location.pathname);
})();

// ── Password visibility toggle ────────────────────────────────
const pwInput = document.getElementById('password');
const pwBtn   = document.getElementById('pw-toggle-btn');
pwBtn.addEventListener('click', () => {
  const show = pwInput.type === 'password';
  pwInput.type = show ? 'text' : 'password';
  pwBtn.classList.toggle('showing', show);
  pwBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

// ── Login (Enter submits automatically via the form) ─────────
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  const btn = document.getElementById('login-btn');
  err.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: pwInput.value
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Login failed');
    localStorage.setItem('bs_token', d.token);
    location.href = '/';
  } catch (ex) {
    err.textContent = ex.message;
    err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});
