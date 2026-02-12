// ============================================================
// Kmart Stock Monitor — Notifications
// Browser alerts, audio, badge, webhooks
//
// Copyright (c) 2026 Ezolution. All rights reserved.
// https://github.com/ezolution
//
// This source code is proprietary and confidential.
// Unauthorized copying, modification, distribution, or use
// of this software, via any medium, is strictly prohibited.
// ============================================================

// ---- Browser notifications ----

export async function showNotification(title, message, imageUrl, onClick) {
  const notifId = `ksm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const options = {
    type: imageUrl ? 'image' : 'basic',
    iconUrl: '',
    title,
    message,
    priority: 2,
    requireInteraction: true,
    silent: false,
  };

  if (imageUrl) options.imageUrl = imageUrl;

  return new Promise(resolve => {
    chrome.notifications.create(notifId, options, id => {
      if (onClick) {
        const handler = clickedId => {
          if (clickedId === id) {
            onClick();
            chrome.notifications.onClicked.removeListener(handler);
          }
        };
        chrome.notifications.onClicked.addListener(handler);
      }
      resolve(id ?? notifId);
    });
  });
}

export async function notifyInStock(product) {
  await showNotification(
    'Back in Stock!',
    `${product.name} is now available at $${product.currentPrice.toFixed(2)}`,
    product.imageUrl || undefined,
    () => chrome.tabs.create({ url: product.url, active: true })
  );
}

export async function notifyPriceDrop(product, oldPrice, newPrice) {
  const dropPct = ((oldPrice - newPrice) / oldPrice * 100).toFixed(1);
  await showNotification(
    'Price Drop!',
    `${product.name}: $${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)} (−${dropPct}%)`,
    product.imageUrl || undefined,
    () => chrome.tabs.create({ url: product.url, active: true })
  );
}

export async function notifyError(product, error) {
  await showNotification('Monitor Error', `${product.name}: ${error}`);
}

export async function notifyCaptcha(product) {
  await showNotification(
    'CAPTCHA Detected',
    `Monitoring paused for ${product.name}. Please solve the CAPTCHA manually.`,
    undefined,
    () => chrome.tabs.create({ url: product.url, active: true })
  );
}

// ---- Audio alerts ----

export async function playAudioAlert(volume = 0.7) {
  try {
    await chrome.runtime.sendMessage({
      type: 'PLAY_AUDIO',
      payload: { volume },
    });
  } catch {
    console.warn('[Audio] No listener available to play alert.');
  }
}

// ---- Badge ----

export async function updateBadge(inStockCount) {
  const text = inStockCount > 0 ? String(inStockCount) : '';
  const color = inStockCount > 0 ? '#22c55e' : '#6b7280';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ---- Webhook dispatch ----

export async function sendWebhook(url, product, event, oldPrice) {
  if (!url) return false;

  const isDiscord = url.includes('discord.com/api/webhooks');
  let body;

  if (event === 'in_stock') {
    if (isDiscord) {
      body = {
        content: '',
        embeds: [{
          title: 'Back in Stock!',
          description: product.name,
          url: product.url,
          color: 0x22c55e,
          fields: [{ name: 'Price', value: `$${product.currentPrice.toFixed(2)}`, inline: true }],
          thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
          timestamp: new Date().toISOString(),
        }],
      };
    } else {
      body = {
        text: `Back in Stock! ${product.name} - $${product.currentPrice.toFixed(2)} ${product.url}`,
      };
    }
  } else {
    const dropPct = oldPrice ? ((oldPrice - product.currentPrice) / oldPrice * 100).toFixed(1) : '?';
    if (isDiscord) {
      body = {
        content: '',
        embeds: [{
          title: 'Price Drop!',
          description: product.name,
          url: product.url,
          color: 0xeab308,
          fields: [
            { name: 'Old Price', value: `$${(oldPrice ?? 0).toFixed(2)}`, inline: true },
            { name: 'New Price', value: `$${product.currentPrice.toFixed(2)}`, inline: true },
            { name: 'Drop', value: `${dropPct}%`, inline: true },
          ],
          thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
          timestamp: new Date().toISOString(),
        }],
      };
    } else {
      body = {
        text: `Price Drop! ${product.name} $${(oldPrice ?? 0).toFixed(2)} → $${product.currentPrice.toFixed(2)} ${product.url}`,
      };
    }
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch (err) {
    console.error('[Webhook] Failed:', err);
    return false;
  }
}
