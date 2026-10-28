const SHEET_ID = '1UhQhc_ht5iKMwG5YfsXQEvkxGFn1KTNVxcwexmLfvUE';
const PHOTO_FOLDER_ID = '1UxjTF-RuRc0aUdn-kKpKrRISr9tHlEY4';
const PHOTO_MAP_CACHE_KEY = 'me-note-stock-photo-map';
const PHOTO_PREFIX = 'Keep_Me_App_Backend_Images/';
// known categories keep this order and English label; any other category in the sheet gets its own tab by name
const CATEGORY_LABELS = { 'เครื่องสำอาง': 'Cosmetics', 'ของใช้': 'Goods', 'ของกิน': 'Food', 'ยา': 'Medicine' };

function categoryList() {
  const known = Object.keys(CATEGORY_LABELS);
  const extra = [...new Set(allRows.map(r => r.category).filter(c => c && !known.includes(c)))]
    .sort((a, b) => a.localeCompare(b, 'th'));
  return [...known.filter(c => allRows.some(r => r.category === c)), ...extra];
}

function renderTabs() {
  const cats = categoryList();
  if (currentCat !== '__all__' && !cats.includes(currentCat)) currentCat = cats[0] || '__all__';
  document.getElementById('tabs').innerHTML = [...cats, '__all__'].map(c => `
    <button class="tab${c === currentCat ? ' active' : ''}" data-cat="${escapeHtml(c)}">
      ${escapeHtml(c === '__all__' ? 'All' : CATEGORY_LABELS[c] || c)}
    </button>`).join('');
}
const STATUSES = ['Active', 'Stock', 'Finished'];

let allRows = [];
let sheetTitle = '';
let header = [];
let formOpen = false;
let photoMap = {};  // filename → file id
let currentCat = 'เครื่องสำอาง';

// ── parse expiry: Google Sheets serial number, or "21/5/28" / "4/4/2027" ──
function parseExpiry(v) {
  if (v === null || v === undefined || v === '') return null;
  // Sheets UNFORMATTED_VALUE returns dates as serial numbers (days since 1899-12-30)
  if (typeof v === 'number' && isFinite(v) && v > 1000) {
    return new Date(Math.round((v - 25569) * 86400 * 1000));
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, a, b, y] = m.map(Number);
  if (y < 100) y += 2000;
  let day = a, month = b;
  if (month > 12 && day <= 12) { day = b; month = a; }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(y, month - 1, day);
}

// days left before an item turns red (soon) / orange (warn); food spoils fast so it gets a short window
const EXPIRY_RULES = {
  default: { soon: 30, warn: 90 },
  'ของกิน': { soon: 5, warn: 14 },
};

function expiryLevel(category, date) {
  const d = daysUntil(date);
  if (d === null) return '';
  const rule = EXPIRY_RULES[category] || EXPIRY_RULES.default;
  if (d < rule.soon) return 'soon';
  if (d < rule.warn) return 'warn';
  return '';
}

function daysUntil(date) {
  if (!date) return null;
  const now = new Date();
  return Math.floor((date - now) / (1000 * 60 * 60 * 24));
}

function fmtDate(d) {
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function render() {
  const search = document.getElementById('search').value.toLowerCase().trim();
  const statusFilter = document.getElementById('status-filter').value;
  const locFilter = document.getElementById('location-filter').value;

  let rows = allRows;
  if (currentCat !== '__all__') {
    rows = rows.filter(r => r.category === currentCat);
  }
  if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
  else rows = rows.filter(r => r.status !== 'Finished');
  if (locFilter) rows = rows.filter(r => r.location === locFilter);
  if (search) {
    rows = rows.filter(r =>
      r.name.toLowerCase().includes(search) ||
      r.location.toLowerCase().includes(search) ||
      r.batch.toLowerCase().includes(search) ||
      r.detail.toLowerCase().includes(search)
    );
  }

  // group: by Type, then by (Barcode + Name)
  const byType = new Map();
  for (const r of rows) {
    const type = r.type || '(ไม่ระบุ)';
    if (!byType.has(type)) byType.set(type, new Map());
    const key = `${r.barcode}|${r.name}`;
    const grp = byType.get(type);
    if (!grp.has(key)) grp.set(key, { key, name: r.name, items: [] });
    grp.get(key).items.push(r);
  }

  // refresh flat lookup for modal
  lastGroups = {};
  for (const grp of byType.values()) {
    for (const g of grp.values()) lastGroups[g.key] = g;
  }

  const sortedTypes = [...byType.keys()].sort((a, b) => a.localeCompare(b, 'th'));
  const content = document.getElementById('content');

  if (!sortedTypes.length) {
    content.className = 'empty';
    content.textContent = 'ไม่มีข้อมูล';
    return;
  }

  content.className = '';
  content.innerHTML = sortedTypes.map(type => {
    const groups = [...byType.get(type).values()];
    // total qty across all variants in this type
    const totalQty = groups.reduce((s, g) => s + g.items.reduce((q, i) => q + i.qty, 0), 0);
    return `
      <div class="type-group">
        <div class="type-header">
          <span class="type-name">${escapeHtml(type)}</span>
          <span class="type-count">${groups.length} รายการ · รวม ${totalQty} ชิ้น</span>
        </div>
        ${groups.map(g => renderItem(g)).join('')}
      </div>
    `;
  }).join('');
}

function photoUrl(photoPath) {
  if (!photoPath) return '';
  const filename = photoPath.split('/').pop();
  const id = photoMap[filename];
  return id ? `https://lh3.googleusercontent.com/d/${id}=w120` : '';
}

function renderItem(group) {
  // aggregate counts by status
  const counts = { Active: 0, Stock: 0, Finished: 0 };
  let earliestExpiry = null;
  const locations = new Set();
  let photoPath = '';
  for (const i of group.items) {
    if (counts[i.status] !== undefined) counts[i.status] += i.qty;
    else counts.Active += i.qty;
    if (i.expiryDate && (!earliestExpiry || i.expiryDate < earliestExpiry)) {
      earliestExpiry = i.expiryDate;
    }
    if (i.location) locations.add(i.location);
    if (!photoPath && i.photo) photoPath = i.photo;
  }

  const expiryClass = expiryLevel(group.items[0].category, earliestExpiry);

  const pills = [];
  if (counts.Active) pills.push(`<span class="pill active">${counts.Active} Active</span>`);
  if (counts.Stock) pills.push(`<span class="pill stock">${counts.Stock} Stock</span>`);
  if (counts.Finished) pills.push(`<span class="pill finished">${counts.Finished} Finished</span>`);

  const img = photoUrl(photoPath);
  const imgHtml = img
    ? `<img class="item-photo" src="${img}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
    : `<div class="item-photo"></div>`;

  return `
    <div class="item" data-key="${escapeHtml(group.key)}">
      ${imgHtml}
      <div class="item-main">
        <div class="item-name">${escapeHtml(group.name)}</div>
        <div class="count-pills">${pills.join('')}</div>
      </div>
      <div class="item-right">
        ${earliestExpiry ? `<div class="item-expiry ${expiryClass}">${fmtDate(earliestExpiry)}</div>` : ''}
        ${locations.size ? `<div class="item-loc">${[...locations].map(escapeHtml).join(', ')}</div>` : ''}
      </div>
    </div>
  `;
}

// keep a flat map of key → group for modal lookup
let lastGroups = {};

function openDetail(key) {
  const g = lastGroups[key];
  if (!g) return;
  stopScanner();
  const counts = { Active: 0, Stock: 0, Finished: 0 };
  for (const i of g.items) {
    if (counts[i.status] !== undefined) counts[i.status] += i.qty;
  }
  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ') || '—';

  const sorted = [...g.items].sort((a, b) => {
    if (a.expiryDate && b.expiryDate) return a.expiryDate - b.expiryDate;
    if (a.expiryDate) return -1;
    if (b.expiryDate) return 1;
    return 0;
  });

  const sample = g.items[0];
  const img = photoUrl(sample.photo);
  const rows = sorted.map(i => {
    const level = expiryLevel(i.category, i.expiryDate);
    const cls = level ? `expiry-${level}` : '';
    return `
      <tr data-row="${i.rowNumber}">
        <td>${escapeHtml(i.status)}</td>
        <td>${i.qty} ${escapeHtml(i.unit)}</td>
        <td class="${cls}">${i.expiryDate ? fmtDate(i.expiryDate) : '—'}</td>
        <td>${escapeHtml(i.location || '—')}</td>
        <td>${escapeHtml(i.batch || i.detail || '')}</td>
        <td class="edit-cell">✎</td>
      </tr>
    `;
  }).join('');

  document.getElementById('modal').innerHTML = `
    <button class="modal-close" id="modal-close-btn" aria-label="ปิด">×</button>
    <div class="modal-photo-wrap">
      ${img ? `<img class="modal-photo" src="${img.replace('=w120','=w600')}" referrerpolicy="no-referrer">` : ''}
    </div>
    <div class="modal-body">
      <div class="modal-field">
        <div class="label">Item Name</div>
        <div class="value">${escapeHtml(sample.name)}</div>
      </div>
      <div class="modal-field">
        <div class="label">Category · Type</div>
        <div class="value">${escapeHtml(sample.category)} · ${escapeHtml(sample.type || '—')}</div>
      </div>
      ${sample.barcode ? `
      <div class="modal-field">
        <div class="label">Barcode</div>
        <div class="value">${escapeHtml(sample.barcode)}</div>
      </div>` : ''}
      <div class="modal-field">
        <div class="label">Summary</div>
        <div class="value">${escapeHtml(summary)}</div>
      </div>
      <div class="modal-divider"></div>
      <table class="modal-table">
        <thead><tr><th>Status</th><th>Qty</th><th>Expiry</th><th>Location</th><th>Batch / Detail</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="modal-hint">แตะแถวเพื่อแก้ไขหรือลบ</div>
      <div class="modal-actions">
        <button class="btn btn-primary" id="add-variant-btn">+ เพิ่มชิ้นใหม่ของรายการนี้</button>
      </div>
    </div>
  `;
  showModal();
  formOpen = false;
  document.getElementById('modal-close-btn').onclick = closeDetail;
  document.querySelectorAll('#modal tbody tr').forEach(tr => {
    tr.onclick = () => {
      const row = allRows.find(r => r.rowNumber === Number(tr.dataset.row));
      if (row) openForm({ row, backKey: key });
    };
  });
  document.getElementById('add-variant-btn').onclick = () => {
    const { id, rowNumber, qty, status, expiryDate, expiryRaw, batch, detail, location, ...base } = sample;
    openForm({ template: { ...base, qty: 1, status: 'Stock', location }, backKey: key });
  };
}

// content scrolls inside the modal so the close button stays pinned to the modal's corner
function showModal() {
  const modal = document.getElementById('modal');
  const scroll = document.createElement('div');
  scroll.className = 'modal-scroll';
  [...modal.children].filter(c => !c.classList.contains('modal-close')).forEach(c => scroll.appendChild(c));
  modal.appendChild(scroll);
  document.getElementById('modal-backdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  stopScanner();
  formOpen = false;
  document.getElementById('modal-backdrop').classList.remove('open');
  document.body.style.overflow = '';
}

// ── edit / add form ──
function toInputDate(d) {
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


// select from existing values, with "+ เพิ่มใหม่…" swapping in a text box; the hidden input carries the form value
const NEW_OPTION = '__new__';

function typesFor(category) {
  return allRows.filter(r => r.category === category).map(r => r.type);
}

function pickOptions(values, current) {
  const opts = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'));
  if (current && !opts.includes(current)) opts.unshift(current);
  return '<option value="">— เลือก —</option>' +
    opts.map(o => `<option value="${escapeHtml(o)}"${o === current ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('') +
    `<option value="${NEW_OPTION}">+ เพิ่มใหม่…</option>`;
}

function pickHTML(name, values, current) {
  return `
    <div class="pick" data-pick="${name}">
      <select class="pick-select">${pickOptions(values, current || '')}</select>
      <div class="pick-new" hidden>
        <input class="pick-input" placeholder="พิมพ์ชื่อใหม่">
        <button type="button" class="pick-back" aria-label="กลับไปเลือกจากรายการ">×</button>
      </div>
      <input type="hidden" name="${name}" value="${escapeHtml(current || '')}">
    </div>`;
}

function initPick(root) {
  const sel = root.querySelector('.pick-select');
  const box = root.querySelector('.pick-new');
  const input = root.querySelector('.pick-input');
  const hidden = root.querySelector('input[type=hidden]');
  sel.onchange = () => {
    if (sel.value === NEW_OPTION) {
      sel.hidden = true;
      box.hidden = false;
      input.value = '';
      hidden.value = '';
      input.focus();
    } else {
      hidden.value = sel.value;
    }
  };
  input.oninput = () => { hidden.value = input.value.trim(); };
  root.querySelector('.pick-back').onclick = () => {
    box.hidden = true;
    sel.hidden = false;
    sel.value = '';
    hidden.value = '';
  };
}

function setPick(root, values, value) {
  root.querySelector('.pick-select').innerHTML = pickOptions(values, value || '');
  root.querySelector('.pick-select').hidden = false;
  root.querySelector('.pick-new').hidden = true;
  root.querySelector('input[type=hidden]').value = value || '';
}

function options(list, selected) {
  return list.map(v => `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

// opts: { row } to edit an existing row, { template } to add a new one, backKey = detail to return to
function openForm({ row, template, backKey }) {
  const isEdit = !!row;
  const cats = [...new Set([...categoryList(), ...Object.keys(CATEGORY_LABELS)])];
  const v = row || template || { category: currentCat === '__all__' ? cats[0] : currentCat, status: 'Stock', qty: 1 };
  const img = photoUrl(v.photo);
  formOpen = true;

  document.getElementById('modal').innerHTML = `
    <button class="modal-close" id="modal-close-btn" aria-label="ปิด">×</button>
    <form class="modal-body" id="item-form" style="padding-top:1.5rem" autocomplete="off">
      <div class="form-title">${isEdit ? 'แก้ไขรายการ' : 'เพิ่มรายการ'}</div>
      <div class="form-grid">
        <label class="full">Barcode
          <div class="barcode-row">
            <input name="barcode" id="barcode-input" inputmode="numeric" value="${escapeHtml(v.barcode || '')}">
            <button type="button" class="scan-icon" id="scan-btn" aria-label="สแกนบาร์โค้ด" title="สแกนบาร์โค้ด">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>
                <path d="M7 8v8M10 8v8M13 8v8M17 8v8"/>
              </svg>
            </button>
          </div>
        </label>
        <div class="full scanner-wrap" id="scanner-wrap" hidden>
          <div id="scanner"></div>
          <button type="button" class="btn" id="scan-stop-btn">ปิดกล้อง</button>
        </div>
        <div class="full barcode-note" id="barcode-note" hidden></div>
        <label class="full">Item Image
          <div class="photo-drop">
            <img id="photo-preview" ${img ? `src="${img.replace('=w120', '=w600')}"` : 'hidden'} referrerpolicy="no-referrer">
            <span class="photo-hint" id="photo-hint">${img ? 'แตะเพื่อเปลี่ยนรูป' : '+ แตะเพื่อเลือกรูป'}</span>
          </div>
          <input type="file" accept="image/*" id="photo-input" hidden>
        </label>
        <label class="full">Item Name
          <input name="name" required value="${escapeHtml(v.name || '')}">
        </label>
        <label>Category
          <select name="category">${options(cats, v.category)}</select>
        </label>
        <label>Type
          ${pickHTML('type', typesFor(v.category), v.type)}
        </label>
        <label>Status
          <select name="status">${options(STATUSES, v.status)}</select>
        </label>
        <label>Location
          ${pickHTML('location', allRows.map(r => r.location), v.location)}
        </label>
        <label>Qty
          <input name="qty" type="number" min="0" step="1" inputmode="numeric" value="${v.qty ?? 1}">
        </label>
        <label>Unit
          ${pickHTML('unit', allRows.map(r => r.unit), v.unit)}
        </label>
        <label>Expiry Date
          <input name="expiry" type="date" value="${toInputDate(v.expiryDate)}">
        </label>
        <label>Price
          <input name="price" type="number" min="0" step="any" inputmode="decimal" value="${escapeHtml(v.price ?? '')}">
        </label>
        <label>Batch Code
          <input name="batch" value="${escapeHtml(v.batch || '')}">
        </label>
        <label>Detail
          <input name="detail" value="${escapeHtml(v.detail || '')}">
        </label>
      </div>
      <div id="form-error"></div>
      <div class="modal-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger" id="delete-btn">ลบ</button>' : ''}
        <button type="button" class="btn" id="cancel-btn">ยกเลิก</button>
        <button type="submit" class="btn btn-primary" id="save-btn">บันทึก</button>
      </div>
    </form>
  `;
  showModal();

  let photoBlob = null;
  let currentPhoto = v.photo || '';
  const form = document.getElementById('item-form');
  const back = () => (backKey && lastGroups[backKey] ? openDetail(backKey) : closeDetail());

  const typePick = form.querySelector('[data-pick="type"]');
  form.querySelectorAll('.pick').forEach(initPick);
  form.elements.category.addEventListener('change', () => {
    if (!typePick.querySelector('.pick-new').hidden) return;   // keep a type the user is typing
    const types = typesFor(form.elements.category.value);
    const cur = typePick.querySelector('input[type=hidden]').value;
    setPick(typePick, types, types.includes(cur) ? cur : '');
  });

  // fills name/category/type/unit/photo from an earlier row with the same barcode (new items only)
  function applyBarcode(code) {
    code = code.trim();
    form.elements.barcode.value = code;
    const note = document.getElementById('barcode-note');
    if (isEdit || !code) { note.hidden = true; return; }
    const matches = allRows.filter(r => r.barcode === code);
    if (!matches.length) {
      note.hidden = false;
      note.textContent = 'ยังไม่มี barcode นี้ในชีท กรอกข้อมูลใหม่ได้เลย';
      return;
    }
    const m = matches.find(r => r.photo) || matches[0];
    form.elements.namedItem("name").value = m.name;
    if ([...form.elements.category.options].some(o => o.value === m.category)) form.elements.category.value = m.category;
    setPick(typePick, typesFor(form.elements.category.value), m.type);
    setPick(form.querySelector('[data-pick="unit"]'), allRows.map(r => r.unit), m.unit);
    if (!photoBlob && m.photo) {
      currentPhoto = m.photo;
      const url = photoUrl(m.photo);
      const preview = document.getElementById('photo-preview');
      if (url) {
        preview.src = url.replace('=w120', '=w600');
        preview.hidden = false;
        document.getElementById('photo-hint').textContent = 'แตะเพื่อเปลี่ยนรูป';
      }
    }
    note.hidden = false;
    note.textContent = `เจอข้อมูลเดิม: ${m.name} กรอกให้แล้ว`;
  }

  form.elements.barcode.addEventListener('change', e => applyBarcode(e.target.value));
  document.getElementById('scan-btn').onclick = () => startScanner(code => applyBarcode(code));
  document.getElementById('scan-stop-btn').onclick = stopScanner;
  document.getElementById('modal-close-btn').onclick = closeDetail;
  document.getElementById('cancel-btn').onclick = back;

  document.getElementById('photo-input').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    photoBlob = await compressImage(file);
    const preview = document.getElementById('photo-preview');
    preview.src = URL.createObjectURL(photoBlob);
    preview.hidden = false;
    document.getElementById('photo-hint').textContent = 'แตะเพื่อเปลี่ยนรูป';
  };

  document.getElementById('item-form').onsubmit = e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    runWrite(() => saveItem(row, fd, photoBlob, currentPhoto));
  };

  if (isEdit) {
    document.getElementById('delete-btn').onclick = () => {
      if (!confirm(`ลบ "${row.name}" (${row.status}, ${row.qty} ${row.unit}) ออกจากชีท?`)) return;
      runWrite(() => MeNoteAuth.deleteRow(SHEET_ID, sheetTitle, row.rowNumber));
    };
  }
}

// ── barcode scanner ──
// zxing-cpp (wasm) via the barcode-detector ponyfill: Safari has no native BarcodeDetector,
// and pure-JS decoders miss thin retail barcodes too often.
let scanner = null;   // { stream, stopped }
let detectorPromise = null;

function getDetector() {
  detectorPromise = detectorPromise || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js';
    s.onload = () => resolve(new BarcodeDetectionAPI.BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'],
    }));
    s.onerror = () => { detectorPromise = null; reject(new Error('โหลดตัวสแกนไม่สำเร็จ')); };
    document.head.appendChild(s);
  });
  return detectorPromise;
}

async function startScanner(onCode) {
  const wrap = document.getElementById('scanner-wrap');
  const box = document.getElementById('scanner');
  const note = document.getElementById('barcode-note');
  await stopScanner();
  const session = { stream: null, stopped: false };
  scanner = session;
  try {
    const [detector, stream] = await Promise.all([
      getDetector(),
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      }),
    ]);
    session.stream = stream;
    if (session.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
    const track = stream.getVideoTracks()[0];
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});

    box.innerHTML = '<video playsinline muted autoplay></video><div class="scan-guide"></div>';
    const video = box.querySelector('video');
    video.srcObject = stream;
    wrap.hidden = false;
    note.hidden = true;
    await video.play();

    // decode only the band inside the guide: smaller frames decode faster and ignore nearby text
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    while (!session.stopped) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh) {
        const cw = Math.round(vw * 0.9), ch = Math.round(vh * 0.45);
        canvas.width = cw;
        canvas.height = ch;
        ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, cw, ch);
        const found = await detector.detect(canvas).catch(() => []);
        if (session.stopped) return;
        if (found.length) {
          if (navigator.vibrate) navigator.vibrate(60);
          await stopScanner();
          onCode(found[0].rawValue);
          return;
        }
      }
      await new Promise(r => setTimeout(r, 80));
    }
  } catch (err) {
    console.error(err);
    if (scanner !== session) return;
    await stopScanner();
    note.hidden = false;
    note.textContent = 'เปิดกล้องไม่ได้: ' + (err.message || err);
  }
}

async function stopScanner() {
  const s = scanner;
  scanner = null;
  const wrap = document.getElementById('scanner-wrap');
  if (wrap) wrap.hidden = true;
  const box = document.getElementById('scanner');
  if (box) box.innerHTML = '';
  if (!s) return;
  s.stopped = true;
  if (s.stream) s.stream.getTracks().forEach(t => t.stop());
}

async function runWrite(fn) {
  const buttons = document.querySelectorAll('#modal button');
  const saveBtn = document.getElementById('save-btn');
  const errBox = document.getElementById('form-error');
  buttons.forEach(b => (b.disabled = true));
  if (saveBtn) saveBtn.textContent = 'กำลังบันทึก…';
  errBox.innerHTML = '';
  try {
    await fn();
    await reload();
    closeDetail();
  } catch (err) {
    console.error(err);
    errBox.innerHTML = `<div class="form-error">บันทึกไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    buttons.forEach(b => (b.disabled = false));
    if (saveBtn) saveBtn.textContent = 'บันทึก';
  }
}

function compressImage(file, maxSide = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('แปลงรูปไม่สำเร็จ'))), 'image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('อ่านไฟล์รูปไม่ได้'));
    img.src = URL.createObjectURL(file);
  });
}

function newItemId() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function colLetter(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// leading apostrophe keeps codes like barcodes as text instead of numbers
const asText = s => (s ? `'${s}` : '');

async function saveItem(row, fd, photoBlob, existingPhoto) {
  const itemId = row ? row.id : newItemId();
  let photo = existingPhoto || '';
  if (photoBlob) {
    const safeName = fd.name.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 20).trim();
    const filename = `${itemId}${fd.barcode}${safeName}.Photo.${Date.now()}.jpg`;
    const file = await MeNoteAuth.uploadToDrive(PHOTO_FOLDER_ID, photoBlob, filename);
    photoMap[file.name] = file.id;
    try { sessionStorage.setItem(PHOTO_MAP_CACHE_KEY, JSON.stringify(photoMap)); } catch {}
    photo = PHOTO_PREFIX + file.name;
  }

  const fields = {
    'Item Name': fd.name.trim(),
    'Barcode': asText(fd.barcode.trim()),
    'Category': fd.category,
    'Type': fd.type.trim(),
    'Qty': fd.qty === '' ? '' : Number(fd.qty),
    'Unit': fd.unit.trim(),
    'Status': fd.status,
    'Expiry Date': fd.expiry,
    'Photo': photo,
    'Price': fd.price === '' ? '' : Number(fd.price),
    'Location': fd.location.trim(),
    'Batch Code': asText(fd.batch.trim()),
    'Detail': fd.detail.trim(),
    'last update': nowStamp(),
  };

  const sheetRef = `'${sheetTitle.replace(/'/g, "''")}'`;
  if (row) {
    const data = Object.entries(fields)
      .filter(([col]) => header.indexOf(col) >= 0)
      .map(([col, val]) => ({
        range: `${sheetRef}!${colLetter(header.indexOf(col))}${row.rowNumber}`,
        values: [[val]],
      }));
    await MeNoteAuth.updateCells(SHEET_ID, data);
  } else {
    const newRow = header.map(() => '');
    newRow[header.indexOf('Item ID')] = itemId;
    for (const [col, val] of Object.entries(fields)) {
      const i = header.indexOf(col);
      if (i >= 0) newRow[i] = val;
    }
    await MeNoteAuth.appendRow(SHEET_ID, sheetTitle, newRow);
  }
}

async function reload() {
  const data = await MeNoteAuth.fetchAllSheets(SHEET_ID);
  handleData(data);
}

function renderSummary() {
  const totals = { active: 0, stock: 0, finished: 0, expiringSoon: 0 };
  for (const r of allRows) {
    if (r.status === 'Active') totals.active += r.qty;
    else if (r.status === 'Stock') totals.stock += r.qty;
    else if (r.status === 'Finished') totals.finished += r.qty;
    const d = daysUntil(r.expiryDate);
    if (r.status !== 'Finished' && d !== null && d >= 0 && expiryLevel(r.category, r.expiryDate) === 'soon') {
      totals.expiringSoon += r.qty;
    }
  }
  document.getElementById('summary').innerHTML = `
    <div class="stat ok">
      <div class="label">Active</div>
      <div class="value">${totals.active}</div>
    </div>
    <div class="stat">
      <div class="label">Stock</div>
      <div class="value">${totals.stock}</div>
    </div>
    <div class="stat alert">
      <div class="label">Expiring soon</div>
      <div class="value">${totals.expiringSoon}</div>
    </div>
    <div class="stat">
      <div class="label">Finished</div>
      <div class="value">${totals.finished}</div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function rowsFromSheet(values) {
  if (!values || !values.length) return [];
  header = values[0].map(h => String(h).trim());
  const idx = name => header.indexOf(name);
  return values
    .map((r, i) => ({ r, rowNumber: i + 1 }))
    .slice(1)
    .filter(({ r }) => r[idx('Item ID')])
    .map(({ r, rowNumber }) => ({
      rowNumber,
      id: r[idx('Item ID')] || '',
      barcode: String(r[idx('Barcode')] || ''),
      name: r[idx('Item Name')] || '',
      category: r[idx('Category')] || '',
      type: r[idx('Type')] || '',
      qty: parseInt(r[idx('Qty')]) || 0,
      unit: r[idx('Unit')] || '',
      status: r[idx('Status')] || '',
      expiryRaw: r[idx('Expiry Date')] ?? '',
      expiryDate: parseExpiry(r[idx('Expiry Date')]),
      photo: r[idx('Photo')] || '',
      price: r[idx('Price')] || '',
      location: r[idx('Location')] || '',
      batch: String(r[idx('Batch Code')] || ''),
      detail: r[idx('Detail')] || '',
    }));
}

async function loadPhotoMap() {
  // cache for the session — folder rarely changes during a viewing
  try {
    const cached = sessionStorage.getItem(PHOTO_MAP_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch {}
  try {
    const files = await MeNoteAuth.fetchDriveFolderFiles(PHOTO_FOLDER_ID);
    const map = {};
    for (const f of files) map[f.name] = f.id;
    if (Object.keys(map).length) {
      try { sessionStorage.setItem(PHOTO_MAP_CACHE_KEY, JSON.stringify(map)); } catch {}
    }
    console.log(`Loaded ${Object.keys(map).length} photos from Drive folder`);
    return map;
  } catch (e) {
    console.warn('Photo folder fetch failed (token may need re-auth for Drive scope):', e);
    // wipe stored token so next reload re-prompts with new scope
    MeNoteAuth.signOut();
    return {};
  }
}

function handleData(data) {
  // pick first sheet that has Item ID header
  let values = null;
  for (const name of Object.keys(data)) {
    const v = data[name];
    if (v && v.length && v[0].includes('Item ID')) { values = v; sheetTitle = name; break; }
  }
  if (!values) {
    const content = document.getElementById('content');
    content.className = 'error';
    content.textContent = 'ไม่เจอแท็บที่มีคอลัมน์ "Item ID" ในชีท';
    return;
  }
  allRows = rowsFromSheet(values);

  // populate location filter
  const locs = [...new Set(allRows.map(r => r.location).filter(Boolean))].sort();
  const locSel = document.getElementById('location-filter');
  const prevLoc = locSel.value;
  locSel.innerHTML = '<option value="">All locations</option>';
  for (const l of locs) {
    const o = document.createElement('option');
    o.value = l; o.textContent = l;
    locSel.appendChild(o);
  }
  if (locs.includes(prevLoc)) locSel.value = prevLoc;
  document.getElementById('fab-add').hidden = false;

  renderTabs();
  renderSummary();
  render();

  // fetch photos in background; re-render when ready
  loadPhotoMap().then(map => {
    photoMap = map;
    render();
  });
}

function load() {
  const content = document.getElementById('content');
  MeNoteAuth.loadAllSheets(SHEET_ID, content, handleData);
}

// events
document.getElementById('tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (!t) return;
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  currentCat = t.dataset.cat;
  render();
});
document.getElementById('search').addEventListener('input', render);
document.getElementById('status-filter').addEventListener('change', render);
document.getElementById('location-filter').addEventListener('change', render);

// open detail on item click (delegated)
document.getElementById('content').addEventListener('click', e => {
  const item = e.target.closest('.item');
  if (item && item.dataset.key) openDetail(item.dataset.key);
});
// close modal on backdrop click or Esc
// forms ignore backdrop/Esc so a stray tap doesn't drop what was typed
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target.id === 'modal-backdrop' && !formOpen) closeDetail();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !formOpen) closeDetail();
});
document.getElementById('fab-add').addEventListener('click', () => openForm({}));

// ── pull to refresh: re-fetches sheet + photo list without reloading the page ──
(function setupPullToRefresh() {
  const ptr = document.getElementById('ptr');
  const icon = document.getElementById('ptr-icon');
  const text = document.getElementById('ptr-text');
  const THRESHOLD = 70;
  let startY = null, pull = 0, busy = false;

  const canPull = () =>
    !busy && window.scrollY <= 0 &&
    !document.getElementById('modal-backdrop').classList.contains('open') &&
    !document.getElementById('fab-add').hidden;   // data has loaded (signed in)

  function show(offset, state) {
    ptr.classList.toggle('ready', state === 'ready');
    ptr.classList.toggle('loading', state === 'loading');
    icon.textContent = state === 'loading' ? '↻' : '↓';
    text.textContent = { pull: 'ดึงลงเพื่อรีเฟรช', ready: 'ปล่อยเพื่อรีเฟรช', loading: 'กำลังโหลด…' }[state] || state;
    ptr.style.transform = `translate(-50%, ${offset}px)`;
    ptr.style.opacity = offset > -40 ? 1 : 0;
  }

  function hide() {
    ptr.classList.add('animate');
    ptr.style.transform = 'translate(-50%, -60px)';
    ptr.style.opacity = 0;
  }

  window.addEventListener('touchstart', e => {
    if (!canPull() || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    pull = 0;
    ptr.classList.remove('animate');
  }, { passive: true });

  window.addEventListener('touchmove', e => {
    if (startY === null) return;
    pull = Math.max(0, e.touches[0].clientY - startY);
    if (window.scrollY > 0) { startY = null; hide(); return; }
    const offset = Math.min(pull * 0.5, 90) - 50;
    show(offset, pull > THRESHOLD ? 'ready' : 'pull');
  }, { passive: true });

  window.addEventListener('touchend', async () => {
    if (startY === null) return;
    startY = null;
    if (pull <= THRESHOLD) { hide(); return; }
    busy = true;
    ptr.classList.add('animate');
    show(16, 'loading');
    try {
      try { sessionStorage.removeItem(PHOTO_MAP_CACHE_KEY); } catch {}
      await reload();
      hide();
    } catch (err) {
      console.error(err);
      show(16, 'รีเฟรชไม่สำเร็จ');
      setTimeout(hide, 2000);
    } finally {
      busy = false;
    }
  });
})();

load();
