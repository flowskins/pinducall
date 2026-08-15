import { Emitter } from './emitter.js';

/**
 * Modo DJ: uma pessoa toca música do próprio PC e todo mundo da sala ouve.
 *
 * O caminho do áudio é montado no WebAudio, e não com `audio.captureStream()`,
 * por um motivo prático: trocar a `src` do elemento encerra a faixa capturada,
 * o que obrigaria a renegociar o WebRTC a cada música. Com o grafo abaixo, a
 * faixa enviada é sempre a mesma — a música muda por baixo dela.
 *
 *   <audio> ──▶ fonte ──┬──▶ ganho local ───▶ alto-falante do DJ
 *                       └──▶ ganho da call ─▶ destino de stream ─▶ WebRTC
 *
 * O ganho local é só para o DJ: ele pode abaixar a música no fone dele sem
 * mudar o volume de quem está ouvindo pela call.
 *
 * Eventos: 'state' ({ faixa, tocando, indice, total }), 'error' (Error).
 */
export class DjPlayer extends Emitter {
  #audio = null;
  #ctx = null;
  #ganhoLocal = null;
  #ganhoCall = null;
  #destino = null;
  #track = null;

  /** @type {{nome: string, url: string}[]} */
  #playlist = [];
  #indice = 0;
  #ativo = false;

  get track() {
    return this.#track;
  }

  get ativo() {
    return this.#ativo;
  }

  get playlist() {
    return this.#playlist;
  }

  get indice() {
    return this.#indice;
  }

  get tocando() {
    return Boolean(this.#audio && !this.#audio.paused && !this.#audio.ended);
  }

  get faixaAtual() {
    return this.#playlist[this.#indice]?.nome ?? null;
  }

  /** Monta o grafo de áudio e devolve a faixa para publicar no WebRTC. */
  iniciar() {
    if (this.#ativo) return this.#track;

    this.#audio = new Audio();
    this.#audio.preload = 'auto';

    this.#ctx = new AudioContext();
    const fonte = this.#ctx.createMediaElementSource(this.#audio);

    this.#ganhoLocal = this.#ctx.createGain();
    this.#ganhoCall = this.#ctx.createGain();
    this.#destino = this.#ctx.createMediaStreamDestination();

    fonte.connect(this.#ganhoLocal);
    fonte.connect(this.#ganhoCall);
    this.#ganhoLocal.connect(this.#ctx.destination);
    this.#ganhoCall.connect(this.#destino);

    this.#track = this.#destino.stream.getAudioTracks()[0] ?? null;
    this.#ativo = true;

    this.#audio.addEventListener('ended', () => this.proxima());
    this.#audio.addEventListener('play', () => this.#emitirEstado());
    this.#audio.addEventListener('pause', () => this.#emitirEstado());
    this.#audio.addEventListener('error', () => {
      this.emit('error', new Error(`Não consegui tocar "${this.faixaAtual ?? 'a faixa'}"`));
      this.proxima();
    });

    return this.#track;
  }

  #emitirEstado() {
    this.emit('state', {
      faixa: this.faixaAtual,
      tocando: this.tocando,
      indice: this.#indice,
      total: this.#playlist.length,
    });
  }

  /** Acrescenta arquivos escolhidos pela pessoa (File[] do input). */
  adicionar(files) {
    const novos = [...files]
      .filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|ogg|wav|flac|opus|aac)$/i.test(f.name))
      .map((f) => ({
        nome: f.name.replace(/\.[^.]+$/, '').slice(0, 80),
        url: URL.createObjectURL(f),
      }));

    if (!novos.length) return 0;

    const vazia = this.#playlist.length === 0;
    this.#playlist.push(...novos);
    if (vazia) this.#carregar(0);

    this.#emitirEstado();
    return novos.length;
  }

  #carregar(indice) {
    if (!this.#playlist.length) return;

    this.#indice = ((indice % this.#playlist.length) + this.#playlist.length) % this.#playlist.length;
    this.#audio.src = this.#playlist[this.#indice].url;
    this.#audio.load();
  }

  async tocar() {
    if (!this.#playlist.length) throw new Error('Escolha as músicas primeiro');

    // Um contexto criado antes de qualquer clique nasce suspenso.
    if (this.#ctx.state === 'suspended') await this.#ctx.resume();
    if (!this.#audio.src) this.#carregar(this.#indice);

    await this.#audio.play();
    this.#emitirEstado();
  }

  pausar() {
    this.#audio?.pause();
    this.#emitirEstado();
  }

  alternar() {
    return this.tocando ? Promise.resolve(this.pausar()) : this.tocar();
  }

  parar() {
    if (!this.#audio) return;
    this.#audio.pause();
    this.#audio.currentTime = 0;
    this.#emitirEstado();
  }

  async proxima() {
    if (!this.#playlist.length) return;
    const estavaTocando = this.tocando || this.#audio.ended;
    this.#carregar(this.#indice + 1);
    if (estavaTocando) await this.tocar().catch(() => {});
    else this.#emitirEstado();
  }

  async anterior() {
    if (!this.#playlist.length) return;

    // Como em qualquer player: se já passou de 3s, volta para o início da faixa.
    if (this.#audio.currentTime > 3) {
      this.#audio.currentTime = 0;
      return;
    }

    const estavaTocando = this.tocando;
    this.#carregar(this.#indice - 1);
    if (estavaTocando) await this.tocar().catch(() => {});
    else this.#emitirEstado();
  }

  async irPara(indice) {
    this.#carregar(indice);
    await this.tocar().catch(() => {});
  }

  /** Volume que só o DJ ouve. */
  setVolumeLocal(v) {
    if (this.#ganhoLocal) this.#ganhoLocal.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Volume que vai para a call. */
  setVolumeCall(v) {
    if (this.#ganhoCall) this.#ganhoCall.gain.value = Math.max(0, Math.min(1, v));
  }

  encerrar() {
    try {
      this.#audio?.pause();
      this.#track?.stop();
      this.#ctx?.close();
    } catch {
      /* já encerrado */
    }

    for (const item of this.#playlist) URL.revokeObjectURL(item.url);

    this.#playlist = [];
    this.#indice = 0;
    this.#audio = null;
    this.#ctx = null;
    this.#track = null;
    this.#ativo = false;
    this.#emitirEstado();
  }
}
