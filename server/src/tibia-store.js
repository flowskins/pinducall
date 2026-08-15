import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('tibia');

/** Timer que toda sala nova já nasce com — o alarme da mastermind potion. */
export function timersPadrao() {
  return [
    {
      id: 'mastermind',
      nome: 'Mastermind Potion',
      dur: 600,
      repete: true,
      cor: '#33ff33',
      fixo: true, // não pode ser removido
      endAt: null,
    },
  ];
}

/**
 * Guarda os timers de cada sala em disco, para que os personalizados
 * sobrevivam a um restart do servidor. Um arquivo por sala, JSON simples.
 */
export class TibiaStore {
  #filePath;
  #timers;

  constructor(roomId) {
    const safeId = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.#filePath = path.join(config.dataDir, `tibia-${safeId}.json`);
    this.#timers = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#filePath, 'utf8'));
      if (!Array.isArray(raw?.timers)) throw new Error('formato inesperado');

      // endAt não é restaurado: um timer que estava correndo quando o servidor
      // caiu não faz sentido continuar contando depois.
      const timers = raw.timers.map((t) => ({ ...t, endAt: null }));

      // Garante que o timer fixo continue existindo mesmo se o arquivo for editado.
      if (!timers.some((t) => t.id === 'mastermind')) timers.unshift(...timersPadrao());
      return timers;
    } catch {
      return timersPadrao();
    }
  }

  save() {
    try {
      fs.writeFileSync(this.#filePath, JSON.stringify({ timers: this.#timers }, null, 2), 'utf8');
    } catch (error) {
      log.warn('não consegui salvar os timers:', error.message);
    }
  }

  get timers() {
    return this.#timers;
  }

  find(id) {
    return this.#timers.find((t) => t.id === id) ?? null;
  }

  add({ nome, dur, repete, cor }) {
    if (this.#timers.length >= 20) throw new Error('Limite de 20 timers na sala');

    const limpo = String(nome ?? '').trim().slice(0, 24) || 'Timer';
    const segundos = Math.round(Number(dur));
    if (!Number.isFinite(segundos) || segundos < 5 || segundos > 24 * 3600) {
      throw new Error('Duração inválida (mínimo 5 segundos)');
    }

    const timer = {
      id: randomUUID().slice(0, 8),
      nome: limpo,
      dur: segundos,
      repete: Boolean(repete),
      cor: typeof cor === 'string' && /^#[0-9a-f]{6}$/i.test(cor) ? cor : '#b14dff',
      fixo: false,
      endAt: null,
    };

    this.#timers.push(timer);
    this.save();
    return timer;
  }

  remove(id) {
    const timer = this.find(id);
    if (!timer) return false;
    if (timer.fixo) throw new Error('Este timer não pode ser removido');

    this.#timers = this.#timers.filter((t) => t.id !== id);
    this.save();
    return true;
  }
}
