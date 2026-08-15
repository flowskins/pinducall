import { tocarAlarme, tocarAviso } from './sounds.js';
import { parsePartyHunt, computeTransfers, formatSplit, comandoTransfer, fmtGp } from './tibia/split.js';
import { DjPlayer } from './dj.js';

const $ = (id) => document.getElementById(id);

/** mm:ss, ou h:mm:ss quando passa de uma hora. */
function fmtTempo(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Painel do Tibia: timers de hunt sincronizados, modo DJ e split de loot.
 *
 * Sobre a sincronia dos timers: o servidor manda `endAt` (relógio DELE) junto
 * com o `now` dele. Guardamos a diferença para o nosso relógio uma vez e daí em
 * diante a contagem roda local, a 10 quadros por segundo. Resultado: ninguém
 * fica adiantado por ter o relógio do Windows desregulado, e não existe polling.
 */
export class TibiaPanel {
  #room;
  #toast;
  #settings;
  #onSettingsChange;

  #timers = [];
  #offsetRelogio = 0;
  #tick = null;
  #avisados = new Set();
  #splitAtual = null;

  #dj = new DjPlayer();
  #djEstado = { peerId: null, nome: null, faixa: null, tocando: false, indice: 0, total: 0 };
  #souDj = false;

  constructor({ room, toast, settings, onSettingsChange }) {
    this.#room = room;
    this.#toast = toast;
    this.#settings = settings;
    this.#onSettingsChange = onSettingsChange;

    this.#montarAbas();
    this.#montarTimers();
    this.#montarDj();
    this.#montarSplit();
    this.#ligarEventosDaSala();
  }

  // ---------------------------------------------------------------------------
  // Abas
  // ---------------------------------------------------------------------------

  #montarAbas() {
    for (const aba of document.querySelectorAll('.ttab')) {
      aba.addEventListener('click', () => {
        for (const outra of document.querySelectorAll('.ttab')) outra.classList.remove('ttab--active');
        aba.classList.add('ttab--active');

        for (const corpo of ['timers', 'dj', 'split']) {
          $(`ttab-${corpo}`).classList.toggle('hidden', corpo !== aba.dataset.ttab);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  #montarTimers() {
    $('timer-form').addEventListener('submit', async (event) => {
      event.preventDefault();

      const campo = $('timer-nome');
      const nome = campo.value.trim() || 'Timer';
      const dur = Number($('timer-min').value || 0) * 60 + Number($('timer-seg').value || 0);

      // Limpa na hora, como o campo do chat: esperar a resposta do servidor
      // deixa o campo "travado" por um instante e atrapalha quem digita rápido.
      campo.value = '';

      try {
        await this.#room.request('timerAdd', { nome, dur, repete: $('timer-rep').checked });
      } catch (error) {
        campo.value = nome; // deu erro: devolve o que a pessoa tinha escrito
        this.#toast(error.message, 'error');
      }
    });

    const vol = $('timer-vol');
    const warn = $('timer-warn');

    vol.value = String(Math.round((this.#settings.alarmeVolume ?? 0.6) * 100));
    warn.value = String(this.#settings.alarmeAviso ?? 10);
    $('timer-vol-v').textContent = `${vol.value}%`;
    $('timer-warn-v').textContent = `${warn.value}s`;

    vol.addEventListener('input', () => {
      $('timer-vol-v').textContent = `${vol.value}%`;
      this.#settings.alarmeVolume = Number(vol.value) / 100;
    });
    vol.addEventListener('change', () => {
      tocarAlarme(this.#settings.alarmeVolume);
      this.#onSettingsChange({ alarmeVolume: this.#settings.alarmeVolume });
    });

    warn.addEventListener('input', () => {
      $('timer-warn-v').textContent = `${warn.value}s`;
      this.#settings.alarmeAviso = Number(warn.value);
    });
    warn.addEventListener('change', () => this.#onSettingsChange({ alarmeAviso: this.#settings.alarmeAviso }));

    this.#tick = setInterval(() => this.#desenharTempos(), 100);
  }

  #agoraServidor() {
    return Date.now() + this.#offsetRelogio;
  }

  aplicarEstado(estado) {
    if (!estado) return;

    if (typeof estado.now === 'number') this.#offsetRelogio = estado.now - Date.now();
    this.#timers = estado.timers ?? [];
    this.#renderTimers();
  }

  #renderTimers() {
    const lista = $('timer-list');
    lista.innerHTML = '';

    if (!this.#timers.length) {
      lista.innerHTML = '<li class="tibia__vazio">Nenhum timer ainda.</li>';
      return;
    }

    for (const timer of this.#timers) {
      const item = document.createElement('li');
      item.className = 'timer';
      item.dataset.id = timer.id;

      const barra = document.createElement('div');
      barra.className = 'timer__bar';

      const ponto = document.createElement('span');
      ponto.className = 'timer__dot';
      ponto.style.background = timer.cor;
      ponto.style.boxShadow = `0 0 8px ${timer.cor}`;

      const nome = document.createElement('span');
      nome.className = 'timer__nome';
      nome.textContent = timer.nome;
      nome.title = timer.nome;

      const tempo = document.createElement('span');
      tempo.className = 'timer__tempo';
      tempo.textContent = fmtTempo(timer.dur * 1000);

      const acoes = document.createElement('div');
      acoes.className = 'timer__acoes';

      const play = document.createElement('button');
      play.className = 'timer__btn timer__btn--play';
      play.type = 'button';
      play.textContent = '▶';
      play.title = 'iniciar para a sala toda';
      play.addEventListener('click', () => this.#alternarTimer(timer.id));
      acoes.append(play);

      if (!timer.fixo) {
        const del = document.createElement('button');
        del.className = 'timer__btn timer__btn--del';
        del.type = 'button';
        del.textContent = '✕';
        del.title = 'remover';
        del.addEventListener('click', async () => {
          try {
            await this.#room.request('timerRemove', { id: timer.id });
          } catch (error) {
            this.#toast(error.message, 'error');
          }
        });
        acoes.append(del);
      }

      item.append(barra, ponto, nome);
      if (timer.repete) {
        const rep = document.createElement('span');
        rep.className = 'timer__rep';
        rep.textContent = '🔁';
        rep.title = 'repete sozinho';
        item.append(rep);
      }
      item.append(tempo, acoes);
      lista.append(item);
    }

    this.#desenharTempos();
  }

  async #alternarTimer(id) {
    const timer = this.#timers.find((t) => t.id === id);
    if (!timer) return;

    try {
      const rodando = timer.endAt && timer.endAt > this.#agoraServidor();
      await this.#room.request(rodando ? 'timerStop' : 'timerStart', { id });
    } catch (error) {
      this.#toast(error.message, 'error');
    }
  }

  /** Roda 10x por segundo: só mexe em texto e largura, sem recriar elementos. */
  #desenharTempos() {
    const agora = this.#agoraServidor();
    const aviso = this.#settings.alarmeAviso ?? 10;

    for (const timer of this.#timers) {
      const item = $('timer-list')?.querySelector(`[data-id="${timer.id}"]`);
      if (!item) continue;

      const tempo = item.querySelector('.timer__tempo');
      const barra = item.querySelector('.timer__bar');
      const play = item.querySelector('.timer__btn--play');
      const rodando = Boolean(timer.endAt && timer.endAt > agora);

      item.classList.toggle('timer--rodando', rodando);

      if (!rodando) {
        tempo.textContent = fmtTempo(timer.dur * 1000);
        barra.style.width = '0%';
        play.textContent = '▶';
        play.title = 'iniciar para a sala toda';
        item.classList.remove('timer--acabando');
        this.#avisados.delete(timer.id);
        continue;
      }

      const restante = timer.endAt - agora;
      tempo.textContent = fmtTempo(restante);
      barra.style.width = `${Math.max(0, Math.min(100, (restante / (timer.dur * 1000)) * 100))}%`;
      play.textContent = '⏹';
      play.title = 'parar para a sala toda';

      const perto = restante <= aviso * 1000;
      item.classList.toggle('timer--acabando', perto && aviso > 0);

      // Aviso antecipado: local, uma vez por contagem.
      if (perto && aviso > 0 && !this.#avisados.has(timer.id)) {
        this.#avisados.add(timer.id);
        tocarAviso(this.#settings.alarmeVolume ?? 0.6);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Modo DJ
  // ---------------------------------------------------------------------------

  #montarDj() {
    $('dj-claim').addEventListener('click', () => this.#assumirDj());
    $('dj-release').addEventListener('click', () => this.#soltarDj());

    $('dj-files').addEventListener('change', (event) => {
      const quantos = this.#dj.adicionar(event.target.files ?? []);
      event.target.value = '';

      if (!quantos) {
        this.#toast('Nenhum arquivo de áudio reconhecido.', 'warn');
        return;
      }
      this.#toast(`${quantos} música(s) na fila.`, 'ok', 3000);
      this.#renderPlaylist();
    });

    // Os quatro botões valem para todo mundo: quem não é DJ manda o comando
    // pela sala e ele é executado no PC de quem está com a música.
    const comandos = [
      ['dj-play', 'play'],
      ['dj-stop', 'stop'],
      ['dj-next', 'next'],
      ['dj-prev', 'prev'],
    ];

    for (const [id, acao] of comandos) {
      $(id).addEventListener('click', () => this.#comandoDj(acao));
    }

    const volCall = $('dj-vol-call');
    const volLocal = $('dj-vol-local');

    volCall.value = String(Math.round((this.#settings.djVolumeCall ?? 0.7) * 100));
    volLocal.value = String(Math.round((this.#settings.djVolumeLocal ?? 0.4) * 100));
    $('dj-vol-call-v').textContent = `${volCall.value}%`;
    $('dj-vol-local-v').textContent = `${volLocal.value}%`;

    volCall.addEventListener('input', () => {
      $('dj-vol-call-v').textContent = `${volCall.value}%`;
      this.#settings.djVolumeCall = Number(volCall.value) / 100;
      this.#dj.setVolumeCall(this.#settings.djVolumeCall);
    });
    volCall.addEventListener('change', () => this.#onSettingsChange({ djVolumeCall: this.#settings.djVolumeCall }));

    volLocal.addEventListener('input', () => {
      $('dj-vol-local-v').textContent = `${volLocal.value}%`;
      this.#settings.djVolumeLocal = Number(volLocal.value) / 100;
      this.#dj.setVolumeLocal(this.#settings.djVolumeLocal);
    });
    volLocal.addEventListener('change', () =>
      this.#onSettingsChange({ djVolumeLocal: this.#settings.djVolumeLocal }),
    );

    this.#dj.on('state', (estado) => {
      this.#renderPlaylist();
      this.#room.request('djUpdate', estado).catch(() => {});
    });

    this.#dj.on('error', (error) => this.#toast(error.message, 'error'));
  }

  async #assumirDj() {
    try {
      await this.#room.request('djClaim');
      this.#souDj = true;

      const track = this.#dj.iniciar();
      this.#dj.setVolumeCall(this.#settings.djVolumeCall ?? 0.7);
      this.#dj.setVolumeLocal(this.#settings.djVolumeLocal ?? 0.4);

      if (track) await this.#room.publicarMusica(track);
      this.#toast('Você está no comando da música. Escolha os arquivos.', 'ok');
      this.#renderDj();
    } catch (error) {
      this.#souDj = false;
      this.#toast(error.message, 'error');
    }
  }

  async #soltarDj() {
    this.#souDj = false;
    this.#dj.encerrar();

    await this.#room.pararMusica().catch(() => {});
    await this.#room.request('djRelease').catch(() => {});
    this.#renderDj();
    this.#renderPlaylist();
  }

  async #comandoDj(acao) {
    if (this.#souDj) {
      await this.#executarComandoDj(acao);
      return;
    }

    if (!this.#djEstado.peerId) {
      this.#toast('Ninguém está no comando da música ainda.', 'warn');
      return;
    }

    try {
      await this.#room.request('djCommand', { acao });
    } catch (error) {
      this.#toast(error.message, 'error');
    }
  }

  /** Executado no PC de quem está com a música. */
  async #executarComandoDj(acao) {
    try {
      if (acao === 'play') await this.#dj.alternar();
      else if (acao === 'pause') this.#dj.pausar();
      else if (acao === 'stop') this.#dj.parar();
      else if (acao === 'next') await this.#dj.proxima();
      else if (acao === 'prev') await this.#dj.anterior();
    } catch (error) {
      this.#toast(error.message, 'error');
    }
  }

  aplicarDj(estado) {
    this.#djEstado = estado ?? this.#djEstado;
    this.#souDj = Boolean(estado?.peerId) && estado.peerId === this.#room.peerId;
    this.#renderDj();
  }

  #renderDj() {
    const { peerId, nome, faixa, tocando } = this.#djEstado;

    $('dj-claim').classList.toggle('hidden', Boolean(peerId));
    $('dj-release').classList.toggle('hidden', !this.#souDj);
    $('dj-owner-tools').classList.toggle('hidden', !this.#souDj);
    $('dj-now').classList.toggle('hidden', !faixa);
    $('dj-now').classList.toggle('dj__now--parado', !tocando);
    $('dj-play').textContent = tocando ? '⏸' : '▶';

    if (faixa) $('dj-track').textContent = faixa;

    const status = $('dj-status');
    if (!peerId) {
      status.textContent = 'Ninguém está tocando música.';
    } else if (this.#souDj) {
      status.textContent = this.#dj.playlist.length
        ? 'Você está no comando 🎧'
        : 'Você está no comando 🎧 — escolha as músicas.';
    } else {
      status.textContent = `${nome} está no comando 🎧`;
    }
  }

  #renderPlaylist() {
    const lista = $('dj-playlist');
    lista.innerHTML = '';

    if (!this.#souDj || !this.#dj.playlist.length) return;

    this.#dj.playlist.forEach((faixa, i) => {
      const item = document.createElement('li');
      item.className = i === this.#dj.indice ? 'dj__item dj__item--atual' : 'dj__item';

      const num = document.createElement('span');
      num.className = 'dj__num';
      num.textContent = String(i + 1).padStart(2, '0');

      const nome = document.createElement('span');
      nome.className = 'dj__nome';
      nome.textContent = faixa.nome;
      nome.title = faixa.nome;

      item.append(num, nome);
      item.addEventListener('click', () => this.#dj.irPara(i));
      lista.append(item);
    });
  }

  // ---------------------------------------------------------------------------
  // Split de loot
  // ---------------------------------------------------------------------------

  #montarSplit() {
    $('split-calc').addEventListener('click', () => this.#calcularSplit());

    $('split-send').addEventListener('click', async () => {
      if (!this.#splitAtual) return;
      try {
        await this.#room.sendChat(formatSplit(this.#splitAtual).texto);
        this.#toast('Split enviado no chat da sala.', 'ok', 3000);
      } catch (error) {
        this.#toast(error.message, 'error');
      }
    });
  }

  #calcularSplit() {
    const alvo = $('split-result');
    const parsed = parsePartyHunt($('split-log').value);

    if (!parsed) {
      this.#splitAtual = null;
      $('split-send').classList.add('hidden');
      alvo.innerHTML =
        '<div class="split__erro">Não reconheci o log. Cole o texto inteiro que o botão <b>Copy</b> do Party Hunt Analyser gera — ele começa com "Session data:".</div>';
      return;
    }

    this.#splitAtual = parsed;
    $('split-send').classList.remove('hidden');

    const { total, share, transfers } = computeTransfers(parsed.players);
    alvo.innerHTML = '';

    const resumo = document.createElement('div');
    resumo.className = 'split__resumo';
    resumo.innerHTML = `Balance total <b>${fmtGp(total)}</b> · ${parsed.players.length} players · cada um fica com <b>${fmtGp(share)}</b>`;
    alvo.append(resumo);

    if (!transfers.length) {
      const ok = document.createElement('div');
      ok.className = 'split__resumo';
      ok.textContent = 'Tudo equilibrado, ninguém paga ninguém 🤝';
      alvo.append(ok);
      return;
    }

    for (const t of transfers) {
      const linha = document.createElement('div');
      linha.className = 'split__linha';

      const texto = document.createElement('span');
      texto.className = 'split__texto';
      texto.innerHTML = `<b>${t.de}</b> paga <span class="split__valor">${fmtGp(t.valor)}</span> para <b>${t.para}</b>`;

      const copiar = document.createElement('button');
      copiar.className = 'split__cp';
      copiar.type = 'button';
      copiar.textContent = '📋';
      copiar.title = `copiar "${comandoTransfer(t)}"`;
      copiar.addEventListener('click', async () => {
        await navigator.clipboard.writeText(comandoTransfer(t));
        copiar.textContent = '✓';
        setTimeout(() => {
          copiar.textContent = '📋';
        }, 1200);
      });

      linha.append(texto, copiar);
      alvo.append(linha);
    }
  }

  // ---------------------------------------------------------------------------
  // Eventos vindos da sala
  // ---------------------------------------------------------------------------

  #ligarEventosDaSala() {
    this.#room.on('tibiaUpdate', (estado) => this.aplicarEstado(estado));
    this.#room.on('djUpdate', (estado) => this.aplicarDj(estado));

    this.#room.on('timerFinished', ({ nome }) => {
      this.#avisados.clear();
      tocarAlarme(this.#settings.alarmeVolume ?? 0.6);
      this.#toast(`⏳ ${nome} acabou!`, 'ok', 6000);
      window.pinducall.app.flashTaskbar();
    });

    this.#room.on('djCommand', ({ acao }) => {
      if (this.#souDj) this.#executarComandoDj(acao);
    });
  }

  /** Chamado ao sair da sala. */
  encerrar() {
    clearInterval(this.#tick);
    this.#tick = null;
    this.#dj.encerrar();
    this.#souDj = false;
    this.#timers = [];
    this.#djEstado = { peerId: null, nome: null, faixa: null, tocando: false, indice: 0, total: 0 };
    this.#renderTimers();
    this.#renderDj();
    this.#renderPlaylist();
  }
}
