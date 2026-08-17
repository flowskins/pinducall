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

/** Canal padrão: por onde todo mundo entra e para onde a sub-sala vazia devolve. */
export const CANAL_PRINCIPAL = 'principal';

/** Teto de sub-salas por sala, para ninguém poluir a lista. */
const MAX_CANAIS = 8;

export class Room {
  /** @type {Map<string, Room>} */
  static #rooms = new Map();

  #log;
  #router;
  #audioLevelObserver;
  /** @type {Map<string, import('./peer.js').Peer>} */
  #peers = new Map();
  /**
   * Sub-salas (canais de voz). Sempre contém o 'principal'. Cada peer carrega
   * o id do canal em que está (peer.state.channel); mídia só circula dentro do
   * mesmo canal.
   * @type {Map<string, { id: string, nome: string, fixo: boolean }>}
   */
  #channels = new Map([[CANAL_PRINCIPAL, { id: CANAL_PRINCIPAL, nome: 'Principal', fixo: true }]]);
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
        // Só quem está no mesmo canal enxerga o indicador de fala.
        this.broadcastChannel(peer.state.channel, 'activeSpeaker', { peerId: peer.id, volume });
      }

      // Quem estava falando e não aparece mais nesta rodada para de "acender".
      for (const peer of this.#peers.values()) {
        if (peer.state.speaking && !speakingIds.has(peer.id)) {
          peer.state.speaking = false;
          this.broadcastChannel(peer.state.channel, 'activeSpeaker', { peerId: peer.id, volume: null });
        }
      }
    });

    this.#audioLevelObserver.on('silence', () => {
      for (const peer of this.#peers.values()) {
        if (peer.state.speaking) {
          peer.state.speaking = false;
          this.broadcastChannel(peer.state.channel, 'activeSpeaker', { peerId: peer.id, volume: null });
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

    const canalDoQueSaiu = peer.state.channel;

    peer.close();
    this.#peers.delete(peerId);
    this.#log.info(`${peer.displayName} saiu (${this.#peers.size}/${config.maxPeersPerRoom})`);

    this.broadcast('peerLeft', { peerId });

    // Sub-sala que ficou vazia deixa de existir (o 'principal' nunca some).
    this.#limparCanalSeVazio(canalDoQueSaiu);

    if (this.#peers.size === 0) {
      this.#log.info('Sala vazia; router será fechado para liberar recursos.');
      // A partir de agora conta o prazo para a sala ser apagada de vez.
      salas.marcarVazia(this.id);
      this.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Sub-salas (canais de voz / breakout)
  // ---------------------------------------------------------------------------

  /** Lista de canais com a contagem de gente em cada um. */
  channelsSummary() {
    const contagem = new Map();
    for (const peer of this.#peers.values()) {
      const c = peer.state.channel;
      contagem.set(c, (contagem.get(c) ?? 0) + 1);
    }
    return [...this.#channels.values()].map((canal) => ({
      id: canal.id,
      nome: canal.nome,
      fixo: canal.fixo,
      count: contagem.get(canal.id) ?? 0,
    }));
  }

  #emitirCanais() {
    this.broadcast('canaisUpdate', { canais: this.channelsSummary() });
  }

  /** Producers de todo mundo (menos `exceptPeerId`) que estão num canal. */
  #producersDoCanal(canalId, exceptPeerId) {
    const lista = [];
    for (const peer of this.#peers.values()) {
      if (peer.id === exceptPeerId || peer.state.channel !== canalId) continue;
      for (const producer of peer.producers.values()) {
        lista.push({
          peerId: peer.id,
          producerId: producer.id,
          kind: producer.kind,
          source: producer.appData?.source ?? 'unknown',
        });
      }
    }
    return lista;
  }

  /** Fecha, no `holder`, os consumers que puxam mídia de `producerPeerId`. */
  #pararDeConsumirDe(holder, producerPeerId) {
    for (const consumer of [...holder.consumers.values()]) {
      if (consumer.appData?.peerId !== producerPeerId) continue;
      try {
        consumer.close();
      } catch {
        /* já fechado */
      }
      holder.consumers.delete(consumer.id);
      this.send(holder, 'consumerClosed', { consumerId: consumer.id });
    }
  }

  #limparCanalSeVazio(canalId) {
    if (!canalId || canalId === CANAL_PRINCIPAL) return;
    const canal = this.#channels.get(canalId);
    if (!canal || canal.fixo) return;
    const aindaTemGente = [...this.#peers.values()].some((p) => p.state.channel === canalId);
    if (aindaTemGente) return;
    this.#channels.delete(canalId);
    this.#emitirCanais();
  }

  criarCanal(peer, nomeBruto) {
    const nome = String(nomeBruto ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (!nome) throw new Error('Dê um nome para a sub-sala');
    if (this.#channels.size >= MAX_CANAIS) {
      throw new Error(`Limite de ${MAX_CANAIS} sub-salas atingido`);
    }

    const id = `c-${randomUUID().slice(0, 8)}`;
    this.#channels.set(id, { id, nome, fixo: false });
    this.#log.info(`${peer.displayName} criou a sub-sala "${nome}"`);
    this.#emitirCanais();
    return { id, nome };
  }

  /**
   * Move a pessoa para outro canal. A mídia dela é recortada do canal antigo e
   * costurada no novo: quem ficou para trás para de ouvi-la, quem está no destino
   * passa a ouvi-la, e ela mesma troca tudo o que consome.
   */
  entrarCanal(peer, canalId) {
    if (!this.#channels.has(canalId)) throw new Error('Essa sub-sala não existe mais');

    const canalAntigo = peer.state.channel;
    if (canalAntigo === canalId) {
      // Idempotente: devolve o que já dá para consumir aqui.
      return { canal: canalId, producers: this.#producersDoCanal(canalId, peer.id) };
    }

    // 1) A própria pessoa larga tudo o que consumia no canal antigo.
    for (const consumer of [...peer.consumers.values()]) {
      try {
        consumer.close();
      } catch {
        /* já fechado */
      }
      peer.consumers.delete(consumer.id);
      this.send(peer, 'consumerClosed', { consumerId: consumer.id });
    }

    // 2) Quem ficou no canal antigo para de puxar a mídia de quem saiu.
    for (const outro of this.#peers.values()) {
      if (outro.id === peer.id || outro.state.channel !== canalAntigo) continue;
      this.#pararDeConsumirDe(outro, peer.id);
    }

    // 3) Efetiva a troca.
    peer.state.channel = canalId;

    // 4) Quem já está no destino passa a receber a mídia da pessoa que chegou.
    for (const outro of this.#peers.values()) {
      if (outro.id === peer.id || outro.state.channel !== canalId) continue;
      for (const producer of peer.producers.values()) {
        this.send(outro, 'newProducer', {
          peerId: peer.id,
          producerId: producer.id,
          kind: producer.kind,
          source: producer.appData?.source ?? 'unknown',
        });
      }
    }

    // 5) Todo mundo atualiza onde a pessoa está; some com o canal antigo se esvaziou.
    this.broadcast('peerUpdated', { peerId: peer.id, state: peer.state });
    this.#limparCanalSeVazio(canalAntigo);
    this.#emitirCanais();

    this.#log.info(`${peer.displayName} foi para a sub-sala "${this.#channels.get(canalId)?.nome}"`);

    // Devolve para a própria pessoa a lista de producers que ela deve consumir agora.
    return { canal: canalId, producers: this.#producersDoCanal(canalId, peer.id) };
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

    // Avisa quem está no MESMO canal para pedir um consumer deste producer novo.
    this.broadcastChannel(
      peer.state.channel,
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

    // Isolamento das sub-salas: só se consome mídia de quem está no mesmo canal.
    if (producerPeer.state.channel !== peer.state.channel) {
      throw new Error('Este producer está em outra sub-sala');
    }

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

  /** Como broadcast, mas só para quem está num canal (sub-sala) específico. */
  broadcastChannel(channelId, method, data, exceptPeerId = null) {
    for (const peer of this.#peers.values()) {
      if (peer.id === exceptPeerId || peer.state.channel !== channelId) continue;
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
