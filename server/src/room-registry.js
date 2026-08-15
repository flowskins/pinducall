import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('salas');

/** Parametros do scrypt. Baratos o bastante para um servidor de 2 vCPU. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSenha(senha, saltHex = randomBytes(16).toString('hex')) {
  const derivada = scryptSync(String(senha), Buffer.from(saltHex, 'hex'), SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return { salt: saltHex, hash: derivada.toString('hex') };
}

function senhaConfere(senha, registro) {
  if (!registro?.hash || !registro?.salt) return false;
  const { hash } = hashSenha(senha, registro.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(registro.hash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Transforma "Hunt da Madruga" em "hunt-da-madruga".
 * O id e o que vai no protocolo; o nome bonito fica so na interface.
 */
export function idDeSala(raw) {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function nomeDeSala(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/**
 * Catalogo de salas do servidor. Cada sala tem senha propria (guardada como
 * scrypt + salt, nunca em texto puro) e sobrevive a reinicializacoes.
 */
export class RoomRegistry {
  /** @type {Map<string, {id, nome, senha, criadaEm, criadaPor, ultimoUso}>} */
  #salas = new Map();
  #arquivo;

  constructor(dataDir = config.dataDir) {
    this.#arquivo = path.join(dataDir, 'salas.json');
    this.#carregar();
  }

  #carregar() {
    try {
      const bruto = fs.readFileSync(this.#arquivo, 'utf8');
      for (const sala of JSON.parse(bruto)) {
        if (!sala?.id) continue;

        // Ninguém está online quando o servidor acaba de subir: a contagem
        // para expirar recomeça do último uso conhecido.
        sala.vazioDesde = sala.vazioDesde ?? sala.ultimoUso ?? sala.criadaEm ?? Date.now();
        // Arquivos gravados antes da versão com salas fixas.
        sala.fixa = sala.fixa ?? sala.criadaPor === 'servidor';

        this.#salas.set(sala.id, sala);
      }
      log.info(`${this.#salas.size} sala(s) carregada(s) de ${this.#arquivo}`);
      this.#gravar();
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn(`Não consegui ler ${this.#arquivo}: ${error.message}`);
      this.#semear();
    }
  }

  /**
   * Primeira execução: se existe ROOM_PASSWORD no .env, cria a sala padrão com
   * ela. Assim quem já usava a versão de sala única continua entrando igual.
   *
   * Ela nasce `fixa`: é a sala da casa, cuja senha está no .env, e some do
   * servidor só se você apagar na mão. As criadas pelo aplicativo expiram.
   */
  #semear() {
    if (!config.roomPassword) return;
    const id = idDeSala(config.defaultRoom) || 'geral';
    this.#salas.set(id, {
      id,
      nome: config.defaultRoom,
      senha: hashSenha(config.roomPassword),
      criadaEm: Date.now(),
      criadaPor: 'servidor',
      ultimoUso: Date.now(),
      vazioDesde: Date.now(),
      fixa: true,
    });
    this.#gravar();
    log.info(`Sala padrão "${id}" criada a partir de ROOM_PASSWORD`);
  }

  #gravar() {
    try {
      fs.mkdirSync(path.dirname(this.#arquivo), { recursive: true });
      fs.writeFileSync(this.#arquivo, JSON.stringify([...this.#salas.values()], null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      log.error(`Não consegui gravar ${this.#arquivo}: ${error.message}`);
    }
  }

  existe(id) {
    return this.#salas.has(id);
  }

  /** Dados públicos de uma sala (sem nada da senha). */
  obter(id) {
    const sala = this.#salas.get(id);
    return sala ? { id: sala.id, nome: sala.nome } : null;
  }

  get total() {
    return this.#salas.size;
  }

  /**
   * Lista pública da tela de entrada. Nunca devolve nada da senha —
   * só o que ajuda a pessoa a achar a sala da turma dela.
   *
   * @param {(id: string) => number} contarPessoas
   */
  listar(contarPessoas = () => 0) {
    return [...this.#salas.values()]
      .map((sala) => ({
        id: sala.id,
        nome: sala.nome,
        pessoas: contarPessoas(sala.id),
        criadaEm: sala.criadaEm,
        ultimoUso: sala.ultimoUso ?? sala.criadaEm,
        fixa: Boolean(sala.fixa),
        // Quando esta sala vazia deixa de existir (null = enquanto tiver gente,
        // ou se ela for fixa).
        expiraEm: sala.fixa || !sala.vazioDesde ? null : sala.vazioDesde + config.roomTtlMs,
      }))
      .sort((a, b) => b.pessoas - a.pessoas || (b.ultimoUso ?? 0) - (a.ultimoUso ?? 0));
  }

  /** Alguém entrou: a sala está viva, o relógio da expiração para. */
  marcarAtividade(id) {
    const sala = this.#salas.get(id);
    if (!sala || sala.vazioDesde === null) return;

    sala.vazioDesde = null;
    sala.ultimoUso = Date.now();
    this.#gravar();
  }

  /** Saiu o último: começa a contar as 24 horas. */
  marcarVazia(id) {
    const sala = this.#salas.get(id);
    if (!sala) return;

    sala.vazioDesde = Date.now();
    sala.ultimoUso = Date.now();
    this.#gravar();
  }

  /**
   * Apaga as salas que passaram do prazo sem ninguém dentro.
   * @returns {Array<{id: string, nome: string}>} as que foram embora
   */
  expirar(agora = Date.now()) {
    const removidas = [];

    for (const sala of [...this.#salas.values()]) {
      if (sala.fixa || !sala.vazioDesde) continue;
      if (agora - sala.vazioDesde < config.roomTtlMs) continue;

      this.#salas.delete(sala.id);
      removidas.push({ id: sala.id, nome: sala.nome });
    }

    if (removidas.length) this.#gravar();
    return removidas;
  }

  criar({ nome, senha, criadaPor }) {
    const nomeLimpo = nomeDeSala(nome);
    if (nomeLimpo.length < 2) throw new Error('O nome da sala precisa ter pelo menos 2 letras');

    const id = idDeSala(nomeLimpo);
    if (!id) throw new Error('Use letras ou números no nome da sala');
    if (this.#salas.has(id)) throw new Error(`Já existe uma sala chamada "${nomeLimpo}"`);

    const senhaTexto = String(senha ?? '');
    if (senhaTexto.length < 4) throw new Error('A senha da sala precisa ter pelo menos 4 caracteres');
    if (senhaTexto.length > 128) throw new Error('Senha longa demais');

    if (this.#salas.size >= config.maxRooms) {
      throw new Error(`Este servidor já está com o limite de ${config.maxRooms} salas`);
    }

    const sala = {
      id,
      nome: nomeLimpo,
      senha: hashSenha(senhaTexto),
      criadaEm: Date.now(),
      criadaPor: String(criadaPor ?? '').slice(0, 32),
      ultimoUso: Date.now(),
      // Nasce vazia: se ninguém entrar, ela some no prazo normal.
      vazioDesde: Date.now(),
      fixa: false,
    };

    this.#salas.set(id, sala);
    this.#gravar();
    log.info(`Sala "${id}" criada por ${sala.criadaPor || 'anônimo'}`);

    return { id: sala.id, nome: sala.nome };
  }

  /** @returns {{id: string, nome: string}} */
  autenticar(id, senha) {
    const sala = this.#salas.get(id);
    if (!sala) throw new Error('Sala não encontrada. Confira o nome ou crie uma nova.');
    if (!senhaConfere(senha, sala.senha)) throw new Error('Senha da sala incorreta');

    sala.ultimoUso = Date.now();
    this.#gravar();
    return { id: sala.id, nome: sala.nome };
  }

  remover(id) {
    const existia = this.#salas.delete(id);
    if (existia) this.#gravar();
    return existia;
  }
}

/** Instancia unica usada pela sinalizacao. */
export const salas = new RoomRegistry();
