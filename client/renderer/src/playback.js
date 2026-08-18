/**
 * Reprodução de áudio remoto. Cada consumer de áudio ganha um <audio> próprio,
 * o que permite volume individual por pessoa e troca de saída (setSinkId).
 */
export class AudioPlayback {
  #elements = new Map(); // consumerId -> HTMLAudioElement
  #peerVolumes = new Map(); // peerId -> 0..1
  #peerMuted = new Set(); // peerIds silenciados só pra mim (mudo local)
  #consumerVolumes = new Map(); // consumerId -> 0..1 (ex.: áudio da tela)
  #consumerMuted = new Set(); // consumerIds silenciados só pra mim
  #outputDeviceId = 'default';
  #deafened = false;
  #masterVolume = 1;

  add(consumerId, peerId, track) {
    this.remove(consumerId);

    const element = document.createElement('audio');
    element.autoplay = true;
    element.dataset.peerId = peerId;
    element.dataset.consumerId = consumerId;
    element.srcObject = new MediaStream([track]);
    element.volume = this.#volumeFor(peerId, consumerId);
    element.muted = this.#mutedFor(peerId, consumerId);

    // Elementos ficam fora da tela; existem só para tocar o audio.
    element.style.display = 'none';
    document.body.append(element);

    this.#applySink(element);

    element.play().catch((error) => {
      console.warn('[playback] autoplay bloqueado, tentando de novo após interacao:', error.message);
      const retry = () => {
        element.play().catch(() => {});
        document.removeEventListener('click', retry);
      };
      document.addEventListener('click', retry, { once: true });
    });

    this.#elements.set(consumerId, element);
    return element;
  }

  remove(consumerId) {
    const element = this.#elements.get(consumerId);
    if (!element) return;

    element.srcObject = null;
    element.remove();
    this.#elements.delete(consumerId);
  }

  removeByPeer(peerId) {
    for (const [consumerId, element] of this.#elements) {
      if (element.dataset.peerId === peerId) this.remove(consumerId);
    }
  }

  #volumeFor(peerId, consumerId) {
    const individual = this.#peerVolumes.get(peerId) ?? 1;
    const doConsumer = consumerId != null ? this.#consumerVolumes.get(consumerId) ?? 1 : 1;
    return Math.max(0, Math.min(1, individual * doConsumer * this.#masterVolume));
  }

  #applyVolume(element) {
    element.volume = this.#volumeFor(element.dataset.peerId, element.dataset.consumerId);
    element.muted = this.#mutedFor(element.dataset.peerId, element.dataset.consumerId);
  }

  setPeerVolume(peerId, volume) {
    this.#peerVolumes.set(peerId, volume);
    for (const element of this.#elements.values()) {
      if (element.dataset.peerId === peerId) this.#applyVolume(element);
    }
  }

  getPeerVolume(peerId) {
    return this.#peerVolumes.get(peerId) ?? 1;
  }

  /** Volume de um consumer específico (ex.: o áudio da tela compartilhada). */
  setConsumerVolume(consumerId, volume) {
    this.#consumerVolumes.set(consumerId, Math.max(0, Math.min(1, volume)));
    const element = this.#elements.get(consumerId);
    if (element) this.#applyVolume(element);
  }

  getConsumerVolume(consumerId) {
    return this.#consumerVolumes.get(consumerId) ?? 1;
  }

  setConsumerMuted(consumerId, muted) {
    if (muted) this.#consumerMuted.add(consumerId);
    else this.#consumerMuted.delete(consumerId);
    const element = this.#elements.get(consumerId);
    if (element) this.#applyVolume(element);
  }

  isConsumerMuted(consumerId) {
    return this.#consumerMuted.has(consumerId);
  }

  setMasterVolume(volume) {
    this.#masterVolume = Math.max(0, Math.min(1, volume));
    for (const element of this.#elements.values()) this.#applyVolume(element);
  }

  /** Combina o "silenciar tudo" (deafen) com o mudo local daquela pessoa/consumer. */
  #mutedFor(peerId, consumerId) {
    return (
      this.#deafened ||
      this.#peerMuted.has(peerId) ||
      (consumerId != null && this.#consumerMuted.has(consumerId))
    );
  }

  setDeafened(deafened) {
    this.#deafened = deafened;
    for (const element of this.#elements.values()) this.#applyVolume(element);
  }

  /** Mudo local: só afeta o que EU ouço daquela pessoa. */
  setPeerMuted(peerId, muted) {
    if (muted) this.#peerMuted.add(peerId);
    else this.#peerMuted.delete(peerId);
    for (const element of this.#elements.values()) {
      if (element.dataset.peerId === peerId) this.#applyVolume(element);
    }
  }

  isPeerMuted(peerId) {
    return this.#peerMuted.has(peerId);
  }

  async #applySink(element) {
    if (this.#outputDeviceId === 'default' || typeof element.setSinkId !== 'function') return;
    try {
      await element.setSinkId(this.#outputDeviceId);
    } catch (error) {
      console.warn('[playback] não consegui trocar a saída de áudio:', error.message);
    }
  }

  async setOutputDevice(deviceId) {
    this.#outputDeviceId = deviceId || 'default';
    await Promise.all([...this.#elements.values()].map((element) => this.#applySink(element)));
  }

  clear() {
    for (const consumerId of [...this.#elements.keys()]) this.remove(consumerId);
  }
}

/**
 * Medidor de nível do próprio microfone, para acender o anel do seu avatar
 * sem depender de um round-trip até o servidor.
 */
export class MicLevelMeter {
  #context = null;
  #analyser = null;
  #source = null;
  #raf = null;
  #data = null;

  start(stream, onLevel) {
    this.stop();
    if (!stream) return;

    this.#context = new AudioContext();
    this.#source = this.#context.createMediaStreamSource(stream);
    this.#analyser = this.#context.createAnalyser();
    this.#analyser.fftSize = 512;
    this.#analyser.smoothingTimeConstant = 0.6;
    this.#source.connect(this.#analyser);

    this.#data = new Uint8Array(this.#analyser.frequencyBinCount);

    const tick = () => {
      this.#analyser.getByteFrequencyData(this.#data);

      let sum = 0;
      for (const value of this.#data) sum += value * value;
      const rms = Math.sqrt(sum / this.#data.length) / 255;

      onLevel(Math.min(1, rms * 3));
      this.#raf = requestAnimationFrame(tick);
    };

    this.#raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = null;

    try {
      this.#source?.disconnect();
      this.#context?.close();
    } catch {
      /* já fechado */
    }

    this.#context = null;
    this.#analyser = null;
    this.#source = null;
  }
}
