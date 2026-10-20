// Pure JavaScript configuration. No Python, JSON file or backend required.
// Last reviewed source snapshot (not live): Jan–Aug 2026.
export const FALLBACK_UGV_STAT = Object.freeze({
  metric: 'ukraine_ugv_logistics_casevac_missions_ytd',
  value: 111377,
  through: '2026-08',
  source: 'https://unmannedsystemstracker.com/#ugv'
});

// OPTIONAL: Replace null with an authorized, CORS-enabled HTTPS API endpoint.
// It must return {metric, value, through} with the same fields as above.
// No public API endpoint has been verified for unmannedsystemstracker.com.
export const DATA_ENDPOINT = null;
