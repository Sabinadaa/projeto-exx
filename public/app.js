const $ = selector => document.querySelector(selector);
const form = $('#payment-form');
const button = $('#pay-button');
const toast = $('#toast');
const apiBase = (window.PAYMENT_API_BASE || '').replace(/\/+$/, '');
const orderTotal = Number($('#payment-form').dataset.total) || 189;
let config = { mode: 'unconfigured' };
let currentPayment = null;
let pollTimer = null;

async function request(url, options = {}) {
  const response = await fetch(`${apiBase}${url}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    cache: 'no-store'
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || 'Falha ao processar a solicitação.');
  return data;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4200);
}

function digits(id) { return $(`#${id}`).value.replace(/\D/g, ''); }
function maskDigits(input, pattern) {
  const raw = input.value.replace(/\D/g, '');
  let out = '', i = 0;
  for (const ch of pattern) {
    if (ch === '#') { if (raw[i] == null) break; out += raw[i++]; }
    else { if (raw.length <= i) break; out += ch; }
  }
  input.value = out;
}

$('#card-number').addEventListener('input', e => maskDigits(e.target, '#### #### #### ####'));
$('#expiry').addEventListener('input', e => maskDigits(e.target, '## / ##'));
$('#cpf').addEventListener('input', e => maskDigits(e.target, '###.###.###-##'));
$('#phone').addEventListener('input', e => {
  const d = e.target.value.replace(/\D/g, '').slice(0, 11);
  e.target.value = d.length > 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length > 6 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d.length > 2 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d;
});
$('#postal').addEventListener('input', e => maskDigits(e.target, '#####-###'));

function selectedMethod() { return $('input[name="payment-method"]:checked')?.value || 'PIX'; }
function updateInstallmentSummary() {
  const count = Number($('#installments').value) || 1;
  const amount = orderTotal / count;
  const money = value => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  $('#installment-summary').textContent = count === 1
    ? `Pagamento à vista: ${money(orderTotal)}.`
    : `${count} parcelas de ${money(amount)} (total ${money(orderTotal)}).`;
}
function updateMethod() {
  const method = selectedMethod();
  const cardFields = $('#card-fields');
  const address = $('.address-details');
  cardFields.hidden = method !== 'CREDIT_CARD';
  address.hidden = method !== 'CREDIT_CARD';
  $('#phone').required = method === 'CREDIT_CARD';
  for (const id of ['card-number', 'expiry', 'cvv']) $(`#${id}`).required = method === 'CREDIT_CARD';
  $('#panel-title').textContent = method === 'PIX' ? 'Pix' : method === 'DEBIT_CARD' ? 'Cartão de débito' : 'Cartão de crédito';
  $('#button-method').textContent = method === 'PIX' ? 'Gerar Pix' : method === 'DEBIT_CARD' ? 'Continuar para débito' : 'Pagar com crédito';
  $('#method-hint').textContent = method === 'DEBIT_CARD'
    ? 'O pagamento será concluído na página segura do Asaas, onde você poderá escolher débito.'
    : method === 'PIX' ? 'O QR Code será gerado pelo Asaas e confirmado após o pagamento.' : 'O banco pode solicitar uma etapa de autenticação 3D Secure.';
}
document.querySelectorAll('input[name="payment-method"]').forEach(input => input.addEventListener('change', updateMethod));
$('#installments').addEventListener('change', updateInstallmentSummary);
updateInstallmentSummary();
updateMethod();

function setRow(id, state, detail) {
  const row = $(`#${id}`);
  row.className = `timeline-row ${state}`;
  const icon = row.querySelector('.timeline-icon');
  icon.textContent = state === 'done' ? '✓' : state === 'failed' ? '×' : state === 'active' ? '◌' : id === 'auth-row' ? '2' : '3';
  row.querySelector('small').textContent = detail;
}

function renderPayment(payment) {
  currentPayment = payment;
  $('#order-time').textContent = `Pedido ${payment.orderId || 'Asaas'} · ${new Date(payment.createdAt || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  $('#mode-badge').textContent = (config.api || 'ASAAS').toUpperCase();
  $('#mode-badge').classList.add('live');
  $('#event-log').hidden = !payment.event;
  if (payment.event) $('#event-name').textContent = payment.event;

  const pixPanel = $('#pix-result');
  if (payment.pix?.encodedImage) {
    $('#pix-qr').src = `data:image/png;base64,${payment.pix.encodedImage}`;
    $('#pix-payload').value = payment.pix.payload || '';
    $('#pix-expiration').textContent = payment.pix.expirationDate ? `Válido até ${new Date(payment.pix.expirationDate).toLocaleString('pt-BR')}` : 'QR Code gerado pelo Asaas';
    pixPanel.hidden = false;
  }

  const finalStatuses = ['CONFIRMED', 'RECEIVED', 'REFUNDED', 'REFUND_REQUESTED', 'CHARGEBACK_REQUESTED', 'OVERDUE', 'CANCELED', 'DELETED'];
  if (['CONFIRMED', 'RECEIVED'].includes(payment.status)) {
    setRow('auth-row', 'done', payment.method === 'CREDIT_CARD' ? 'Validação processada pelo banco / 3DS' : 'Forma de pagamento processada');
    setRow('result-row', 'done', 'Pagamento confirmado pelo Asaas');
    $('#pending-note').innerHTML = '<span>✓</span> Pagamento confirmado pelo Asaas. O pedido pode ser liberado.';
  } else if (['REFUSED', 'REFUNDED', 'CANCELED', 'DELETED', 'OVERDUE', 'CHARGEBACK_REQUESTED'].includes(payment.status)) {
    setRow('auth-row', 'failed', payment.status === 'OVERDUE' ? 'Pagamento vencido' : 'Pagamento não aprovado');
    setRow('result-row', 'failed', `Status Asaas: ${payment.status}`);
    $('#pending-note').innerHTML = '<span>!</span> Não libere o pedido. Consulte o status atualizado no Asaas.';
  } else {
    setRow('auth-row', payment.challengeUrl ? 'active' : 'done', payment.challengeUrl ? 'O banco emissor solicita uma confirmação' : 'Dados recebidos pelo Asaas');
    setRow('result-row', '', `Aguardando confirmação do Asaas · ${payment.status || 'PENDING'}`);
    $('#pending-note').innerHTML = '<span>◉</span> Retorno ao checkout não confirma pagamento. Aguardando o Asaas.';
  }
  if (payment.invoiceUrl) {
    $('#hosted-link').href = payment.invoiceUrl;
    $('#hosted-payment').hidden = false;
  }
  if (!finalStatuses.includes(payment.status)) startPolling(payment.id);
}

async function refreshPayment(id) {
  const data = await request(`/api/payments/${encodeURIComponent(id)}`);
  renderPayment(data);
}
function startPolling(id) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const data = await request(`/api/payments/${encodeURIComponent(id)}`);
      renderPayment(data);
      if (['CONFIRMED', 'RECEIVED', 'REFUSED', 'REFUNDED', 'CANCELED', 'DELETED', 'OVERDUE'].includes(data.status)) clearInterval(pollTimer);
    } catch { /* Mantém a cobrança pendente enquanto o servidor tenta novamente. */ }
  }, 5000);
}

$('#copy-pix').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#pix-payload').value); notify('Código Pix copiado.'); }
  catch { $('#pix-payload').select(); document.execCommand('copy'); notify('Código Pix copiado.'); }
});

function validateForm(method) {
  for (const [id, message] of [['name', 'Informe o nome do titular.'], ['email', 'Informe um e-mail válido.'], ['cpf', 'Informe o CPF do titular.']]) {
    const field = $(`#${id}`);
    if (!field.value.trim()) { notify(message); field.focus(); return false; }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($('#email').value.trim())) { notify('Confira o formato do e-mail.'); $('#email').focus(); return false; }
  if (digits('cpf').length !== 11) { notify('O CPF deve ter 11 dígitos.'); $('#cpf').focus(); return false; }
  if (method === 'CREDIT_CARD') {
    for (const [id, message] of [['card-number', 'Informe o número do cartão.'], ['expiry', 'Informe a validade do cartão.'], ['cvv', 'Informe o código de segurança.'], ['phone', 'Informe o celular do titular.']]) {
      const field = $(`#${id}`);
      if (!field.value.trim()) { notify(message); field.focus(); return false; }
    }
    if (digits('card-number').length < 12) { notify('Confira o número do cartão.'); $('#card-number').focus(); return false; }
    if (!/^\d{2}\s*\/\s*\d{2,4}$/.test($('#expiry').value)) { notify('Use a validade no formato MM / AA.'); $('#expiry').focus(); return false; }
    if (!/^\d{3,4}$/.test(digits('cvv'))) { notify('O código de segurança deve ter 3 ou 4 dígitos.'); $('#cvv').focus(); return false; }
    if (digits('phone').length < 10) { notify('Informe um celular com DDD.'); $('#phone').focus(); return false; }
    const missingAddress = ['postal', 'number', 'address', 'province'].find(id => !$(`#${id}`).value.trim());
    if (missingAddress) { $('.address-details').open = true; notify('Complete o endereço de cobrança para validar o cartão.'); $(`#${missingAddress}`).focus(); return false; }
  }
  return true;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const method = selectedMethod();
  if (config.mode !== 'asaas') { notify(config.error || 'Asaas indisponível. Configure e publique o backend com uma chave de API.'); return; }
  if (!validateForm(method)) return;
  const body = {
    paymentMethod: method,
    holder: { name: $('#name').value.trim(), email: $('#email').value.trim(), cpf: digits('cpf'), phone: digits('phone') },
    deviceInfo: { colorDepth: screen.colorDepth, screenHeight: screen.height, screenWidth: screen.width, timeZoneOffset: new Date().getTimezoneOffset() / 60, language: navigator.language, userAgent: navigator.userAgent }
  };
  if (method === 'CREDIT_CARD') {
    body.installmentCount = Number($('#installments').value);
    const [month, rawYear] = $('#expiry').value.split('/').map(value => value.trim());
    body.card = { holderName: $('#name').value.trim(), number: digits('card-number'), expiryMonth: month, expiryYear: rawYear.length === 2 ? `20${rawYear}` : rawYear, ccv: digits('cvv') };
    body.holder = { ...body.holder, postalCode: digits('postal'), address: $('#address').value.trim(), addressNumber: $('#number').value.trim(), province: $('#province').value.trim() };
  }
  button.disabled = true;
  button.classList.add('is-processing');
  button.innerHTML = '<span>◌</span> Conectando ao Asaas…';
  $('#pix-result').hidden = true;
  $('#hosted-payment').hidden = true;
  try {
    const payment = await request('/api/payments', { method: 'POST', body: JSON.stringify(body) });
    renderPayment(payment);
    $('#status-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (payment.challengeUrl) {
      notify('O banco solicitou autenticação 3DS. Abrindo ambiente do emissor…');
      setTimeout(() => location.assign(payment.challengeUrl), 700);
    } else if (payment.invoiceUrl) notify('Cobrança criada. Continue na página segura do Asaas para escolher débito.');
    else if (payment.pix) notify('Pix criado pelo Asaas. Pague usando o QR Code ou o código copia e cola.');
    else notify('Solicitação enviada. Aguardando confirmação do Asaas.');
  } catch (error) { notify(error.message); }
  finally { button.classList.remove('is-processing'); button.disabled = false; button.innerHTML = `<span>🔒</span> <span id="button-method">${method === 'PIX' ? 'Gerar Pix' : method === 'DEBIT_CARD' ? 'Continuar para débito' : 'Pagar com crédito'}</span> <b>→</b>`; }
});

async function loadConfig() {
  try {
    config = await request('/api/config');
    $('#mode-badge').textContent = config.mode === 'asaas' ? (config.api || 'ASAAS').toUpperCase() : 'API INDISPONÍVEL';
    $('#mode-badge').classList.toggle('live', config.mode === 'asaas');
    if (config.mode === 'asaas') {
      button.disabled = false;
      $('#pending-note').innerHTML = '<span>◉</span> Nenhum pagamento foi confirmado. A confirmação virá do Asaas.';
    }
    else {
      config.error = config.message || 'Backend encontrado, mas ASAAS_API_KEY não está configurada.';
      $('#button-method').textContent = 'API não configurada';
      $('#pending-note').innerHTML = '<span>!</span> Backend sem configuração Asaas. Nenhuma aprovação será simulada.';
      button.disabled = true;
    }
  } catch {
    config = { mode: 'unconfigured', error: 'Não foi possível conectar ao backend. Confira PAYMENT_API_BASE e o serviço Node.' };
    $('#mode-badge').textContent = 'API OFFLINE';
    $('#button-method').textContent = 'Backend indisponível';
    $('#pending-note').innerHTML = '<span>!</span> Não foi possível conectar ao backend de pagamentos.';
    button.disabled = true;
  }
}
loadConfig();
