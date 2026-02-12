// ============================================================
// Kmart Stock Monitor — Background Service Worker
// Core monitoring loop, message routing, alarm management
//
// ALL product data is fetched via real browser tabs + content
// script parsing (not fetch()) to bypass Cloudflare/bot blocks.
//
// Copyright (c) 2026 Ezolution. All rights reserved.
// https://github.com/ezolution
//
// This source code is proprietary and confidential.
// Unauthorized copying, modification, distribution, or use
// of this software, via any medium, is strictly prohibited.
// ============================================================

import {
  getProducts, saveProducts, getProduct, addProduct,
  updateProduct, removeProduct, getSettings, saveSettings,
  getProfiles, saveProfile, deleteProfile,
  getLogs, addLog, clearLogs, exportAll, importAll,
} from '../utils/storage.js';

import {
  isValidKmartUrl,
} from '../utils/kmart-parser.js';

import {
  jitter, backoffDelay, rotateUserAgent,
  RateLimiter, startSessionRotation,
} from '../utils/anti-detection.js';

import {
  notifyInStock, notifyPriceDrop, notifyError,
  updateBadge, playAudioAlert, sendWebhook,
} from '../utils/notifications.js';

// ---- Constants ----
const ALARM_NAME = 'kmart-monitor-tick';
const RATE_LIMITER = new RateLimiter(20, 60000);

// ---- Lifecycle ----

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[KSM] Installed/updated:', details.reason);
  await getSettings();
  await refreshBadge();
  startSessionRotation();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[KSM] Browser started');
  await refreshBadge();
  startSessionRotation();
  await ensureAlarmRunning();
});

// ---- Tab-based product data fetching ----
// We use a real browser tab so the content script can parse
// the live DOM. This bypasses Cloudflare / bot protection.
// A single "monitor tab" is reused across checks to avoid
// visible tab open/close flashing.

let monitorTabId = null;

/**
 * Get or create a reusable background monitor tab.
 * Navigates it to the given URL and waits for load.
 */
async function getMonitorTab(url) {
  // Check if our monitor tab still exists
  if (monitorTabId) {
    try {
      const tab = await chrome.tabs.get(monitorTabId);
      if (tab) {
        // Tab exists — navigate it to the new URL
        await chrome.tabs.update(monitorTabId, { url, active: false });
        await waitForTabLoad(monitorTabId);
        await sleep(2000);
        return monitorTabId;
      }
    } catch {
      // Tab was closed by user, reset
      monitorTabId = null;
    }
  }

  // Create a new monitor tab (not active, won't steal focus)
  const tab = await chrome.tabs.create({ url, active: false });
  monitorTabId = tab.id;
  await waitForTabLoad(monitorTabId);
  await sleep(2000);
  return monitorTabId;
}

/**
 * Clean up the monitor tab (call when all checks are done).
 */
async function closeMonitorTab() {
  if (monitorTabId) {
    try { await chrome.tabs.remove(monitorTabId); } catch { /* already gone */ }
    monitorTabId = null;
  }
}

/**
 * Fetch product data by navigating the monitor tab and asking
 * the content script to parse the page.
 */
async function fetchProductViaTab(url) {
  const tabId = await getMonitorTab(url);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'PARSE_PRODUCT_PAGE',
  });

  if (response?.success && response.data) {
    return response.data;
  }

  throw new Error(response?.error || 'Content script returned no data.');
}

/**
 * Try to get product data from an already-open tab first,
 * falling back to the reusable monitor tab.
 */
async function fetchProductData(url) {
  // Check if user already has this page open
  try {
    const existing = await chrome.tabs.query({
      url: url.replace(/\/$/, '') + '*',
    });

    for (const tab of existing) {
      // Skip our own monitor tab
      if (tab.id === monitorTabId) continue;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'PARSE_PRODUCT_PAGE',
        });
        if (response?.success && response.data) {
          return response.data;
        }
      } catch {
        // Content script not ready on this tab
      }
    }
  } catch {
    // Query failed, fall through
  }

  // No existing tab with data — use the monitor tab
  return await fetchProductViaTab(url);
}

// ---- Alarm-based monitoring ----

async function ensureAlarmRunning() {
  const settings = await getSettings();
  const products = await getProducts();
  // Keep alarm running for both active AND error products (error keeps retrying)
  const hasMonitoring = products.some(
    p => p.monitorState === 'active' || p.monitorState === 'error'
  );

  if (!hasMonitoring) {
    await chrome.alarms.clear(ALARM_NAME);
    console.log('[KSM] No active/error products — alarm cleared.');
    return;
  }

  const periodInMinutes = Math.max(settings.checkIntervalSeconds / 60, 10 / 60);
  const existing = await chrome.alarms.get(ALARM_NAME);

  if (!existing || Math.abs(existing.periodInMinutes - periodInMinutes) > 0.01) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0.05,
      periodInMinutes,
    });
    console.log(`[KSM] Alarm set: every ${settings.checkIntervalSeconds}s`);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await monitorTick();
});

// ---- Core monitoring tick ----

let isChecking = false;

async function monitorTick() {
  if (isChecking) return;
  isChecking = true;

  try {
    const settings = await getSettings();
    const products = await getProducts();

    // Include both 'active' AND 'error' products — error products
    // keep retrying on a slow cadence instead of stopping forever
    const eligible = products.filter(
      p => p.monitorState === 'active' || p.monitorState === 'error'
    );

    if (eligible.length === 0) { isChecking = false; return; }

    if (Math.random() < 0.1) rotateUserAgent();

    for (const product of eligible) {
      if (!RATE_LIMITER.canRequest()) {
        const wait = RATE_LIMITER.waitTime();
        await sleep(wait);
      }

      // Backoff: products with errors wait longer between retries
      // error state uses a minimum 5-minute floor so we're not hammering
      if (product.errorCount > 0) {
        const minDelay = product.monitorState === 'error' ? 5 * 60 * 1000 : 0;
        const delay = Math.max(backoffDelay(product.errorCount), minDelay);
        const since = Date.now() - (product.lastChecked ?? 0);
        if (since < delay) continue;
      }

      try {
        await checkProduct(product, settings);
        RATE_LIMITER.record();
      } catch (err) {
        console.error(`[KSM] Error checking ${product.name}:`, err);
      }

      await sleep(jitter(2000, settings.jitterPercent));
    }

    // Close the monitor tab after all checks are done
    await closeMonitorTab();
    await refreshBadge();
  } finally {
    isChecking = false;
  }
}

// ---- Detect junk / 404 data ----

/**
 * Returns true if the parsed data looks like a valid Kmart product page
 * (not a 404, error page, or unrelated content).
 */
function isValidProductData(data) {
  if (!data) return false;

  // ---- Signal 1: No name at all ----
  if (!data.name || data.name.trim().length < 3) return false;

  const name = data.name.toLowerCase().trim();

  // ---- Signal 2: Name matches known junk patterns ----
  const junkPhrases = [
    'page not found',
    'not found',
    '404',
    'error',
    'sorry',
    'oops',
    'something went wrong',
    'access denied',
    'just a moment',       // Cloudflare challenge
    'unknown product',
    'can\'t be found',
    'cannot be found',
    'no longer available',
    'doesn\'t exist',
    'does not exist',
    'unavailable',
    'we couldn\'t find',
    'we could not find',
    'kmart australia',     // Generic page title with no product
    'attention required',  // Bot challenge
    'please verify',
    'checking your browser',
  ];
  if (junkPhrases.some(j => name.includes(j))) return false;

  // ---- Signal 3: No price AND no image → almost certainly not a product ----
  const hasPrice = typeof data.price === 'number' && data.price > 0;
  const hasImage = typeof data.imageUrl === 'string' && data.imageUrl.length > 10;
  if (!hasPrice && !hasImage) return false;

  // ---- Signal 4: Name looks like a full sentence, not a product title ----
  // Real product names rarely contain 8+ words of filler. Sentence-like names
  // with common filler words are suspicious (e.g. "Sorry, the page you're
  // looking for can't be found").
  const wordCount = name.split(/\s+/).length;
  const fillerWords = ['the', 'you', 'your', 'this', 'that', 'for', 'are', 'was', 'were', 'our', 'please'];
  const fillerCount = name.split(/\s+/).filter(w => fillerWords.includes(w)).length;
  if (wordCount >= 6 && fillerCount >= 3) return false;

  return true;
}

// ---- Check a single product ----

async function checkProduct(product, settings) {
  const now = Date.now();

  try {
    const data = await fetchProductData(product.url);

    // ---- Guard: detect 404 / junk pages ----
    // If the page returned garbage data (product taken down, 404, etc.),
    // treat it as a temporary error — don't overwrite stored product info.
    if (!isValidProductData(data)) {
      const errorMsg = `Page returned invalid data (possible 404 or taken down): "${data?.name || 'empty'}"`;
      console.warn(`[KSM] ${product.name}: ${errorMsg}`);

      // If the stored name itself is junk (e.g. added before validation was fixed),
      // repair it now using the URL-extracted name
      const nameFix = {};
      if (!isValidProductData({ name: product.name, price: product.currentPrice, imageUrl: product.imageUrl })) {
        nameFix.name = nameFromUrl(product.url);
      }

      await updateProduct(product.id, {
        lastChecked: now,
        errorCount: product.errorCount + 1,
        lastError: errorMsg,
        ...nameFix,
        // Keep existing price, stockStatus, imageUrl untouched
      });

      await addLog({
        timestamp: now, productId: product.id, event: 'error',
        details: errorMsg,
      });

      // After 10 junk responses, notify user but DON'T stop monitoring
      // (the page might come back). Just slow down via backoff.
      if (product.errorCount + 1 === 10) {
        if (settings.notificationsEnabled) {
          await notifyError(product,
            `Page may be taken down (${product.errorCount + 1} failed checks). ` +
            `Still monitoring on a slow cadence — will notify if it comes back.`
          );
        }
      }

      return; // Don't update stock status or overwrite product data
    }

    // ---- Valid product data — proceed normally ----

    const oldStatus = product.stockStatus;
    const oldPrice = product.currentPrice;
    const newStatus = data.stockStatus;
    const newPrice = data.price > 0 ? data.price : oldPrice;

    const snapshot = {
      timestamp: now,
      price: newPrice,
      stockStatus: newStatus,
      variantsAvailable: (data.variants || []).filter(v => v.available).map(v => v.value),
    };

    const history = [snapshot, ...product.history];
    if (history.length > settings.maxHistoryPerProduct) {
      history.length = settings.maxHistoryPerProduct;
    }

    // Only update name/image if the new data looks real
    // (don't overwrite "OP10 One Piece..." with "Page Not Found")
    const safeName = (data.name && data.name.length > 3) ? data.name : product.name;
    const safeImage = data.imageUrl || product.imageUrl;

    const updates = {
      currentPrice: newPrice,
      stockStatus: newStatus,
      lastChecked: now,
      errorCount: 0,           // Reset errors on valid data
      lastError: null,
      history,
      name: safeName,
      imageUrl: safeImage,
      maxPurchaseQty: data.maxPurchaseQty ?? product.maxPurchaseQty ?? null,
    };

    // If product was in error state and we got valid data, restore to active
    if (product.monitorState === 'error') {
      updates.monitorState = 'active';
      await addLog({
        timestamp: now, productId: product.id, event: 'check',
        details: `Product page recovered — monitoring resumed.`,
      });
    }

    // ---- OOS → In Stock ----
    if (newStatus === 'in_stock' && (oldStatus === 'out_of_stock' || oldStatus === 'unknown')) {
      updates.lastInStock = now;

      await addLog({
        timestamp: now, productId: product.id, event: 'in_stock',
        details: `${product.name} is back in stock at $${newPrice.toFixed(2)}`,
      });

      if (settings.notificationsEnabled) {
        await notifyInStock({ ...product, ...updates });
      }
      if (settings.audioAlertEnabled) {
        await playAudioAlert(settings.audioVolume);
      }
      if (settings.webhookEnabled && settings.webhookUrl) {
        await sendWebhook(settings.webhookUrl, { ...product, ...updates }, 'in_stock');
      }
      if (product.autoAddToCart || settings.globalAutoAdd) {
        await triggerAddToCart(product);
      }
    }

    // ---- In Stock → OOS ----
    if (newStatus === 'out_of_stock' && oldStatus === 'in_stock') {
      await addLog({
        timestamp: now, productId: product.id, event: 'out_of_stock',
        details: `${product.name} is now out of stock`,
      });
    }

    // ---- Price drop ----
    if (newPrice > 0 && oldPrice > 0 && newPrice < oldPrice) {
      const dropPct = ((oldPrice - newPrice) / oldPrice) * 100;
      updates.previousPrice = oldPrice;

      if (dropPct >= settings.priceDropThreshold) {
        await addLog({
          timestamp: now, productId: product.id, event: 'price_change',
          details: `Price dropped ${dropPct.toFixed(1)}%: $${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)}`,
          oldPrice, newPrice,
        });

        if (settings.notificationsEnabled) {
          await notifyPriceDrop({ ...product, ...updates }, oldPrice, newPrice);
        }
        if (settings.audioAlertEnabled) {
          await playAudioAlert(settings.audioVolume);
        }
        if (settings.webhookEnabled && settings.webhookUrl) {
          await sendWebhook(settings.webhookUrl, { ...product, ...updates }, 'price_drop', oldPrice);
        }
      }
    }

    await updateProduct(product.id, updates);

    await addLog({
      timestamp: now, productId: product.id, event: 'check',
      details: `Checked: ${newStatus}, $${newPrice.toFixed(2)}`,
    });

  } catch (err) {
    // Total failure (tab crash, network down, content script error, etc.)
    const errorMsg = err?.message ?? String(err);

    await updateProduct(product.id, {
      lastChecked: now,
      errorCount: product.errorCount + 1,
      lastError: errorMsg,
      // Don't change monitorState — keep trying via backoff
    });

    await addLog({
      timestamp: now, productId: product.id, event: 'error',
      details: errorMsg,
    });

    // Notify at 5 errors, but keep monitoring (just with backoff)
    if (product.errorCount + 1 === 5) {
      await updateProduct(product.id, { monitorState: 'error' });
      if (settings.notificationsEnabled) {
        await notifyError(product,
          `Hitting errors (${product.errorCount + 1} so far): ${errorMsg}. ` +
          `Still retrying on a slower cadence.`
        );
      }
    }
  }
}

// ---- Add-to-cart via content script ----

/**
 * Trigger add-to-cart/bag with retry logic.
 * Attempts up to 3 times with exponential backoff (3s, 6s, 12s).
 */
const ADD_CART_MAX_RETRIES = 3;
const ADD_CART_BASE_DELAY = 3000;

async function triggerAddToCart(product) {
  let lastError = '';

  for (let attempt = 1; attempt <= ADD_CART_MAX_RETRIES; attempt++) {
    let tabId = null;
    let createdTab = false;

    try {
      const tabs = await chrome.tabs.query({ url: product.url + '*' });

      if (tabs.length > 0 && tabs[0].id) {
        tabId = tabs[0].id;
        await chrome.tabs.update(tabId, { url: product.url });
        await waitForTabLoad(tabId);
        await sleep(2000);
      } else {
        const tab = await chrome.tabs.create({ url: product.url, active: false });
        tabId = tab.id;
        createdTab = true;
        await waitForTabLoad(tabId);
        await sleep(2000);
      }

      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'ADD_TO_CART',
        payload: {
          productId: product.id,
          variants: product.selectedVariants,
          quantity: product.maxQuantity,
          maxOut: true,  // Always try to add the maximum allowed quantity
        },
      });

      if (response && response.success) {
        const qtyInfo = response.quantityRequested
          ? ` (qty: ${response.quantityRequested}${response.pageMax ? ', page max: ' + response.pageMax : ''})`
          : '';
        const warnInfo = response.warning ? ` [Warning: ${response.warning}]` : '';

        await addLog({
          timestamp: Date.now(), productId: product.id, event: 'add_to_cart',
          details: `Auto add-to-bag succeeded for ${product.name}${qtyInfo}${warnInfo}` +
            (attempt > 1 ? ` (attempt ${attempt}/${ADD_CART_MAX_RETRIES})` : ''),
        });

        // Update stored maxPurchaseQty if we learned it from the page
        if (response.pageMax && response.pageMax > 0) {
          await updateProduct(product.id, { maxPurchaseQty: response.pageMax });
        }
        if (createdTab && tabId) {
          try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
        }
        return;
      }

      lastError = response?.error || 'Content script returned failure';
      console.warn(`[KSM] Add-to-bag attempt ${attempt}/${ADD_CART_MAX_RETRIES} failed: ${lastError}`);

    } catch (err) {
      lastError = err?.message || String(err);
      console.warn(`[KSM] Add-to-bag attempt ${attempt}/${ADD_CART_MAX_RETRIES} error: ${lastError}`);
    }

    if (createdTab && tabId) {
      try { await chrome.tabs.remove(tabId); } catch { /* ignore */ }
    }

    if (attempt < ADD_CART_MAX_RETRIES) {
      const delay = ADD_CART_BASE_DELAY * Math.pow(2, attempt - 1);
      console.log(`[KSM] Retrying add-to-bag in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }

  console.error(`[KSM] Add-to-bag failed after ${ADD_CART_MAX_RETRIES} attempts: ${lastError}`);
  await addLog({
    timestamp: Date.now(), productId: product.id, event: 'error',
    details: `Add-to-bag failed after ${ADD_CART_MAX_RETRIES} attempts: ${lastError}`,
  });
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);
  });
}

// ---- Badge ----

async function refreshBadge() {
  const products = await getProducts();
  const count = products.filter(
    p => p.monitorState === 'active' && p.stockStatus === 'in_stock'
  ).length;
  await updateBadge(count);
}

// ---- Message handler ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'GET_PRODUCTS':
      return { success: true, data: await getProducts() };

    case 'ADD_PRODUCT': {
      const { url } = msg.payload;
      if (!isValidKmartUrl(url)) {
        return { success: false, error: 'Invalid Kmart product URL.' };
      }
      try {
        // Try to fetch live data from the page
        let data = null;
        let pageIsDown = false;

        try {
          data = await fetchProductData(url);
        } catch {
          // Tab failed entirely — page may not exist at all
          pageIsDown = true;
        }

        // Check if the page returned junk (404, error page, taken down)
        if (!pageIsDown && data && !isValidProductData(data)) {
          pageIsDown = true;
        }

        // Extract a readable name from the URL slug as fallback
        const fallbackName = nameFromUrl(url);

        if (pageIsDown) {
          // Page is down — still add it for monitoring, but mark
          // as waiting for recovery so the user knows the situation
          const product = {
            id: crypto.randomUUID(),
            url,
            name: fallbackName,
            imageUrl: '',
            currentPrice: 0,
            previousPrice: null,
            stockStatus: 'out_of_stock',
            monitorState: 'active',
            lastChecked: Date.now(),
            lastInStock: null,
            addedAt: Date.now(),
            errorCount: 1,
            lastError: 'Product page is currently unavailable — monitoring for when it comes back.',
            selectedVariants: [],
            autoAddToCart: false,
            maxQuantity: 1,
            history: [],
            tags: [],
          };
          await addProduct(product);
          await ensureAlarmRunning();
          await refreshBadge();
          return { success: true, data: product };
        }

        // Page is live — use the real data
        const product = {
          id: crypto.randomUUID(),
          url,
          name: (data.name && data.name.length > 3) ? data.name : fallbackName,
          imageUrl: data.imageUrl || '',
          currentPrice: data.price || 0,
          previousPrice: null,
          stockStatus: data.stockStatus || 'unknown',
          monitorState: 'active',
          lastChecked: Date.now(),
          lastInStock: data.stockStatus === 'in_stock' ? Date.now() : null,
          addedAt: Date.now(),
          errorCount: 0,
          lastError: null,
          selectedVariants: [],
          autoAddToCart: false,
          maxQuantity: 1,
          maxPurchaseQty: data.maxPurchaseQty ?? null,
          history: [{
            timestamp: Date.now(),
            price: data.price || 0,
            stockStatus: data.stockStatus || 'unknown',
            variantsAvailable: (data.variants || []).filter(v => v.available).map(v => v.value),
          }],
          tags: [],
        };
        await addProduct(product);
        await ensureAlarmRunning();
        await refreshBadge();

        // Auto add-to-bag immediately if product is already in stock
        if (product.stockStatus === 'in_stock') {
          const settings = await getSettings();
          if (settings.globalAutoAdd) {
            // Don't await — run in background so ADD_PRODUCT returns fast
            triggerAddToCart(product).catch(() => {});
          }
        }

        return { success: true, data: product };
      } catch (err) {
        return { success: false, error: `Failed to add product: ${err.message}` };
      }
    }

    case 'REMOVE_PRODUCT':
      await removeProduct(msg.payload.id);
      await ensureAlarmRunning();
      await refreshBadge();
      return { success: true };

    case 'UPDATE_PRODUCT': {
      const updated = await updateProduct(msg.payload.id, msg.payload.updates);
      await ensureAlarmRunning();
      await refreshBadge();
      return { success: true, data: updated };
    }

    case 'TOGGLE_MONITOR': {
      const product = await getProduct(msg.payload.id);
      if (!product) return { success: false, error: 'Product not found.' };
      const newState = product.monitorState === 'active' ? 'paused' : 'active';
      const updated = await updateProduct(msg.payload.id, {
        monitorState: newState, errorCount: 0, lastError: null,
      });
      await ensureAlarmRunning();
      return { success: true, data: updated };
    }

    case 'START_ALL': {
      const products = await getProducts();
      for (const p of products) {
        await updateProduct(p.id, { monitorState: 'active', errorCount: 0, lastError: null });
      }
      await ensureAlarmRunning();
      return { success: true };
    }

    case 'STOP_ALL': {
      const products = await getProducts();
      for (const p of products) {
        await updateProduct(p.id, { monitorState: 'paused' });
      }
      await chrome.alarms.clear(ALARM_NAME);
      return { success: true };
    }

    case 'CHECK_NOW': {
      const product = await getProduct(msg.payload.id);
      if (!product) return { success: false, error: 'Product not found.' };
      const settings = await getSettings();
      await checkProduct(product, settings);
      await refreshBadge();
      return { success: true, data: await getProduct(msg.payload.id) };
    }

    case 'GET_SETTINGS':
      return { success: true, data: await getSettings() };

    case 'UPDATE_SETTINGS': {
      const current = await getSettings();
      const merged = { ...current, ...msg.payload };
      await saveSettings(merged);
      await ensureAlarmRunning();
      return { success: true, data: merged };
    }

    case 'GET_PROFILES':
      return { success: true, data: await getProfiles() };

    case 'SAVE_PROFILE':
      await saveProfile(msg.payload);
      return { success: true };

    case 'DELETE_PROFILE':
      await deleteProfile(msg.payload.id);
      return { success: true };

    case 'GET_LOGS':
      return { success: true, data: await getLogs(msg.payload?.limit, msg.payload?.offset) };

    case 'CLEAR_LOGS':
      await clearLogs();
      return { success: true };

    case 'EXPORT_DATA':
      return { success: true, data: await exportAll() };

    case 'IMPORT_DATA':
      await importAll(msg.payload);
      await ensureAlarmRunning();
      await refreshBadge();
      return { success: true };

    case 'ADD_TO_CART': {
      const product = await getProduct(msg.payload.id);
      if (!product) return { success: false, error: 'Product not found.' };
      await triggerAddToCart(product);
      return { success: true };
    }

    case 'GO_TO_CHECKOUT':
      await chrome.tabs.create({ url: 'https://www.kmart.com.au/cart', active: true });
      return { success: true };

    case 'PARSE_PRODUCT_PAGE':
      return { success: true, data: msg.payload };

    default:
      return { success: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ---- Helpers ----

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract a human-readable product name from a Kmart URL slug.
 * e.g. "/product/pokemon-trading-card-game-mega-evolution-43718702/"
 *   → "Pokemon Trading Card Game Mega Evolution"
 */
function nameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    // Match the slug between /product/ and the trailing ID/slash
    const match = path.match(/\/product\/([^/]+)/);
    if (!match) return 'Unknown Product';

    let slug = match[1];
    // Remove trailing numeric product ID (e.g. -43718702)
    slug = slug.replace(/-\d{6,}$/, '');
    // Convert hyphens to spaces, clean up colons
    const name = slug
      .replace(/-/g, ' ')
      .replace(/:\s*/g, ': ')
      .replace(/\s+/g, ' ')
      .trim();
    // Title-case each word
    return name
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || 'Unknown Product';
  } catch {
    return 'Unknown Product';
  }
}

// ---- Startup ----

(async () => {
  console.log('[KSM] Service worker loaded.');
  startSessionRotation();
  await ensureAlarmRunning();
  await refreshBadge();
})();
