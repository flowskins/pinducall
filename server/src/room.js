import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { mediaCodecs } from './sfu/codecs.js';
import { pickWorker } from './sfu/workers.js';
import { ChatStore } from './chat-store.js';
import { TibiaStore } from './tibia-store.js';
import { salas } from './room-registry.js';

/** Fontes de mídia validas. Qualquer outra coisa e recusada no produce(). */
export const MEDIA_SOURCES = new Set(['mic', 'screen', 'screen-audio', 'music']);

export class Room {
  /** @type {Map<string, Room>} */
  static #rooms = new Map();

  #log;
  #router;
  #audioLevelObserver;
  /** @type {Map<string, import('./peer.js').Peer>} */
  #peers = new Map();
  #chat;
  #tibia;
  #tibiaTick = null;
  /** Estado do modo DJ. peerId = quem está com a música na mão. */
  #dj = { peerId: null, nome: null, faixa: null, tocando: false, indice: 0, total: 0 };
  #closed = false;

  constructor(id, router, audioLevelObserver) {
    this.id = id;
    this.#router = router;
    this.#audioLevelObserver = audioLevelObserver;
    this.#log = createLogger(`room:${id}`);
    this.#chat = new ChatStore(id);
    this.#tibia = new TibiaStore(id);
    this.createdAt = Date.now();

    // Varredura dos timers: dispara o alarme e reinicia os que repetem.
    this.#tibiaTick = setInterval(() => this.#varrerTimers(), 1000);

    this.#wireAudioLevelObserver();
  }

  static async getOrCreate(roomId) {
    const existing = Room.#rooms.get(roomId);
    if (existing && !existing.#closed) return existing;

    const worker = pickWorker();
    const router = await worker.createRouter({ mediaCodecs });

    // Detecta quem está falando para acender o indicador no cliente.
    const audioLevelObserver = await router.createAudioLevelObserver({
      maxEntries: 3,
      threshold: -58,
      interval: 400,
    });

    const room = new Room(roomId, router, audioLevelObserver);
    Room.#rooms.set(roomId, room);
    createLogger('rooms').info(`Sala "${roomId}" criada no worker ${worker.pid}`);
    return room;
  }

  static get(roomId) {
    return Room.#rooms.get(roomId);
  }

  static list() {
    return [...Room.#rooms.values()].map((room) => room.summary());
  }

  get router() {
    return this.#router;
  }

  get peerCount() {
    return this.#peers.size;
  }

  get isFull() {
    return this.#peers.size >= config.maxPeersPerRoom;
  }

  summary() {
    return {
      id: this.id,
      peerCount: this.#peers.size,
      maxPeers: config.maxPeersPerRoom,
      createdAt: this.createdAt,
      peers: [...this.#peers.values()].map((peer) => peer.toPublic()),
    };
  }

  #wireAudioLevelObserver() {
    this.#audioLevelObserver.on('volumes', (volumes) => {
      const speakingIds = new Set();

      for (const { producer, volume } of volumes) {
        const peer = this.#findPeerByProducerId(producer.id);
        if (!peer) continue;
        speakingIds.add(peer.id);
        if (!peer.state.speaking) {
          peer.state.speaking = true;
        }
        this.broadcast('activeSpeaker', { peerId: peer.id, volume });
      }

      // Quem estava falando e não aparece mais nesta rodada para de "acender".
      for (const peer of this.#peers.values()) {
        if (peer.state.speaking && !speakingIds.has(peer.id)) {
          peer.state.speaking = false;
          this.broadcast('activeSpeaker', { peerId: peer.id, volume: null });
        }
      }
    });

    this.#audioLevelObserver.on('silence', () => {
      for (const peer of this.#peers.values()) {
        if (peer.state.speaking) {
          peer.state.speaking = false;
          this.broadcast('activeSpeaker', { peerId: peer.id, volume: null });
        }
      }
    });
  }

  #findPeerByProducerId(producerId) {
    for (const peer of this.#peers.values()) {
      if (peer.producers.has(producerId)) return peer;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Peers
  // ---------------------------------------------------------------------------

  addPeer(peer) {
    if (this.isFull) {
      throw new Error(`A sala está cheia (limite de ${config.maxPeersPerRoom} pessoas)`);
    }
    this.#peers.set(peer.id, peer);
    this.#log.info(`${peer.displayName} entrou (${this.#peers.size}/${config.maxPeersPerRoom})`);

    // Enquanto tiver gente aqui, o relógio da expiração fica parado.
    salas.marcarAtividade(this.id);

    this.broadcast('peerJoined', { peer: peer.toPublic() }, peer.id);
    return peer;
  }

  getPeer(peerId) {
    return this.#peers.get(peerId);
  }

  listPeers(exceptPeerId) {
    return [...this.#peers.values()]
      .filter((peer) => peer.id !== exceptPeerId)
      .map((peer) => peer.toPublic());
  }

  removePeer(peerId) {
    const peer = this.#peers.get(peerId);
    if (!peer) return;

    // Se quem saiu estava com a música, o comando fica livre para outro assumir.
    if (this.#dj.peerId === peerId) {
      this.#dj = { peerId: null, nome: null, faixa: null, tocando: false, indice: 0, total: 0 };
      this.broadcast('djUpdate', this.djState());
    }

    peer.close();
    this.#peers.delete(peerId);
    this.#log.info(`${peer.displayName} saiu (${this.#peers.size}/${config.maxPeersPerRoom})`);

    this.broadcast('peerLeft', { peerId });

    if (this.#peers.size === 0) {
      this.#log.info('Sala vazia; router será fechado para liberar recursos.');
      // A partir de agora conta o prazo para a sala ser apagada de vez.
      salas.marcarVazia(this.id);
      this.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Transports / producers / consumers
  // ---------------------------------------------------------------------------

  async createWebRtcTransport(peer, direction) {
    const options = config.mediasoup.webRtcTransport;
    const { rtcMinPort, rtcMaxPort } = config.mediasoup.workerSettings;

    const listenInfos = [];
    if (options.enableUdp) {
      listenInfos.push({
        protocol: 'udp',
        ip: '0.0.0.0',
        announcedAddress: options.announcedAddress,
        exposeInternalIp: options.exposeInternalIp,
        portRange: { min: rtcMinPort, max: rtcMaxPort },
      });
    }
    if (options.enableTcp) {
      listenInfos.push({
        protocol: 'tcp',
        ip: '0.0.0.0',
        announcedAddress: options.announcedAddress,
        exposeInternalIp: options.exposeInternalIp,
        portRange: { min: rtcMinPort, max: rtcMaxPort },
      });
    }

    if (listenInfos.length === 0) {
      throw new Error('Nem UDP nem TCP estao habilitados: revise ENABLE_UDP/ENABLE_TCP');
    }

    const transport = await this.#router.createWebRtcTransport({
      listenInfos,
      enableUdp: options.enableUdp,
      enableTcp: options.enableTcp,
      preferUdp: options.preferUdp,
      initialAvailableOutgoingBitrate: options.initialAvailableOutgoingBitrate,
      appData: { peerId: peer.id, direction },
    });

    if (direction === 'send' && options.maxIncomingBitrate > 0) {
      try {
        await transport.setMaxIncomingBitrate(options.maxIncomingBitrate);
      } catch (error) {
        this.#log.warn('setMaxIncomingBitrate falhou:', error.message);
      }
    }

    transport.on('dtlsstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        this.#log.warn(`DTLS ${state} no transport ${direction} de ${peer.displayName}`);
      }
    });

    peer.addTransport(transport);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  async createProducer(peer, { transportId, kind, rtpParameters, appData = {} }) {
    const source = appData.source;
    if (!MEDIA_SOURCES.has(source)) {
      throw new Error(`Fonte de mídia inválida: "${source}"`);
    }

    // Uma pessoa não pode ter dois producers da mesma fonte.
    const duplicate = peer.findProducerBySource(source);
    if (duplicate) {
      duplicate.close();
    }

    const transport = peer.getTransport(transportId);
    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: { ...appData, peerId: peer.id, source },
    });

    peer.addProducer(producer);

    if (kind === 'audio' && source === 'mic') {
      try {
        await this.#audioLevelObserver.addProducer({ producerId: producer.id });
      } catch (error) {
        this.#log.warn('Não foi possível monitorar o nível de áudio:', error.message);
      }
    }

    if (source === 'screen') {
      peer.state.screenSharing = true;
      this.broadcast('peerUpdated', { peerId: peer.id, state: peer.state });
    }

    producer.observer.once('close', () => {
      this.broadcast('producerClosed', { peerId: peer.id, producerId: producer.id, source });
      if (source === 'screen') {
        peer.state.screenSharing = false;
        this.broadcast('peerUpdated', { peerId: peer.id, state: peer.state });
      }
    });

    // Avisa todo mundo para pedir um consumer deste producer novo.
    this.broadcast(
      'newProducer',
      { peerId: peer.id, producerId: producer.id, kind, source },
      peer.id,
    );

    this.#log.debug(`${peer.displayName} publicou ${kind}/${source}`);
    return { id: producer.id };
  }

  async createConsumer(peer, { producerId, transportId }) {
    if (!peer.rtpCapabilities) {
      throw new Error('rtpCapabilities do cliente ainda não foram enviadas');
    }

    const producerPeer = this.#findPeerByProducerId(producerId);
    if (!producerPeer) throw new Error(`Producer ${producerId} não existe mais`);

    const producer = producerPeer.producers.get(producerId);

    if (!this.#router.canConsume({ producerId, rtpCapabilities: peer.rtpCapabilities })) {
      throw new Error('O cliente não consegue consumir este producer (codecs incompativeis)');
    }

    const transport = peer.getTransport(transportId);

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: peer.rtpCapabilities,
      // Começa pausado: retomamos só depois que o cliente confirma o handler,
      // evitando perder os primeiros frames (recomendacao do mediasoup).
      paused: true,
      appData: { peerId: producerPeer.id, source: producer.appData?.source },
    });

    peer.addConsumer(consumer);

    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id);
      this.send(peer, 'consumerClosed', { consumerId: consumer.id });
    });

    consumer.on('producerpause', () => this.send(peer, 'consumerPaused', { consumerId: consumer.id }));
    consumer.on('producerresume', () => this.send(peer, 'consumerResumed', { consumerId: consumer.id }));

    return {
      id: consumer.id,
      producerId,
      peerId: producerPeer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      source: producer.appData?.source ?? 'unknown',
      producerPaused: consumer.producerPaused,
    };
  }

  // ---------------------------------------------------------------------------
  // Tibia: timers de hunt sincronizados
  // ---------------------------------------------------------------------------

  /**
   * O estado vai com `now` do servidor junto. O cliente calcula o desvio do
   * próprio relógio uma vez e derruba a contagem localmente — assim ninguém
   * fica adiantado por causa de relógio desregulado, e não precisa de polling.
   */
  tibiaState() {
    return {
      now: Date.now(),
      timers: this.#tibia.timers.map((t) => ({
        id: t.id,
        nome: t.nome,
        dur: t.dur,
        repete: t.repete,
        cor: t.cor,
        fixo: Boolean(t.fixo),
        endAt: t.endAt,
      })),
    };
  }

  #emitirTibia() {
    this.broadcast('tibiaUpdate', this.tibiaState());
  }

  #varrerTimers() {
    if (this.#closed) return;

    const agora = Date.now();
    let mudou = false;

    for (const timer of this.#tibia.timers) {
      if (!timer.endAt || timer.endAt > agora) continue;

      // O alarme sai do servidor: todo mundo ouve no mesmo instante.
      this.broadcast('timerFinished', { id: timer.id, nome: timer.nome, repete: timer.repete });

      if (timer.repete) {
        // Soma a duração (em vez de partir de agora) para não acumular atraso.
        timer.endAt += timer.dur * 1000;
        while (timer.endAt <= agora) timer.endAt += timer.dur * 1000;
      } else {
        timer.endAt = null;
      }
      mudou = true;
    }

    if (mudou) this.#emitirTibia();
  }

  startTimer(peer, id) {
    const timer = this.#tibia.find(id);
    if (!timer) throw new Error('Este timer não existe mais');

    timer.endAt = Date.now() + timer.dur * 1000;
    this.#emitirTibia();
    this.broadcast('tibiaLog', {
      texto: `${peer.displayName} iniciou o timer ${timer.nome}`,
      at: Date.now(),
    });
    return this.tibiaState();
  }

  stopTimer(peer, id) {
    const timer = this.#tibia.find(id);
    if (!timer) throw new Error('Este timer não existe mais');

    timer.endAt = null;
    this.#emitirTibia();
    this.broadcast('tibiaLog', {
      texto: `${peer.displayName} parou o timer ${timer.nome}`,
      at: Date.now(),
    });
    return this.tibiaState();
  }

  addTimer(peer, dados) {
    const timer = this.#tibia.add(dados);
    this.#emitirTibia();
    this.broadcast('tibiaLog', {
      texto: `${peer.displayName} criou o timer ${timer.nome}`,
      at: Date.now(),
    });
    return this.tibiaState();
  }

  removeTimer(peer, id) {
    this.#tibia.remove(id);
    this.#emitirTibia();
    return this.tibiaState();
  }

  // ---------------------------------------------------------------------------
  // Modo DJ: uma pessoa toca, todo mundo escuta pela call
  // ---------------------------------------------------------------------------

  djState() {
    return { ...this.#dj };
  }

  #emitirDj() {
    this.broadcast('djUpdate', this.djState());
  }

  /** Assume o comando da música. Só sai quem está com ela ou se ninguém estiver. */
  claimDj(peer) {
    if (this.#dj.peerId && this.#dj.peerId !== peer.id) {
      const atual = this.#peers.get(this.#dj.peerId);
      if (atual) throw new Error(`${atual.displayName} já está no comando da música`);
    }

    this.#dj = { peerId: peer.id, nome: peer.displayName, faixa: null, tocando: false, indice: 0, total: 0 };
    this.#emitirDj();
    return this.djState();
  }

  releaseDj(peer) {
    if (this.#dj.peerId !== peer.id) return this.djState();

    this.#dj = { peerId: null, nome: null, faixa: null, tocando: false, indice: 0, total: 0 };
    this.#emitirDj();
    return this.djState();
  }

  /** O cliente do DJ informa o que está tocando; o servidor só repassa. */
  updateDj(peer, dados) {
    if (this.#dj.peerId !== peer.id) throw new Error('Você não está no comando da música');

    this.#dj = {
      ...this.#dj,
      faixa: typeof dados.faixa === 'string' ? dados.faixa.slice(0, 120) : null,
      tocando: Boolean(dados.tocando),
      indice: Number.isFinite(dados.indice) ? dados.indice : 0,
      total: Number.isFinite(dados.total) ? dados.total : 0,
    };
    this.#emitirDj();
    return this.djState();
  }

  /**
   * Qualquer pessoa da sala pode apertar play/stop/próxima: o comando viaja
   * até quem está com a música e é executado lá.
   */
  djCommand(peer, acao) {
    const validos = ['play', 'pause', 'stop', 'next', 'prev'];
    if (!validos.includes(acao)) throw new Error('Comando de música inválido');
    if (!this.#dj.peerId) throw new Error('Ninguém está no comando da música');

    const dj = this.#peers.get(this.#dj.peerId);
    if (!dj) throw new Error('Quem estava com a música saiu da sala');

    this.send(dj, 'djCommand', { acao, de: peer.displayName });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  postChatMessage(peer, text) {
    const clean = String(text ?? '').trim().slice(0, 2000);
    if (!clean) throw new Error('Mensagem vazia');

    const message = {
      id: randomUUID(),
      peerId: peer.id,
      displayName: peer.displayName,
      text: clean,
      sentAt: Date.now(),
    };

    this.#chat.append(message);
    this.broadcast('chatMessage', message);
    return message;
  }

  /**
   * Mensagem de arquivo. Só o servidor chama isto, depois que o upload
   * terminou — o cliente não consegue inventar um arquivo que não existe.
   */
  postArquivo(ticket, item) {
    const message = {
      id: randomUUID(),
      peerId: ticket.peerId,
      displayName: ticket.displayName,
      sentAt: Date.now(),
      arquivo: {
        token: item.token,
        nome: item.nome,
        tamanho: item.tamanho,
        tipo: item.tipo,
        expiraEm: item.expiraEm,
      },
    };

    this.#chat.append(message);
    this.broadcast('chatMessage', message);
    return message;
  }

  chatHistory() {
    return this.#chat.history();
  }

  // ---------------------------------------------------------------------------
  // Envio de mensagens
  // ---------------------------------------------------------------------------

  send(peer, method, data) {
    peer?.socket?.notify?.(method, data);
  }

  broadcast(method, data, exceptPeerId = null) {
    for (const peer of this.#peers.values()) {
      if (peer.id === exceptPeerId) continue;
      this.send(peer, method, data);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;

    for (const peer of this.#peers.values()) peer.close();
    this.#peers.clear();

    this.#chat.close();
    clearInterval(this.#tibiaTick);
    this.#tibiaTick = null;

    try {
      this.#router.close();
    } catch {
      /* já fechado */
    }

    Room.#rooms.delete(this.id);
  }
}
