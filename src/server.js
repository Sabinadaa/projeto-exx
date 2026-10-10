const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ASAAS_API_KEY || '';
const API_BASE = (process.env.ASAAS_API_BASE || 'https://api-sandbox.asaas.com/v3').replace(/\/$/, '');
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || 'https://sabinadaa.github.io,http://localhost:3000,http://localhost:3001').split(',').map(origin => origin.trim()).filter(Boolean));
if (process.env.RENDER_EXTERNAL_URL) ALLOWED_ORIGINS.add(process.env.RENDER_EXTERNAL_URL.replace(/\/$/, ''));
const isProductionApi = API_BASE === 'https://api.asaas.com/v3';
const PRODUCT_PRICE = 189.00;
const PAYMENT_EVENTS = new Set([
  'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
  'PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED', 'PAYMENT_OVERDUE',
  'PAYMENT_REFUNDED', 'PAYMENT_DELETED', 'PAYMENT_RESTORED'
]);
const payments = new Map();
const seenEvents = new Set();
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_ROOT = path.join(ROOT, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 100_000) { reject(new Error('Requisição muito grande.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON inválido.')); } });
    req.on('error', reject);
  });
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const localDev = process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!ALLOWED_ORIGINS.has(origin) && !localDev) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, asaas-access-token');
  return true;
}
function payerIp(req) {
  const raw = req.socket.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}
function safePayment(payment, entry) {
  return {
    id: payment.id,
    orderId: entry?.orderId || payment.externalReference,
    method: entry?.method || (payment.billingType === 'PIX' ? 'PIX' : 'CREDIT_CARD'),
    amount: payment.value,
    status: payment.status,
    providerStatus: payment.status,
    event: entry?.event || null,
    challengeUrl: payment.threeDSecureChallengeUrl || entry?.challengeUrl || null,
    invoiceUrl: payment.invoiceUrl || entry?.invoiceUrl || null,
    pix: entry?.pix || null,
    createdAt: entry?.createdAt || payment.dateCreated || new Date().toISOString(),
    updatedAt: payment.clientPaymentDate || payment.paymentDate || null
  };
}
async function asaas(pathname, method, body) {
  if (!API_KEY) throw Object.assign(new Error('Asaas não configurado. Defina ASAAS_API_KEY no servidor.'), { status: 503 });
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: { access_token: API_KEY, 'content-type': 'application/json', accept: 'application/json', 'User-Agent': 'Sistema3DS/1.0' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000)
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.errors?.map(item => item.description).join('; ') || data.message || `Asaas retornou HTTP ${response.status}`);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return data;
}
function validate(body) {
  const method = body.paymentMethod;
  if (!['PIX', 'CREDIT_CARD', 'DEBIT_CARD'].includes(method)) throw Object.assign(new Error('Escolha Pix, cartão de crédito ou cartão de débito.'), { status: 400 });
  const holder = body.holder || {};
  if (!holder.name?.trim() || !/^\S+@\S+\.\S+$/.test(holder.email || '') || !/^\d{11}$/.test(holder.cpf || '')) {
    throw Object.assign(new Error('Informe nome, e-mail válido e CPF com 11 dígitos.'), { status: 400 });
  }
  if (method === 'CREDIT_CARD') {
    const card = body.card || {};
    if (!/^\d{12,19}$/.test(card.number || '') || !/^\d{2}$/.test(card.expiryMonth || '') || !/^\d{4}$/.test(card.expiryYear || '') || !/^\d{3,4}$/.test(card.ccv || '')) {
      throw Object.assign(new Error('Confira os dados do cartão de crédito.'), { status: 400 });
    }
    if (!holder.phone || !holder.postalCode || !holder.address || !holder.addressNumber || !holder.province) {
      throw Object.assign(new Error('Complete os dados de contato e endereço para validar o cartão.'), { status: 400 });
    }
  }
}
async function createAsaasPayment(body, req, orderId) {
  if (body.paymentMethod === 'CREDIT_CARD' && isProductionApi && !PUBLIC_BASE_URL.startsWith('https://')) {
    throw Object.assign(new Error('Configure PUBLIC_BASE_URL com HTTPS para usar 3DS em produção.'), { status: 400 });
  }
  const holder = body.holder;
  const customer = await asaas('/customers', 'POST', {
    name: holder.name.trim(), email: holder.email.trim(), cpfCnpj: holder.cpf,
    ...(holder.phone ? { mobilePhone: holder.phone } : {}), notificationDisabled: true
  });
  const method = body.paymentMethod;
  const requestBody = {
    customer: customer.id,
    billingType: method === 'PIX' ? 'PIX' : 'CREDIT_CARD',
    value: PRODUCT_PRICE,
    dueDate: new Date().toISOString().slice(0, 10),
    description: 'Whey 100% Concentrado Pouch 900g — EXX Nutrition',
    externalReference: orderId
  };
  if (method === 'CREDIT_CARD') {
    requestBody.creditCard = {
      holderName: body.card.holderName,
      number: body.card.number,
      expiryMonth: body.card.expiryMonth,
      expiryYear: body.card.expiryYear,
      ccv: body.card.ccv
    };
    requestBody.creditCardHolderInfo = {
      name: holder.name, email: holder.email, cpfCnpj: holder.cpf,
      postalCode: holder.postalCode, address: holder.address,
      addressNumber: holder.addressNumber, province: holder.province, phone: holder.phone
    };
    requestBody.threeDSecure = { callbackUrl: `${PUBLIC_BASE_URL}/callback/3ds` };
    requestBody.deviceInfo = { ...body.deviceInfo, remoteIp: payerIp(req) };
  }
  const providerPayment = await asaas('/payments', 'POST', requestBody);
  let pix = null;
  if (method === 'PIX') pix = await asaas(`/payments/${encodeURIComponent(providerPayment.id)}/pixQrCode`, 'GET');
  const entry = {
    id: providerPayment.id, orderId, method, amount: PRODUCT_PRICE,
    status: providerPayment.status || 'PENDING', event: null,
    challengeUrl: providerPayment.threeDSecureChallengeUrl || null,
    invoiceUrl: providerPayment.invoiceUrl || null, pix,
    createdAt: new Date().toISOString()
  };
  payments.set(entry.id, entry);
  return { ...entry, mode: 'asaas', providerStatus: entry.status };
}
function applyWebhook(body) {
  if (!body.id || !body.event || !PAYMENT_EVENTS.has(body.event)) return { invalid: true };
  if (seenEvents.has(body.id)) return { duplicate: true };
  seenEvents.add(body.id);
  const paymentId = body.payment?.id;
  const entry = payments.get(paymentId);
  if (entry) {
    entry.event = body.event;
    if (body.payment?.status) entry.status = body.payment.status;
    else if (body.event === 'PAYMENT_CONFIRMED') entry.status = 'CONFIRMED';
    else if (body.event === 'PAYMENT_RECEIVED') entry.status = 'RECEIVED';
    else if (body.event.includes('REFUSED') || body.event.includes('FAILED')) entry.status = 'REFUSED';
    else if (body.event === 'PAYMENT_OVERDUE') entry.status = 'OVERDUE';
    else if (body.event === 'PAYMENT_REFUNDED') entry.status = 'REFUNDED';
    entry.updatedAt = new Date().toISOString();
  }
  return { duplicate: false };
}

const server = http.createServer(async (req, res) => {
  if (!applyCors(req, res)) return json(res, 403, { error: 'Origem não autorizada.' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, {
      mode: API_KEY ? 'asaas' : 'unconfigured',
      api: API_KEY ? (isProductionApi ? 'produção' : 'sandbox') : null,
      webhookReady: Boolean(WEBHOOK_TOKEN),
      message: API_KEY ? null : 'Backend disponível, mas ASAAS_API_KEY não está configurada.'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/payments') {
    try {
      if (!API_KEY) return json(res, 503, { error: 'Asaas não configurado. Defina ASAAS_API_KEY no servidor; nenhum pagamento foi simulado.' });
      const body = await readBody(req);
      validate(body);
      const orderId = `PED-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      return json(res, 201, await createAsaasPayment(body, req, orderId));
    } catch (error) { return json(res, error.status || 502, { error: error.message || 'Não foi possível iniciar o pagamento.' }); }
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/asaas') {
    if (!WEBHOOK_TOKEN) return json(res, 503, { error: 'Configure ASAAS_WEBHOOK_TOKEN no servidor.' });
    if (!safeEqual(req.headers['asaas-access-token'], WEBHOOK_TOKEN)) return json(res, 401, { error: 'Token do webhook inválido.' });
    try {
      const result = applyWebhook(await readBody(req));
      if (result.invalid) return json(res, 400, { error: 'Evento de cobrança não reconhecido.' });
      return json(res, 200, { received: true, duplicate: Boolean(result.duplicate) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/payments/')) {
    try {
      const paymentId = decodeURIComponent(url.pathname.slice('/api/payments/'.length));
      if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) return json(res, 400, { error: 'Identificador de cobrança inválido.' });
      const providerPayment = await asaas(`/payments/${encodeURIComponent(paymentId)}`, 'GET');
      if (!String(providerPayment.externalReference || '').startsWith('PED-')) return json(res, 404, { error: 'Cobrança deste checkout não encontrada.' });
      const entry = payments.get(paymentId);
      if (entry) entry.status = providerPayment.status;
      return json(res, 200, safePayment(providerPayment, entry));
    } catch (error) { return json(res, error.status || 502, { error: error.message || 'Não foi possível consultar o pagamento.' }); }
  }

  if (req.method === 'GET' && url.pathname === '/callback/3ds') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Autenticação concluída</title><body style="margin:0;background:#f4f4f4;font:16px system-ui;color:#171717;display:grid;place-items:center;min-height:100vh"><main style="background:white;padding:36px;border-radius:20px;max-width:480px;box-shadow:0 15px 50px #0001"><div style="font-size:30px">🔐</div><h1>Autenticação concluída</h1><p>O retorno do banco foi recebido. O pagamento permanece pendente até o Asaas confirmar o resultado.</p><p>Volte ao checkout para acompanhar o status.</p></main></body>`);
  }

  const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = requested === 'index.html' ? path.join(ROOT, 'index.html') : requested.startsWith('public/') ? path.resolve(ROOT, requested) : '';
  if (!file || (file !== path.join(ROOT, 'index.html') && !file.startsWith(PUBLIC_ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Não encontrado.' });
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => console.log(`Checkout EXX disponível em ${PUBLIC_BASE_URL} (${API_KEY ? `Asaas ${isProductionApi ? 'produção' : 'sandbox'}` : 'Asaas não configurado'})`));
