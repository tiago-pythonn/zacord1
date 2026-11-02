# Zacord

## Executar

Instale o Node.js 18 ou superior e, no PowerShell, execute:

```powershell
cd "C:\Users\ADM\Downloads\html\zacord"
node server.js
```

Abra `http://localhost:3000`. Crie uma conta, compartilhe seu username e adicione outras pessoas para iniciar conversas. O chat recebe mensagens automaticamente, permite enviar imagens de até 4 MB, inclui emojis prontos e permite criar e compartilhar até 20 emojis personalizados por conta (256 KB cada).

Contas, conversas e mensagens ficam em `data.json`, criado ao lado de `server.js`. As senhas são armazenadas com hash; sessões ativas são encerradas quando o servidor reinicia.

As chamadas individuais usam áudio e vídeo do navegador, permitem compartilhar a tela e, quando o navegador oferece essa opção, o áudio compartilhado junto com ela. No seletor de compartilhamento, habilite o áudio da aba ou do sistema para enviá-lo à chamada. O navegador pedirá acesso ao microfone e à câmera; o compartilhamento de tela só começa depois da sua autorização. Chamadas em grupo ainda não estão disponíveis.

Para chamadas entre redes diferentes, configure servidores STUN/TURN no servidor com a variável `ZACORD_ICE_SERVERS`, contendo um array JSON de servidores ICE. O STUN público usado por padrão pode não atravessar firewalls ou NATs restritivos; TURN é necessário para conexões confiáveis nesses casos. Exemplo de formato:

```powershell
$env:ZACORD_ICE_SERVERS = '[{"urls":"stun:seu-stun:3478"},{"urls":"turn:seu-turn:3478","username":"usuario","credential":"senha"}]'
node server.js
```

Por padrão, o servidor aceita conexões somente deste computador. Para testar em uma rede local confiável, defina `ZACORD_HOST=0.0.0.0` antes de iniciar e acesse pelo IP do computador que está executando o servidor. Em outros dispositivos, microfone, câmera e compartilhamento de tela exigem HTTPS; use um proxy HTTPS para servir o app. Não exponha o servidor diretamente à internet sem HTTPS. A sinalização das chamadas é temporária e fica somente na memória do servidor.

## GitHub Pages

Os nomes de entrada do site são `index.html` e `style.css`, e os links dos arquivos usam caminhos relativos para funcionar em um endereço de projeto, como `https://owner.github.io/repositorio/`. No GitHub, abra **Settings → Pages**, selecione a branch do site e a pasta raiz (`/(root)`).

O GitHub Pages publica arquivos estáticos e **não executa `server.js`**. Para habilitar login, mensagens, imagens, emojis e chamadas, hospede o backend Node.js em um serviço com HTTPS. Depois, configure `config.js` com a URL base desse backend:

```js
window.ZACORD_API_URL = 'https://seu-backend.example.com';
```

No serviço do backend, permita a origem exata do site Pages (inclua apenas o domínio, sem o caminho do repositório) e configure seus servidores ICE:

```powershell
$env:ZACORD_ALLOWED_ORIGINS = 'https://owner.github.io'
$env:ZACORD_ICE_SERVERS = '[{"urls":"stun:seu-stun:3478"},{"urls":"turn:seu-turn:3478","username":"usuario","credential":"senha"}]'
node server.js
```

Use um backend com armazenamento persistente para manter as contas e conversas entre reinicializações. Para chamadas confiáveis entre redes diferentes, configure um servidor TURN. Não coloque credenciais do TURN em arquivos publicados no GitHub Pages.
