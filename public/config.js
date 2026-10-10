// Backend Node que mantém a chave secreta Asaas no servidor.
// Ao trocar de hospedagem, altere somente esta URL (HTTPS obrigatório em produção).
window.PAYMENT_API_BASE = location.hostname.endsWith('github.io')
  ? 'https://exx-nutrition-3ds.onrender.com'
  : '';
