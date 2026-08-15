import { config, siteBaseUrl, signalingUrl } from './config.js';
import { convites } from './invites.js';
import { salas } from './room-registry.js';

/** Escapa para interpolar dentro de HTML sem abrir buraco de injeção. */
function esc(texto) {
  return String(texto ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function pagina({ titulo, corpo }) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(titulo)}</title>
    <link rel="icon" href="/imagens/mascote.png" />
    <style>
      :root { color-scheme: dark; --neon:#33ff33; --violet:#b14dff; }
      * { box-sizing: border-box; }
      body {
        margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
        background:#07080c; color:#eef2f8; text-align:center;
        font-family:'Segoe UI', system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif;
      }
      body::before {
        content:''; position:fixed; inset:0; pointer-events:none;
        background:
          radial-gradient(700px 420px at 50% -10%, rgba(51,255,51,.15), transparent 70%),
          radial-gradient(600px 400px at 90% 20%, rgba(177,77,255,.13), transparent 70%);
      }
      .card {
        position:relative; width:min(460px,100%); padding:38px 30px 30px;
        border:1px solid #232838; border-radius:20px;
        background:linear-gradient(180deg,#11141d,#0d1017);
        box-shadow:0 30px 70px rgba(0,0,0,.6);
      }
      img.mascote { width:170px; margin:-8px auto 6px; display:block;
        filter:drop-shadow(0 12px 26px rgba(0,0,0,.6)); }
      h1 { margin:6px 0 4px; font-size:24px; letter-spacing:-.4px; }
      .sala { color:var(--neon); font-weight:800; }
      p { color:#a8b1c4; margin:0 0 22px; font-size:15px; line-height:1.55; }
      .btn {
        display:flex; align-items:center; justify-content:center; gap:10px;
        padding:15px 22px; border-radius:13px; text-decoration:none;
        font-weight:750; font-size:16px; border:1px solid transparent; cursor:pointer;
      }
      .btn--neon {
        background:linear-gradient(180deg,#33ff33,#1fcc1f); color:#06210a;
        box-shadow:0 0 0 1px rgba(51,255,51,.5), 0 12px 34px rgba(51,255,51,.3);
      }
      .btn--ghost {
        border-color:rgba(177,77,255,.45); color:#d6a2ff; background:rgba(177,77,255,.08);
        margin-top:12px; font-size:15px; padding:13px 20px;
      }
      .aviso { margin-top:22px; font-size:12.5px; color:#6b7488; line-height:1.6; }
      .aviso b { color:#a8b1c4; font-weight:650; }
      .erro { color:#ff8f8f; }
      code { font-family:'Cascadia Code', Consolas, ui-monospace, monospace; font-size:12px;
        background:rgba(177,77,255,.12); color:#d6a2ff; padding:2px 7px; border-radius:5px; }
    </style>
  </head>
  <body><div class="card">${corpo}</div></body>
</html>`;
}

function paginaErro(mensagem) {
  return pagina({
    titulo: 'Convite indisponível — PinduCcall',
    corpo: `
      <img class="mascote" src="/imagens/mascote.png" alt="" />
      <h1 class="erro">Convite indisponível</h1>
      <p>${esc(mensagem)}</p>
      <a class="btn btn--neon" href="/">Ir para a página do PinduCcall</a>
    `,
  });
}

/**
 * Página de um convite. Ela existe porque o link precisa funcionar para os dois
 * casos: quem já tem o app (abre direto na sala) e quem não tem (vê o que é e
 * baixa). Um link "pinduccall://" puro só serviria para o primeiro grupo.
 */
export function servirConvite(req, res, token) {
  const convite = convites.resolver(token);

  const responder = (html, status = 200) => {
    const corpo = Buffer.from(html, 'utf8');
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': corpo.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // O link é secreto: não deixa vazar no Referer de quem clicar em algo.
      'referrer-policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : corpo);
  };

  if (!convite) {
    responder(paginaErro('Este link expirou ou foi gerado por um servidor que não existe mais.'), 404);
    return;
  }

  const sala = salas.obter(convite.roomId);
  if (!sala) {
    responder(paginaErro('A sala deste convite não existe mais.'), 404);
    return;
  }

  const deepLink = `pinduccall://entrar?t=${encodeURIComponent(convite.token)}&srv=${encodeURIComponent(signalingUrl)}`;
  const horas = Math.max(1, Math.round((convite.expiraEm - Date.now()) / 3_600_000));

  responder(
    pagina({
      titulo: `Entrar em ${sala.nome} — PinduCcall`,
      corpo: `
      <img class="mascote" src="/imagens/mascote.png" alt="" />
      <h1>Você foi convidado para<br /><span class="sala">${esc(sala.nome)}</span></h1>
      <p>
        ${convite.criadoPor ? `${esc(convite.criadoPor)} te chamou.` : ''}
        Clique abaixo que o PinduCcall abre já dentro da sala — não precisa de senha.
      </p>

      <a class="btn btn--neon" id="abrir" href="${esc(deepLink)}">Entrar na sala</a>
      <a class="btn btn--ghost" href="${esc(siteBaseUrl)}/#baixar">Ainda não tenho o app</a>

      <p class="aviso">
        O link vale por mais <b>${horas} hora${horas === 1 ? '' : 's'}</b>.
        Se o navegador perguntar, permita abrir o <code>PinduCcall</code>.
      </p>

      <script>
        // Tenta abrir o app sozinho, uma vez só. Se o app não estiver
        // instalado nada acontece e os botões continuam ali.
        setTimeout(function () { window.location.href = ${JSON.stringify(deepLink)}; }, 400);
      </script>
    `,
    }),
  );
}

/** @returns {string|null} o token, quando a URL for /c/<token> */
export function tokenDaUrl(urlPath) {
  const match = /^\/c\/([A-Za-z0-9_-]{8,64})\/?$/.exec(urlPath);
  return match ? match[1] : null;
}

export const conviteTtlHoras = Math.round(config.inviteTtlMs / 3_600_000);
