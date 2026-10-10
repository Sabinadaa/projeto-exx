// Used by the GitHub Pages frontend to call the Node service over HTTPS.
// The Node app itself serves the frontend at the same origin, so it uses an empty base.
window.PAYMENT_API_BASE = location.hostname.endsWith('github.io')
  ? 'https://exx-nutrition-3ds.onrender.com'
  : '';
