# Como deixar a sala acessível pela internet

O PinduCcall usa **dois canais de rede diferentes**, e entender essa separação
resolve 90% dos problemas de conexão:

| Canal | O que passa por ele | Protocolo | Porta padrão |
|---|---|---|---|
| **Sinalização** | entrar na sala, chat, avisos de quem entrou/saiu | WebSocket sobre TCP | `4000` |
| **Mídia** | voz e compartilhamento de tela | WebRTC: UDP (com fallback TCP) | `40000-40100` |

A sinalização é leve e passa em qualquer lugar. A mídia é o canal exigente:
precisa de UDP para ter latência baixa, e é ele que dá trabalho.

> **O aviso mais importante deste documento**
>
> Túneis HTTP como **Cloudflare Tunnel, ngrok gratuito e localtunnel não
> transportam a mídia.** Eles falam HTTP/WebSocket, e o WebRTC precisa de
> UDP puro entre as máquinas. Se você usar só um túnel desses, todo mundo vai
> conseguir entrar na sala e conversar por texto, mas **ninguém vai se ouvir**.
>
> Por isso a opção recomendada abaixo é uma VPN mesh, não um túnel HTTP.

---

## Opção 1 — Tailscale (recomendada)

Uma VPN mesh: cria uma rede privada entre os computadores convidados. Do ponto
de vista do app é como se todos estivessem na mesma LAN. Atende ao que você
pediu — **sem abrir portas no roteador e sem expor seu IP público** — e, ao
contrário de um túnel HTTP, carrega UDP normalmente.

**No seu PC (o host):**

1. Instale o [Tailscale](https://tailscale.com/download/windows) e entre com uma conta (o plano gratuito cobre até 100 dispositivos).
2. Descubra seu IP da rede Tailscale — começa com `100.`:
   ```powershell
   tailscale ip -4
   ```
   Exemplo de resposta: `100.101.102.103`
3. No arquivo `server/.env`, coloque esse IP:
   ```
   ANNOUNCED_IP=100.101.102.103
   ```
4. Rode `iniciar-servidor.bat`.

**Para cada convidado:**

1. Instalar o Tailscale e entrar na **mesma** rede (você convida pelo painel do Tailscale, em *Share* ou pelo link de convite).
2. Abrir o PinduCcall e usar o endereço:
   ```
   ws://100.101.102.103:4000/ws
   ```

Vantagens: nada de mexer no roteador, seu IP público não aparece, o tráfego é
criptografado ponta a ponta pela VPN e a latência costuma ser ótima porque o
Tailscale tenta conexão direta antes de usar relay.

Desvantagem: cada pessoa precisa instalar o Tailscale uma vez.

> **ZeroTier** funciona igualmente bem se você preferir; a ideia é a mesma,
> muda só o app e o formato do IP.

---

## Opção 2 — Port forwarding no roteador

Melhor latência possível, porque o tráfego vai direto. Em troca, seu IP público
fica visível para quem entra e você precisa mexer no roteador.

1. Descubra o IP local do seu PC:
   ```powershell
   ipconfig
   ```
   Anote o "Endereço IPv4" (algo como `192.168.0.15`).

2. No painel do roteador (normalmente `192.168.0.1` ou `192.168.1.1`), procure
   *Port Forwarding* / *Encaminhamento de portas* / *Servidores virtuais* e crie:

   | Porta externa | Protocolo | IP interno | Porta interna |
   |---|---|---|---|
   | 4000 | TCP | 192.168.0.15 | 4000 |
   | 40000-40100 | UDP | 192.168.0.15 | 40000-40100 |
   | 40000-40100 | TCP | 192.168.0.15 | 40000-40100 |

   O intervalo TCP é o plano B: se a rede de algum convidado bloquear UDP, o
   WebRTC negocia por TCP sozinho.

3. Libere as mesmas portas no Firewall do Windows rodando `liberar-firewall.ps1`.

4. Descubra seu IP público em qualquer site de "meu ip" e coloque no `.env`:
   ```
   ANNOUNCED_IP=189.x.y.z
   ```

5. Os convidados usam `ws://189.x.y.z:4000/ws`.

**Se o seu IP muda** (o normal em conexão residencial), use um DDNS gratuito
(No-IP, DuckDNS) e coloque o hostname no lugar do IP:
```
ANNOUNCED_IP=minhasala.duckdns.org
```

**Se não funcionar de jeito nenhum**, sua operadora provavelmente usa CGNAT —
vários clientes dividem o mesmo IP público e port forwarding simplesmente não
existe nesse cenário. Teste: se o IP que aparece no painel do roteador for
diferente do IP que os sites de "meu ip" mostram, é CGNAT. Nesse caso use a
Opção 1.

---

## Opção 3 — Cloudflare Tunnel (só para a sinalização)

Serve se você quiser um endereço bonito e com HTTPS (`wss://sala.seudominio.com/ws`)
sem expor porta, **mas a mídia continua precisando de uma das opções acima**.
Na prática é uma combinação: Cloudflare para a sinalização + Tailscale ou port
forwarding para a mídia. Se você já vai configurar um dos dois, o Cloudflare
vira só um conforto extra.

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:4000
```

O comando imprime uma URL `https://algo-aleatorio.trycloudflare.com`. No app,
troque o `https://` por `wss://` e acrescente `/ws`:

```
wss://algo-aleatorio.trycloudflare.com/ws
```

E no `.env` o `ANNOUNCED_IP` continua sendo o IP pelo qual a **mídia** chega
(o IP do Tailscale ou o IP público com as portas encaminhadas).

---

## Testando se está tudo certo

**1. O servidor está de pé?** No navegador do próprio PC host:
```
http://localhost:4000/health
```
Deve responder um JSON com `"status": "ok"` e o `announcedAddress` que você configurou.

**2. Os convidados alcançam a sinalização?** Peça para alguém abrir no navegador:
```
http://SEU-ENDERECO:4000/health
```
- Não abre → problema de firewall, roteador ou endereço errado. A mídia nem chega a ser testada.
- Abre → a sinalização está ok; se ainda assim ninguém se ouve, o problema é a faixa de portas de mídia.

**3. Entram na sala e o chat funciona, mas ninguém se ouve.**
Esse é o sintoma clássico de mídia bloqueada. Confira, nesta ordem:
- as portas `40000-40100` estão liberadas em **UDP** no firewall do Windows;
- se usa port forwarding, elas também estão encaminhadas no roteador;
- o `ANNOUNCED_IP` no `.env` é o endereço que os convidados enxergam (não o `127.0.0.1`);
- a rede do Windows está marcada como **Privada**, não Pública.

---

## Quanta banda isso consome?

O servidor recebe uma cópia de cada pessoa e envia para todas as outras. Quem
sente o peso é o **upload do seu PC**, e ele cresce com o número de pessoas.

| Cenário | Download do host | Upload do host |
|---|---|---|
| 10 pessoas só na voz | ~0,4 Mbps | ~3,6 Mbps |
| 10 pessoas + 1 tela 1080p30 | ~3 Mbps | ~30 Mbps |
| 10 pessoas + 1 tela 1080p60 | ~5 Mbps | ~50 Mbps |

Regra prática: **upload do host ≈ (pessoas − 1) × banda de quem transmite**.

Se seu upload for modesto, três ajustes ajudam muito:

- escolher **720p 30fps** no seletor de qualidade ao compartilhar;
- baixar `MAX_INCOMING_BITRATE` no `.env` (ex.: `2500000` para 2,5 Mbps);
- combinar de só uma pessoa compartilhar tela por vez.

O simulcast já ajuda automaticamente: quem está com internet ruim recebe uma
camada de resolução menor sem estragar a qualidade para os demais.
