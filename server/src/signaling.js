import { WebSocketServer } from 'ws';
import { config, siteBaseUrl } from './config.js';
import { createLogger } from './lib/logger.js';
import { wrapSocket } from './lib/rpc.js';
import { Room } from './room.js';
import { Peer } from './peer.js';
import { salas, idDeSala } from './room-registry.js';
import { convites } from './invites.js';
import { arquivos } from './arquivos.js';

const log = createLogger('signaling');

/** Quantas pessoas estão agora numa sala (0 se o router nem foi criado). */
function contarPessoas(roomId) {
  return Room.get(roomId)?.peerCount ?? 0;
}

/**
 * O mediasoup roda os consumers num processo separado (worker). Quando o
 * producer morre, o worker apaga o handler antes do objeto aqui do lado
 * marcar `closed`. Nessa fresta a chamada volta com "handler not found" —
 * é a corrida normal de quem parou de transmitir, não um defeito.
 */
function sumiuNoWorker(error) {
  return /handler with ID .* not found|Channel closed|Channel ended/i.test(String(error?.message ?? ''));
}

function sanitizeDisplayName(raw) {
  // Remove caracteres de controle (inclusive quebras de linha) e normaliza espacos.
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  if (!name) throw new Error('Escolha um nome de exibição');
  return name;
}

function sanitizeRoomId(raw) {
  return idDeSala(raw ?? config.defaultRoom) || idDeSala(config.defaultRoom) || 'geral';
}

/**
 * Estado por conexão antes/depois do join. Guardado fora do Peer porque
 * a conexão existe antes de virar participante.
 */
class Session {
  constructor(connection) {
    this.connection = connection;
    /** @type {Room|null} */
    this.room = null;
    /** @type {Peer|null} */
    this.peer = null;
    this.chatTimestamps = [];
    /** Tentativas de senha erradas nesta conexão. */
    this.tentativasFalhas = 0;
  }

  /**
   * Freia ataque de força bruta: cada erro de senha atrasa a próxima resposta,
   * e depois de 10 erros a conexão para de aceitar tentativas.
   */
  async penalizarSenhaErrada() {
    this.tentativasFalhas += 1;
    if (this.tentativasFalhas > 10) {
      throw new Error('Muitas tentativas. Feche o aplicativo e tente de novo.');
    }
    const espera = Math.min(2000, 150 * this.tentativasFalhas);
    await new Promise((resolve) => setTimeout(resolve, espera));
  }

  requirePeer() {
    if (!this.peer || !this.room) throw new Error('Você ainda não entrou na sala');
    return { peer: this.peer, room: this.room };
  }

  /** Anti-flood bem simples: no máximo 10 mensagens a cada 10 segundos. */
  checkChatRate() {
    const now = Date.now();
    this.chatTimestamps = this.chatTimestamps.filter((t) => now - t < 10_000);
    if (this.chatTimestamps.length >= 10) {
      throw new Error('Calma lá: muitas mensagens em pouco tempo');
    }
    this.chatTimestamps.push(now);
  }
}

const handlers = {
  /**
   * Vitrine da tela de entrada. Não exige senha: mostra só nome e quantas
   * pessoas tem em cada sala, o que não dá acesso a nada.
   */
  async listarSalas() {
    return {
      salas: salas.listar(contarPessoas),
      maxRooms: config.maxRooms,
      maxPeers: config.maxPeersPerRoom,
    };
  },

  /**
   * Cria uma sala nova com senha própria. Quem tem o aplicativo pode criar —
   * o controle de quem chega aqui é a distribuição do instalador.
   */
  async criarSala(session, data) {
    const sala = salas.criar({
      nome: data.nome,
      senha: data.senha,
      criadaPor: String(data.displayName ?? '').slice(0, 32),
    });

    log.info(`Sala "${sala.id}" cadastrada (${salas.total}/${config.maxRooms})`);
    return sala;
  },

  /**
   * Lê um convite antes de entrar: o app precisa saber para qual sala o link
   * aponta (e mostrar o nome dela) antes de carregar o device do mediasoup.
   */
  async verConvite(session, data) {
    const convite = convites.resolver(data.token);
    if (!convite) throw new Error('Este convite expirou ou não existe mais');

    const sala = salas.obter(convite.roomId);
    if (!sala) throw new Error('A sala deste convite não existe mais');

    return {
      roomId: sala.id,
      nome: sala.nome,
      pessoas: contarPessoas(sala.id),
      expiraEm: convite.expiraEm,
    };
  },

  /** Gera (ou reaproveita) o link de convite da sala em que a pessoa está. */
  async criarConvite(session) {
    const { peer, room } = session.requirePeer();
    const convite = convites.criar({ roomId: room.id, criadoPor: peer.displayName });

    return {
      token: convite.token,
      url: `${siteBaseUrl}/c/${convite.token}`,
      expiraEm: convite.expiraEm,
    };
  },

  async join(session, data) {
    if (session.peer) throw new Error('Esta conexão já está em uma sala');

    const displayName = sanitizeDisplayName(data.displayName);

    // Com convite, a sala vem do próprio token: o cliente não escolhe.
    let roomId;
    let sala;

    if (data.convite) {
      const convite = convites.resolver(data.convite);
      if (!convite) throw new Error('Este convite expirou ou não existe mais');

      roomId = convite.roomId;
      sala = salas.obter(roomId);
      if (!sala) throw new Error('A sala deste convite não existe mais');
    } else {
      roomId = sanitizeRoomId(data.roomId);
      try {
        sala = salas.autenticar(roomId, data.password);
      } catch (error) {
        await session.penalizarSenhaErrada();
        throw error;
      }
    }

    const room = await Room.getOrCreate(roomId);

    if (room.isFull) {
      throw new Error(`A sala está cheia (${config.maxPeersPerRoom} pessoas)`);
    }

    const peer = new Peer({ socket: session.connection, displayName });
    peer.rtpCapabilities = data.rtpCapabilities ?? null;

    room.addPeer(peer);
    session.room = room;
    session.peer = peer;

    return {
      peerId: peer.id,
      roomId: room.id,
      roomName: sala.nome,
      maxPeers: config.maxPeersPerRoom,
      routerRtpCapabilities: room.router.rtpCapabilities,
      peers: room.listPeers(peer.id),
      chatHistory: room.chatHistory(),
    };
  },

  async getRouterRtpCapabilities(session, data) {
    const roomId = sanitizeRoomId(data.roomId);
    // Só cria router para sala cadastrada: senão qualquer conexão anônima
    // conseguiria gastar memória do servidor inventando nomes de sala.
    if (!salas.existe(roomId)) throw new Error('Sala não encontrada');
    const room = await Room.getOrCreate(roomId);
    return { routerRtpCapabilities: room.router.rtpCapabilities };
  },

  async setRtpCapabilities(session, data) {
    const { peer } = session.requirePeer();
    if (!data.rtpCapabilities) throw new Error('rtpCapabilities ausentes');
    peer.rtpCapabilities = data.rtpCapabilities;
    return { ok: true };
  },

  async createWebRtcTransport(session, data) {
    const { peer, room } = session.requirePeer();
    const direction = data.direction === 'recv' ? 'recv' : 'send';
    return room.createWebRtcTransport(peer, direction);
  },

  async connectWebRtcTransport(session, data) {
    const { peer } = session.requirePeer();
    const transport = peer.getTransport(data.transportId);
    await transport.connect({ dtlsParameters: data.dtlsParameters });
    return { ok: true };
  },

  async produce(session, data) {
    const { peer, room } = session.requirePeer();
    return room.createProducer(peer, {
      transportId: data.transportId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
      appData: data.appData ?? {},
    });
  },

  async closeProducer(session, data) {
    const { peer } = session.requirePeer();
    const producer = peer.producers.get(data.producerId);
    if (producer) producer.close();
    return { ok: true };
  },

  async pauseProducer(session, data) {
    const { peer } = session.requirePeer();
    const producer = peer.producers.get(data.producerId);
    if (producer) await producer.pause();
    return { ok: true };
  },

  async resumeProducer(session, data) {
    const { peer } = session.requirePeer();
    const producer = peer.producers.get(data.producerId);
    if (producer) await producer.resume();
    return { ok: true };
  },

  async consume(session, data) {
    const { peer, room } = session.requirePeer();
    return room.createConsumer(peer, {
      producerId: data.producerId,
      transportId: data.transportId,
    });
  },

  async resumeConsumer(session, data) {
    const { peer } = session.requirePeer();
    const consumer = peer.consumers.get(data.consumerId);
    // Corrida normal: quem estava produzindo parou (fechou a tela, saiu da
    // sala) entre o consume() e o resume(). Não é erro — só não há mais o que
    // despausar, e o cliente joga o consumer fora ao ver "fechado".
    if (!consumer || consumer.closed) return { ok: false, fechado: true };
    try {
      await consumer.resume();
    } catch (error) {
      // O objeto ainda dizia "aberto" aqui, mas o worker já tinha derrubado o
      // handler dele (o producer morreu no meio do caminho). É a mesma corrida
      // de cima, só que percebida um pouco depois — segue não sendo erro.
      if (consumer.closed || sumiuNoWorker(error)) return { ok: false, fechado: true };
      throw error;
    }
    return { ok: true };
  },

  async pauseConsumer(session, data) {
    const { peer } = session.requirePeer();
    const consumer = peer.consumers.get(data.consumerId);
    if (!consumer || consumer.closed) return { ok: true };
    try {
      await consumer.pause();
    } catch (error) {
      if (!consumer.closed && !sumiuNoWorker(error)) throw error;
    }
    return { ok: true };
  },

  async setConsumerPreferredLayers(session, data) {
    const { peer } = session.requirePeer();
    const consumer = peer.consumers.get(data.consumerId);
    if (!consumer) throw new Error(`Consumer ${data.consumerId} não encontrado`);
    await consumer.setPreferredLayers({
      spatialLayer: data.spatialLayer,
      temporalLayer: data.temporalLayer,
    });
    return { ok: true };
  },

  async setState(session, data) {
    const { peer, room } = session.requirePeer();
    if (typeof data.micMuted === 'boolean') peer.state.micMuted = data.micMuted;
    if (typeof data.deafened === 'boolean') peer.state.deafened = data.deafened;
    room.broadcast('peerUpdated', { peerId: peer.id, state: peer.state });
    return { state: peer.state };
  },

  async chat(session, data) {
    const { peer, room } = session.requirePeer();
    session.checkChatRate();
    return room.postChatMessage(peer, data.text);
  },

  /**
   * Autoriza o envio de um arquivo. O upload em si vai por HTTP, com o ticket
   * devolvido aqui — o WebSocket não é caminho para megabytes.
   */
  async pedirEnvioDeArquivo(session, data) {
    const { peer, room } = session.requirePeer();
    session.checkChatRate();

    const ticket = arquivos.criarTicket({
      roomId: room.id,
      peerId: peer.id,
      displayName: peer.displayName,
      nome: data.nome,
      tamanho: data.tamanho,
      tipo: data.tipo,
    });

    return {
      url: `${siteBaseUrl}/arquivo?t=${encodeURIComponent(ticket.ticket)}`,
      nome: ticket.nome,
      maxBytes: config.arquivoMaxBytes,
      validadeHoras: Math.round(config.arquivoTtlMs / 3_600_000),
    };
  },

  // ---------------------------------------------------------------------------
  // Tibia: timers de hunt
  // ---------------------------------------------------------------------------

  async tibiaGetState(session) {
    const { room } = session.requirePeer();
    return room.tibiaState();
  },

  async timerStart(session, data) {
    const { peer, room } = session.requirePeer();
    return room.startTimer(peer, data.id);
  },

  async timerStop(session, data) {
    const { peer, room } = session.requirePeer();
    return room.stopTimer(peer, data.id);
  },

  async timerAdd(session, data) {
    const { peer, room } = session.requirePeer();
    return room.addTimer(peer, {
      nome: data.nome,
      dur: data.dur,
      repete: data.repete,
      cor: data.cor,
    });
  },

  async timerRemove(session, data) {
    const { peer, room } = session.requirePeer();
    return room.removeTimer(peer, data.id);
  },

  // ---------------------------------------------------------------------------
  // Modo DJ
  // ---------------------------------------------------------------------------

  async djGetState(session) {
    const { room } = session.requirePeer();
    return room.djState();
  },

  async djClaim(session) {
    const { peer, room } = session.requirePeer();
    return room.claimDj(peer);
  },

  async djRelease(session) {
    const { peer, room } = session.requirePeer();
    return room.releaseDj(peer);
  },

  async djUpdate(session, data) {
    const { peer, room } = session.requirePeer();
    return room.updateDj(peer, data);
  },

  async djCommand(session, data) {
    const { peer, room } = session.requirePeer();
    return room.djCommand(peer, data.acao);
  },

  async getRoomInfo(session) {
    const { room } = session.requirePeer();
    return room.summary();
  },

  async getStats(session) {
    const { peer } = session.requirePeer();
    const stats = [];
    for (const producer of peer.producers.values()) {
      stats.push({ type: 'producer', source: producer.appData?.source, stats: await producer.getStats() });
    }
    return { stats };
  },
};

export function attachSignaling(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 512 * 1024 });

  // Heartbeat: derruba sockets zumbis que não responderam ao ping.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket já indo embora */
      }
    }
  }, 20_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const remote = req.socket.remoteAddress;
    log.info(`Nova conexão de ${remote}`);

    let session;

    const connection = wrapSocket(ws, {
      onRequest: async (method, data) => {
        const handler = handlers[method];
        if (!handler) throw new Error(`Método desconhecido: "${method}"`);
        return handler(session, data);
      },
      onClose: () => {
        if (session?.room && session.peer) {
          session.room.removePeer(session.peer.id);
        }
        log.info(`Conexão de ${remote} encerrada`);
      },
    });

    session = new Session(connection);
  });

  log.info('Sinalização WebSocket ativa em /ws');
  return wss;
}
