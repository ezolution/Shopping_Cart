// ============================================================
// Kmart Stock Monitor — Popup UI Script
//
// Copyright (c) 2026 Ezolution. All rights reserved.
// https://github.com/ezolution
//
// This source code is proprietary and confidential.
// Unauthorized copying, modification, distribution, or use
// of this software, via any medium, is strictly prohibited.
// ============================================================

// ---- DOM references ----

const inputUrl      = document.getElementById('input-url');
const btnAdd        = document.getElementById('btn-add');
const btnStartAll   = document.getElementById('btn-start-all');
const btnStopAll    = document.getElementById('btn-stop-all');
const btnSettings   = document.getElementById('btn-settings');
const btnExport     = document.getElementById('btn-export');
const btnImport     = document.getElementById('btn-import');
const btnCart       = document.getElementById('btn-cart');
const fileImport    = document.getElementById('file-import');
const productList   = document.getElementById('product-list');
const emptyState    = document.getElementById('empty-state');
const countInStock  = document.getElementById('count-in-stock');
const countOutStock = document.getElementById('count-out-stock');
const countMonitoring = document.getElementById('count-monitoring');

let products = [];

// ---- Messaging ----

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, response => {
      resolve(response ?? { success: false, error: 'No response.' });
    });
  });
}

// ---- Init ----

async function init() {
  await loadProducts();
  bindEvents();
  setInterval(loadProducts, 10000);
}

async function loadProducts() {
  const resp = await sendMessage({ type: 'GET_PRODUCTS' });
  if (resp.success) {
    products = resp.data;
    renderProducts();
    updateSummary();
  }
}

// ---- Render ----

function renderProducts() {
  const existing = productList.querySelectorAll('.product-card');
  existing.forEach(el => el.remove());

  if (products.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  const sorted = [...products].sort((a, b) => {
    if (a.monitorState === 'active' && b.monitorState !== 'active') return -1;
    if (b.monitorState === 'active' && a.monitorState !== 'active') return 1;
    return (b.lastChecked ?? 0) - (a.lastChecked ?? 0);
  });

  for (const product of sorted) {
    productList.insertBefore(createProductCard(product), emptyState);
  }
}

function createProductCard(p) {
  const card = document.createElement('div');
  card.className = 'product-card';
  card.dataset.id = p.id;

  const statusClass = `status-${p.stockStatus}`;
  const statusLabel = formatStatus(p.stockStatus);
  const monitorClass = `monitor-${p.monitorState}`;
  const lastChecked = p.lastChecked ? timeAgo(p.lastChecked) : 'Never';
  const priceOld = p.previousPrice && p.previousPrice !== p.currentPrice
    ? `<span class="product-price-old">$${p.previousPrice.toFixed(2)}</span>` : '';

  card.innerHTML = `
    <div class="monitor-indicator ${monitorClass}"></div>
    <img class="product-thumb" src="${esc(p.imageUrl || '')}" alt="" loading="lazy">
    <div class="product-info">
      <div class="product-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="product-meta">
        <span class="product-price">$${p.currentPrice.toFixed(2)}</span>
        ${priceOld}
        <span class="product-status ${statusClass}">${statusLabel}</span>
      </div>
      <div class="product-last-check">Checked ${lastChecked}</div>
    </div>
    <div class="product-actions">
      <button class="icon-btn btn-toggle" title="${p.monitorState === 'active' ? 'Pause' : 'Resume'}">
        ${p.monitorState === 'active'
          ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="4" height="16"/><rect x="15" y="4" width="4" height="16"/></svg>'
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>'
        }
      </button>
      <button class="icon-btn btn-check-now" title="Check Now">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
      </button>
      <button class="icon-btn btn-remove" title="Remove">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;

  // Hide broken images gracefully
  const thumb = card.querySelector('.product-thumb');
  if (thumb) {
    thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
    // Also hide immediately if src is empty
    if (!p.imageUrl) thumb.style.display = 'none';
  }

  // Open product page
  card.querySelector('.product-name').addEventListener('click', () => {
    chrome.tabs.create({ url: p.url, active: true });
  });

  // Toggle monitor
  card.querySelector('.btn-toggle').addEventListener('click', async () => {
    await sendMessage({ type: 'TOGGLE_MONITOR', payload: { id: p.id } });
    await loadProducts();
  });

  // Check now
  card.querySelector('.btn-check-now').addEventListener('click', async () => {
    const btn = card.querySelector('.btn-check-now');
    btn.innerHTML = '<div class="spinner"></div>';
    const resp = await sendMessage({ type: 'CHECK_NOW', payload: { id: p.id } });
    await loadProducts();
    if (!resp.success) showToast(resp.error ?? 'Check failed', 'error');
  });

  // Remove
  card.querySelector('.btn-remove').addEventListener('click', async () => {
    const ok = await showConfirm(`Remove "${p.name}" from monitoring?`);
    if (ok) {
      await sendMessage({ type: 'REMOVE_PRODUCT', payload: { id: p.id } });
      await loadProducts();
      showToast('Product removed', 'info');
    }
  });

  return card;
}

function updateSummary() {
  countInStock.textContent = products.filter(p => p.stockStatus === 'in_stock').length;
  countOutStock.textContent = products.filter(p => p.stockStatus === 'out_of_stock').length;
  countMonitoring.textContent = products.filter(p => p.monitorState === 'active').length;
}

// ---- Events ----

function bindEvents() {
  btnAdd.addEventListener('click', addProduct);
  inputUrl.addEventListener('keydown', e => { if (e.key === 'Enter') addProduct(); });

  btnStartAll.addEventListener('click', async () => {
    await sendMessage({ type: 'START_ALL' });
    await loadProducts();
    showToast('All monitors started', 'success');
  });

  btnStopAll.addEventListener('click', async () => {
    await sendMessage({ type: 'STOP_ALL' });
    await loadProducts();
    showToast('All monitors stopped', 'info');
  });

  btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

  btnExport.addEventListener('click', async () => {
    const resp = await sendMessage({ type: 'EXPORT_DATA' });
    if (resp.success) {
      const blob = new Blob([JSON.stringify(resp.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kmart-monitor-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Data exported', 'success');
    }
  });

  btnImport.addEventListener('click', () => fileImport.click());
  fileImport.addEventListener('change', async () => {
    const file = fileImport.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const resp = await sendMessage({ type: 'IMPORT_DATA', payload: data });
      if (resp.success) {
        await loadProducts();
        showToast(`Imported ${data.products?.length ?? 0} products`, 'success');
      } else {
        showToast(resp.error ?? 'Import failed', 'error');
      }
    } catch {
      showToast('Invalid JSON file', 'error');
    }
    fileImport.value = '';
  });

  btnCart.addEventListener('click', () => sendMessage({ type: 'GO_TO_CHECKOUT' }));
}

async function addProduct() {
  const url = inputUrl.value.trim();
  if (!url) { showToast('Please enter a URL', 'error'); return; }
  if (!url.includes('kmart.com.au/product/')) {
    showToast('Please enter a valid Kmart product URL', 'error');
    return;
  }

  btnAdd.disabled = true;
  btnAdd.innerHTML = '<div class="spinner"></div>';

  const resp = await sendMessage({ type: 'ADD_PRODUCT', payload: { url } });

  btnAdd.disabled = false;
  btnAdd.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  if (resp.success) {
    inputUrl.value = '';
    await loadProducts();
    showToast('Product added!', 'success');
  } else {
    showToast(resp.error ?? 'Failed to add product', 'error');
  }
}

// ---- Helpers ----

function formatStatus(status) {
  const map = { in_stock: 'In Stock', out_of_stock: 'Out of Stock', limited: 'Limited', unknown: 'Unknown' };
  return map[status] ?? 'Unknown';
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ---- Toast ----

function showToast(message, type = 'info') {
  document.querySelector('.popup-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `popup-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 2500);
}

// ---- Confirm dialog ----

function showConfirm(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <p>${esc(message)}</p>
        <div class="confirm-actions">
          <button class="confirm-cancel">Cancel</button>
          <button class="confirm-ok">Remove</button>
        </div>
      </div>
    `;
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.querySelector('.confirm-ok').addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    document.body.appendChild(overlay);
  });
}

// ---- Audio listener ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PLAY_AUDIO') {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.value = (msg.payload?.volume ?? 0.7) * 0.3;
      osc.start();
      setTimeout(() => { osc.frequency.value = 1000; }, 150);
      setTimeout(() => { osc.frequency.value = 1200; }, 300);
      setTimeout(() => { osc.stop(); ctx.close(); }, 500);
      sendResponse({ success: true });
    } catch { sendResponse({ success: false }); }
    return true;
  }
});

// ---- Bootstrap ----

document.addEventListener('DOMContentLoaded', init);
