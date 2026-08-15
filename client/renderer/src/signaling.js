import { Emitter } from './emitter.js';

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Cliente do protocolo de sinalização. Espelha server/src/lib/rpc.js:
 *
 *   { t: 'req',    id, method, data }
 *   { t: 'res',    id, ok, data | error }
 *   { t: 'notify', method, data }
 *
 * Eventos emitidos: 'open', 'close', 'error', 'notify:<method>'.
 */
export class Signaling extends Emitter {
  #ws = null;
  #pending = new Map();
  #seq = 0;

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      let settled = false;

      try {
        this.#ws = new WebSocket(url);
      } catch (error) {
        reject(new Error(`Endereço inválido: ${error.message}`));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#ws?.close();
        reject(new Error('O servidor não respondeu em 15 segundos'));
      }, 15_000);

      this.#ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emit('open');
        resolve();
      });

      this.#ws.addEventListener('error', () => {
        if (settled) {
          this.emit('error', new Error('Erro na conexão com o servidor'));
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(new Error('Não foi possível conectar. Confira o endereço e se o servidor está ligado.'));
      });

      this.#ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        for (const [, entry] of this.#pending) {
          entry.reject(new Error('Conexão encerrada'));
        }
        this.#pending.clear();
        this.emit('close', { code: event.code, reason: event.reason });
      });

      this.#ws.addEventListener('message', (event) => this.#handleMessage(event.data));
    });
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.t === 'res') {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);

      if (message.ok) entry.resolve(message.data);
      else entry.reject(new Error(message.error?.message ?? 'Erro desconhecido no servidor'));
      return;
    }

    if (message.t === 'notify') {
      this.emit(`notify:${message.method}`, message.data);
      this.emit('notify', message.method, message.data);
    }
  }

  request(method, data = {}) {
    if (!this.connected) {
      return Promise.reject(new Error('Sem conexão com o servidor'));
    }

    const id = `r${(this.#seq += 1)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`O servidor demorou demais para responder "${method}"`));
      }, REQUEST_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ t: 'req', id, method, data }));
    });
  }

  notify(method, data = {}) {
    if (!this.connected) return;
    this.#ws.send(JSON.stringify({ t: 'notify', method, data }));
  }

  close() {
    try {
      this.#ws?.close(1000, 'saiu');
    } catch {
      /* já fechado */
    }
    this.#ws = null;
  }
}
