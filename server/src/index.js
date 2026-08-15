import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { config, announcedAddress } from './config.js';
import { createLogger } from './lib/logger.js';
import { startWorkers, closeWorkers, getWorkerStats } from './sfu/workers.js';
import { attachSignaling } from './signaling.js';
import { Room } from './room.js';
import { servirSite, siteDisponivel } from './site.js';
import { servirConvite, tokenDaUrl } from './convite-page.js';
import { iniciarFaxina } from './limpeza.js';
import {
  ehUploadDeArquivo,
  receberUpload,
  responderPreflight,
  servirArquivo,
  tokenDeArquivo,
} from './arquivo-http.js';

const log = createLogger('server');

function createHttpServer() {
  const certPath = process.env.TLS_CERT?.trim();
  const keyPath = process.env.TLS_KEY?.trim();

  const requestHandler = (req, res) => {
    const caminho = (req.url ?? '/').split('?')[0];

    if (caminho === '/health') {
      const body = JSON.stringify(
        {
          status: 'ok',
          uptimeSeconds: Math.round(process.uptime()),
          announcedAddress,
          maxPeersPerRoom: config.maxPeersPerRoom,
          maxRooms: config.maxRooms,
          workers: getWorkerStats(),
          rooms: Room.list(),
        },
        null,
        2,
      );
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    // Arquivos do chat: POST /arquivo?t=<ticket> e GET /arquivo/<token>
    if (ehUploadDeArquivo(caminho)) {
      if (req.method === 'OPTIONS') {
        responderPreflight(res);
        return;
      }
      if (req.method === 'POST') {
        receberUpload(req, res, req.url);
        return;
      }
    }

    const tokenArquivo = tokenDeArquivo(caminho);
    if (tokenArquivo && (req.method === 'GET' || req.method === 'HEAD')) {
      servirArquivo(req, res, tokenArquivo);
      return;
    }

    // Links de convite: /c/<token>
    const token = tokenDaUrl(caminho);
    if (token && (req.method === 'GET' || req.method === 'HEAD')) {
      servirConvite(req, res, token);
      return;
    }

    // Landing page e instaladores saem de public/.
    if (servirSite(req, res)) return;

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  };

  if (certPath && keyPath) {
    log.info('TLS habilitado: o servidor vai aceitar wss:// direto');
    return https.createServer(
      { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
      requestHandler,
    );
  }

  return http.createServer(requestHandler);
}

async function main() {
  log.info('Iniciando o servidor PinduCcall...');
  await startWorkers();

  const server = createHttpServer();
  attachSignaling(server);
  const pararFaxina = iniciarFaxina();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindAddress, resolve);
  });

  const scheme = process.env.TLS_CERT ? 'wss' : 'ws';
  const { rtcMinPort, rtcMaxPort } = config.mediasoup.workerSettings;

  log.info('');
  log.info('  PinduCcall no ar');
  log.info(`  Sinalização ....... ${scheme}://${announcedAddress}:${config.port}/ws`);
  log.info(`  Mídia (UDP/TCP) ... ${announcedAddress}:${rtcMinPort}-${rtcMaxPort}`);
  const httpScheme = process.env.TLS_CERT ? 'https' : 'http';
  log.info(
    `  Landing page ...... ${
      siteDisponivel()
        ? `${httpScheme}://${announcedAddress}:${config.port}/`
        : 'sem public/index.html'
    }`,
  );
  log.info(`  Sala padrão ....... ${config.defaultRoom} (não expira)`);
  log.info(`  Limite ............ ${config.maxPeersPerRoom} pessoas por sala, ${config.maxRooms} salas`);
  log.info(
    `  Salas vazias ...... apagadas depois de ${Math.round(config.roomTtlMs / 3_600_000)}h sem ninguém`,
  );
  log.info('');

  if (!config.roomPassword) {
    log.warn('Nenhuma ROOM_PASSWORD definida. Não exponha este servidor na internet assim.');
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Recebido ${signal}, encerrando...`);

    pararFaxina();
    server.close();
    for (const summary of Room.list()) Room.get(summary.id)?.close();
    await closeWorkers();

    setTimeout(() => process.exit(0), 300);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('Promise rejeitada sem tratamento:', reason));
  process.on('uncaughtException', (error) => log.error('Exceção não tratada:', error));
}

main().catch((error) => {
  log.error('Falha fatal no boot:', error);
  process.exit(1);
});
