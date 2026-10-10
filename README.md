# Sistema 3DS — EXX Nutrition

Aplicação local demonstrativa de pagamentos com autenticação 3D Secure. Ela inicia no modo demonstração, sem credenciais, para permitir testar a experiência inteira no navegador.

## Estrutura do projeto

```text
index.html  Página inicial na raiz, publicada pelo GitHub Pages
public/     CSS, JavaScript e configuração pública do frontend
src/      Servidor HTTP e integração Asaas
outputs/  Arquivos finais exportados
work/     Arquivos temporários de trabalho
```

## Executar

Requer Node.js 18 ou superior. No diretório do projeto:

```powershell
node src/server.js
```

Abra <http://localhost:3000>. Preencha os campos com dados fictícios e escolha uma resposta do banco. No cenário de desafio, aprove/falhe o desafio e depois simule o webhook Asaas. Nenhum pagamento real ocorre sem `ASAAS_API_KEY`.

## Publicar a aplicação web

O `index.html` fica na raiz do repositório para o GitHub Pages encontrá-lo como página inicial. O workflow publica esse arquivo e a pasta `public/` na raiz do site. GitHub Pages publica HTML, CSS e JavaScript, mas não executa o servidor Node. O arquivo `render.yaml` configura o backend Node para o Render; o arquivo `public/config.js` aponta o frontend do GitHub Pages para esse backend por HTTPS. O próprio serviço Render também serve a aplicação completa no mesmo domínio.

Para publicar a aplicação completa, importe este repositório no Render usando **New → Blueprint**. O serviço `exx-nutrition-3ds` inicia sem `ASAAS_API_KEY` em modo de demonstração e aceita dados fictícios para testar o formulário. O domínio padrão é `https://exx-nutrition-3ds.onrender.com`. Se o Render atribuir outro domínio, atualize `public/config.js` antes de publicar no GitHub Pages. Para servir a interface pelo Pages, ative **Settings → Pages → Build and deployment → Source: GitHub Actions**; o workflow publica o `index.html` da raiz junto com `public/`.

O CORS do Node aceita o domínio GitHub Pages deste projeto e origens locais de desenvolvimento. O backend retorna erro se o front-end no Pages ainda não estiver configurado com sua URL. Não inclua a chave Asaas em `public/config.js`, no GitHub Pages ou no repositório.

O resumo usa o produto público “Whey 100% Concentrado Pouch 900g — EXX Nutrition”, listado por R$ 189,00 na página consultada. A foto é carregada diretamente do CDN da EXX, e o link do nome abre a ficha do produto. O frete fica indicado como calculado pelo CEP e não entra no valor desta simulação.

## Modos de integração

Sem `ASAAS_API_KEY`, o servidor simula a jornada: desafio do emissor, frictionless e recusa. Os botões de simulação disparam eventos localmente, incluindo a proteção contra evento duplicado.

No modo demonstração, confira a jornada manual 3DS na tela. Os cenários locais não cobram nem chamam o Asaas.

Para conectar ao Sandbox Asaas:

```powershell
$env:ASAAS_API_KEY="sua_chave_sandbox"
$env:ASAAS_WEBHOOK_TOKEN="um-segredo-compartilhado-com-32-caracteres-ou-mais"
$env:PUBLIC_BASE_URL="https://seu-dominio-publico"
node src/server.js
```

No Render, cadastre `ASAAS_API_KEY` somente no painel **Environment** do serviço. O blueprint gera um `ASAAS_WEBHOOK_TOKEN`; copie esse valor para a configuração do webhook no painel Asaas. Sem a chave de API, o formulário usa a simulação local e não envia cobrança ao Asaas.

Por padrão a API aponta para `https://api-sandbox.asaas.com/v3`. Para produção, configure também `$env:ASAAS_API_BASE="https://api.asaas.com/v3"` e use uma `PUBLIC_BASE_URL` HTTPS. Configure no painel Asaas um webhook para `/webhooks/asaas` com os eventos `PAYMENT_CONFIRMED`, `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` e `PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED`, usando o mesmo token em `ASAAS_WEBHOOK_TOKEN`.

O servidor cria o cliente Asaas e, em seguida, cria a cobrança `CREDIT_CARD` com `threeDSecure` e `deviceInfo`. A API Key fica somente no servidor. Os dados do cartão são encaminhados diretamente ao Asaas pela chamada server-side e não são gravados em arquivo ou banco local. Em produção, use armazenamento durável para pagamentos/eventos, configure proxy confiável para obter o IP do pagador, limites de requisição, política de retenção, gestão de segredos e controles PCI adequados. Habilite 3DS na conta Asaas com o suporte. Sandbox aprova automaticamente e não simula o desafio real.

## Escolha técnica: Checkout x 3DS

A referência inicial (`POST /v3/checkouts`) cria uma página hospedada e devolve um checkout, não uma confirmação financeira. Os eventos desse recurso são `CHECKOUT_CREATED`, `CHECKOUT_PAID`, `CHECKOUT_CANCELED` e `CHECKOUT_EXPIRED`. O guia específico de 3DS descreve as cobranças de cartão em `POST /v3/payments` com `threeDSecure` e `deviceInfo`, e confirma o resultado por eventos de cobrança. Para atender à necessidade de autenticação explícita 3DS, esta solução usa a segunda rota. Se a prioridade for não coletar cartão no sistema, o Checkout hospedado é a alternativa mais simples, mas seu fluxo deve ser validado com o Asaas para os requisitos 3DS da conta.

## Controles demonstrados

- O desafio pode ser silencioso ou exigir uma ação do pagador no banco emissor.
- O `timeZoneOffset` é enviado em horas e o IP é obtido no servidor.
- O retorno do desafio mantém o pagamento pendente; a aplicação só conclui com webhook.
- Eventos de desafio abandonado e captura recusada mantêm o pedido bloqueado.
- Eventos repetidos não são processados novamente (idempotência por `id`).
- A chave Asaas não vai para o navegador e o cartão não é persistido.

## Referências Asaas

- [Criar novo Checkout](https://docs.asaas.com/reference/criar-novo-checkout)
- [Criar cobrança com 3DS](https://docs.asaas.com/docs/criar-cobran%C3%A7a-com-3ds)
- [Eventos para Checkout](https://docs.asaas.com/docs/eventos-para-checkout)
- [Eventos para cobranças](https://docs.asaas.com/docs/eventos-de-cobrancas)
