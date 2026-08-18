import * as mediasoupClient from 'mediasoup-client';
import { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import { Emitter } from './emitter.js';
import { Signaling } from './signaling.js';

/**
 * Camadas de simulcast do compartilhamento de tela.
 * Precisa bater com o que o servidor espera em sfu/codecs.js.
 */
const SCREEN_ENCODINGS = [
  { rid: 'r0', maxBitrate: 600_000, scaleResolutionDownBy: 4 },
  { rid: 'r1', maxBitrate: 2_000_000, scaleResolutionDownBy: 2 },
  // Camada cheia (1080p): bem mais banda para o texto do jogo ficar nítido.
  { rid: 'r2', maxBitrate: 6_000_000, scaleResolutionDownBy: 1 },
];

/**
 * Orquestra tudo do lado do cliente: sinalização, device do mediasoup,
 * transports, producers (mic/tela) e consumers (o que vem dos outros).
 *
 * Eventos:
 *   'joined'        { peerId, roomId, peers, chatHistory, maxPeers }
 *   'peerJoined'    peer
 *   'peerLeft'      { peerId }
 *   'peerUpdated'   { peerId, state }
 *   'chat'          message
 *   'track'         { peerId, source, kind, track, consumerId }
 *   'trackEnded'    { consumerId }
 *   'speaking'      { peerId, volume }
 *   'localState'    { micMuted, deafened, screenSharing }
 *   'disconnected'  { reason }
 *   'warning'       string
 */
export class RoomClient extends Emitter {
  /** Cadeia de áudio da redução de ruído ativa: { ctx, source, node, dest }. */
  #ruido = null;
  /** wasm + URL do worklet do RNNoise, carregados uma única vez. */
  #ruidoAssets = null;

  constructor() {
    super();
    this.signaling = new Signaling();
    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;

    this.peerId = null;
    this.roomId = null;
    /** Sub-sala (canal de voz) em que estou agora. */
    this.channel = 'principal';

    this.micProducer = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;
    this.musicProducer = null;

    /** @type {Map<string, import('mediasoup-client').types.Consumer>} */
    this.consumers = new Map();

    this.localStream = null;
    this.screenStream = null;

    this.state = { micMuted: false, deafened: false, screenSharing: false };
    this.audioConstraints = {};

    // Redução de ruído (RNNoise). A cadeia de áudio ativa e os assets carregados
    // ficam em campos privados (#ruido / #ruidoAssets).
    this.reducaoRuido = false;
    this.micDeviceId = 'default';

    this.#wireSignaling();
  }

  #wireSignaling() {
    this.signaling.on('notify:peerJoined', ({ peer }) => this.emit('peerJoined', peer));
    this.signaling.on('notify:peerLeft', (data) => this.emit('peerLeft', data));
    this.signaling.on('notify:peerUpdated', (data) => this.emit('peerUpdated', data));
    this.signaling.on('notify:chatMessage', (message) => this.emit('chat', message));
    this.signaling.on('notify:activeSpeaker', (data) => this.emit('speaking', data));

    // Painel do Tibia: timers sincronizados e modo DJ.
    this.signaling.on('notify:tibiaUpdate', (data) => this.emit('tibiaUpdate', data));
    this.signaling.on('notify:tibiaLog', (data) => this.emit('tibiaLog', data));
    this.signaling.on('notify:timerFinished', (data) => this.emit('timerFinished', data));
    this.signaling.on('notify:djUpdate', (data) => this.emit('djUpdate', data));
    this.signaling.on('notify:djCommand', (data) => this.emit('djCommand', data));

    // Sub-salas: mudou a lista/contagem de canais.
    this.signaling.on('notify:canaisUpdate', (data) => this.emit('canais', data.canais ?? []));

    this.signaling.on('notify:newProducer', async ({ producerId }) => {
      try {
        await this.#consume(producerId);
      } catch (error) {
        console.error('[room] falha ao consumir producer novo:', error);
        this.emit('warning', `Não consegui receber a mídia de alguém: ${error.message}`);
      }
    });

    this.signaling.on('notify:consumerClosed', ({ consumerId }) => {
      const consumer = this.consumers.get(consumerId);
      consumer?.close();
      this.consumers.delete(consumerId);
      this.emit('trackEnded', { consumerId });
    });

    this.signaling.on('close', () => {
      this.emit('disconnected', { reason: 'A conexão com o servidor caiu' });
    });
  }

  // ---------------------------------------------------------------------------
  // Entrar / sair
  // ---------------------------------------------------------------------------

  /**
   * Entra na sala. Com `convite` a senha não é usada: o token já diz ao
   * servidor qual é a sala e que a pessoa pode entrar.
   */
  async join({ url, roomId, displayName, password, convite, audio = {}, avatar = null }) {
    this.audioConstraints = audio;
    this.reducaoRuido = Boolean(audio.reducaoRuido);
    this.state.avatar = avatar;

    await this.signaling.connect(url);

    const { routerRtpCapabilities } = await this.signaling.request('getRouterRtpCapabilities', {
      roomId,
    });

    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities });

    const result = await this.signaling.request('join', {
      roomId,
      displayName,
      password,
      convite,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    this.peerId = result.peerId;
    this.roomId = result.roomId;
    this.channel = 'principal';

    // Manda o avatar escolhido para os outros verem (o join nasce sem ele).
    if (this.state.avatar) {
      this.signaling.request('setState', { avatar: this.state.avatar }).catch(() => {});
    }

    await this.#createSendTransport();
    await this.#createRecvTransport();

    this.emit('joined', result);

    // Começa a receber quem já estava na sala — mas só quem está na MINHA sub-sala.
    for (const peer of result.peers) {
      if ((peer.state?.channel ?? 'principal') !== this.channel) continue;
      for (const producer of peer.producers ?? []) {
        try {
          await this.#consume(producer.id);
        } catch (error) {
          console.error('[room] falha ao consumir producer existente:', error);
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Sub-salas (canais de voz / breakout)
  // ---------------------------------------------------------------------------

  /** Cria uma sub-sala e já entra nela. */
  async criarCanal(nome) {
    const canal = await this.signaling.request('criarCanal', { nome });
    await this.entrarCanal(canal.id);
    return canal;
  }

  /**
   * Troca de sub-sala. O servidor derruba (via consumerClosed) tudo o que eu
   * consumia no canal antigo; aqui eu só passo a consumir a mídia do novo canal.
   */
  async entrarCanal(canalId) {
    const res = await this.signaling.request('entrarCanal', { canalId });
    this.channel = res.canal;

    for (const p of res.producers ?? []) {
      try {
        await this.#consume(p.producerId);
      } catch (error) {
        console.error('[room] falha ao consumir producer da sub-sala:', error);
      }
    }

    this.emit('canalEntrou', { canal: res.canal });
    return res;
  }

  async leave() {
    this.stopScreenShare().catch(() => {});
    this.pararMusica().catch(() => {});
    this.#stopMic();

    for (const consumer of this.consumers.values()) consumer.close();
    this.consumers.clear();

    try {
      this.sendTransport?.close();
      this.recvTransport?.close();
    } catch {
      /* já fechado */
    }

    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    this.peerId = null;

    this.signaling.close();
  }

  // ---------------------------------------------------------------------------
  // Transports
  // ---------------------------------------------------------------------------

  async #createSendTransport() {
    const params = await this.signaling.request('createWebRtcTransport', { direction: 'send' });
    this.sendTransport = this.device.createSendTransport({ ...params, iceServers: [] });

    this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.signaling
        .request('connectWebRtcTransport', { transportId: this.sendTransport.id, dtlsParameters })
        .then(callback)
        .catch(errback);
    });

    this.sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      this.signaling
        .request('produce', {
          transportId: this.sendTransport.id,
          kind,
          rtpParameters,
          appData,
        })
        .then(({ id }) => callback({ id }))
        .catch(errback);
    });

    this.sendTransport.on('connectionstatechange', (state) => {
      if (state === 'failed') {
        this.emit('warning', 'A conexão de envio de mídia falhou. Verifique firewall e portas UDP.');
      }
    });
  }

  async #createRecvTransport() {
    const params = await this.signaling.request('createWebRtcTransport', { direction: 'recv' });
    this.recvTransport = this.device.createRecvTransport({ ...params, iceServers: [] });

    this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.signaling
        .request('connectWebRtcTransport', { transportId: this.recvTransport.id, dtlsParameters })
        .then(callback)
        .catch(errback);
    });

    this.recvTransport.on('connectionstatechange', (state) => {
      if (state === 'failed') {
        this.emit('warning', 'A conexão de recepção de mídia falhou. Verifique firewall e portas UDP.');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Microfone
  // ---------------------------------------------------------------------------

  async startMic(deviceId = 'default') {
    if (this.micProducer && !this.micProducer.closed) return this.localStream;

    this.micDeviceId = deviceId;
    const { stream, track } = await this.#capturarMic(deviceId);
    this.localStream = stream;

    this.micProducer = await this.sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: false,
        opusDtx: true,
        opusFec: true,
        opusMaxPlaybackRate: 48000,
      },
      appData: { source: 'mic' },
    });

    this.micProducer.on('transportclose', () => {
      this.micProducer = null;
    });

    if (this.state.micMuted) {
      await this.micProducer.pause();
      for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = false;
    }

    return this.localStream;
  }

  /**
   * Abre o microfone e devolve { stream, track }. Com a redução de ruído ligada,
   * o `track` já é a saída limpa do RNNoise; senão é o track cru. `this.localStream`
   * guarda sempre o stream CRU — mutar corta a entrada, inclusive do RNNoise.
   */
  async #capturarMic(deviceId) {
    const constraints = {
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: this.audioConstraints.echoCancellation ?? true,
        // Com o RNNoise ligado, desliga a supressão do navegador (não processa duas vezes).
        noiseSuppression: this.reducaoRuido ? false : this.audioConstraints.noiseSuppression ?? true,
        autoGainControl: this.audioConstraints.autoGainControl ?? true,
        channelCount: 1,
      },
      video: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const bruto = stream.getAudioTracks()[0];
    if (!bruto) throw new Error('Nenhum microfone disponível');

    if (!this.reducaoRuido) return { stream, track: bruto };

    // Sem a ponte com o processo principal (ex.: fora do Electron) não há RNNoise:
    // segue com o som normal, sem erro.
    if (!window.pinducall?.ruido?.carregar) return { stream, track: bruto };

    try {
      const track = await this.#ligarRuido(stream);
      return { stream, track };
    } catch (error) {
      console.error('[room] RNNoise falhou, seguindo sem redução de ruído:', error);
      this.emit('warning', 'Não consegui ligar a redução de ruído; seguindo com o som normal.');
      return { stream, track: bruto };
    }
  }

  async #carregarAssetsRuido() {
    if (this.#ruidoAssets) return this.#ruidoAssets;
    const { workletCode, wasm } = await window.pinducall.ruido.carregar();
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    this.#ruidoAssets = { wasm, workletUrl: URL.createObjectURL(blob) };
    return this.#ruidoAssets;
  }

  /** Monta a cadeia RNNoise sobre `stream` e devolve o track de saída já limpo. */
  async #ligarRuido(stream) {
    const assets = await this.#carregarAssetsRuido();
    // RNNoise assume 48kHz.
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(assets.workletUrl);

    const source = ctx.createMediaStreamSource(stream);
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: assets.wasm });
    const dest = ctx.createMediaStreamDestination();
    source.connect(node);
    node.connect(dest);

    // Se o worklet quebrar (ex.: WASM não instanciou), ele para de emitir som —
    // microfone mudo. Esse evento avisa na hora: volta pro som cru.
    node.onprocessorerror = () => {
      console.error('[room] erro no worklet do RNNoise; revertendo para o som cru');
      this.#reverterParaCru(
        'A redução de ruído falhou neste PC e estava deixando você mudo; voltei para o som normal.',
      ).catch(() => {});
    };

    // O Chromium pode criar o AudioContext SUSPENSO (política de autoplay) e
    // também suspendê-lo quando o app fica em segundo plano — o que é comum aqui,
    // com o jogo em primeiro plano. Suspenso, o worklet não processa e a saída
    // fica MUDA. Então: garante que arranca rodando e re-liga se cair.
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* segue para a checagem abaixo */
      }
    }
    if (ctx.state !== 'running') {
      // Não deu para rodar: melhor cair no som cru (quem chamou trata o erro)
      // do que deixar o microfone mudo.
      try {
        await ctx.close();
      } catch {
        /* ok */
      }
      throw new Error('AudioContext ficou suspenso; seguindo sem RNNoise');
    }
    // Mantém vivo: se o Chromium suspender (app em segundo plano), re-liga.
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    });

    this.#ruido = { ctx, source, node, dest };
    // Rede de segurança: se, mesmo montado, o RNNoise entregar SILÊNCIO (o
    // worklet não processou por qualquer motivo), volta sozinho pro som cru —
    // assim o microfone nunca fica mudo de verdade.
    this.#vigiarRuido();
    return dest.stream.getAudioTracks()[0];
  }

  /**
   * Vigia a cadeia do RNNoise: compara o nível de entrada (mic cru) com o de
   * saída (depois do RNNoise). Se a pessoa claramente falou (entrada com sinal)
   * mas a saída ficou muda, o RNNoise não está funcionando neste PC — então
   * reverte pro som cru e avisa. Se a saída acompanha a entrada, para de vigiar.
   */
  #vigiarRuido() {
    const ruido = this.#ruido;
    if (!ruido) return;
    const { ctx, source, node } = ruido;

    const aIn = ctx.createAnalyser();
    const aOut = ctx.createAnalyser();
    aIn.fftSize = 1024;
    aOut.fftSize = 1024;
    try {
      source.connect(aIn);
      node.connect(aOut);
    } catch {
      return;
    }
    ruido.analisadores = [aIn, aOut];

    const bIn = new Float32Array(aIn.fftSize);
    const bOut = new Float32Array(aOut.fftSize);
    const rms = (a, buf) => {
      a.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return Math.sqrt(s / buf.length);
    };

    let maxIn = 0;
    let maxOut = 0;
    const inicio = performance.now();

    const limpar = () => {
      try {
        source.disconnect(aIn);
        node.disconnect(aOut);
      } catch {
        /* ok */
      }
    };

    const tick = () => {
      // Trocou de mic, desligou o RNNoise ou saiu da sala: para de vigiar.
      if (this.#ruido !== ruido) {
        limpar();
        return;
      }
      maxIn = Math.max(maxIn, rms(aIn, bIn));
      maxOut = Math.max(maxOut, rms(aOut, bOut));

      // Assim que a saída dá QUALQUER sinal audível, o RNNoise está funcionando
      // (ele silencia ruído de propósito, então "saída baixa" sozinho não prova
      // defeito — só a saída morta prova). Encerra a vigília, sem reverter.
      if (maxOut > 0.0015) {
        limpar();
        return;
      }

      // Entrou som CLARO na entrada e a saída seguiu MORTA (zero absoluto): o
      // worklet não está processando. Aí sim volta pro cru. Limiar conservador
      // pra nunca reverter um RNNoise que só está suprimindo ruído.
      if (maxIn > 0.05 && performance.now() - inicio > 2000) {
        limpar();
        console.warn(
          `[room] RNNoise sem saída (in=${maxIn.toFixed(3)} out=${maxOut.toFixed(3)}); revertendo`,
        );
        this.#reverterParaCru(
          'A redução de ruído não funcionou neste PC e estava deixando você mudo; voltei para o som normal.',
        ).catch(() => {});
        return;
      }

      // Sem veredito ainda. Continua por até ~12s (tempo de a pessoa falar algo).
      if (performance.now() - inicio > 12000) {
        limpar();
        return;
      }
      setTimeout(tick, 200);
    };
    setTimeout(tick, 300);
  }

  /** Desliga o RNNoise e volta a produzir o som cru do microfone. */
  async #reverterParaCru(mensagem) {
    if (!this.reducaoRuido) return;
    if (!this.micProducer || this.micProducer.closed) return;
    this.reducaoRuido = false;

    try {
      const ruidoAntigo = this.#ruido;
      const streamAntigo = this.localStream;
      this.#ruido = null;

      const { stream, track } = await this.#capturarMic(this.micDeviceId);
      await this.micProducer.replaceTrack({ track });
      this.localStream = stream;
      for (const t of stream.getAudioTracks()) t.enabled = !this.state.micMuted;

      await this.#desligarRuido(ruidoAntigo);
      for (const t of streamAntigo?.getTracks() ?? []) t.stop();
    } catch (error) {
      console.error('[room] falha ao reverter para o som cru:', error);
    }

    if (mensagem) this.emit('warning', mensagem);
    this.emit('ruidoRevertido');
    this.emit('localState', { ...this.state });
  }

  async #desligarRuido(ruido = this.#ruido) {
    if (!ruido) return;
    if (ruido === this.#ruido) this.#ruido = null;
    try {
      ruido.node.destroy?.();
    } catch {
      /* ok */
    }
    try {
      ruido.source.disconnect();
      ruido.node.disconnect();
    } catch {
      /* ok */
    }
    try {
      await ruido.ctx.close();
    } catch {
      /* ok */
    }
  }

  /** Liga/desliga a redução de ruído em tempo real, trocando o track no ar. */
  async setNoiseSuppression(enabled) {
    enabled = Boolean(enabled);
    if (this.reducaoRuido === enabled) return;
    this.reducaoRuido = enabled;

    if (this.micProducer && !this.micProducer.closed) {
      const ruidoAntigo = this.#ruido;
      const streamAntigo = this.localStream;
      this.#ruido = null;

      const { stream, track } = await this.#capturarMic(this.micDeviceId);
      await this.micProducer.replaceTrack({ track });
      this.localStream = stream;
      for (const t of stream.getAudioTracks()) t.enabled = !this.state.micMuted;

      await this.#desligarRuido(ruidoAntigo);
      for (const t of streamAntigo?.getTracks() ?? []) t.stop();
    }

    this.emit('localState', { ...this.state });
  }

  async #stopMic() {
    try {
      this.micProducer?.close();
    } catch {
      /* já fechado */
    }
    this.micProducer = null;

    await this.#desligarRuido();

    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
  }

  async setMicMuted(muted) {
    this.state.micMuted = muted;

    if (this.micProducer && !this.micProducer.closed) {
      if (muted) await this.micProducer.pause();
      else await this.micProducer.resume();
    }

    // Corta o track também: garantia de que nada sai do microfone quando mudo.
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }

    await this.signaling.request('setState', { micMuted: muted }).catch(() => {});
    this.emit('localState', { ...this.state });
  }

  async setDeafened(deafened) {
    this.state.deafened = deafened;
    // Ficar surdo também muta o microfone, como no Discord.
    if (deafened && !this.state.micMuted) await this.setMicMuted(true);

    await this.signaling.request('setState', { deafened }).catch(() => {});
    this.emit('localState', { ...this.state });
  }

  /** Avatar próprio: { emoji, color } ou null. Vai para todos os participantes. */
  async setAvatar(avatar) {
    this.state.avatar = avatar;
    await this.signaling.request('setState', { avatar }).catch(() => {});
    this.emit('localState', { ...this.state });
  }

  async switchMic(deviceId) {
    if (!this.sendTransport) return;

    this.micDeviceId = deviceId;

    if (this.micProducer && !this.micProducer.closed) {
      const ruidoAntigo = this.#ruido;
      const streamAntigo = this.localStream;
      this.#ruido = null;

      const { stream, track } = await this.#capturarMic(deviceId);
      await this.micProducer.replaceTrack({ track });
      this.localStream = stream;
      for (const t of stream.getAudioTracks()) t.enabled = !this.state.micMuted;

      await this.#desligarRuido(ruidoAntigo);
      for (const old of streamAntigo?.getTracks() ?? []) old.stop();
    } else {
      await this.#stopMic();
      await this.startMic(deviceId);
    }

    return this.localStream;
  }

  // ---------------------------------------------------------------------------
  // Compartilhamento de tela
  // ---------------------------------------------------------------------------

  /**
   * Captura de uma câmera — inclusive câmera virtual, como a do OBS.
   *
   * Existe por um motivo concreto: janela que o Windows proíbe copiar (o Tibia
   * em qualquer motor gráfico, por exemplo) não pode ser capturada por nenhum
   * programa de fora. Mas se você já tem o OBS pegando essa imagem, ele publica
   * o resultado como uma câmera comum — e câmera o Windows entrega numa boa.
   * Então o PinduCcall lê a câmera virtual e transmite, sem precisar mexer por
   * dentro do jogo.
   *
   * O som do sistema não vem junto com a câmera; ele é capturado à parte, pelo
   * mesmo caminho de sempre.
   */
  async capturarCamera(deviceId, { withAudio, frameRate, maxHeight }) {
    let camera;
    try {
      camera = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          frameRate: { ideal: frameRate, max: frameRate },
          height: { ideal: maxHeight },
          width: { ideal: Math.round((maxHeight * 16) / 9) },
        },
        audio: false,
      });
    } catch (error) {
      throw new Error(`Não consegui abrir essa câmera: ${error.message}`);
    }

    if (!withAudio) return camera;

    // Som do computador: vem da captura de tela, então pegamos uma tela só para
    // ficar com a trilha de áudio e jogamos a imagem dela fora na hora.
    try {
      const telas = await window.pinducall.screen.list();
      const tela = telas.find((fonte) => fonte.kind === 'screen');
      if (!tela) throw new Error('nenhuma tela disponível');

      await window.pinducall.screen.select(tela.id, true);
      const comSom = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      comSom.getVideoTracks().forEach((track) => track.stop());

      const audio = comSom.getAudioTracks()[0];
      if (audio) camera.addTrack(audio);
    } catch {
      // Sem som é melhor do que sem nada: o aviso sai depois, junto com os
      // outros casos de fonte sem áudio.
    } finally {
      await window.pinducall.screen.cancel();
    }

    return camera;
  }

  async startScreenShare({ sourceId, withAudio = true, frameRate = 30, maxHeight = 1080 }) {
    if (this.state.screenSharing) await this.stopScreenShare();

    let stream;

    if (sourceId.startsWith('camera:')) {
      stream = await this.capturarCamera(sourceId.slice('camera:'.length), {
        withAudio,
        frameRate,
        maxHeight,
      });
    } else {
      // O processo principal precisa saber qual fonte usar antes da captura.
      await window.pinducall.screen.select(sourceId, withAudio);

      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: frameRate, max: frameRate },
            height: { max: maxHeight },
          },
          audio: withAudio,
        });
      } catch (error) {
        await window.pinducall.screen.cancel();
        throw new Error(`Não foi possível capturar a tela: ${error.message}`);
      }
    }

    this.screenStream = stream;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('A captura não retornou video');

    // Diz ao encoder que o conteudo e texto/UI: prioriza nitidez sobre fluidez.
    videoTrack.contentHint = 'detail';

    this.screenProducer = await this.sendTransport.produce({
      track: videoTrack,
      encodings: SCREEN_ENCODINGS,
      // Começa já num bitrate alto (não sobe do zero borrado) e deixa o encoder
      // chegar na camada cheia. min garante um piso decente.
      codecOptions: {
        videoGoogleStartBitrate: 3000,
        videoGoogleMaxBitrate: 6000,
        videoGoogleMinBitrate: 1000,
      },
      appData: { source: 'screen' },
    });

    // Quando a pessoa clica em "parar compartilhamento" na barra do Windows.
    videoTrack.addEventListener('ended', () => {
      this.stopScreenShare().catch((error) => console.error('[room] stopScreenShare:', error));
    });

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      this.screenAudioProducer = await this.sendTransport.produce({
        track: audioTrack,
        codecOptions: { opusStereo: true, opusDtx: false, opusFec: true },
        appData: { source: 'screen-audio' },
      });
    } else if (withAudio) {
      this.emit('warning', 'Compartilhando sem som do sistema (a fonte escolhida não oferece áudio).');
    }

    this.state.screenSharing = true;
    this.emit('localState', { ...this.state });

    // A prévia local usa o stream cru da captura, sem passar pelo servidor:
    // é exatamente o que a sua máquina está enviando, sem latência de ida e volta.
    this.emit('localScreen', { stream, hasAudio: Boolean(audioTrack) });

    return stream;
  }

  /**
   * Estatísticas reais do que está sendo transmitido agora (resolução, taxa de
   * quadros e banda somando todas as camadas de simulcast).
   * Devolve null quando não há compartilhamento ativo.
   */
  async getScreenShareStats() {
    const producer = this.screenProducer;
    if (!producer || producer.closed) return null;

    const report = await producer.getStats();

    let bytesSent = 0;
    let width = 0;
    let height = 0;
    let framesPerSecond = 0;
    let activeLayers = 0;

    for (const entry of report.values()) {
      if (entry.type !== 'outbound-rtp' || entry.kind !== 'video') continue;

      bytesSent += entry.bytesSent ?? 0;
      if ((entry.frameWidth ?? 0) > width) {
        width = entry.frameWidth ?? 0;
        height = entry.frameHeight ?? 0;
      }
      framesPerSecond = Math.max(framesPerSecond, entry.framesPerSecond ?? 0);
      if ((entry.bytesSent ?? 0) > 0) activeLayers += 1;
    }

    return { bytesSent, width, height, framesPerSecond, activeLayers, at: performance.now() };
  }

  async stopScreenShare() {
    if (!this.state.screenSharing && !this.screenProducer) return;

    for (const producer of [this.screenProducer, this.screenAudioProducer]) {
      if (!producer || producer.closed) continue;
      try {
        await this.signaling.request('closeProducer', { producerId: producer.id });
      } catch {
        /* servidor já pode ter fechado */
      }
      producer.close();
    }

    this.screenProducer = null;
    this.screenAudioProducer = null;
    this.musicProducer = null;

    for (const track of this.screenStream?.getTracks() ?? []) track.stop();
    this.screenStream = null;

    this.state.screenSharing = false;
    this.emit('localState', { ...this.state });
    this.emit('localScreenEnded');
  }

  // ---------------------------------------------------------------------------
  // Consumo
  // ---------------------------------------------------------------------------

  /** Ainda faz sentido continuar consumindo, ou já estamos saindo da sala? */
  get #naSala() {
    return Boolean(this.recvTransport) && !this.recvTransport.closed && this.signaling.connected;
  }

  async #consume(producerId) {
    if (!this.#naSala) return;

    const params = await this.signaling.request('consume', {
      producerId,
      transportId: this.recvTransport.id,
    });

    // Entre o pedido e a resposta a pessoa pode ter clicado em "sair": aí o
    // servidor já derrubou o consumer e não faz sentido montar o track.
    if (!this.#naSala) return;

    const consumer = await this.recvTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
    });

    this.consumers.set(consumer.id, consumer);

    if (!this.#naSala) {
      consumer.close();
      this.consumers.delete(consumer.id);
      return;
    }

    // O servidor cria o consumer pausado; só agora e seguro despausar.
    // Se o producer morreu nesse meio tempo (parou de compartilhar a tela, por
    // exemplo), o servidor já jogou fora o consumer: não é erro, é corrida.
    const resumo = await this.signaling.request('resumeConsumer', { consumerId: consumer.id });
    if (resumo?.fechado) {
      consumer.close();
      this.consumers.delete(consumer.id);
      return;
    }

    this.emit('track', {
      consumerId: consumer.id,
      peerId: params.peerId,
      source: params.source,
      kind: params.kind,
      track: consumer.track,
    });
  }

  /**
   * Pausa o recebimento de um consumer (ex.: "não quero assistir o vídeo do
   * fulano"). O servidor para de mandar a mídia — economiza banda — e o consumer
   * local também para de decodificar.
   */
  async pausarConsumer(consumerId) {
    const consumer = this.consumers.get(consumerId);
    try {
      await this.signaling.request('pauseConsumer', { consumerId });
    } catch {
      /* servidor pode já ter fechado */
    }
    try {
      consumer?.pause();
    } catch {
      /* ok */
    }
  }

  /** Volta a receber um consumer pausado. */
  async retomarConsumer(consumerId) {
    const consumer = this.consumers.get(consumerId);
    try {
      consumer?.resume();
    } catch {
      /* ok */
    }
    try {
      await this.signaling.request('resumeConsumer', { consumerId });
    } catch {
      /* ok */
    }
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  async sendChat(text) {
    return this.signaling.request('chat', { text });
  }

  /** Atalho para o painel do Tibia falar com o servidor. */
  request(method, data = {}) {
    return this.signaling.request(method, data);
  }

  // ---------------------------------------------------------------------------
  // Modo DJ: publica a música como uma faixa de áudio própria
  // ---------------------------------------------------------------------------

  /**
   * A música vai numa faixa separada do microfone (source 'music'), com opus
   * em estéreo e sem DTX — DTX corta o silêncio, o que engole o começo das
   * músicas e as partes baixas.
   */
  async publicarMusica(track) {
    if (!this.sendTransport) throw new Error('Você ainda não está conectado à sala');
    if (this.musicProducer && !this.musicProducer.closed) return this.musicProducer;

    this.musicProducer = await this.sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: true,
        opusDtx: false,
        opusFec: true,
        opusMaxAverageBitrate: 128000,
      },
      appData: { source: 'music' },
    });

    this.musicProducer.on('transportclose', () => {
      this.musicProducer = null;
    });

    return this.musicProducer;
  }

  async pararMusica() {
    if (!this.musicProducer || this.musicProducer.closed) {
      this.musicProducer = null;
      return;
    }

    try {
      await this.signaling.request('closeProducer', { producerId: this.musicProducer.id });
    } catch {
      /* o servidor já pode ter fechado */
    }

    this.musicProducer.close();
    this.musicProducer = null;
  }
}
