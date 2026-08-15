import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('site');

/** Pasta da landing page e dos instaladores. */
export const publicDir = path.join(config.rootDir, 'public');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  // Feed do auto-update (electron-updater): latest.yml + .blockmap.
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.blockmap': 'application/octet-stream',
};

/**
 * Resolve a URL para um arquivo real dentro de public/, recusando qualquer
 * coisa que tente escapar da pasta (../, links, %2e%2e e afins).
 */
function resolverArquivo(urlPath) {
  let caminho;
  try {
    caminho = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }

  if (caminho.includes('\0')) return null;
  if (caminho === '/' || caminho === '') caminho = '/index.html';

  const destino = path.resolve(publicDir, `.${caminho}`);
  const raiz = path.resolve(publicDir);
  if (destino !== raiz && !destino.startsWith(raiz + path.sep)) return null;

  let info;
  try {
    info = fs.statSync(destino);
  } catch {
    return null;
  }

  if (info.isDirectory()) return resolverArquivo(path.posix.join(caminho, 'index.html'));
  if (!info.isFile()) return null;

  return { destino, tamanho: info.size, mtime: info.mtime };
}

/**
 * Serve a landing page e os instaladores. Devolve true quando tratou o pedido.
 * Só responde a GET e HEAD — este servidor não recebe upload por HTTP.
 */
export function servirSite(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const arquivo = resolverArquivo(req.url ?? '/');
  if (!arquivo) return false;

  const ext = path.extname(arquivo.destino).toLowerCase();
  const etag = `"${arquivo.tamanho.toString(16)}-${arquivo.mtime.getTime().toString(16)}"`;

  const cabecalhos = {
    'content-type': TIPOS[ext] ?? 'application/octet-stream',
    'content-length': arquivo.tamanho,
    etag,
    'x-content-type-options': 'nosniff',
    // Página e feed de update mudam a qualquer hora: sem cache. O resto
    // (imagens, instaladores) pode ficar em cache por uma hora.
    'cache-control':
      ext === '.html' || ext === '.yml' || ext === '.yaml' ? 'no-cache' : 'public, max-age=3600',
  };

  if (ext === '.exe' || ext === '.zip') {
    cabecalhos['content-disposition'] =
      `attachment; filename="${path.basename(arquivo.destino)}"`;
  }

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return true;
  }

  res.writeHead(200, cabecalhos);

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  const fluxo = fs.createReadStream(arquivo.destino);
  fluxo.on('error', (erro) => {
    log.warn(`Falha ao enviar ${arquivo.destino}: ${erro.message}`);
    res.destroy();
  });
  fluxo.pipe(res);
  return true;
}

/** Só para o log do boot saber se a landing page existe. */
export function siteDisponivel() {
  return fs.existsSync(path.join(publicDir, 'index.html'));
}
