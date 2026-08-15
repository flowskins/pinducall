import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { arquivos, extensaoDe } from './arquivos.js';
import { Room } from './room.js';

const log = createLogger('arquivo-http');

/**
 * O renderer do Electron roda em file:// e o servidor é outra origem, então o
 * navegador exige CORS até para o nosso próprio app. Liberar `*` aqui é seguro
 * porque o que autoriza o envio é o ticket secreto, não a origem.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function responderJson(res, status, corpo, fecharConexao = false) {
  const texto = Buffer.from(JSON.stringify(corpo), 'utf8');
  const cabecalhos = {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': texto.length,
    'cache-control': 'no-store',
  };
  // Quando recusamos no meio do envio, o corpo que ainda vem pelo fio não tem
  // dono. Fechar a conexão é mais limpo do que tentar drenar megabytes.
  if (fecharConexao) cabecalhos.connection = 'close';

  res.writeHead(status, cabecalhos);
  res.end(texto);
}

/** @returns {string|null} o token quando a URL for /arquivo/<token> */
export function tokenDeArquivo(caminho) {
  const match = /^\/arquivo\/([A-Za-z0-9_-]{8,64})$/.exec(caminho);
  return match ? match[1] : null;
}

export function ehUploadDeArquivo(caminho) {
  return caminho === '/arquivo';
}

/** Resposta ao preflight do navegador antes do POST. */
export function responderPreflight(res) {
  res.writeHead(204, { ...CORS, 'content-length': 0 });
  res.end();
}

/**
 * Recebe o corpo cru do POST e grava em disco, cortando se passar do tamanho
 * declarado no ticket. Não usa multipart de propósito: o cliente é nosso, o
 * nome do arquivo já veio no ticket, e assim não entra dependência nova.
 */
export function receberUpload(req, res, urlCompleta) {
  const ticketBruto = new URL(urlCompleta, 'http://interno').searchParams.get('t');
  const ticket = arquivos.usarTicket(ticketBruto);

  if (!ticket) {
    req.resume();
    responderJson(res, 403, { erro: 'Autorização de envio inválida ou vencida' }, true);
    return;
  }

  const declarado = Number(req.headers['content-length'] ?? 0);
  if (declarado > ticket.tamanho + 1024) {
    req.resume();
    responderJson(res, 413, { erro: 'O arquivo é maior do que o anunciado' }, true);
    return;
  }

  const extensao = extensaoDe(ticket.nome);
  const destino = arquivos.caminhoDe(ticket.ticket, extensao);
  const saida = fs.createWriteStream(destino, { mode: 0o600 });

  let recebidos = 0;
  let abortado = false;

  const abortar = (status, mensagem) => {
    if (abortado) return;
    abortado = true;
    saida.destroy();
    fs.rmSync(destino, { force: true });
    responderJson(res, status, { erro: mensagem }, true);
    req.destroy();
  };

  req.on('data', (pedaco) => {
    recebidos += pedaco.length;
    // Teto real: o content-length pode mentir, o fluxo não.
    if (recebidos > config.arquivoMaxBytes || recebidos > ticket.tamanho + 1024) {
      abortar(413, 'Arquivo maior que o limite');
    }
  });

  req.on('error', () => abortar(400, 'A transferência falhou'));

  req.pipe(saida);

  saida.on('error', (erro) => {
    log.error(`Falha ao gravar ${destino}: ${erro.message}`);
    abortar(500, 'Não consegui gravar o arquivo');
  });

  saida.on('finish', () => {
    if (abortado) return;

    if (recebidos === 0) {
      fs.rmSync(destino, { force: true });
      responderJson(res, 400, { erro: 'Arquivo vazio' });
      return;
    }

    const item = arquivos.registrar(ticket, { caminho: destino, tamanhoReal: recebidos });

    // Quem anuncia no chat é o servidor: assim ninguém forja uma mensagem de
    // arquivo que não existe.
    const sala = Room.get(ticket.roomId);
    const mensagem = sala?.postArquivo(ticket, item) ?? null;

    responderJson(res, 200, {
      ok: true,
      token: item.token,
      nome: item.nome,
      tamanho: item.tamanho,
      expiraEm: item.expiraEm,
      mensagem,
    });
  });
}

/** Entrega o arquivo. Sempre como anexo, nunca renderizado pelo navegador. */
export function servirArquivo(req, res, token) {
  const item = arquivos.resolver(token);

  if (!item) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Este arquivo expirou ou não existe mais.');
    return;
  }

  let info;
  try {
    info = fs.statSync(item.caminho);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Este arquivo expirou ou não existe mais.');
    return;
  }

  // Cabeçalho HTTP não carrega acento: o Node escreve os headers em latin1 e o
  // "relatório.txt" chegava corrompido do outro lado (ou travava o download).
  // Então vai um nome só-ASCII no filename= e o nome de verdade no filename*.
  const ascii = item.nome.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_');

  res.writeHead(200, {
    // Genérico de propósito: nada de HTML ou SVG sendo executado no navegador
    // de quem baixa.
    'content-type': 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.nome)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=600',
    'referrer-policy': 'no-referrer',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const fluxo = fs.createReadStream(item.caminho);
  fluxo.on('error', () => res.destroy());
  fluxo.pipe(res);
}

/** Usado só pelo log de boot. */
export function pastaDeArquivos() {
  return path.join(config.dataDir, 'arquivos');
}
