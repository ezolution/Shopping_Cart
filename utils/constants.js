// ============================================================
// Kmart Stock Monitor — Shared Constants & Defaults
//
// Copyright (c) 2026 Ezolution. All rights reserved.
// https://github.com/ezolution
//
// This source code is proprietary and confidential.
// Unauthorized copying, modification, distribution, or use
// of this software, via any medium, is strictly prohibited.
// ============================================================

export const DEFAULT_SETTINGS = {
  checkIntervalSeconds: 30,
  jitterPercent: 15,
  maxProducts: 50,
  globalAutoAdd: false,
  notificationsEnabled: true,
  audioAlertEnabled: true,
  audioVolume: 0.7,
  priceDropThreshold: 10,
  autoCheckout: false,
  checkoutConfirmGates: true,
  webhookUrl: '',
  webhookEnabled: false,
  maxHistoryPerProduct: 500,
  theme: 'system',
};
