import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { salas } from './room-registry.js';
import { convites } from './invites.js';
import { arquivos, formatarTamanho } from './arquivos.js';
import { Room } from './room.js';

const log = createLogger('limpeza');

/** Mesmo saneamento que ChatStore e TibiaStore usam para nomear os arquivos. */
function nomeSeguro(roomId) {
  return String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function apagarArquivo(caminho) {
  try {
    fs.rmSync(caminho, { force: true });
  } catch (error) {
    log.warn(`Não consegui apagar ${caminho}: ${error.message}`);
  }
}

/**
 * Apaga tudo que pertencia a uma sala: histórico de chat, timers e convites.
 * A sala em si já saiu do registro quando esta função é chamada.
 */
function apagarRastros(roomId) {
  const seguro = nomeSeguro(roomId);
  apagarArquivo(path.join(config.dataDir, `chat-${seguro}.jsonl`));
  apagarArquivo(path.join(config.dataDir, `tibia-${seguro}.json`));
  convites.removerDaSala(roomId);
  arquivos.removerDaSala(roomId);
}

/**
 * Uma passada da faxina: expira as salas que ficaram o prazo inteiro sem
 * ninguém e leva junto os arquivos delas.
 *
 * @returns {Array<{id: string, nome: string}>}
 */
export function faxina() {
  // Arquivos vencem sozinhos, mesmo em sala que continua viva.
  const arquivosVencidos = arquivos.expirar();
  for (const item of arquivosVencidos) {
    log.info(`Arquivo "${item.nome}" (${formatarTamanho(item.tamanho)}) expirou e foi apagado`);
  }

  const removidas = salas.expirar();

  for (const sala of removidas) {
    // Por segurança: se por algum motivo o router ainda estiver de pé, fecha.
    Room.get(sala.id)?.close();
    apagarRastros(sala.id);
    log.info(`Sala "${sala.nome}" (${sala.id}) expirou depois de ${horas()}h vazia`);
  }

  return removidas;
}

function horas() {
  return Math.round(config.roomTtlMs / 3_600_000);
}

/** Liga a faxina periódica. Devolve a função que a desliga. */
export function iniciarFaxina() {
  faxina();

  const timer = setInterval(faxina, config.limpezaIntervaloMs);
  timer.unref?.();

  log.info(
    `Salas vazias por mais de ${horas()}h são apagadas (checagem a cada ${Math.round(
      config.limpezaIntervaloMs / 60_000,
    )} min)`,
  );

  return () => clearInterval(timer);
}
