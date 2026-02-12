// ============================================================
// Kmart Stock Monitor — Content Script
// Runs on Kmart product pages (self-contained, no ES imports)
// Handles: page parsing, add-to-cart, variant selection,
//          checkout autofill, MutationObserver for live changes
//
// Copyright (c) 2026 Ezolution. All rights reserved.
// https://github.com/ezolution
//
// This source code is proprietary and confidential.
// Unauthorized copying, modification, distribution, or use
// of this software, via any medium, is strictly prohibited.
// ============================================================

(function () {
  'use strict';

  // ================================================================
  // INLINE UTILITIES (can't import in content scripts)
  // ================================================================

  function humanDelay(minMs = 200, maxMs = 800) {
    const ms = Math.round(minMs + Math.random() * (maxMs - minMs));
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Check if extension context is still valid (survives reload). */
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  /** Safe wrapper for chrome.runtime.sendMessage — silently no-ops after reload. */
  function safeSendMessage(msg) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      // Extension was reloaded — this content script is orphaned
    }
  }

  // ---- Kmart parser (inlined) ----

  function parseProductPage(doc) {
    const data = {
      name: '',
      price: 0,
      stockStatus: 'unknown',
      imageUrl: '',
      variants: [],
      productId: '',
      breadcrumb: [],
      maxPurchaseQty: null,
    };

    // Name
    const nameEl =
      doc.querySelector('[data-testid="product-title"]') ??
      doc.querySelector('.product-title h1') ??
      doc.querySelector('h1.css-1baxq2i') ??
      doc.querySelector('h1');
    data.name = nameEl?.textContent?.trim() ?? 'Unknown Product';

    // Price — JSON-LD first
    const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLd) {
      try {
        const json = JSON.parse(script.textContent ?? '');
        const offer = json?.offers ?? json?.offers?.[0];
        if (offer?.price) { data.price = parseFloat(offer.price); break; }
      } catch { /* skip */ }
    }
    if (data.price === 0) {
      const priceSels = [
        '[data-testid="product-price"]', '.product-price .price',
        '.product-price__current', 'span[class*="price"]', '.css-1n4h0hr',
      ];
      for (const sel of priceSels) {
        const el = doc.querySelector(sel);
        if (el?.textContent) {
          const m = el.textContent.match(/\$?([\d,]+\.?\d*)/);
          if (m) { data.price = parseFloat(m[1].replace(',', '')); break; }
        }
      }
    }

    // Stock status — check DOM for online availability FIRST
    // "In Store Only" means NOT available online, which is what we care about
    const pageText = doc.body?.innerText?.toLowerCase() ?? '';
    const isInStoreOnly =
      pageText.includes('in store only') ||
      pageText.includes('in-store only') ||
      pageText.includes('available for in-store purchase only') ||
      pageText.includes('not available for delivery') ||
      !!doc.querySelector('[data-testid="in-store-only"], [class*="inStoreOnly"], [class*="in-store-only"]');

    if (isInStoreOnly) {
      data.stockStatus = 'out_of_stock';
    } else {
      // Check for an Add to Cart / Add to Bag button
      const addBtn = (() => {
        const selectors = [
          '[data-testid="add-to-cart-button"]',
          '[data-testid="add-to-bag-button"]',
          'button[class*="addToCart"]',
          'button[class*="addToBag"]',
          'button[aria-label*="Add to"]',
          '.add-to-cart-button',
          '.add-to-bag-button',
        ];
        for (const sel of selectors) {
          const el = doc.querySelector(sel);
          if (el) return el;
        }
        // Fallback: scan all buttons by text content
        for (const btn of doc.querySelectorAll('button')) {
          const txt = (btn.textContent ?? '').toLowerCase().trim();
          if (txt.includes('add to cart') || txt.includes('add to bag')) return btn;
        }
        return null;
      })();

      if (addBtn) {
        if (addBtn.disabled) {
          data.stockStatus = 'out_of_stock';
        } else {
          const txt = (addBtn.textContent ?? '').toLowerCase();
          if (txt.includes('out of stock') || txt.includes('unavailable')) data.stockStatus = 'out_of_stock';
          else if (txt.includes('add to')) data.stockStatus = 'in_stock';
        }
      } else {
        // No Add to Cart/Bag button at all — likely not available online
        // Fall back to JSON-LD but only trust OutOfStock, not InStock
        let jsonStatus = 'unknown';
        for (const script of jsonLd) {
          try {
            const json = JSON.parse(script.textContent ?? '');
            const avail = json?.offers?.availability ?? json?.offers?.[0]?.availability ?? '';
            if (avail.includes('OutOfStock')) { jsonStatus = 'out_of_stock'; break; }
          } catch { /* skip */ }
        }
        data.stockStatus = jsonStatus === 'unknown' ? 'out_of_stock' : jsonStatus;
      }

      // Explicit OOS markers override everything
      const oos = doc.querySelector('[data-testid="out-of-stock"], .out-of-stock-message, .oos-message');
      if (oos) data.stockStatus = 'out_of_stock';
    }

    // Image
    const imgEl =
      doc.querySelector('[data-testid="product-image"] img') ??
      doc.querySelector('.product-image img') ??
      doc.querySelector('.product-gallery img') ??
      doc.querySelector('picture img');
    data.imageUrl = imgEl?.getAttribute('src') ?? imgEl?.getAttribute('data-src') ?? '';

    // Product ID
    for (const script of jsonLd) {
      try {
        const json = JSON.parse(script.textContent ?? '');
        if (json?.sku) { data.productId = String(json.sku); break; }
        if (json?.productID) { data.productId = String(json.productID); break; }
      } catch { /* skip */ }
    }

    // Max purchase quantity
    data.maxPurchaseQty = (() => {
      // Quantity input max attribute
      const qtyInput = doc.querySelector(
        '[data-testid="quantity-input"] input, input[name="quantity"], .quantity-input input, input[type="number"][max]'
      );
      if (qtyInput) {
        const max = parseInt(qtyInput.getAttribute('max'));
        if (max > 0) return max;
      }
      // Quantity dropdown
      const qtySelect = doc.querySelector(
        'select[name="quantity"], [data-testid="quantity-select"], .quantity-selector select'
      );
      if (qtySelect) {
        const values = Array.from(qtySelect.querySelectorAll('option'))
          .map(o => parseInt(o.value)).filter(v => v > 0);
        if (values.length > 0) return Math.max(...values);
      }
      // "Limit X per customer" text
      const bodyText = doc.body?.innerText ?? '';
      const limitPatterns = [
        /limit\s+(\d+)\s+per\s+(customer|order|person|transaction)/i,
        /maximum\s+(\d+)\s+per\s+(customer|order|person|transaction)/i,
        /max(?:imum)?\s+(?:qty|quantity)[\s:]+(\d+)/i,
        /(\d+)\s+per\s+customer/i,
        /purchase\s+limit[\s:]+(\d+)/i,
      ];
      for (const pat of limitPatterns) {
        const m = bodyText.match(pat);
        if (m) { const v = parseInt(m[1]); if (v > 0 && v <= 999) return v; }
      }
      return null;
    })();

    // Variants
    const sizeButtons = doc.querySelectorAll(
      '[data-testid="size-selector"] button, .size-selector button, [class*="sizeOption"]'
    );
    for (const btn of sizeButtons) {
      data.variants.push({
        type: 'size',
        value: btn.textContent?.trim() ?? '',
        available: !btn.disabled && !btn.classList.contains('unavailable'),
      });
    }
    const colourButtons = doc.querySelectorAll(
      '[data-testid="colour-selector"] button, .colour-selector button, [class*="colourOption"]'
    );
    for (const btn of colourButtons) {
      data.variants.push({
        type: 'colour',
        value: btn.getAttribute('aria-label') ?? btn.getAttribute('title') ?? btn.textContent?.trim() ?? '',
        available: !btn.disabled && !btn.classList.contains('unavailable'),
      });
    }

    return data;
  }

  // ================================================================
  // INITIALISATION
  // ================================================================

  let currentProductData = null;
  let observer = null;
  let reparseTimeout;

  function init() {
    const url = window.location.href;

    if (url.includes('/product/')) {
      parseAndReport();
      setupMutationObserver();
      injectFloatingButton();
    }

    if (url.includes('/cart') || url.includes('/checkout')) {
      setupCheckoutAssist();
    }
  }

  // ---- Parse & report to background ----

  async function parseAndReport() {
    if (!isContextValid()) return;
    await humanDelay(500, 1500);
    try {
      currentProductData = parseProductPage(document);
      safeSendMessage({
        type: 'PARSE_PRODUCT_PAGE',
        payload: currentProductData,
      });
    } catch (err) {
      if (!isContextValid()) return; // Silently ignore after reload
      console.error('[KSM Content] Parse failed:', err);
    }
  }

  // ---- MutationObserver ----

  function setupMutationObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(mutations => {
      let shouldReparse = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' || mutation.type === 'attributes') {
          const target = mutation.target;
          const classes = (target.className ?? '').toString().toLowerCase();
          const id = (target.id ?? '').toLowerCase();
          const testId = (target.getAttribute?.('data-testid') ?? '').toLowerCase();

          const relevant = [
            'product-price', 'add-to-cart', 'out-of-stock',
            'stock-status', 'size-selector', 'colour-selector', 'price',
          ];

          if (relevant.some(s => classes.includes(s) || id.includes(s) || testId.includes(s))) {
            shouldReparse = true;
            break;
          }
        }
      }

      if (shouldReparse) {
        clearTimeout(reparseTimeout);
        reparseTimeout = setTimeout(() => parseAndReport(), 1000);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'data-testid'],
    });
  }

  // ---- Message handler ----

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  });

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'ADD_TO_CART':
        return await performAddToCart(msg.payload.variants, msg.payload.quantity ?? 1, msg.payload.maxOut ?? false);

      case 'GO_TO_CHECKOUT':
        window.location.href = 'https://www.kmart.com.au/cart';
        return { success: true };

      case 'PARSE_PRODUCT_PAGE':
        return { success: true, data: parseProductPage(document) };

      case 'PLAY_AUDIO':
        playAlertSound(msg.payload?.volume ?? 0.7);
        return { success: true };

      default:
        return { success: false, error: `Unhandled: ${msg.type}` };
    }
  }

  // ================================================================
  // ADD TO CART
  // ================================================================

  async function performAddToCart(variants = [], quantity = 1, maxOut = false) {
    try {
      // Select any requested variants (size, colour)
      for (const variant of variants) {
        await selectVariant(variant);
        await humanDelay(300, 700);
      }

      // Determine the quantity to add
      let targetQty = quantity;

      if (maxOut) {
        // Read the actual max from the live page right now
        const pageMax = detectPageMaxQuantity();
        if (pageMax && pageMax > 0) {
          targetQty = pageMax;
        } else {
          // No max detected on page — use a sensible default
          // (some pages don't show a max until you try to exceed it)
          targetQty = Math.max(quantity, 10);
        }
      }

      if (targetQty > 1) {
        await setQuantity(targetQty);
        await humanDelay(200, 500);
      }

      const addBtn = findAddToCartButton();
      if (!addBtn) return { success: false, error: 'Add to bag button not found.' };
      if (addBtn.disabled) return { success: false, error: 'Button disabled (likely out of stock).' };

      await humanDelay(100, 400);
      simulateClick(addBtn);
      await humanDelay(1000, 2000);

      // Check if an error message appeared after clicking (e.g. "max quantity exceeded")
      const errorMsg = detectCartError();

      return {
        success: true,
        quantityRequested: targetQty,
        pageMax: maxOut ? detectPageMaxQuantity() : null,
        warning: errorMsg || null,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Detect the maximum quantity allowed from the live page.
   * Checks: input max attribute, select options, +/- button limits,
   * and "limit per customer" text.
   */
  function detectPageMaxQuantity() {
    // 1. Input field with max attribute
    const qtyInput = document.querySelector(
      '[data-testid="quantity-input"] input, input[name="quantity"], .quantity-input input, input[type="number"][max]'
    );
    if (qtyInput) {
      const max = parseInt(qtyInput.getAttribute('max'));
      if (max > 0) return max;
    }

    // 2. Quantity dropdown — highest option value
    const qtySelect = document.querySelector(
      'select[name="quantity"], [data-testid="quantity-select"], .quantity-selector select'
    );
    if (qtySelect) {
      const values = Array.from(qtySelect.querySelectorAll('option'))
        .map(o => parseInt(o.value)).filter(v => v > 0);
      if (values.length > 0) return Math.max(...values);
    }

    // 3. Text on page: "Limit X per customer"
    const bodyText = document.body?.innerText ?? '';
    const patterns = [
      /limit\s+(\d+)\s+per\s+(customer|order|person|transaction)/i,
      /maximum\s+(\d+)\s+per\s+(customer|order|person|transaction)/i,
      /max(?:imum)?\s+(?:qty|quantity)[\s:]+(\d+)/i,
      /(\d+)\s+per\s+customer/i,
      /purchase\s+limit[\s:]+(\d+)/i,
    ];
    for (const pat of patterns) {
      const m = bodyText.match(pat);
      if (m) {
        const v = parseInt(m[1]);
        if (v > 0 && v <= 999) return v;
      }
    }

    return null;
  }

  /**
   * Check for error/warning messages that may appear after clicking Add to Bag.
   * e.g. "Maximum quantity reached", "Could not add to cart".
   */
  function detectCartError() {
    const errorSelectors = [
      '[data-testid="add-to-cart-error"]',
      '[data-testid="cart-error"]',
      '.cart-error-message',
      '.add-to-cart-error',
      '[class*="errorMessage"]',
      '[role="alert"]',
    ];
    for (const sel of errorSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 0) {
        return el.textContent.trim();
      }
    }
    return null;
  }

  function findAddToCartButton() {
    const selectors = [
      '[data-testid="add-to-cart-button"]',
      '[data-testid="add-to-bag-button"]',
      'button[class*="addToCart"]',
      'button[class*="addToBag"]',
      'button[aria-label*="Add to"]',
      'button[aria-label*="add to cart"]',
      'button[aria-label*="add to bag"]',
      '.add-to-cart-button',
      '.add-to-bag-button',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Fallback: text search
    for (const btn of document.querySelectorAll('button')) {
      const txt = (btn.textContent ?? '').toLowerCase();
      if (txt.includes('add to cart') || txt.includes('add to bag')) return btn;
    }
    return null;
  }

  async function selectVariant(variant) {
    const typeMap = {
      size: [
        '[data-testid="size-selector"] button',
        '.size-selector button',
        '[class*="sizeOption"] button',
      ],
      colour: [
        '[data-testid="colour-selector"] button',
        '.colour-selector button',
        '[class*="colourOption"] button',
        '[class*="colorOption"] button',
      ],
    };
    const selectors = typeMap[variant.type.toLowerCase()] ?? [];
    for (const sel of selectors) {
      for (const btn of document.querySelectorAll(sel)) {
        const label = (
          btn.getAttribute('aria-label') ??
          btn.getAttribute('title') ??
          btn.textContent?.trim() ?? ''
        ).toLowerCase();
        if (label.includes(variant.value.toLowerCase())) {
          simulateClick(btn);
          return;
        }
      }
    }
  }

  async function setQuantity(qty) {
    const qtyInput = document.querySelector(
      '[data-testid="quantity-input"] input, input[name="quantity"], .quantity-input input'
    );
    if (qtyInput) {
      // Use native setter to ensure React/framework picks it up
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(qtyInput, String(qty));
      } else {
        qtyInput.value = String(qty);
      }
      qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
      qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
      qtyInput.dispatchEvent(new Event('blur', { bubbles: true }));
      return;
    }

    // Fallback: click the "+" button repeatedly
    const plusBtn = document.querySelector(
      '[data-testid="quantity-increase"], button[aria-label*="increase"], button[aria-label*="Increase"], .qty-plus'
    );
    if (plusBtn) {
      for (let i = 1; i < qty; i++) {
        if (plusBtn.disabled) break; // Hit the max
        simulateClick(plusBtn);
        await humanDelay(150, 350);
      }
    }
  }

  // ================================================================
  // CHECKOUT ASSISTANCE
  // ================================================================

  async function setupCheckoutAssist() {
    await humanDelay(1500, 3000);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'AUTOFILL_CHECKOUT') {
        autofillCheckout(msg.payload)
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
      }
    });
  }

  async function autofillCheckout(profile) {
    const fields = [
      { selectors: ['#firstName', '[name="firstName"]', '[data-testid="firstName"]'], value: profile.firstName },
      { selectors: ['#lastName', '[name="lastName"]', '[data-testid="lastName"]'], value: profile.lastName },
      { selectors: ['#email', '[name="email"]', '[type="email"]'], value: profile.email },
      { selectors: ['#phone', '[name="phone"]', '[type="tel"]'], value: profile.phone },
      { selectors: ['#addressLine1', '[name="addressLine1"]', '[name="address1"]'], value: profile.addressLine1 },
      { selectors: ['#addressLine2', '[name="addressLine2"]', '[name="address2"]'], value: profile.addressLine2 },
      { selectors: ['#suburb', '[name="suburb"]', '[name="city"]'], value: profile.suburb },
      { selectors: ['#postcode', '[name="postcode"]', '[name="postalCode"]'], value: profile.postcode },
    ];

    for (const field of fields) {
      if (!field.value) continue;
      for (const sel of field.selectors) {
        const input = document.querySelector(sel);
        if (input) {
          await humanDelay(100, 300);
          fillInput(input, field.value);
          break;
        }
      }
    }

    if (profile.state) {
      const stateSelect = document.querySelector('#state, [name="state"], [data-testid="state"]');
      if (stateSelect) {
        const option = Array.from(stateSelect.options).find(
          o => o.value.toLowerCase() === profile.state.toLowerCase() ||
               o.textContent?.toLowerCase() === profile.state.toLowerCase()
        );
        if (option) {
          stateSelect.value = option.value;
          stateSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  }

  // ================================================================
  // DOM INTERACTION HELPERS
  // ================================================================

  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + (Math.random() - 0.5) * 4;
    const y = rect.top + rect.height / 2 + (Math.random() - 0.5) * 4;

    const events = [
      new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }),
      new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }),
      new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }),
      new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }),
      new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }),
    ];
    events.forEach(e => el.dispatchEvent(e));
  }

  function fillInput(input, value) {
    input.focus();
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ================================================================
  // FLOATING ACTION BUTTON
  // ================================================================

  function injectFloatingButton() {
    if (document.getElementById('ksm-floating-btn')) return;

    const container = document.createElement('div');
    container.id = 'ksm-floating-btn';
    container.innerHTML = `
      <div class="ksm-fab-container">
        <button class="ksm-fab" title="Kmart Stock Monitor">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <path d="M16 10a4 4 0 01-8 0"/>
          </svg>
        </button>
        <div class="ksm-fab-menu" style="display:none;">
          <button class="ksm-fab-action" data-action="monitor">Monitor This Product</button>
          <button class="ksm-fab-action" data-action="add-to-cart">Quick Add to Cart</button>
          <button class="ksm-fab-action" data-action="check-now">Check Stock Now</button>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    const fab = container.querySelector('.ksm-fab');
    const menu = container.querySelector('.ksm-fab-menu');

    fab.addEventListener('click', () => {
      menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    });

    container.querySelectorAll('.ksm-fab-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const action = e.currentTarget.dataset.action;
        menu.style.display = 'none';

        switch (action) {
          case 'monitor':
            safeSendMessage({
              type: 'ADD_PRODUCT',
              payload: { url: window.location.href },
            });
            showToast('Product added to monitor!');
            break;

          case 'add-to-cart': {
            const result = await performAddToCart();
            showToast(result.success ? 'Added to cart!' : `Failed: ${result.error}`);
            break;
          }

          case 'check-now': {
            const data = parseProductPage(document);
            const text = data.stockStatus === 'in_stock'
              ? `In Stock — $${data.price.toFixed(2)}`
              : 'Out of Stock';
            showToast(text);
            break;
          }
        }
      });
    });

    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) menu.style.display = 'none';
    });
  }

  // ---- Toast ----

  function showToast(message, duration = 3000) {
    const existing = document.getElementById('ksm-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'ksm-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 100px; right: 24px;
      background: #1a1a2e; color: #fff;
      padding: 12px 20px; border-radius: 8px;
      font-size: 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      z-index: 2147483646; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      animation: ksm-toast-in 0.3s ease; max-width: 320px;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ---- Audio alert ----

  function playAlertSound(volume) {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.value = volume * 0.3;
      osc.start();
      setTimeout(() => { osc.frequency.value = 1000; }, 150);
      setTimeout(() => { osc.frequency.value = 800; }, 300);
      setTimeout(() => { osc.frequency.value = 1200; }, 450);
      setTimeout(() => { osc.stop(); ctx.close(); }, 600);
    } catch (err) {
      console.warn('[KSM] Audio failed:', err);
    }
  }

  // ---- Bootstrap ----

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
