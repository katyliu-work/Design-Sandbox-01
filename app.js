'use strict';

/* ============================================================
   Module state
   ============================================================ */
let selected = null;       // currently selected element inside the iframe
let editMode = true;       // true = clicks select elements; false = page's own interactivity runs
let sbxCounter = 0;        // for generating unique data-sbx-id values
let ruleMap = {};          // sbx-id -> generated hover CSS rule text
let historyStack = [];     // undo stack of full-document HTML snapshots
let sourceUrl = null;      // URL the current document was fetched from, if any

let layouts = [];          // [{id, name, html, sourceUrl}] — independent full-page versions
let activeLayoutIndex = -1;
let addingNewLayout = false; // true while the empty screen is being used to add another layout, not start over

let stylePresets = [];     // [{id, name, tokens: {cssVarName: value}}] — saved Design Token sets

const frame = () => document.getElementById('previewFrame');

/* ============================================================
   Router — each screen is addressable as its own URL (#/state)
   ============================================================ */
const STATES = ['empty', 'importing', 'error', 'workspace'];

function setState(name) {
  document.querySelectorAll('.state').forEach(s => s.classList.remove('active'));
  document.querySelector(`.state[data-state="${name}"]`).classList.add('active');
  if (location.hash !== `#/${name}`) location.hash = `/${name}`;
}

function syncFromHash() {
  const name = (location.hash || '').replace('#/', '');
  if (STATES.includes(name)) setState(name);
}
window.addEventListener('hashchange', syncFromHash);

/* ============================================================
   Import (URL fetch / file upload / pasted source)
   ============================================================ */
function importFromUrl() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) return;
  setState('importing');
  fetch(url)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text().then(html => handleImportedHtml(html, r.url)); })
    .catch(err => showImportError(
      `讀不到這個網址的內容（${err.message}）。通常是對方網站設定不允許被其他網頁讀取——這是瀏覽器的安全機制，不是這個工具的問題，也沒辦法從這裡繞過去。` +
      `建議改用「上傳 HTML 檔案」或「貼上 HTML 原始碼」，這兩種方式完全不受影響。`
    ));
}

function importFromFile(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  setState('importing');
  const reader = new FileReader();
  reader.onload = e => handleImportedHtml(e.target.result);
  reader.onerror = () => showImportError('檔案讀取失敗，請確認檔案格式為 .html。');
  reader.readAsText(file);
  evt.target.value = ''; // allow re-selecting the same file later
}

function importFromPaste() {
  const html = document.getElementById('pasteInput').value;
  if (!html.trim()) return;
  setState('importing');
  handleImportedHtml(html);
}

function showImportError(message) {
  document.getElementById('errorMsg').textContent = message;
  setState('error');
}

// Decide what an incoming document means: the very first import (or an
// explicit restart) replaces everything and starts a single-layout session;
// while the empty screen is open in "add layout" mode, it instead joins the
// existing set as a new tab.
function handleImportedHtml(html, url) {
  if (addingNewLayout) {
    addingNewLayout = false;
    addLayout(html, url);
  } else {
    layouts = [{ id: makeId(), name: '版面1', html, sourceUrl: url || null }];
    activeLayoutIndex = 0;
    stylePresets = [];
    renderStylePresets();
    loadIntoFrame(html, url);
    renderLayoutTabs();
  }
}

const makeId = () => `id-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/* ============================================================
   Iframe lifecycle
   ------------------------------------------------------------
   IMPORTANT: once an iframe's `srcdoc` has been set, the browser
   ignores any later change to `src` while srcdoc is still present
   (srcdoc always wins per spec). So reloading — for a second
   import, or to restore an undo snapshot — requires removing the
   srcdoc attribute *before* navigating to about:blank, or the
   "reload" silently does nothing and onload never fires again.
   ============================================================ */
function reloadFrame(html, mode) {
  // mode: 'import' = brand-new document, resets everything, opens the workspace
  //       'switch'  = jumping to a different layout tab, resets undo history only
  //       'undo'    = restoring a snapshot, keeps everything else as-is
  const f = frame();
  const isRestore = mode !== 'import'; // 'switch' and 'undo' both reuse an existing document as-is

  if (mode === 'import') {
    selected = null;
    ruleMap = {};
    sbxCounter = 0;
    historyStack = [];
    updateUndoButton();
    setEditMode('edit');
  } else if (mode === 'switch') {
    // Per-layout undo history isn't kept across tab switches — each layout
    // starts its own clean history when you arrive at it. ruleMap/sbxCounter
    // are rebuilt from the document itself in setupFrame, same as undo.
    historyStack = [];
    updateUndoButton();
    clearSelection();
  } else {
    clearSelection();
  }

  f.removeAttribute('srcdoc');
  f.onload = () => {
    f.onload = () => {
      setupFrame(f, isRestore);
      if (mode === 'import') setState('workspace');
      if (mode === 'switch') { setState('workspace'); renderLayoutTabs(); }
    };
    f.srcdoc = html;
  };
  f.src = 'about:blank';
}

function loadIntoFrame(html, url) {
  sourceUrl = url || null;
  reloadFrame(html, 'import');
}
const restoreDoc = html => reloadFrame(html, 'undo');

function addLayout(html, url) {
  layouts.push({ id: makeId(), name: `版面${layouts.length + 1}`, html, sourceUrl: url || null });
  switchToLayout(layouts.length - 1);
}

function switchToLayout(index) {
  if (index === activeLayoutIndex) return;
  // save in-progress edits back into the layout we're leaving
  if (activeLayoutIndex >= 0) {
    const doc = frame().contentDocument;
    if (doc?.documentElement) layouts[activeLayoutIndex].html = doc.documentElement.outerHTML;
  }
  activeLayoutIndex = index;
  sourceUrl = layouts[index].sourceUrl;
  reloadFrame(layouts[index].html, 'switch');
}

function startAddLayout() {
  addingNewLayout = true;
  document.getElementById('emptyTitle').textContent = '新增另一個版面';
  setState('empty');
}

function renderLayoutTabs() {
  const wrap = document.getElementById('layoutTabs');
  wrap.innerHTML = '';
  layouts.forEach((layout, i) => {
    const btn = document.createElement('button');
    btn.className = 'layout-tab' + (i === activeLayoutIndex ? ' active' : '');
    btn.textContent = layout.name;
    btn.title = '雙擊可重新命名';
    btn.addEventListener('click', () => switchToLayout(i));
    btn.addEventListener('dblclick', () => renameLayout(i));
    wrap.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'layout-tab-add';
  addBtn.textContent = '+';
  addBtn.title = '新增版面';
  addBtn.addEventListener('click', startAddLayout);
  wrap.appendChild(addBtn);
}

function renameLayout(index) {
  const name = window.prompt('幫這個版面取個名字', layouts[index].name);
  if (name && name.trim()) {
    layouts[index].name = name.trim();
    renderLayoutTabs();
  }
}

function setupFrame(f, isRestore) {
  const doc = f.contentDocument;

  // srcdoc documents have no base URL of their own, so relative asset paths
  // (css/img/script src) in the loaded page would otherwise fail to resolve.
  // A restored snapshot already carries this tag from the original load.
  if (!isRestore && sourceUrl && !doc.head.querySelector('base')) {
    const base = doc.createElement('base');
    base.href = sourceUrl;
    base.dataset.sbxInjected = '1';
    doc.head.insertBefore(base, doc.head.firstChild);
  }

  if (!doc.head.querySelector('link[data-sbx-font]')) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.sbxFont = '1';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@500;600;700&display=swap';
    doc.head.appendChild(link);
  }

  if (!doc.getElementById('sbx-base-style')) {
    const style = doc.createElement('style');
    style.id = 'sbx-base-style';
    style.textContent = '.sbx-selected{outline:2px solid #1F3A3D !important; outline-offset:2px;}';
    doc.head.appendChild(style);
  }

  let dyn = doc.getElementById('sbx-dynamic-rules');
  if (!dyn) {
    dyn = doc.createElement('style');
    dyn.id = 'sbx-dynamic-rules';
    doc.head.appendChild(dyn);
  }

  doc.body.addEventListener('click', e => {
    if (!editMode) return; // preview mode: let the page's own JS handle the click
    e.preventDefault();
    e.stopPropagation();
    selectElement(e.target);
  }, true);

  isRestore ? syncStateFromDoc(doc, dyn) : detectTokens(doc);
  clearSelection();
}

// After restoring a snapshot, rebuild sbxCounter (avoid id collisions) and
// ruleMap (so future hover edits don't wipe out restored hover rules).
function syncStateFromDoc(doc, dynStyleEl) {
  let maxId = 0;
  doc.querySelectorAll('[data-sbx-id]').forEach(el => {
    const n = parseInt((el.dataset.sbxId || '').replace('sbx-', ''), 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  });
  sbxCounter = maxId;

  ruleMap = {};
  const re = /\[data-sbx-id="([^"]+)"\]:hover\{ background-color:([^;]+) !important; \}/g;
  let m;
  while ((m = re.exec(dynStyleEl.textContent || '')) !== null) ruleMap[m[1]] = m[0];

  detectTokens(doc);
}

/* ============================================================
   Selection & field population
   ============================================================ */
function selectElement(el) {
  const doc = frame().contentDocument;
  if (el === doc.documentElement || el === doc.body) return;

  pushHistory(); // checkpoint: state right before editing this element

  if (selected) selected.classList.remove('sbx-selected');
  selected = el;
  if (!selected.dataset.sbxId) selected.dataset.sbxId = `sbx-${++sbxCounter}`;
  selected.classList.add('sbx-selected');

  document.getElementById('emptyHint').classList.add('hidden');
  document.getElementById('fieldsWrap').classList.remove('hidden');
  const info = document.getElementById('selInfo');
  info.classList.remove('hidden');
  info.textContent = `<${el.tagName.toLowerCase()}${el.className ? ` class="${el.className}"` : ''}>`;

  populateFields(el);
}

function setEditMode(mode) {
  editMode = mode === 'edit';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('modeHint').textContent = editMode
    ? '點擊畫面中的元素即可選取並調整樣式'
    : '預覽模式：畫面中的按鈕、分頁、勾選框等互動會照原本網頁的設計運作';
  if (!editMode) clearSelection();
}

function clearSelection() {
  selected = null;
  document.getElementById('emptyHint').classList.remove('hidden');
  document.getElementById('fieldsWrap').classList.add('hidden');
  document.getElementById('selInfo').classList.add('hidden');
}

function populateFields(el) {
  const cs = getComputedStyle(el);
  const set = (id, val) => { document.getElementById(id).value = val; };

  set('f-bg', rgbToHex(cs.backgroundColor) || '#ffffff');
  set('f-color', rgbToHex(cs.color) || '#000000');
  set('f-border', rgbToHex(cs.borderColor) || '#cccccc');
  set('f-font', '');

  const size = parseInt(cs.fontSize) || 16;
  set('f-size', size);
  document.getElementById('f-size-val').textContent = `${size}px`;
  set('f-weight', normalizeWeight(cs.fontWeight));

  const pad = parseInt(cs.paddingTop) || 0;
  set('f-pad', pad);
  document.getElementById('f-pad-val').textContent = `${pad}px`;

  const mar = parseInt(cs.marginTop) || 0;
  set('f-mar', mar);
  document.getElementById('f-mar-val').textContent = `${mar}px`;

  const width = el.style.width || '';
  const widthMatch = width.match(/^([\d.]+)(px|%)$/);
  set('f-width-mode', widthMatch ? widthMatch[2] : '');
  document.getElementById('widthValueWrap').classList.toggle('hidden', !widthMatch);
  set('f-width-value', widthMatch ? widthMatch[1] : '');
  document.getElementById('f-width-unit').textContent = widthMatch ? widthMatch[2] : '';
  set('f-hover', '#e7eeed');
  set('f-trans', 0);
  document.getElementById('f-trans-val').textContent = '0ms';
  set('f-class', el.className.replace('sbx-selected', '').trim());
  set('f-id', el.id || '');

  document.querySelectorAll('#alignGroup button').forEach(b =>
    b.classList.toggle('active', b.dataset.align === cs.textAlign)
  );

  const isFlex = cs.display === 'flex';
  document.getElementById('f-flex').checked = isFlex;
  document.getElementById('flexControls').classList.toggle('hidden', !isFlex);

  const isLeaf = el.children.length === 0;
  document.getElementById('textFieldWrap').classList.toggle('hidden', !isLeaf);
  if (isLeaf) set('f-text', el.textContent);

  const isImg = el.tagName === 'IMG';
  document.getElementById('imgFieldWrap').classList.toggle('hidden', !isImg);
  if (isImg) set('f-imgsrc', el.getAttribute('src') || '');

  const isLink = el.tagName === 'A';
  document.getElementById('hrefFieldWrap').classList.toggle('hidden', !isLink);
  if (isLink) set('f-href', el.getAttribute('href') || '');
}

/* ============================================================
   Field → style/attribute application
   ============================================================ */
function applyStyle(prop, val) { if (selected) selected.style[prop] = val; }

function applyAttr(name, val) {
  if (!selected) return;
  val === '' ? selected.removeAttribute(name) : selected.setAttribute(name, val);
}

function applyBorderColor(val) {
  if (!selected) return;
  const cs = getComputedStyle(selected);
  if (cs.borderStyle === 'none') selected.style.borderStyle = 'solid';
  if (parseInt(cs.borderWidth) === 0) selected.style.borderWidth = '1px';
  selected.style.borderColor = val;
}

function applyFontSize(v) {
  applyStyle('fontSize', `${v}px`);
  document.getElementById('f-size-val').textContent = `${v}px`;
}

function applyPadding(v) {
  applyStyle('padding', `${v}px`);
  document.getElementById('f-pad-val').textContent = `${v}px`;
}

function applyMargin(v) {
  if (selected) { selected.style.marginTop = `${v}px`; selected.style.marginBottom = `${v}px`; }
  document.getElementById('f-mar-val').textContent = `${v}px`;
}

function applyWidthMode(mode) {
  document.getElementById('widthValueWrap').classList.toggle('hidden', !mode);
  document.getElementById('f-width-unit').textContent = mode;
  if (!mode) { applyStyle('width', ''); return; }
  const val = document.getElementById('f-width-value').value;
  if (val !== '') applyStyle('width', `${val}${mode}`);
}

function applyWidthValue(val) {
  const mode = document.getElementById('f-width-mode').value;
  if (mode && val !== '') applyStyle('width', `${val}${mode}`);
}

function applyAlign(value, btn) {
  applyStyle('textAlign', value);
  document.querySelectorAll('#alignGroup button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function applyFlex(on) {
  applyStyle('display', on ? 'flex' : '');
  document.getElementById('flexControls').classList.toggle('hidden', !on);
}

function applyText(val) { if (selected) selected.textContent = val; }

function applyTransition(v) {
  applyStyle('transition', `all ${v}ms ease`);
  document.getElementById('f-trans-val').textContent = `${v}ms`;
}

function applyHover(color) {
  if (!selected) return;
  const id = selected.dataset.sbxId;
  ruleMap[id] = `[data-sbx-id="${id}"]:hover{ background-color:${color} !important; }`;
  frame().contentDocument.getElementById('sbx-dynamic-rules').textContent = Object.values(ruleMap).join('\n');
}

/* ---- element operations (each is a one-shot undo checkpoint) ---- */
function moveEl(dir) {
  if (!selected?.parentElement) return;
  pushHistory();
  const sib = dir === -1 ? selected.previousElementSibling : selected.nextElementSibling;
  if (!sib) return;
  dir === -1
    ? selected.parentElement.insertBefore(selected, sib)
    : selected.parentElement.insertBefore(sib, selected);
}

function duplicateEl() {
  if (!selected) return;
  pushHistory();
  const clone = selected.cloneNode(true);
  clone.classList.remove('sbx-selected');
  delete clone.dataset.sbxId;
  selected.parentElement.insertBefore(clone, selected.nextSibling);
}

function deleteEl() {
  if (!selected) return;
  pushHistory();
  selected.remove();
  clearSelection();
}

/* ============================================================
   Design tokens (CSS custom properties on :root)
   ============================================================ */
// Collects the :root custom-property names declared in the document's own
// stylesheets, then reads their *current effective* values via computed
// style — so already-applied overrides (from this panel or an applied style
// preset) are captured correctly, not just each variable's original default.
function readRootTokens(doc) {
  const names = new Set();
  try {
    for (const sheet of doc.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText === ':root') {
            for (const name of rule.style) if (name.startsWith('--')) names.add(name);
          }
        }
      } catch { /* cross-origin sheet — can't read its rules, skip */ }
    }
  } catch { /* no stylesheets */ }

  const cs = doc.defaultView.getComputedStyle(doc.documentElement);
  const tokens = {};
  names.forEach(name => { tokens[name] = cs.getPropertyValue(name).trim(); });
  return tokens;
}

function detectTokens(doc) {
  const tokens = readRootTokens(doc);
  const section = document.getElementById('tokensSection');
  const body = document.getElementById('tokensBody');
  body.innerHTML = '';

  const names = Object.keys(tokens);
  section.classList.toggle('hidden', names.length === 0);

  names.forEach(name => {
    const row = document.createElement('label');
    row.className = 'field';
    row.innerHTML = `<span>${name}</span><input type="text" value="${tokens[name]}">`;
    row.querySelector('input').addEventListener('change', e =>
      doc.documentElement.style.setProperty(name, e.target.value)
    );
    body.appendChild(row);
  });
}

/* ============================================================
   Style presets — a named snapshot of the current page's CSS
   custom properties (Design Tokens), reapplicable to whichever
   layout is currently open.
   ============================================================ */
function saveStylePreset() {
  const doc = frame().contentDocument;
  const tokens = readRootTokens(doc);
  if (Object.keys(tokens).length === 0) {
    alert('這個版面沒有偵測到共用的顏色／數值設定（CSS 自訂變數），沒有東西可以存成風格。');
    return;
  }
  const name = window.prompt('幫這組風格取個名字', `風格${stylePresets.length + 1}`);
  if (!name || !name.trim()) return;
  stylePresets.push({ id: makeId(), name: name.trim(), tokens });
  renderStylePresets(stylePresets[stylePresets.length - 1].id);
}

function applyStylePreset(id) {
  if (!id) return;
  const preset = stylePresets.find(p => p.id === id);
  if (!preset) return;
  const doc = frame().contentDocument;
  Object.entries(preset.tokens).forEach(([name, value]) => doc.documentElement.style.setProperty(name, value));
  detectTokens(doc); // refresh the Design Tokens panel to reflect the applied values
}

function renderStylePresets(selectedId) {
  const select = document.getElementById('stylePresetSelect');
  select.innerHTML = '<option value="">套用風格…</option>' +
    stylePresets.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  if (selectedId) select.value = selectedId;
}

/* ============================================================
   Undo
   ============================================================ */
function pushHistory() {
  const doc = frame().contentDocument;
  if (!doc?.documentElement) return;
  historyStack.push(doc.documentElement.outerHTML);
  if (historyStack.length > 50) historyStack.shift();
  updateUndoButton();
}

function undo() {
  if (historyStack.length === 0) return;
  restoreDoc(historyStack.pop());
  updateUndoButton();
}

function updateUndoButton() {
  document.getElementById('undoBtn').disabled = historyStack.length === 0;
}

/* ============================================================
   Export
   ============================================================ */
function exportHtml() {
  const doc = frame().contentDocument;
  const clone = doc.documentElement.cloneNode(true);
  clone.querySelectorAll('.sbx-selected').forEach(el => el.classList.remove('sbx-selected'));
  clone.querySelector('#sbx-base-style')?.remove();
  clone.querySelector('base[data-sbx-injected]')?.remove();

  const blob = new Blob([`<!DOCTYPE html>\n${clone.outerHTML}`], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'exported.html';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============================================================
   Small helpers
   ============================================================ */
function rgbToHex(rgb) {
  const m = rgb && rgb.match(/\d+/g);
  if (!m) return null;
  return '#' + m.slice(0, 3).map(x => (`0${parseInt(x).toString(16)}`).slice(-2)).join('');
}

function normalizeWeight(w) {
  const n = parseInt(w);
  if (isNaN(n)) return '400';
  if (n <= 450) return '400';
  if (n <= 550) return '500';
  if (n <= 650) return '600';
  return '700';
}

/* ============================================================
   Wiring — every control is bound here once; no inline HTML handlers
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  syncFromHash();

  // buttons identified by data-action
  document.querySelectorAll('[data-action]').forEach(el => {
    const actions = {
      'import-url': importFromUrl,
      'import-paste': importFromPaste,
      'toggle-paste': () => document.getElementById('pasteBox').classList.toggle('hidden'),
      'go-empty': () => setState('empty'), // used by the error screen's retry — must not disturb addingNewLayout
      'restart': () => {
        addingNewLayout = false;
        document.getElementById('emptyTitle').textContent = '載入你的頁面';
        setState('empty');
      },
      'undo': undo,
      'export': exportHtml,
      'save-style-preset': saveStylePreset,
    };
    el.addEventListener('click', actions[el.dataset.action]);
  });

  document.getElementById('fileInput').addEventListener('change', importFromFile);

  document.querySelectorAll('.mode-btn').forEach(btn =>
    btn.addEventListener('click', () => setEditMode(btn.dataset.mode))
  );

  document.getElementById('stylePresetSelect').addEventListener('change', e => applyStylePreset(e.target.value));

  // toolbar field bindings: [elementId, eventType, handler]
  const bindings = [
    ['f-bg', 'input', v => applyStyle('backgroundColor', v)],
    ['f-color', 'input', v => applyStyle('color', v)],
    ['f-border', 'input', applyBorderColor],
    ['f-font', 'change', v => applyStyle('fontFamily', v)],
    ['f-size', 'input', applyFontSize],
    ['f-weight', 'change', v => applyStyle('fontWeight', v)],
    ['f-pad', 'input', applyPadding],
    ['f-mar', 'input', applyMargin],
    ['f-width-mode', 'change', applyWidthMode],
    ['f-width-value', 'input', applyWidthValue],
    ['f-hover', 'input', applyHover],
    ['f-trans', 'input', applyTransition],
    ['f-text', 'input', applyText],
    ['f-imgsrc', 'change', v => applyAttr('src', v)],
    ['f-href', 'change', v => applyAttr('href', v)],
    ['f-class', 'change', v => applyAttr('class', v)],
    ['f-id', 'change', v => applyAttr('id', v)],
    ['f-flex', 'change', (_, el) => applyFlex(el.checked)],
    ['f-justify', 'change', v => applyStyle('justifyContent', v)],
    ['f-align-items', 'change', v => applyStyle('alignItems', v)],
  ];
  bindings.forEach(([id, evt, fn]) => {
    document.getElementById(id).addEventListener(evt, e => fn(e.target.value, e.target));
  });

  // text-align button group
  document.querySelectorAll('#alignGroup button').forEach(btn =>
    btn.addEventListener('click', () => applyAlign(btn.dataset.align, btn))
  );

  // element-operation buttons
  const ops = { up: () => moveEl(-1), down: () => moveEl(1), duplicate: duplicateEl, delete: deleteEl };
  document.querySelectorAll('[data-op]').forEach(btn =>
    btn.addEventListener('click', () => ops[btn.dataset.op]())
  );
});
