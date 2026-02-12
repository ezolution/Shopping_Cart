// ============================================================
// Kmart Stock Monitor — Kmart Product Page Parser
// Scrapes product data from Kmart Australia pages
//
// Copyright (c) 2026 Ezolution. All rights reserved.
// https://github.com/ezolution
//
// This source code is proprietary and confidential.
// Unauthorized copying, modification, distribution, or use
// of this software, via any medium, is strictly prohibited.
// ============================================================

/** Validate that a URL is a Kmart Australia product page */
export function isValidKmartUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'www.kmart.com.au' || parsed.hostname === 'kmart.com.au') &&
      parsed.pathname.includes('/product/')
    );
  } catch {
    return false;
  }
}

/** Extract the Kmart product/SKU ID from a URL */
export function extractProductId(url) {
  const match =
    url.match(/\/product\/[^/]+-(\d{6,})\/?/i) ||
    url.match(/\/product\/[^/]+\/P_(\d+)/i) ||
    url.match(/\/product\/.*?(\d{6,})/i);
  return match ? match[1] : null;
}

/**
 * Parse product data from a live DOM (content script)
 * or from a DOMParser result (background fetch).
 */
export function parseProductPage(doc) {
  const data = {
    name: '',
    price: 0,
    stockStatus: 'unknown',
    imageUrl: '',
    variants: [],
    productId: '',
    breadcrumb: [],
  };

  // ---- Name ----
  const nameEl =
    doc.querySelector('[data-testid="product-title"]') ??
    doc.querySelector('.product-title h1') ??
    doc.querySelector('h1.css-1baxq2i') ??
    doc.querySelector('h1');
  data.name = nameEl?.textContent?.trim() ?? 'Unknown Product';

  // ---- Price ----
  data.price = parsePrice(doc);

  // ---- Stock status ----
  data.stockStatus = parseStockStatus(doc);

  // ---- Image ----
  const imgEl =
    doc.querySelector('[data-testid="product-image"] img') ??
    doc.querySelector('.product-image img') ??
    doc.querySelector('.product-gallery img') ??
    doc.querySelector('picture img');
  data.imageUrl = imgEl?.getAttribute('src') ?? imgEl?.getAttribute('data-src') ?? '';

  // ---- Product ID ----
  data.productId = parseStructuredProductId(doc);

  // ---- Variants ----
  data.variants = parseVariants(doc);

  // ---- Breadcrumb ----
  const crumbs = doc.querySelectorAll(
    '[data-testid="breadcrumb"] a, .breadcrumb a, nav[aria-label="breadcrumb"] a'
  );
  data.breadcrumb = Array.from(crumbs).map(a => a.textContent?.trim() ?? '');

  return data;
}

// ---- Internal helpers ----

function parsePrice(doc) {
  // JSON-LD first (most reliable)
  const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLd) {
    try {
      const json = JSON.parse(script.textContent ?? '');
      const offer = json?.offers ?? json?.offers?.[0];
      if (offer?.price) return parseFloat(offer.price);
    } catch { /* continue */ }
  }

  // DOM fallback
  const selectors = [
    '[data-testid="product-price"]',
    '.product-price .price',
    '.product-price__current',
    'span[class*="price"]',
    '.css-1n4h0hr',
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el?.textContent) {
      const match = el.textContent.match(/\$?([\d,]+\.?\d*)/);
      if (match) return parseFloat(match[1].replace(',', ''));
    }
  }
  return 0;
}

function parseStockStatus(doc) {
  // Check for "In Store Only" FIRST — means not available online
  const pageText = doc.body?.innerText?.toLowerCase() ?? '';
  const isInStoreOnly =
    pageText.includes('in store only') ||
    pageText.includes('in-store only') ||
    pageText.includes('available for in-store purchase only') ||
    pageText.includes('not available for delivery') ||
    !!doc.querySelector('[data-testid="in-store-only"], [class*="inStoreOnly"], [class*="in-store-only"]');

  if (isInStoreOnly) return 'out_of_stock';

  // Check for an Add to Cart button (only present for online-purchasable items)
  const addBtn =
    doc.querySelector('[data-testid="add-to-cart-button"]') ??
    doc.querySelector('button[class*="addToCart"]') ??
    doc.querySelector('button[aria-label*="Add to"]') ??
    doc.querySelector('.add-to-cart-button');

  if (addBtn) {
    if (addBtn.disabled) return 'out_of_stock';
    const text = (addBtn.textContent ?? '').toLowerCase();
    if (text.includes('out of stock') || text.includes('unavailable')) return 'out_of_stock';
    if (text.includes('add to')) return 'in_stock';
  } else {
    // No Add to Cart button — likely not available online
    // Only trust JSON-LD for OutOfStock, not InStock (which may mean in-store)
    const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLd) {
      try {
        const json = JSON.parse(script.textContent ?? '');
        const avail = json?.offers?.availability ?? json?.offers?.[0]?.availability ?? '';
        if (avail.includes('OutOfStock')) return 'out_of_stock';
      } catch { /* continue */ }
    }
    return 'out_of_stock'; // No add-to-cart button = not purchasable online
  }

  // Explicit OOS markers override everything
  const oos = doc.querySelector(
    '[data-testid="out-of-stock"], .out-of-stock-message, .oos-message'
  );
  if (oos) return 'out_of_stock';

  const lowStock = doc.querySelector('[class*="low-stock"], [class*="limited"]');
  if (lowStock) return 'limited';

  return 'unknown';
}

function parseStructuredProductId(doc) {
  const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLd) {
    try {
      const json = JSON.parse(script.textContent ?? '');
      if (json?.sku) return String(json.sku);
      if (json?.productID) return String(json.productID);
    } catch { /* continue */ }
  }
  const metaSku = doc.querySelector('meta[property="product:sku"]');
  if (metaSku) return metaSku.getAttribute('content') ?? '';
  return extractProductId(doc.location?.href ?? '') ?? '';
}

function parseVariants(doc) {
  const variants = [];

  // Size variants
  const sizeButtons = doc.querySelectorAll(
    '[data-testid="size-selector"] button, .size-selector button, [class*="sizeOption"]'
  );
  for (const btn of sizeButtons) {
    variants.push({
      type: 'size',
      value: btn.textContent?.trim() ?? '',
      available: !btn.disabled && !btn.classList.contains('unavailable'),
    });
  }

  // Colour variants
  const colourButtons = doc.querySelectorAll(
    '[data-testid="colour-selector"] button, .colour-selector button, [class*="colourOption"]'
  );
  for (const btn of colourButtons) {
    const label =
      btn.getAttribute('aria-label') ??
      btn.getAttribute('title') ??
      btn.textContent?.trim() ?? '';
    variants.push({
      type: 'colour',
      value: label,
      available: !btn.disabled && !btn.classList.contains('unavailable'),
    });
  }

  return variants;
}

/**
 * Fetch product data by URL (used by background service worker).
 * Uses fetch + DOMParser — no tab needed.
 */
export async function fetchProductData(url, headers = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-AU,en;q=0.9',
      'Cache-Control': 'no-cache',
      ...headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return parseProductPage(doc);
}
