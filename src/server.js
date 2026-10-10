const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ASAAS_API_KEY || '';
const API_BASE = (process.env.ASAAS_API_BASE || 'https://api-sandbox.asaas.com/v3').replace(/\/$/, '');
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || 'https://sabinadaa.github.io,http://localhost:3000').split(',').map(origin => origin.trim()).filter(Boolean));
if (process.env.RENDER_EXTERNAL_URL) ALLOWED_ORIGINS.add(process.env.RENDER_EXTERNAL_URL.replace(/\/$/, ''));
const isProductionApi = API_BASE === 'https://api.asaas.com/v3';
const PRODUCT_PRICE = 189.00;
const PAYMENT_EVENTS = ['PAYMENT_CONFIRMED', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED'];
const payments = new Map();
const seenEvents = new Set();
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_ROOT = path.join(ROOT, 'public');

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 100_000) reject(new Error('Requisição muito grande.')); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON inválido.')); } }); req.on('error', reject); }); }
function safeEqual(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const isLocalDevOrigin = process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!ALLOWED_ORIGINS.has(origin) && !isLocalDevOrigin) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  return true;
}
function localIp(req) { const raw = req.socket.remoteAddress || ''; return raw.startsWith('::ffff:') ? raw.slice(7) : raw; }
function applyPaymentEvent(payment, event) {
  payment.event = event;
  if (event === 'PAYMENT_CONFIRMED') payment.status = 'CONFIRMED';
  if (['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED'].includes(event)) payment.status = 'REFUSED';
  payment.updatedAt = new Date().toISOString();
}
function acceptWebhook(eventIds, eventId, payment, event) {
  if (!PAYMENT_EVENTS.includes(event)) return { invalid: true };
  if (eventIds.has(eventId)) return { duplicate: true };
  eventIds.add(eventId);
  if (payment) applyPaymentEvent(payment, event);
  return { duplicate: false };
}

async function asaas(pathname, method, body) {
  const response = await fetch(`${API_BASE}${pathname}`, { method, headers: { access_token: API_KEY, 'content-type': 'application/json', accept: 'application/json', 'User-Agent': 'Sistema3DS/1.0' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000) });
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) { const err = new Error(data.errors?.map(e => e.description).join('; ') || data.message || `Asaas retornou HTTP ${response.status}`); err.status = response.status; throw err; }
  return data;
}

async function createAsaasPayment(body, req) {
  if (isProductionApi && !PUBLIC_BASE_URL.startsWith('https://')) throw Object.assign(new Error('Configure PUBLIC_BASE_URL com HTTPS para usar 3DS em produção.'), { status: 400 });
  const customer = await asaas('/customers', 'POST', { name: body.holder.name, email: body.holder.email, cpfCnpj: body.holder.cpf, notificationDisabled: true });
  const payment = await asaas('/payments', 'POST', {
    customer: customer.id,
    billingType: 'CREDIT_CARD',
    value: PRODUCT_PRICE,
    dueDate: new Date().toISOString().slice(0, 10),
    description: 'Pedido protegido — Sistema 3DS',
    externalReference: body.orderId,
    creditCard: { holderName: body.card.holderName, number: body.card.number.replace(/\s/g, ''), expiryMonth: body.card.expiryMonth, expiryYear: body.card.expiryYear, ccv: body.card.ccv },
    creditCardHolderInfo: { name: body.holder.name, email: body.holder.email, cpfCnpj: body.holder.cpf, postalCode: body.holder.postalCode, address: body.holder.address, addressNumber: body.holder.addressNumber, province: body.holder.province, phone: body.holder.phone },
    threeDSecure: { callbackUrl: `${PUBLIC_BASE_URL}/callback/3ds` },
    deviceInfo: { ...body.deviceInfo, remoteIp: localIp(req) }
  });
  const entry = { id: payment.id, orderId: body.orderId, status: 'PENDING', providerStatus: payment.status, amount: PRODUCT_PRICE, mode: 'asaas', event: null, challengeUrl: payment.threeDSecureChallengeUrl || null, createdAt: new Date().toISOString() };
  payments.set(entry.id, entry);
  return entry;
}

const server = http.createServer(async (req, res) => {
  if (!applyCors(req, res)) return json(res, 403, { error: 'Origem não autorizada.' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { mode: API_KEY ? 'asaas' : 'demo', api: API_KEY ? (isProductionApi ? 'produção' : 'sandbox') : null, webhookReady: Boolean(WEBHOOK_TOKEN) });

  if (req.method === 'POST' && url.pathname === '/api/payments') {
    try {
      const body = await readBody(req);
      if (body.value != null && Number(body.value) !== PRODUCT_PRICE) return json(res, 400, { error: 'Valor do pedido divergente do catálogo. Pagamento bloqueado.' });
      if (!body.holder?.name || !body.holder?.email || !body.holder?.cpf || !body.card?.number || !body.card?.ccv) return json(res, 400, { error: 'Preencha os dados do pagador e do cartão.' });
      const orderId = `PED-${Date.now().toString(36).toUpperCase()}`;
      const input = { ...body, orderId };
      let result;
      if (API_KEY) result = await createAsaasPayment(input, req);
      else {
        const scenario = ['challenge', 'approved', 'refused'].includes(body.scenario) ? body.scenario : 'challenge';
        result = { id: `pay_demo_${crypto.randomBytes(5).toString('hex')}`, orderId, status: 'PENDING', amount: PRODUCT_PRICE, mode: 'demo', event: null, challengeUrl: scenario === 'challenge' ? '/issuer-challenge' : null, scenario, createdAt: new Date().toISOString() };
        payments.set(result.id, result);
      }
      return json(res, 201, result);
    } catch (error) { return json(res, error.status || 400, { error: error.message || 'Não foi possível iniciar o pagamento.' }); }
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/demo/')) {
    if (API_KEY) return json(res, 403, { error: 'A simulação está disponível apenas sem uma chave Asaas configurada.' });
    try {
      const body = await readBody(req);
      const payment = payments.get(body.paymentId);
      if (!payment) return json(res, 404, { error: 'Pagamento não encontrado.' });
      if (url.pathname === '/api/demo/challenge') {
        if (payment.status !== 'PENDING') return json(res, 409, { error: 'Este pagamento não aguarda autenticação.' });
        payment.issuerResult = body.result === 'fail' ? 'fail' : 'success';
        return json(res, 200, { ...payment, status: 'PENDING', message: 'Autenticação concluída. Aguardando confirmação do processamento.' });
      }
      if (url.pathname === '/api/demo/webhook') {
        const eventId = body.eventId || `evt_${crypto.randomUUID()}`;
        const event = body.event;
        const accepted = acceptWebhook(seenEvents, eventId, payment, event);
        if (accepted.invalid) return json(res, 400, { error: 'Evento de demonstração inválido.' });
        if (accepted.duplicate) return json(res, 200, { ...payment, duplicate: true, message: 'Webhook repetido: evento ignorado (idempotência).' });
        return json(res, 200, payment);
      }
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/asaas') {
    if (!WEBHOOK_TOKEN) return json(res, 503, { error: 'Configure ASAAS_WEBHOOK_TOKEN no servidor.' });
    if (!safeEqual(req.headers['asaas-access-token'], WEBHOOK_TOKEN)) return json(res, 401, { error: 'Token do webhook inválido.' });
    try {
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: 'ID do evento obrigatório.' });
      const id = body.payment?.id;
      const payment = payments.get(id);
      const accepted = acceptWebhook(seenEvents, body.id, payment, body.event);
      if (accepted.invalid) return json(res, 400, { error: 'Evento não reconhecido.' });
      return json(res, 200, { received: true, duplicate: accepted.duplicate });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/payments/')) {
    const payment = payments.get(decodeURIComponent(url.pathname.split('/').pop()));
    return payment ? json(res, 200, payment) : json(res, 404, { error: 'Pagamento não encontrado.' });
  }

  if (req.method === 'GET' && url.pathname === '/callback/3ds') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Autenticação concluída</title><body style="margin:0;background:#f4f6fb;font:16px system-ui;color:#172333;display:grid;place-items:center;min-height:100vh"><main style="background:white;padding:36px;border-radius:20px;max-width:480px;box-shadow:0 15px 50px #19365718"><div style="font-size:30px">🔐</div><h1>Autenticação concluída</h1><p>Seu retorno do banco foi recebido. O pagamento continua em processamento até o Asaas confirmar o resultado por webhook.</p><p>Você pode voltar à tela do Sistema 3DS.</p></main></body>`);
  }

  const requested = url.pathname === '/' || url.pathname === '/issuer-challenge' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = requested === 'index.html'
    ? path.join(ROOT, 'index.html')
    : requested.startsWith('public/') ? path.resolve(ROOT, requested) : '';
  if (!file || (file !== path.join(ROOT, 'index.html') && !file.startsWith(PUBLIC_ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Não encontrado.' });
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => console.log(`Sistema 3DS disponível em ${PUBLIC_BASE_URL} (${API_KEY ? `Asaas ${isProductionApi ? 'produção' : 'sandbox'}` : 'modo demonstração'})`));
