/**
 * Sons de alarme gerados na hora com WebAudio.
 *
 * Nada de arquivo de áudio: o alarme precisa tocar mesmo com o app recém-
 * instalado, e um bipe sintetizado nunca some, nunca falha em carregar e não
 * pesa no instalador.
 */

let ctx = null;

function contexto() {
  if (!ctx) ctx = new AudioContext();
  // O Chromium suspende o contexto quando a janela fica muito tempo sem foco.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Um bipe.
 * @param {number} freq Frequência em Hz.
 * @param {number} inicio Atraso em segundos a partir de agora.
 * @param {number} dur Duração em segundos.
 * @param {number} volume 0..1
 * @param {OscillatorType} tipo
 */
function bipe(freq, inicio, dur, volume, tipo = 'sine') {
  const audio = contexto();
  const osc = audio.createOscillator();
  const gain = audio.createGain();

  osc.type = tipo;
  osc.frequency.value = freq;

  const t0 = audio.currentTime + inicio;
  // Envelope suave: onda quadrada crua estala no alto-falante.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Alarme de timer: três notas subindo, difícil de confundir com o jogo. */
export function tocarAlarme(volume = 0.6) {
  const v = Math.max(0, Math.min(1, volume)) * 0.5;
  if (v <= 0) return;

  bipe(880, 0, 0.18, v, 'triangle');
  bipe(1174, 0.2, 0.18, v, 'triangle');
  bipe(1568, 0.4, 0.34, v, 'triangle');
}

/** Aviso antecipado: um toque curto e discreto antes do timer acabar. */
export function tocarAviso(volume = 0.6) {
  const v = Math.max(0, Math.min(1, volume)) * 0.3;
  if (v <= 0) return;
  bipe(660, 0, 0.12, v, 'sine');
}

/** Chamado quando alguém te convoca / evento que merece atenção. */
export function tocarChamado(volume = 0.6) {
  const v = Math.max(0, Math.min(1, volume)) * 0.45;
  if (v <= 0) return;

  bipe(523, 0, 0.14, v, 'square');
  bipe(659, 0.16, 0.14, v, 'square');
  bipe(523, 0.32, 0.14, v, 'square');
  bipe(659, 0.48, 0.26, v, 'square');
}

/** Deixa o contexto pronto — o Chromium exige um gesto do usuário antes do 1º som. */
export function prepararAudio() {
  try {
    contexto();
  } catch {
    /* sem suporte a WebAudio: o app segue sem alarme */
  }
}
