// Me-Note · shared Google OAuth + Sheets API helper
// Usage: include this script, then call MeNoteAuth.loadAllSheets(spreadsheetId, container, onData)

(function () {
  const CLIENT_ID = '228482250401-1v59etll53j26q1qqrif95ei3g4lvkco.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const TOKEN_KEY = 'me-note-token';

  let tokenClient = null;
  let gisReadyResolve;
  const gisReady = new Promise((r) => { gisReadyResolve = r; });

  function getStoredToken() {
    try {
      const raw = sessionStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const { token, expiresAt } = JSON.parse(raw);
      if (Date.now() >= expiresAt - 60000) return null;
      return token;
    } catch { return null; }
  }

  async function initClient() {
    await gisReady;
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: () => {},
    });
    return tokenClient;
  }

  async function getToken({ interactive = false } = {}) {
    const stored = getStoredToken();
    if (stored) return stored;
    const client = await initClient();
    return new Promise((resolve, reject) => {
      client.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
          token: resp.access_token,
          expiresAt: Date.now() + (resp.expires_in * 1000),
        }));
        resolve(resp.access_token);
      };
      client.requestAccessToken({ prompt: interactive ? '' : 'none' });
    });
  }

  async function apiGet(url, token) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'API error');
    return data;
  }

  async function fetchAllSheets(spreadsheetId) {
    const token = await getToken();
    const meta = await apiGet(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(title)`,
      token
    );
    const names = meta.sheets.map((s) => s.properties.title);
    const ranges = names.map((n) => `ranges=${encodeURIComponent("'" + n.replace(/'/g, "''") + "'")}`).join('&');
    const data = await apiGet(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${ranges}`,
      token
    );
    const result = {};
    names.forEach((name, i) => {
      result[name] = (data.valueRanges[i] && data.valueRanges[i].values) || [];
    });
    return result;
  }

  function renderSignInUI(container, message, onClick) {
    container.innerHTML = `
      <div style="padding:2.5rem 1rem;text-align:center;background:var(--me-surface);border:1px solid var(--me-border);border-radius:var(--me-radius);box-shadow:var(--me-shadow);margin:1rem 0">
        <div style="font-size:2.5rem;margin-bottom:0.75rem">🔐</div>
        <div style="color:var(--me-ink);font-weight:500;margin-bottom:0.5rem">เข้าสู่ระบบเพื่อดูข้อมูล</div>
        <div style="color:var(--me-muted);font-size:0.85rem;margin-bottom:1.5rem;max-width:340px;margin-left:auto;margin-right:auto;line-height:1.6">${message || 'ข้อมูลของคุณเป็นส่วนตัว — กดเข้าสู่ระบบด้วย Google เพื่อโหลด'}</div>
        <button id="me-signin-btn" style="background:var(--me-coral);color:#fff;border:none;border-radius:var(--me-radius-pill);padding:10px 24px;font-family:inherit;font-size:0.9rem;font-weight:500;cursor:pointer;transition:opacity .2s ease">
          เข้าสู่ระบบด้วย Google
        </button>
      </div>`;
    document.getElementById('me-signin-btn').onclick = onClick;
  }

  function renderError(container, message) {
    container.innerHTML = `
      <div style="padding:1rem;background:var(--me-alert-bg);color:var(--me-alert-text);border-radius:var(--me-radius-sm);margin:1rem 0">
        ⚠️ ${message}
      </div>`;
  }

  // Main convenience: try silent fetch, else render sign-in button.
  // onData(sheetMap) is called when data is ready.
  async function loadAllSheets(spreadsheetId, container, onData) {
    try {
      const data = await fetchAllSheets(spreadsheetId);
      onData(data);
    } catch (err) {
      // any error → assume need to sign in (token expired, missing, etc.)
      renderSignInUI(container, null, async () => {
        try {
          await getToken({ interactive: true });
          const data = await fetchAllSheets(spreadsheetId);
          onData(data);
        } catch (err2) {
          renderError(container, 'เข้าสู่ระบบไม่สำเร็จ: ' + err2.message);
        }
      });
    }
  }

  window.MeNoteAuth = {
    getToken,
    fetchAllSheets,
    loadAllSheets,
    signOut: () => sessionStorage.removeItem(TOKEN_KEY),
  };

  // Auto-load Google Identity Services library
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.defer = true;
  s.onload = () => gisReadyResolve();
  document.head.appendChild(s);
})();
