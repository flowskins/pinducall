import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('chat');

/**
 * Histórico de chat em JSONL (uma mensagem por linha), um arquivo por sala.
 * Simples de ler, resistente a corrupcao (uma linha ruim não derruba o resto)
 * e não exige banco de dados instalado no PC.
 */
export class ChatStore {
  #filePath;
  #buffer = [];
  #maxInMemory;
  #writeStream = null;

  constructor(roomId, { maxInMemory = config.chatHistorySize } = {}) {
    this.#maxInMemory = maxInMemory;

    const safeId = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.#filePath = path.join(config.dataDir, `chat-${safeId}.jsonl`);

    this.#loadTail();
  }

  /** Le apenas o final do arquivo, para não carregar meses de histórico na RAM. */
  #loadTail() {
    if (!fs.existsSync(this.#filePath)) return;

    try {
      const stat = fs.statSync(this.#filePath);
      const maxBytes = 1024 * 1024; // 1 MB de cauda basta para centenas de mensagens
      const start = Math.max(0, stat.size - maxBytes);

      const fd = fs.openSync(this.#filePath, 'r');
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      fs.closeSync(fd);

      const lines = buffer.toString('utf8').split('\n');
      // Se cortamos no meio do arquivo, a primeira linha pode estar truncada.
      if (start > 0) lines.shift();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.#buffer.push(JSON.parse(trimmed));
        } catch {
          /* linha corrompida: ignora */
        }
      }

      this.#trim();
      log.info(`Histórico de "${path.basename(this.#filePath)}" carregado: ${this.#buffer.length} mensagens`);
    } catch (error) {
      log.warn('Não foi possível ler o histórico de chat:', error.message);
    }
  }

  #trim() {
    if (this.#buffer.length > this.#maxInMemory) {
      this.#buffer = this.#buffer.slice(-this.#maxInMemory);
    }
  }

  #stream() {
    if (!this.#writeStream) {
      this.#writeStream = fs.createWriteStream(this.#filePath, { flags: 'a' });
      this.#writeStream.on('error', (error) => {
        log.error('Falha ao gravar o chat:', error.message);
        this.#writeStream = null;
      });
    }
    return this.#writeStream;
  }

  append(message) {
    this.#buffer.push(message);
    this.#trim();
    try {
      this.#stream().write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      log.error('Falha ao gravar o chat:', error.message);
    }
    return message;
  }

  history(limit = this.#maxInMemory) {
    return this.#buffer.slice(-limit);
  }

  close() {
    this.#writeStream?.end();
    this.#writeStream = null;
  }
}
