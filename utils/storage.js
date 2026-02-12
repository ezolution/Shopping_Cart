// ============================================================
// Storage Utility — Chrome Storage API wrapper
// Products, settings, logs, profiles, export/import
// ============================================================

import { DEFAULT_SETTINGS } from './constants.js';

const KEYS = {
  PRODUCTS: 'monitored_products',
  SETTINGS: 'user_settings',
  LOGS: 'monitor_logs',
  PROFILES: 'checkout_profiles',
};

// ---- Generic helpers ----

async function get(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// ---- Products ----

export async function getProducts() {
  return (await get(KEYS.PRODUCTS)) ?? [];
}

export async function saveProducts(products) {
  await set(KEYS.PRODUCTS, products);
}

export async function getProduct(id) {
  const products = await getProducts();
  return products.find(p => p.id === id);
}

export async function addProduct(product) {
  const products = await getProducts();
  if (products.some(p => p.url === product.url)) {
    throw new Error('Product URL is already being monitored.');
  }
  const settings = await getSettings();
  if (products.length >= settings.maxProducts) {
    throw new Error(`Maximum product limit (${settings.maxProducts}) reached.`);
  }
  products.push(product);
  await saveProducts(products);
}

export async function updateProduct(id, updates) {
  const products = await getProducts();
  const idx = products.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Product ${id} not found.`);
  products[idx] = { ...products[idx], ...updates };
  await saveProducts(products);
  return products[idx];
}

export async function removeProduct(id) {
  const products = await getProducts();
  await saveProducts(products.filter(p => p.id !== id));
}

// ---- Settings ----

export async function getSettings() {
  const stored = await get(KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(settings) {
  await set(KEYS.SETTINGS, settings);
}

// ---- Checkout Profiles ----

export async function getProfiles() {
  return (await get(KEYS.PROFILES)) ?? [];
}

export async function saveProfile(profile) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  if (profile.isDefault) {
    profiles.forEach(p => {
      if (p.id !== profile.id) p.isDefault = false;
    });
  }
  await set(KEYS.PROFILES, profiles);
}

export async function deleteProfile(id) {
  const profiles = await getProfiles();
  await set(KEYS.PROFILES, profiles.filter(p => p.id !== id));
}

// ---- Logs ----

const MAX_LOGS = 5000;

export async function getLogs(limit = 200, offset = 0) {
  const logs = (await get(KEYS.LOGS)) ?? [];
  return logs.slice(offset, offset + limit);
}

export async function addLog(entry) {
  const logs = (await get(KEYS.LOGS)) ?? [];
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  await set(KEYS.LOGS, logs);
}

export async function clearLogs() {
  await set(KEYS.LOGS, []);
}

// ---- Export / Import ----

export async function exportAll() {
  return {
    version: '1.0.0',
    exportedAt: Date.now(),
    products: await getProducts(),
    settings: await getSettings(),
    profiles: await getProfiles(),
  };
}

export async function importAll(data) {
  if (!data.version || !data.products) {
    throw new Error('Invalid import data format.');
  }
  await saveProducts(data.products);
  if (data.settings) await saveSettings({ ...DEFAULT_SETTINGS, ...data.settings });
  if (data.profiles) await set(KEYS.PROFILES, data.profiles);
}

// ---- Storage usage ----

export async function getStorageUsage() {
  return new Promise(resolve => {
    chrome.storage.local.getBytesInUse(null, used => {
      resolve({ used, total: 10 * 1024 * 1024 });
    });
  });
}
