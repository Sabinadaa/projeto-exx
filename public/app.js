const $ = s => document.querySelector(s);
const form = $('#payment-form'), button = $('#pay-button'), toast = $('#toast');
const apiBase = (window.PAYMENT_API_BASE || '').replace(/\/+$/, '');
const onGithubPages = location.hostname.endsWith('github.io');
let config = { mode: 'demo' }, currentPayment = null, pollTimer = null;

async function request(url, body) {
  if (onGithubPages && !apiBase) throw new Error('O backend Node ainda não foi configurado. Defina PAYMENT_API_BASE em public/config.js com a URL HTTPS do servidor.');
  const response = await fetch(`${apiBase}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Falha ao processar a solicitação.');
  return data;
}
function notify(message) { toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 3600); }
function maskDigits(input, pattern) { const raw = input.value.replace(/\D/g, ''); let out = '', i = 0; for (const ch of pattern) { if (ch === '#') { if (raw[i] == null) break; out += raw[i++]; } else { if (raw.length <= i) break; out += ch; } } input.value = out; }
$('#card-number').addEventListener('input', e => maskDigits(e.target, '#### #### #### ####'));
$('#expiry').addEventListener('input', e => maskDigits(e.target, '## / ##'));
$('#cpf').addEventListener('input', e => maskDigits(e.target, '###.###.###-##'));
$('#phone').addEventListener('input', e => { const d=e.target.value.replace(/\D/g,'').slice(0,11);e.target.value=d.length>10?`(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`:d.length>6?`(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`:d.length>2?`(${d.slice(0,2)}) ${d.slice(2)}`:d; });
$('#postal').addEventListener('input', e => maskDigits(e.target, '#####-###'));

function setRow(id, state, detail) { const row = $(`#${id}`); row.className = `timeline-row ${state}`; const icon = row.querySelector('.timeline-icon'); if (state === 'done') icon.textContent = '✓'; else if (state === 'failed') icon.textContent = '×'; else if (state === 'active') icon.textContent = '◌'; row.querySelector('small').textContent = detail; }
function setStatus(payment) {
  currentPayment = payment;
  $('#order-time').textContent = `Pedido ${payment.orderId} · ${new Date(payment.createdAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;
  $('#mode-badge').textContent = payment.mode === 'asaas' ? (config.api || 'ASAAS').toUpperCase() : 'DEMO';
  $('#mode-badge').classList.toggle('live', payment.mode === 'asaas');
  if (payment.status === 'CONFIRMED') {
    setRow('auth-row','done','Identidade autenticada pelo banco emissor'); setRow('result-row','done','Pagamento confirmado pelo Asaas'); $('#pending-note').innerHTML='<span>✓</span> Pagamento confirmado pelo evento do Asaas.';
  } else if (payment.status === 'REFUSED') {
    setRow('auth-row','failed',payment.event?.includes('CHALLENGE_FAILED')?'Autenticação não concluída':'Transação recusada pelo banco emissor'); setRow('result-row','failed','Pedido não liberado · nenhum pagamento confirmado'); $('#pending-note').innerHTML='<span>!</span> Não libere o pedido. Tente outro método de pagamento.';
  } else if (payment.challengeUrl && payment.issuerResult !== 'success') {
    setRow('auth-row','active','O banco emissor solicita uma confirmação'); setRow('result-row','', 'Aguardando desafio e webhook do Asaas');
  } else if (payment.challengeUrl && payment.issuerResult === 'success') {
    setRow('auth-row','done','Desafio concluído pelo pagador'); setRow('result-row','active','Aguardando confirmação do Asaas por webhook');
  } else {
    setRow('auth-row','done','Autenticação silenciosa (frictionless)'); setRow('result-row','active','Aguardando confirmação do Asaas por webhook');
  }
  if (payment.mode === 'demo') {
    $('#demo-actions').hidden = false;
    if (payment.challengeUrl && !payment.event && payment.issuerResult !== 'success') $('#demo-actions').innerHTML = `<strong>Simulação do banco emissor</strong><div>O Asaas só confirma após o resultado do desafio e a notificação de webhook.</div><button class="primary" data-action="challenge">Aprovar desafio (OTP)</button><button data-action="fail">Falhar desafio</button>`;
    else if (!payment.event && payment.scenario === 'refused') $('#demo-actions').innerHTML = `<strong>Simulação de recusa do emissor</strong><div>Uma recusa mantém o pedido bloqueado e não libera o produto.</div><button class="primary" data-action="refuse">Receber webhook de recusa</button><button data-action="confirm">Simular aprovação</button>`;
    else if (!payment.event) $('#demo-actions').innerHTML = `<strong>Aguardando evento de confirmação</strong><div>Simule a notificação autenticada do Asaas para concluir o pedido.</div><button class="primary" data-action="confirm">Simular webhook PAYMENT_CONFIRMED</button><button data-action="refuse">Simular recusa</button>`;
    else $('#demo-actions').innerHTML = `<strong>Demonstração concluída</strong><div>Evento processado com proteção contra reenvio duplicado.</div><button data-action="again">Iniciar outro pagamento</button>`;
  } else { $('#demo-actions').hidden = true; }
  $('#event-log').hidden = !payment.event;
  if (payment.event) $('#event-name').textContent = payment.event;
}

$('#demo-actions').addEventListener('click', async e => {
  const action = e.target.dataset.action; if (!action) return;
  try {
    if (action === 'again') { currentPayment = null; $('#payment-form').reset(); $('#demo-actions').hidden = true; setRow('auth-row','','Aguardando envio dos dados'); setRow('result-row','','Confirmada somente pelo Asaas'); $('#event-log').hidden=true; $('#pending-note').innerHTML='<span>◉</span> O retorno ao checkout não confirma o pagamento.'; return; }
    if (action === 'challenge' || action === 'fail') {
      const result = await request('/api/demo/challenge',{paymentId:currentPayment.id,result:action==='challenge'?'success':'fail'});
      if (action === 'fail') currentPayment.issuerResult='fail';
      else currentPayment.issuerResult='success';
      currentPayment={...currentPayment,...result};
      if (action === 'fail') { const p=await request('/api/demo/webhook',{paymentId:currentPayment.id,event:'PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED'}); setStatus(p); }
      else { setStatus(currentPayment); notify('Desafio aprovado. Agora aguarde o webhook do Asaas.'); }
    } else {
      const event = action==='confirm'?'PAYMENT_CONFIRMED':'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED';
      const p=await request('/api/demo/webhook',{paymentId:currentPayment.id,event,eventId:`evt_${crypto.randomUUID()}`});setStatus(p);notify(event==='PAYMENT_CONFIRMED'?'Webhook recebido. Pedido confirmado com segurança.':'Webhook de recusa recebido. Pedido mantido bloqueado.');
    }
  } catch(err) { notify(err.message); }
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (onGithubPages && !apiBase) { notify('Backend não configurado. Defina PAYMENT_API_BASE em public/config.js para habilitar o envio.'); return; }
  const [month, year] = $('#expiry').value.split('/').map(x=>x.trim());
  const deviceInfo={colorDepth:screen.colorDepth,screenHeight:screen.height,screenWidth:screen.width,timeZoneOffset:new Date().getTimezoneOffset()/60,language:navigator.language,userAgent:navigator.userAgent};
  const body={ value:189.00, scenario:$('#scenario').value, card:{holderName:$('#name').value,number:$('#card-number').value,expiryMonth:month,expiryYear:year?.length===2?`20${year}`:year,ccv:$('#cvv').value}, holder:{name:$('#name').value,email:$('#email').value,cpf:$('#cpf').value.replace(/\D/g,''),phone:$('#phone').value.replace(/\D/g,''),postalCode:$('#postal').value.replace(/\D/g,''),address:$('#address').value,addressNumber:$('#number').value,province:$('#province').value}, deviceInfo};
  button.disabled=true;button.innerHTML='<span>◌</span> Processando com segurança…';
  try {
    const payment=await request('/api/payments',body);setStatus(payment);$('#status-panel').scrollIntoView({behavior:'smooth',block:'nearest'});
    if (payment.challengeUrl && payment.mode === 'asaas') { notify('Redirecionando para a autenticação do banco…'); setTimeout(() => location.assign(payment.challengeUrl), 700); }
    else notify(payment.challengeUrl?'Pagamento pendente: o banco exige autenticação 3DS.':'Solicitação enviada. Aguardando resultado do pagamento.');
  }
  catch(error){notify(error.message);}
  finally{button.disabled=false;button.innerHTML='<span>🔒</span> Pagar R$ 189,00 <b>→</b>';}
});

if (onGithubPages && !apiBase) {
  $('#mode-badge').textContent = 'API PENDENTE';
  $('#pending-note').innerHTML = '<span>◉</span> Formulário restaurado. Configure o backend HTTPS antes de enviar dados.';
} else fetch(`${apiBase}/api/config`).then(r=>r.json()).then(data=>{config=data;if(data.mode==='asaas'){$('#demo-controls').hidden=true;$('#mode-badge').textContent=(data.api||'asaas').toUpperCase();$('#mode-badge').classList.add('live');$('#pending-note').innerHTML='<span>◉</span> Confirmação final recebida pelo webhook do Asaas.';}}).catch(()=>notify('Não foi possível conectar ao servidor.'));
