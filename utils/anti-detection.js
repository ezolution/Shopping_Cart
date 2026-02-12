// ============================================================
// Kmart Stock Monitor — Anti-Detection / Stealth Utilities
// Jitter, backoff, UA rotation, rate limiting, detection checks
//
// Copyright (c) 2026 Ezolution. All rights reserved.
// https://github.com/ezolution
//
// This source code is proprietary and confidential.
// Unauthorized copying, modification, distribution, or use
// of this software, via any medium, is strictly prohibited.
// ============================================================

// ---- Timing jitter ----

/**
 * Add random jitter to an interval.
 * @param {number} baseMs   Base interval in milliseconds
 * @param {number} jitterPct  ± percentage (e.g. 15 → ±15%)
 * @returns {number}
 */
export function jitter(baseMs, jitterPct = 15) {
  const factor = 1 + (Math.random() * 2 - 1) * (jitterPct / 100);
  return Math.round(baseMs * factor);
}

/**
 * Sleep for a random human-like duration.
 * @param {number} minMs
 * @param {number} maxMs
 */
export function humanDelay(minMs = 200, maxMs = 800) {
  const ms = Math.round(minMs + Math.random() * (maxMs - minMs));
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Exponential backoff ----

export function backoffDelay(errorCount) {
  const base = 1000;
  const cap = 5 * 60 * 1000;
  const delay = Math.min(base * Math.pow(2, errorCount), cap);
  return jitter(delay, 20);
}

// ---- User-Agent rotation ----

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

let currentUAIndex = Math.floor(Math.random() * USER_AGENTS.length);

export function getUserAgent() {
  return USER_AGENTS[currentUAIndex];
}

export function rotateUserAgent() {
  let next;
  do {
    next = Math.floor(Math.random() * USER_AGENTS.length);
  } while (next === currentUAIndex && USER_AGENTS.length > 1);
  currentUAIndex = next;
  return USER_AGENTS[currentUAIndex];
}

// ---- Request headers ----

export function buildHeaders(referer) {
  return {
    'User-Agent': getUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    ...(referer ? { Referer: referer } : {}),
  };
}

// ---- Rate limiter ----

export class RateLimiter {
  constructor(maxRequests = 10, windowMs = 60000) {
    this.timestamps = [];
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  canRequest() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    return this.timestamps.length < this.maxRequests;
  }

  record() {
    this.timestamps.push(Date.now());
  }

  waitTime() {
    if (this.canRequest()) return 0;
    const oldest = this.timestamps[0];
    return oldest + this.windowMs - Date.now();
  }
}

// ---- Cloudflare / CAPTCHA detection ----

export function isCloudflareChallenge(html, status) {
  if (status === 403 || status === 503) {
    const markers = [
      'cf-browser-verification', 'cf_chl_opt', 'challenge-platform',
      'Checking your browser', 'Just a moment', '_cf_chl', 'ray ID',
    ];
    const lower = html.toLowerCase();
    return markers.some(m => lower.includes(m.toLowerCase()));
  }
  return false;
}

export function hasCaptcha(html) {
  const markers = [
    'g-recaptcha', 'h-captcha', 'cf-turnstile', 'captcha-container',
    'recaptcha/api', 'hcaptcha.com', 'challenges.cloudflare.com',
  ];
  const lower = html.toLowerCase();
  return markers.some(m => lower.includes(m));
}

// ---- Session rotation ----

let sessionTimer = null;

export function startSessionRotation(intervalMs = 10 * 60 * 1000) {
  stopSessionRotation();
  sessionTimer = setInterval(() => {
    rotateUserAgent();
    console.log('[Stealth] Rotated UA:', getUserAgent());
  }, intervalMs);
}

export function stopSessionRotation() {
  if (sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
}
