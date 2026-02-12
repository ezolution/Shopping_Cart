# Kmart Stock Monitor — Chrome Extension

> **Copyright (c) 2026 [Ezolution](https://github.com/ezolution). All rights reserved.**
> This software is proprietary. See [LICENSE](LICENSE) for details.

A Chrome extension for monitoring Kmart Australia product availability with auto add-to-cart and checkout assistance.

**Zero dependencies. No build step. Pure vanilla JavaScript.**

---

## Features

### Product Monitoring
- Monitor multiple Kmart product URLs simultaneously (up to 50)
- Track price changes with full history
- Detect when out-of-stock items come back in stock
- Configurable check intervals with anti-detection jitter
- Rolling price/stock history per product

### Notifications
- Browser desktop notifications (works when minimised)
- Audio alert tones (configurable volume)
- Price drop alerts with customisable threshold
- Discord / Telegram webhook notifications

### Auto Add-to-Cart
- One-click add to cart from popup or floating button
- Automatic add-to-cart when stock is detected
- Variant selection support (size, colour)
- Max quantity control

### Checkout Assistance
- Quick "Go to Cart" button
- Autofill checkout forms with saved profile
- Support for Kmart's checkout flow
- Confirmation gates before proceeding

### Anti-Detection / Stealth
- Randomised check intervals with configurable jitter
- Human-like delays between actions
- User-Agent rotation (7 realistic agents)
- Cloudflare / CAPTCHA detection (pauses and alerts user)
- Exponential backoff on errors
- Rate limiting (20 requests/minute cap)
- Realistic mouse events and form filling

### Data Management
- Export / Import monitored product lists (JSON)
- Storage usage monitoring
- Per-product history with configurable cap
- Full monitoring log

---

## Setup — Load in Chrome

No build tools, no npm, no compilation needed.

### 1. Add Icons

Create PNG icon files and place them in the `icons/` directory:

```
icons/icon16.png    (16×16 pixels)
icons/icon48.png    (48×48 pixels)
icons/icon128.png   (128×128 pixels)
```

Use any image editor, or grab a free shopping bag icon and resize it.

### 2. Load the Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `Kmart Checkout` folder
5. The extension icon appears in your toolbar

### 3. Pin It

Click the puzzle-piece icon in Chrome's toolbar and pin "Kmart Stock Monitor" for easy access.

---

## Usage

### Adding a Product
1. Go to any product page on `kmart.com.au`
2. Either:
   - Click the floating red button on the page and select "Monitor This Product"
   - Copy the URL and paste it into the popup's URL input field

### Monitoring
- Products are checked automatically at your configured interval
- Green dot = actively monitoring
- Yellow dot = paused
- Red dot = error (auto-retries with backoff)
- Use the play/stop buttons in the header for global control

### Settings
Click the gear icon to open the full settings page:
- **Check Interval**: 10–600 seconds
- **Jitter**: Random timing variance for stealth (0–50%)
- **Notifications**: Browser, audio, and webhook alerts
- **Automation**: Auto add-to-cart and checkout
- **Checkout Profile**: Save shipping details for autofill
- **Webhooks**: Discord or Telegram integration

### Export / Import
- **Export**: Downloads a JSON file with all products, settings, and profiles
- **Import**: Load a previously exported JSON file

---

## Project Structure

```
Kmart Checkout/
├── manifest.json                 # Chrome Manifest V3
├── README.md
│
├── background/
│   └── service-worker.js         # Core monitoring loop & message router
│
├── content/
│   ├── content-script.js         # Page interaction (self-contained, no imports)
│   └── content-style.css         # Floating button & toast styles
│
├── popup/
│   ├── popup.html                # Extension popup
│   ├── popup.css                 # Popup dark theme styles
│   └── popup.js                  # Popup UI logic
│
├── options/
│   ├── options.html              # Settings page
│   └── options.js                # Settings logic
│
├── utils/                        # Shared modules (ES module imports)
│   ├── constants.js              # Default settings
│   ├── storage.js                # Chrome Storage API wrapper
│   ├── kmart-parser.js           # Kmart page scraper
│   ├── anti-detection.js         # Stealth utilities
│   └── notifications.js          # Alerts, badge, webhooks
│
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### How modules work

- **Background service worker** uses `type: "module"` in the manifest, so it can `import` from `utils/`.
- **Popup and Options pages** use standard `<script>` tags — they talk to the background via `chrome.runtime.sendMessage` only.
- **Content script** is fully self-contained (Chrome doesn't allow ES module imports in content scripts). All needed utility code is inlined.

---

## Anti-Detection Strategy

| Technique | Implementation |
|-----------|---------------|
| Request timing | Configurable jitter (±0–50%) on check intervals |
| User-Agent | Pool of 7 realistic UAs, rotated every ~10 minutes |
| Request headers | Full browser-like headers (Accept, Sec-Fetch-*, DNT) |
| Rate limiting | In-memory limiter: 20 req/min with queue |
| Error handling | Exponential backoff (1s → 5min cap) on failures |
| CAPTCHA detection | Detects Cloudflare/reCAPTCHA, pauses and alerts user |
| DOM interaction | MutationObserver instead of constant polling |
| Click simulation | Realistic mouse events with slight coordinate randomisation |
| Form filling | Native setter + React/Angular-compatible event dispatch |

---

## Troubleshooting

### Extension not loading
- Make sure icon PNG files exist in `icons/`
- Check Chrome DevTools console for any manifest errors

### Products not being checked
- Check that monitoring is active (green dot on the product card)
- Open the service worker console: `chrome://extensions/` → click "Inspect views: service worker"
- Ensure the product URL is a valid `kmart.com.au/product/` URL

### Notifications not showing
- Check Chrome's notification permissions for the extension
- Ensure "Browser Notifications" is enabled in Settings
- On macOS: System Settings → Notifications → Chrome must be allowed

### Add-to-cart not working
- Kmart may have changed their page structure
- Check the browser console on the Kmart page for errors
- Try the manual "Quick Add to Cart" floating button

---

## License

**Copyright (c) 2026 [Ezolution](https://github.com/ezolution). All rights reserved.**

This software is proprietary and confidential. Unauthorized copying, modification, distribution, or use of this software, via any medium, is strictly prohibited without the prior written permission of Ezolution.

See the full [LICENSE](LICENSE) file for details.

---

*Kmart Stock Monitor is developed and maintained by [Ezolution](https://github.com/ezolution).*
