// Me-Note · shared Google OAuth + Sheets API helper
// Usage: include this script, then call MeNoteAuth.loadAllSheets(spreadsheetId, container, onData)

(function () {
  const CLIENT_ID = '228482250401-1v59etll53j26q1qqrif95ei3g4lvkco.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';
  // bump when SCOPES change so tokens with old scopes are discarded
  const TOKEN_KEY = 'me-note-token-v2';

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

  async function apiSend(method, url, body) {
    const token = await getToken();
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'API error');
    return data;
  }

  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

  function updateCells(spreadsheetId, data) {
    return apiSend('POST', `${SHEETS}/${spreadsheetId}/values:batchUpdate`, {
      valueInputOption: 'USER_ENTERED',
      data,
    });
  }

  function appendRow(spreadsheetId, sheetTitle, row) {
    const range = encodeURIComponent(`'${sheetTitle.replace(/'/g, "''")}'!A1`);
    return apiSend('POST',
      `${SHEETS}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values: [row] });
  }

  async function deleteRow(spreadsheetId, sheetTitle, rowNumber) {
    const token = await getToken();
    const meta = await apiGet(`${SHEETS}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`, token);
    const sheet = meta.sheets.find((s) => s.properties.title === sheetTitle);
    if (!sheet) throw new Error(`ไม่เจอแท็บ ${sheetTitle}`);
    return apiSend('POST', `${SHEETS}/${spreadsheetId}:batchUpdate`, {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      }],
    });
  }

  async function uploadToDrive(folderId, blob, name) {
    const token = await getToken();
    const boundary = 'menote' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({ name, parents: [folderId] }),
      `\r\n--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Upload failed');
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
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`,
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

  function signInThenLoad(spreadsheetId, container, onData) {
    renderSignInUI(container, null, async () => {
      try {
        renderLoading(container);
        await getToken({ interactive: true });
        const data = await fetchAllSheets(spreadsheetId);
        onData(data);
      } catch (err) {
        console.error('Sign-in failed:', err);
        renderSignInUI(container, 'เข้าสู่ระบบไม่สำเร็จ: ' + err.message + ' — ลองกดอีกครั้ง', () => signInThenLoad(spreadsheetId, container, onData));
      }
    });
  }

  function renderLoading(container) {
    container.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--me-muted)"><div style="font-size:2rem;margin-bottom:0.5rem">⏳</div><div>กำลังโหลดข้อมูล…</div></div>`;
  }

  // Main convenience: if we have a stored token, try fetching;
  // otherwise show sign-in button immediately (avoids hangs from silent auth race).
  async function loadAllSheets(spreadsheetId, container, onData) {
    const stored = getStoredToken();
    if (!stored) {
      signInThenLoad(spreadsheetId, container, onData);
      return;
    }
    try {
      const data = await fetchAllSheets(spreadsheetId);
      onData(data);
    } catch (err) {
      console.error('Fetch failed, asking re-auth:', err);
      sessionStorage.removeItem(TOKEN_KEY);
      signInThenLoad(spreadsheetId, container, onData);
    }
  }

  async function fetchDriveFolderFiles(folderId) {
    const token = await getToken();
    const files = [];
    let pageToken = '';
    do {
      const url = `https://www.googleapis.com/drive/v3/files?` +
        `q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}` +
        `&fields=nextPageToken,files(id,name)&pageSize=1000` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const data = await apiGet(url, token);
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  window.MeNoteAuth = {
    getToken,
    fetchAllSheets,
    fetchDriveFolderFiles,
    updateCells,
    appendRow,
    deleteRow,
    uploadToDrive,
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
