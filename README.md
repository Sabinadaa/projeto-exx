# Checkout seguro — EXX Nutrition

Checkout web conectado ao Asaas, com pagamento por Pix, cartão de crédito com 3D Secure e cartão de débito na página hospedada do Asaas. Não existe modo de demonstração: sem backend configurado, a tela informa que pagamentos estão indisponíveis e não simula aprovação.

## Estrutura

```text
index.html       Página inicial servida pelo GitHub Pages ou Node
public/          CSS, JavaScript e URL pública do backend
src/server.js    Backend Node e integração privada com Asaas
render.yaml      Configuração de publicação do backend no Render
```

## Executar localmente

Requer Node.js 18 ou superior.

```powershell
$env:ASAAS_API_KEY="sua_chave_sandbox"
$env:ASAAS_WEBHOOK_TOKEN="um-segredo-longo-e-aleatorio"
$env:PUBLIC_BASE_URL="http://localhost:3000"
node src/server.js
```

Abra <http://localhost:3000>. Sem `ASAAS_API_KEY`, o backend permanece disponível para carregar a interface, mas o checkout bloqueia novos pagamentos e não inventa resultados. Use somente credenciais sandbox enquanto valida a integração.

## Publicar no GitHub Pages e hospedar a API

GitHub Pages publica HTML, CSS e JavaScript; ele não executa Node e não pode guardar a chave privada do Asaas. Publique o backend Node como serviço web (o `render.yaml` configura o Render) e cadastre `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN` no painel de variáveis secretas do serviço. Nunca coloque a chave em `public/config.js`, no HTML ou em repositório.

O frontend de GitHub Pages usa `window.PAYMENT_API_BASE` em `public/config.js`. Troque o valor `https://exx-nutrition-3ds.onrender.com` pela URL HTTPS do seu backend quando publicar em outro serviço. Configure também `ALLOWED_ORIGINS` no backend para aceitar somente o domínio real do Pages. Para abrir tudo pelo mesmo serviço Node, acesse o domínio do backend e mantenha `PAYMENT_API_BASE` vazio para usar a mesma origem.

No repositório, ative **Settings → Pages → Build and deployment → Source: GitHub Actions**. O workflow publica o `index.html` da raiz e a pasta `public/`.

## Configurar Asaas

Por padrão, o backend usa `https://api-sandbox.asaas.com/v3`. No Render, mantenha `ASAAS_API_BASE` sem definir para sandbox; para produção, configure `ASAAS_API_BASE=https://api.asaas.com/v3`, `PUBLIC_BASE_URL` com HTTPS e uma chave de produção válida. A URL pública também é usada como callback do 3DS.

Cadastre no painel Asaas um webhook HTTPS apontando para `/webhooks/asaas`, usando o mesmo segredo de `ASAAS_WEBHOOK_TOKEN`. Selecione os eventos:

- `PAYMENT_CONFIRMED`
- `PAYMENT_RECEIVED`
- `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`
- `PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED`
- `PAYMENT_OVERDUE`
- `PAYMENT_REFUNDED`
- `PAYMENT_DELETED`
- `PAYMENT_RESTORED`

O backend valida o token de acesso do webhook e ignora IDs de evento repetidos. Além do webhook, a tela consulta o status da cobrança diretamente no Asaas enquanto ela está pendente. O retorno do 3DS, por si só, nunca aprova o pedido.

## Formas de pagamento

- **Pix:** cria cobrança `PIX`, busca QR Code dinâmico no Asaas e mostra imagem, código copia e cola e vencimento. O status é confirmado pela API/webhook.
- **Crédito:** encaminha os dados diretamente do backend ao Asaas com `threeDSecure` e `deviceInfo`. Se o emissor pedir desafio, o cliente é redirecionado para a URL fornecida pelo Asaas. A aplicação libera o pedido somente após status final confirmado pelo Asaas.
- **Débito:** a API não recebe diretamente dados de cartão de débito. O checkout cria uma cobrança de cartão e mostra `invoiceUrl` para o cliente continuar na página segura do Asaas e escolher débito.

O preço do item é definido no backend (R$ 189,00); o navegador não pode alterar o valor da cobrança. O exemplo usa o produto público Whey 100% Concentrado Pouch 900g da EXX Nutrition; frete não está incluído.

## Limites e cuidados

O 3DS precisa estar habilitado na conta Asaas. A documentação informa que o Sandbox aprova transações automaticamente e não permite validar o desafio 3DS real. Não use números de cartão reais no Sandbox. Para produção, use HTTPS, configure uma fonte confiável para o IP do comprador se estiver atrás de proxy, retenção mínima de dados e persistência durável para conciliação de pedidos e eventos. Este exemplo mantém metadados em memória; a consulta direta à cobrança permite atualizar o status após reinício, mas um e-commerce de produção deve integrar um banco de dados durável.

## Documentação consultada

- [Criar cobrança no Asaas](https://docs.asaas.com/reference/criar-nova-cobranca)
- [Criar cobrança com 3DS](https://docs.asaas.com/docs/criar-cobranca-com-3ds)
- [Cobranças via Pix e QR Code](https://docs.asaas.com/docs/cobrancas-via-pix)
- [Cobranças via cartão de crédito e débito](https://docs.asaas.com/docs/cobrancas-via-cartao-de-credito)
- [Criar novo Checkout](https://docs.asaas.com/reference/criar-novo-checkout)
