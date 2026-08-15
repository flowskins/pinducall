/**
 * Testes da parte pura do controle do OBS.
 *
 * O que dá para testar sem OBS nenhum: a conta da string de autenticação do
 * obs-websocket (é o que decide se a gente entra ou leva a porta na cara), a
 * montagem do alvo da janela do Tibia e o empacotamento dos requests. O
 * handshake ao vivo e a câmera virtual só dá para provar na máquina com OBS.
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const obs = require('../electron/obs-control.js');

let falhas = 0;
let contagem = 0;

function check(rotulo, condicao, detalhe = '') {
  contagem += 1;
  if (condicao) console.log(`  ok    ${rotulo}`);
  else {
    falhas += 1;
    console.error(`  FALHA ${rotulo} ${detalhe}`);
  }
}

// --- Autenticação ----------------------------------------------------------
// Reproduz a fórmula do obs-websocket de forma independente e compara.
function authEsperada(senha, salt, challenge) {
  const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('base64');
  return sha(sha(senha + salt) + challenge);
}

{
  const senha = 'segredo-do-obs';
  const salt = 'c2FsdC1xdWFscXVlcg==';
  const challenge = 'Y2hhbGxlbmdlLTEyMw==';
  const obtido = obs.stringDeAutenticacao(senha, salt, challenge);

  check('a string de autenticação bate com a fórmula do obs-websocket',
    obtido === authEsperada(senha, salt, challenge), obtido);
  check('a autenticação muda quando o challenge muda',
    obs.stringDeAutenticacao(senha, salt, 'outro') !== obtido);
  check('a autenticação é base64 (o OBS recusa qualquer outra coisa)',
    /^[A-Za-z0-9+/]+=*$/.test(obtido), obtido);
}

// --- Alvo da janela --------------------------------------------------------
{
  const alvo = obs.alvoDaJanela({ titulo: 'Tibia - Avozinho', classe: 'Qt693QWindowIcon', exe: 'client.exe' });
  check('o alvo sai no formato titulo:classe:exe',
    alvo === 'Tibia - Avozinho:Qt693QWindowIcon:client.exe', alvo);

  // Dois-pontos no título quebrariam o formato: têm que ser neutralizados.
  const comDoisPontos = obs.alvoDaJanela({ titulo: 'Tibia: Web', classe: 'C', exe: 'client.exe' });
  check('dois-pontos no título não quebram o alvo',
    comDoisPontos.split(':').length === 3, comDoisPontos);

  const vazio = obs.alvoDaJanela({});
  check('sem dados, cai num alvo padrão de client.exe',
    /client\.exe$/.test(vazio), vazio);
}

// --- Config do game_capture ------------------------------------------------
{
  const cfg = obs.configDoCaptura({ titulo: 'Tibia', classe: 'Q', exe: 'client.exe' });
  check('captura por janela específica', cfg.capture_mode === 'window', JSON.stringify(cfg));
  check('casa pelo executável (prioridade 2), pra não quebrar ao trocar de char',
    cfg.priority === 2);
  check('liga o anti-cheat hook — é o que faz o gancho pegar cliente protegido',
    cfg.anti_cheat_hook === true);
}

// --- Empacotamento do request ----------------------------------------------
{
  const bruto = obs.empacotarRequest('StartVirtualCam', undefined, 'pc-1');
  const msg = JSON.parse(bruto);
  check('o request usa o op 6 (Request) do protocolo', msg.op === obs.OP.REQUEST, bruto);
  check('leva o requestType, o requestId e um requestData',
    msg.d.requestType === 'StartVirtualCam' && msg.d.requestId === 'pc-1' && typeof msg.d.requestData === 'object',
    bruto);
}

// --- Handshake simulado ----------------------------------------------------
// Um WebSocket de mentira que fala o protocolo do OBS: manda o Hello, confere a
// autenticação que o cliente devolve e responde Identified. Prova o caminho
// inteiro de conexão sem precisar do OBS.
{
  const senha = 'abc123';
  const salt = 'U2FsdEV4ZW1wbG8=';
  const challenge = 'Q2hhbGxlbmdlWA==';

  class SocketFalso {
    constructor() {
      this.ouvintes = {};
      this.enviados = [];
      // Assim que "conecta", manda o Hello pedindo autenticação.
      queueMicrotask(() => this.emitir('message', JSON.stringify({
        op: 0,
        d: { obsWebSocketVersion: '5.0.0', rpcVersion: 1, authentication: { challenge, salt } },
      })));
    }

    on(evento, fn) { (this.ouvintes[evento] ??= []).push(fn); }
    emitir(evento, dado) { (this.ouvintes[evento] ?? []).forEach((fn) => fn(dado)); }

    send(bruto) {
      this.enviados.push(bruto);
      const msg = JSON.parse(bruto);
      if (msg.op === 1) {
        // O cliente respondeu o Identify: confere a autenticação e confirma.
        const esperada = authEsperada(senha, salt, challenge);
        if (msg.d.authentication === esperada) {
          queueMicrotask(() => this.emitir('message', JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })));
        } else {
          queueMicrotask(() => this.emitir('error', new Error('autenticação errada')));
        }
      }
    }

    close() {}
  }

  const controle = new obs.ObsControle(() => new SocketFalso());
  try {
    await controle.conectar({ porta: 4455, senha, timeoutMs: 2000 });
    check('o handshake completo conecta quando a senha está certa', true);
  } catch (erro) {
    check('o handshake completo conecta quando a senha está certa', false, erro.message);
  }

  const controleErrado = new obs.ObsControle(() => new SocketFalso());
  let recusou = false;
  try {
    await controleErrado.conectar({ porta: 4455, senha: 'senha-errada', timeoutMs: 2000 });
  } catch {
    recusou = true;
  }
  check('senha errada é recusada no handshake', recusou);
}

console.log(`\n${contagem - falhas}/${contagem} verificações passaram.\n`);
process.exit(falhas === 0 ? 0 : 1);
