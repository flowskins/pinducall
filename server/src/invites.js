import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('convites');

/** Token curto o bastante para caber num link, longo o bastante para não ser adivinhado. */
function novoToken() {
  return randomBytes(15).toString('base64url'); // 20 caracteres, 120 bits
}

/**
 * Convites de entrada direta. Um convite vale por uma sala, não tem limite de
 * uso e morre sozinho depois do prazo. É gravado em disco para o link não
 * quebrar quando o servidor reinicia.
 */
export class InviteStore {
  /** @type {Map<string, {token, roomId, criadoPor, criadoEm, expiraEm}>} */
  #convites = new Map();
  #arquivo;

  constructor(dataDir = config.dataDir) {
    this.#arquivo = path.join(dataDir, 'convites.json');
    this.#carregar();
  }

  #carregar() {
    try {
      const bruto = JSON.parse(fs.readFileSync(this.#arquivo, 'utf8'));
      for (const convite of bruto) {
        if (convite?.token) this.#convites.set(convite.token, convite);
      }
      if (this.#expurgar()) this.#gravar();
      log.info(`${this.#convites.size} convite(s) válido(s) carregado(s)`);
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn(`Não consegui ler ${this.#arquivo}: ${error.message}`);
    }
  }

  #gravar() {
    try {
      fs.mkdirSync(path.dirname(this.#arquivo), { recursive: true });
      fs.writeFileSync(this.#arquivo, JSON.stringify([...this.#convites.values()], null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      log.error(`Não consegui gravar ${this.#arquivo}: ${error.message}`);
    }
  }

  /** Joga fora os vencidos. @returns {boolean} se removeu alguma coisa */
  #expurgar() {
    const agora = Date.now();
    let removeu = false;
    for (const [token, convite] of this.#convites) {
      if (convite.expiraEm <= agora) {
        this.#convites.delete(token);
        removeu = true;
      }
    }
    return removeu;
  }

  get total() {
    this.#expurgar();
    return this.#convites.size;
  }

  /**
   * Cria (ou reaproveita) o convite de uma sala. Reaproveitar evita encher o
   * disco de tokens quando a pessoa clica em "Convidar" várias vezes seguidas,
   * e faz o link continuar o mesmo durante a noite inteira de jogo.
   */
  criar({ roomId, criadoPor }) {
    this.#expurgar();

    const restante = config.inviteTtlMs;
    const existente = [...this.#convites.values()].find(
      (c) => c.roomId === roomId && c.expiraEm - Date.now() > restante * 0.5,
    );
    if (existente) return existente;

    const convite = {
      token: novoToken(),
      roomId,
      criadoPor: String(criadoPor ?? '').slice(0, 32),
      criadoEm: Date.now(),
      expiraEm: Date.now() + restante,
    };

    this.#convites.set(convite.token, convite);
    this.#gravar();
    log.info(`Convite criado para "${roomId}" por ${convite.criadoPor || 'alguém'}`);
    return convite;
  }

  /** @returns {{token, roomId, expiraEm}|null} */
  resolver(token) {
    const convite = this.#convites.get(String(token ?? ''));
    if (!convite) return null;

    if (convite.expiraEm <= Date.now()) {
      this.#convites.delete(convite.token);
      this.#gravar();
      return null;
    }

    return convite;
  }

  /** Usado quando uma sala deixa de existir. */
  removerDaSala(roomId) {
    let removeu = false;
    for (const [token, convite] of this.#convites) {
      if (convite.roomId === roomId) {
        this.#convites.delete(token);
        removeu = true;
      }
    }
    if (removeu) this.#gravar();
    return removeu;
  }
}

export const convites = new InviteStore();
