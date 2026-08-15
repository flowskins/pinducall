import { randomUUID } from 'node:crypto';

/**
 * Representa uma pessoa conectada: seu socket, seus transports do mediasoup,
 * o que ela esta publicando (mic/tela) e o que ela esta recebendo.
 */
export class Peer {
  constructor({ socket, displayName }) {
    this.id = randomUUID();
    this.socket = socket;
    this.displayName = displayName;
    this.joinedAt = Date.now();

    /** Capacidades RTP declaradas pelo cliente (necessárias para criar consumers). */
    this.rtpCapabilities = null;

    /** @type {Map<string, import('mediasoup/node/lib/types').WebRtcTransport>} */
    this.transports = new Map();
    /** @type {Map<string, import('mediasoup/node/lib/types').Producer>} */
    this.producers = new Map();
    /** @type {Map<string, import('mediasoup/node/lib/types').Consumer>} */
    this.consumers = new Map();

    this.state = {
      micMuted: false,
      deafened: false,
      screenSharing: false,
      speaking: false,
      // { emoji, color } escolhido pela pessoa; null = usa iniciais + cor do id.
      avatar: null,
    };

    this.closed = false;
  }

  /** Dados públicos enviados para os outros participantes. */
  toPublic() {
    return {
      id: this.id,
      displayName: this.displayName,
      joinedAt: this.joinedAt,
      state: { ...this.state },
      producers: [...this.producers.values()].map((producer) => ({
        id: producer.id,
        kind: producer.kind,
        source: producer.appData?.source ?? 'unknown',
        paused: producer.paused,
      })),
    };
  }

  getTransport(transportId) {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error(`Transport ${transportId} não encontrado`);
    return transport;
  }

  addTransport(transport) {
    this.transports.set(transport.id, transport);
    transport.observer.once('close', () => this.transports.delete(transport.id));
  }

  addProducer(producer) {
    this.producers.set(producer.id, producer);
    producer.observer.once('close', () => this.producers.delete(producer.id));
  }

  addConsumer(consumer) {
    this.consumers.set(consumer.id, consumer);
    consumer.observer.once('close', () => this.consumers.delete(consumer.id));
  }

  /** Producer de uma fonte especifica ('mic', 'screen', 'screen-audio'). */
  findProducerBySource(source) {
    return [...this.producers.values()].find((producer) => producer.appData?.source === source);
  }

  close() {
    if (this.closed) return;
    this.closed = true;

    // Fechar os transports derruba producers e consumers em cascata.
    for (const transport of this.transports.values()) {
      try {
        transport.close();
      } catch {
        /* já fechado */
      }
    }

    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }
}
