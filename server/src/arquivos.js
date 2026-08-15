import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('arquivos');

/**
 * Extensões que o servidor recusa. Não é antivírus: é para a sala não virar
 * um canal cômodo de distribuir executável para os amigos. Documento, imagem,
 * áudio, vídeo e arquivo compactado passam normalmente.
 */
const EXTENSOES_BLOQUEADAS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.pif', '.scr', '.cpl', '.msc',
  '.dll', '.sys', '.drv', '.jar', '.ps1', '.psm1', '.vbs', '.vbe', '.wsf',
  '.wsh', '.hta', '.reg', '.lnk', '.inf', '.appx', '.msix', '.gadget',
  '.apk', '.app', '.dmg', '.pkg', '.deb', '.rpm', '.run', '.sh', '.bin',
]);

function token() {
  return randomBytes(15).toString('base64url');
}

/** Deixa o nome exibível e seguro para virar nome de arquivo em disco. */
export function nomeDeArquivo(bruto) {
  const limpo = String(bruto ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return limpo || 'arquivo';
}

export function extensaoDe(nome) {
  const ext = path.extname(nomeDeArquivo(nome)).toLowerCase();
  return ext.length > 12 ? '' : ext;
}

export function extensaoPermitida(nome) {
  return !EXTENSOES_BLOQUEADAS.has(extensaoDe(nome));
}

export function formatarTamanho(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Arquivos enviados no chat. Cada um vive 24h (o mesmo prazo dos convites) e
 * some junto com a sala. O conteúdo fica em data/arquivos/, os metadados em
 * arquivos.json, e o link de download é o próprio token — longo o bastante
 * para não ser adivinhado.
 */
export class ArquivoStore {
  /** @type {Map<string, object>} */
  #arquivos = new Map();
  /** Tickets de upload ainda não usados. @type {Map<string, object>} */
  #tickets = new Map();
  #indice;
  #pasta;

  constructor(dataDir = config.dataDir) {
    this.#indice = path.join(dataDir, 'arquivos.json');
    this.#pasta = path.join(dataDir, 'arquivos');
    fs.mkdirSync(this.#pasta, { recursive: true });
    this.#carregar();
  }

  #carregar() {
    try {
      for (const item of JSON.parse(fs.readFileSync(this.#indice, 'utf8'))) {
        if (item?.token) this.#arquivos.set(item.token, item);
      }
      log.info(`${this.#arquivos.size} arquivo(s) no índice`);
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn(`Não consegui ler ${this.#indice}: ${error.message}`);
    }
  }

  #gravar() {
    try {
      fs.writeFileSync(this.#indice, JSON.stringify([...this.#arquivos.values()], null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      log.error(`Não consegui gravar ${this.#indice}: ${error.message}`);
    }
  }

  #bytesDaSala(roomId) {
    let total = 0;
    for (const item of this.#arquivos.values()) {
      if (item.roomId === roomId) total += item.tamanho;
    }
    return total;
  }

  get bytesTotais() {
    let total = 0;
    for (const item of this.#arquivos.values()) total += item.tamanho;
    return total;
  }

  get total() {
    return this.#arquivos.size;
  }

  /**
   * Autoriza um envio. O ticket vale poucos minutos e some depois de usado —
   * é o que impede alguém de despejar arquivo sem estar numa sala.
   */
  criarTicket({ roomId, peerId, displayName, nome, tamanho, tipo }) {
    const limpo = nomeDeArquivo(nome);
    const bytes = Number(tamanho);

    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('Arquivo vazio');
    if (bytes > config.arquivoMaxBytes) {
      throw new Error(`O limite é ${formatarTamanho(config.arquivoMaxBytes)} por arquivo`);
    }
    if (!extensaoPermitida(limpo)) {
      throw new Error('Esse tipo de arquivo não é aceito aqui (programas e scripts são bloqueados)');
    }
    if (this.#bytesDaSala(roomId) + bytes > config.arquivoSalaBytes) {
      throw new Error('Esta sala já atingiu o limite de arquivos guardados');
    }
    if (this.bytesTotais + bytes > config.arquivoTotalBytes) {
      throw new Error('O servidor está sem espaço para arquivos no momento');
    }

    const ticket = {
      ticket: token(),
      roomId,
      peerId,
      displayName: String(displayName ?? '').slice(0, 32),
      nome: limpo,
      tamanho: bytes,
      tipo: String(tipo ?? '').slice(0, 100),
      expiraEm: Date.now() + 5 * 60 * 1000,
    };

    this.#tickets.set(ticket.ticket, ticket);
    return ticket;
  }

  /** Consome o ticket (só serve uma vez). */
  usarTicket(valor) {
    const ticket = this.#tickets.get(String(valor ?? ''));
    if (!ticket) return null;

    this.#tickets.delete(ticket.ticket);
    if (ticket.expiraEm <= Date.now()) return null;
    return ticket;
  }

  caminhoDe(tokenArquivo, extensao) {
    return path.join(this.#pasta, `${tokenArquivo}${extensao}`);
  }

  /** Registra o arquivo já gravado em disco e devolve o que vai para o chat. */
  registrar(ticket, { caminho, tamanhoReal }) {
    const item = {
      token: token(),
      roomId: ticket.roomId,
      peerId: ticket.peerId,
      displayName: ticket.displayName,
      nome: ticket.nome,
      tamanho: tamanhoReal,
      tipo: ticket.tipo,
      caminho,
      criadoEm: Date.now(),
      expiraEm: Date.now() + config.arquivoTtlMs,
    };

    this.#arquivos.set(item.token, item);
    this.#gravar();
    log.info(`"${item.nome}" (${formatarTamanho(item.tamanho)}) enviado em ${item.roomId}`);
    return item;
  }

  resolver(tokenArquivo) {
    const item = this.#arquivos.get(String(tokenArquivo ?? ''));
    if (!item) return null;
    if (item.expiraEm <= Date.now()) return null;
    if (!fs.existsSync(item.caminho)) return null;
    return item;
  }

  #apagar(item) {
    try {
      fs.rmSync(item.caminho, { force: true });
    } catch (error) {
      log.warn(`Não consegui apagar ${item.caminho}: ${error.message}`);
    }
    this.#arquivos.delete(item.token);
  }

  /** @returns {Array<object>} os que foram apagados */
  expirar(agora = Date.now()) {
    const removidos = [];
    for (const item of [...this.#arquivos.values()]) {
      if (item.expiraEm > agora) continue;
      this.#apagar(item);
      removidos.push(item);
    }

    for (const [chave, ticket] of this.#tickets) {
      if (ticket.expiraEm <= agora) this.#tickets.delete(chave);
    }

    if (removidos.length) this.#gravar();
    return removidos;
  }

  removerDaSala(roomId) {
    const removidos = [];
    for (const item of [...this.#arquivos.values()]) {
      if (item.roomId !== roomId) continue;
      this.#apagar(item);
      removidos.push(item);
    }
    if (removidos.length) this.#gravar();
    return removidos;
  }
}

export const arquivos = new ArquivoStore();
