// ============================================================
// Options Page Script — Settings, profiles, data management
// ============================================================

// ---- Messaging ----

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, response => {
      resolve(response ?? { success: false, error: 'No response.' });
    });
  });
}

// ---- DOM refs ----

const el = {
  checkInterval: document.getElementById('checkInterval'),
  jitterPercent: document.getElementById('jitterPercent'),
  maxProducts: document.getElementById('maxProducts'),
  notificationsEnabled: document.getElementById('notificationsEnabled'),
  audioAlertEnabled: document.getElementById('audioAlertEnabled'),
  audioVolume: document.getElementById('audioVolume'),
  priceDropThreshold: document.getElementById('priceDropThreshold'),
  globalAutoAdd: document.getElementById('globalAutoAdd'),
  autoCheckout: document.getElementById('autoCheckout'),
  checkoutConfirmGates: document.getElementById('checkoutConfirmGates'),
  webhookEnabled: document.getElementById('webhookEnabled'),
  webhookUrl: document.getElementById('webhookUrl'),
  profFirstName: document.getElementById('prof-firstName'),
  profLastName: document.getElementById('prof-lastName'),
  profEmail: document.getElementById('prof-email'),
  profPhone: document.getElementById('prof-phone'),
  profAddress1: document.getElementById('prof-address1'),
  profAddress2: document.getElementById('prof-address2'),
  profSuburb: document.getElementById('prof-suburb'),
  profState: document.getElementById('prof-state'),
  profPostcode: document.getElementById('prof-postcode'),
  maxHistory: document.getElementById('maxHistory'),
  storageFill: document.getElementById('storage-fill'),
  storageText: document.getElementById('storage-text'),
  btnSave: document.getElementById('btn-save'),
  btnSaveProfile: document.getElementById('btn-save-profile'),
  btnClearLogs: document.getElementById('btn-clear-logs'),
  btnReset: document.getElementById('btn-reset'),
};

// ---- Init ----

async function init() {
  await loadSettings();
  await loadProfile();
  await loadStorageUsage();
  bindEvents();
}

// ---- Load settings ----

async function loadSettings() {
  const resp = await sendMessage({ type: 'GET_SETTINGS' });
  if (!resp.success) return;
  const s = resp.data;

  el.checkInterval.value = s.checkIntervalSeconds;
  el.jitterPercent.value = s.jitterPercent;
  el.maxProducts.value = s.maxProducts;
  el.notificationsEnabled.checked = s.notificationsEnabled;
  el.audioAlertEnabled.checked = s.audioAlertEnabled;
  el.audioVolume.value = s.audioVolume;
  el.priceDropThreshold.value = s.priceDropThreshold;
  el.globalAutoAdd.checked = s.globalAutoAdd;
  el.autoCheckout.checked = s.autoCheckout;
  el.checkoutConfirmGates.checked = s.checkoutConfirmGates;
  el.webhookEnabled.checked = s.webhookEnabled;
  el.webhookUrl.value = s.webhookUrl;
  el.maxHistory.value = s.maxHistoryPerProduct;
}

// ---- Save settings ----

async function saveSettings() {
  const settings = {
    checkIntervalSeconds: clamp(parseInt(el.checkInterval.value) || 30, 10, 600),
    jitterPercent: clamp(parseInt(el.jitterPercent.value) || 15, 0, 50),
    maxProducts: clamp(parseInt(el.maxProducts.value) || 50, 1, 100),
    notificationsEnabled: el.notificationsEnabled.checked,
    audioAlertEnabled: el.audioAlertEnabled.checked,
    audioVolume: parseFloat(el.audioVolume.value) || 0.7,
    priceDropThreshold: clamp(parseInt(el.priceDropThreshold.value) || 10, 1, 90),
    globalAutoAdd: el.globalAutoAdd.checked,
    autoCheckout: el.autoCheckout.checked,
    checkoutConfirmGates: el.checkoutConfirmGates.checked,
    webhookEnabled: el.webhookEnabled.checked,
    webhookUrl: el.webhookUrl.value.trim(),
    maxHistoryPerProduct: clamp(parseInt(el.maxHistory.value) || 500, 10, 2000),
  };

  const resp = await sendMessage({ type: 'UPDATE_SETTINGS', payload: settings });
  showToast(resp.success ? 'Settings saved!' : (resp.error ?? 'Failed'), resp.success ? 'success' : 'error');
}

// ---- Profile ----

async function loadProfile() {
  const resp = await sendMessage({ type: 'GET_PROFILES' });
  if (!resp.success) return;
  const profile = resp.data.find(p => p.isDefault) ?? resp.data[0];
  if (!profile) return;

  el.profFirstName.value = profile.firstName;
  el.profLastName.value = profile.lastName;
  el.profEmail.value = profile.email;
  el.profPhone.value = profile.phone;
  el.profAddress1.value = profile.addressLine1;
  el.profAddress2.value = profile.addressLine2;
  el.profSuburb.value = profile.suburb;
  el.profState.value = profile.state;
  el.profPostcode.value = profile.postcode;
}

async function saveProfile() {
  const profile = {
    id: 'default',
    name: 'Default Profile',
    firstName: el.profFirstName.value.trim(),
    lastName: el.profLastName.value.trim(),
    email: el.profEmail.value.trim(),
    phone: el.profPhone.value.trim(),
    addressLine1: el.profAddress1.value.trim(),
    addressLine2: el.profAddress2.value.trim(),
    suburb: el.profSuburb.value.trim(),
    state: el.profState.value,
    postcode: el.profPostcode.value.trim(),
    country: 'Australia',
    isDefault: true,
  };

  const resp = await sendMessage({ type: 'SAVE_PROFILE', payload: profile });
  showToast(resp.success ? 'Profile saved!' : (resp.error ?? 'Failed'), resp.success ? 'success' : 'error');
}

// ---- Storage ----

async function loadStorageUsage() {
  try {
    const used = await chrome.storage.local.getBytesInUse(null);
    const total = 10 * 1024 * 1024;
    const pct = (used / total) * 100;
    el.storageFill.style.width = `${Math.min(pct, 100)}%`;
    if (pct > 80) el.storageFill.style.background = '#ef4444';
    else if (pct > 50) el.storageFill.style.background = '#eab308';
    el.storageText.textContent = `${(used / 1024).toFixed(1)} KB / ${(total / 1024 / 1024).toFixed(0)} MB (${pct.toFixed(1)}%)`;
  } catch {
    el.storageText.textContent = 'Unable to read storage usage.';
  }
}

// ---- Events ----

function bindEvents() {
  el.btnSave.addEventListener('click', saveSettings);
  el.btnSaveProfile.addEventListener('click', saveProfile);

  el.btnClearLogs.addEventListener('click', async () => {
    if (!confirm('Clear all monitoring logs?')) return;
    const resp = await sendMessage({ type: 'CLEAR_LOGS' });
    if (resp.success) {
      showToast('Logs cleared', 'success');
      await loadStorageUsage();
    }
  });

  el.btnReset.addEventListener('click', async () => {
    if (!confirm('Delete ALL data including products, settings, and profiles?')) return;
    if (!confirm('This cannot be undone. Proceed?')) return;
    await chrome.storage.local.clear();
    showToast('All data reset', 'success');
    setTimeout(() => location.reload(), 1000);
  });

  el.notificationsEnabled.addEventListener('change', async () => {
    if (el.notificationsEnabled.checked) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        el.notificationsEnabled.checked = false;
        showToast('Notification permission denied', 'error');
      }
    }
  });
}

// ---- Helpers ----

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function showToast(message, type) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 2500);
}

// ---- Bootstrap ----

document.addEventListener('DOMContentLoaded', init);
