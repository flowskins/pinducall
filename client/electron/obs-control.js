/**
 * Controle do OBS por baixo dos panos.
 *
 * Por que isto existe: o Tibia tranca a cópia da própria janela (a trava
 * WDA_MONITOR, medida na máquina do usuário). Nenhuma API de captura do Windows
 * fura isso — só um gancho dentro do processo do jogo, que é o que o OBS faz no
 * "Captura de Jogo". Em vez de reescrever esse gancho (código nativo, arriscado,
 * impossível de testar sem o jogo), o PinduCcall reaproveita o do OBS: abre o
 * OBS minimizado na bandeja, monta a cena do Tibia sozinho e liga a câmera
 * virtual. O usuário nunca toca no OBS — do lado dele é só "Compartilhar".
 *
 * A conversa com o OBS usa o obs-websocket v5, que já vem embutido no OBS 28+.
 * Precisa estar ligado (Ferramentas → Configurações do Servidor WebSocket), com
 * porta e senha; o PinduCcall guarda esses dois e cuida do resto.
 *
 * Este arquivo separa de propósito a PARTE PURA (montar a string de
 * autenticação, montar o alvo da janela, empacotar um request) — que dá para
 * testar aqui sem OBS nenhum — da parte que fala com o socket de verdade.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Códigos de operação do obs-websocket v5.
const OP = {
  HELLO: 0,
  IDENTIFY: 1,
  IDENTIFIED: 2,
  EVENT: 5,
  REQUEST: 6,
  REQUEST_RESPONSE: 7,
};

// ---------------------------------------------------------------------------
// Parte pura (testável sem OBS)
// ---------------------------------------------------------------------------

/**
 * String de autenticação do obs-websocket v5.
 *
 *   segredo = base64( sha256( senha + salt ) )
 *   auth    = base64( sha256( segredo + challenge ) )
 *
 * @param {string} senha
 * @param {string} salt vindo do Hello
 * @param {string} challenge vindo do Hello
 */
function stringDeAutenticacao(senha, salt, challenge) {
  const sha256base64 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('base64');
  const segredo = sha256base64(senha + salt);
  return sha256base64(segredo + challenge);
}

/**
 * Alvo do "Captura de Jogo" do OBS, no formato que ele espera: "titulo:classe:exe".
 *
 * A gente já enumera as janelas do Tibia (título, classe e o client.exe), então
 * entrega o alvo exato para o OBS em vez de deixar ele adivinhar. Com a
 * prioridade em "executável", trocar de personagem (que muda o título) não
 * quebra o vínculo.
 *
 * @param {{titulo?: string, classe?: string, exe?: string}} janela
 */
function alvoDaJanela(janela) {
  const limpar = (valor) => String(valor ?? '').replace(/:/g, '#');
  const titulo = limpar(janela.titulo) || 'Tibia';
  const classe = limpar(janela.classe) || 'Qt5152QWindowIcon';
  const exe = limpar(janela.exe) || 'client.exe';
  return `${titulo}:${classe}:${exe}`;
}

/**
 * Configuração do input game_capture apontado para o Tibia.
 * O anti_cheat_hook é o que faz o gancho passar em cliente protegido.
 */
function configDoCaptura(janela) {
  return {
    capture_mode: 'window',
    window: alvoDaJanela(janela),
    priority: 2, // 0=título, 1=classe, 2=executável — casa pelo client.exe
    capture_cursor: true,
    allow_transparency: false,
    premultiplied_alpha: false,
    anti_cheat_hook: true,
    hook_rate: 1, // normal
    limit_framerate: false,
  };
}

/** Empacota um request do obs-websocket v5. */
function empacotarRequest(requestType, requestData, requestId) {
  return JSON.stringify({
    op: OP.REQUEST,
    d: { requestType, requestId, requestData: requestData ?? {} },
  });
}

// ---------------------------------------------------------------------------
// Localizar e abrir o OBS
// ---------------------------------------------------------------------------

const CAMINHOS_PROVAVEIS = [
  'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
  'C:\\Program Files (x86)\\obs-studio\\bin\\64bit\\obs64.exe',
];

/**
 * Onde está o obs64.exe. Usa o caminho salvo, senão tenta os lugares comuns.
 * @param {string} [caminhoSalvo]
 */
function acharObs(caminhoSalvo) {
  const candidatos = [caminhoSalvo, ...CAMINHOS_PROVAVEIS].filter(Boolean);
  return candidatos.find((c) => {
    try { return fs.existsSync(c); } catch { return false; }
  }) ?? null;
}

/**
 * Abre o OBS minimizado na bandeja. NÃO liga a câmera virtual pela linha de
 * comando de propósito: a gente liga depois, via websocket, só quando a cena do
 * Tibia já estiver montada — assim a câmera nunca sai "vazia".
 *
 * @param {string} caminhoObs caminho do obs64.exe
 */
function abrirObsEscondido(caminhoObs) {
  // O OBS precisa rodar com o diretório de trabalho no próprio bin/64bit,
  // senão não acha os arquivos de tradução e recusa a abrir.
  const dir = path.dirname(caminhoObs);
  const filho = spawn(caminhoObs, ['--minimize-to-tray', '--multi', '--disable-updater'], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  filho.unref();
  return filho;
}

// ---------------------------------------------------------------------------
// Cliente do obs-websocket
// ---------------------------------------------------------------------------

/**
 * Conexão viva com o OBS. Fininha de propósito: faz o handshake, manda request e
 * casa a resposta pelo requestId. Usa a implementação de WebSocket que for
 * passada (o `ws` no processo principal), para o módulo continuar testável.
 */
class ObsControle {
  /**
   * @param {(url: string) => any} criarSocket fábrica de WebSocket (ex.: url => new WS(url))
   */
  constructor(criarSocket) {
    this.criarSocket = criarSocket;
    this.socket = null;
    this.pendentes = new Map();
    this.proximoId = 1;
  }

  /**
   * Conecta e faz o handshake. Resolve quando o OBS confirma a identificação.
   * @param {{porta: number, senha: string, timeoutMs?: number}} opcoes
   */
  conectar({ porta, senha, timeoutMs = 8000 }) {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${porta}`;
      const socket = this.criarSocket(url);
      this.socket = socket;

      const prazo = setTimeout(() => {
        try { socket.close(); } catch {}
        reject(new Error('o OBS não respondeu no tempo esperado'));
      }, timeoutMs);

      const onMensagem = (dado) => {
        let msg;
        try { msg = JSON.parse(dado.toString()); } catch { return; }

        if (msg.op === OP.HELLO) {
          const auth = msg.d?.authentication;
          const identificar = {
            op: OP.IDENTIFY,
            d: { rpcVersion: 1, eventSubscriptions: 0 },
          };
          if (auth) {
            if (!senha) {
              clearTimeout(prazo);
              reject(new Error('o OBS está pedindo senha e nenhuma foi configurada'));
              return;
            }
            identificar.d.authentication = stringDeAutenticacao(senha, auth.salt, auth.challenge);
          }
          socket.send(JSON.stringify(identificar));
          return;
        }

        if (msg.op === OP.IDENTIFIED) {
          clearTimeout(prazo);
          resolve(this);
          return;
        }

        if (msg.op === OP.REQUEST_RESPONSE) {
          const { requestId, requestStatus, responseData } = msg.d ?? {};
          const aguardando = this.pendentes.get(requestId);
          if (!aguardando) return;
          this.pendentes.delete(requestId);
          if (requestStatus?.result) aguardando.resolve(responseData ?? {});
          else aguardando.reject(new Error(requestStatus?.comment || `request ${requestId} falhou`));
        }
      };

      socket.on('message', onMensagem);
      socket.on('error', (erro) => {
        clearTimeout(prazo);
        reject(new Error(`não consegui falar com o OBS: ${erro.message}`));
      });
      socket.on('close', () => {
        for (const p of this.pendentes.values()) p.reject(new Error('a conexão com o OBS caiu'));
        this.pendentes.clear();
      });
    });
  }

  /** Manda um request e espera a resposta correspondente. */
  pedir(requestType, requestData) {
    return new Promise((resolve, reject) => {
      const id = `pc-${this.proximoId++}`;
      this.pendentes.set(id, { resolve, reject });
      try {
        this.socket.send(empacotarRequest(requestType, requestData, id));
      } catch (erro) {
        this.pendentes.delete(id);
        reject(erro);
      }
    });
  }

  fechar() {
    try { this.socket?.close(); } catch {}
  }
}

module.exports = {
  OP,
  stringDeAutenticacao,
  alvoDaJanela,
  configDoCaptura,
  empacotarRequest,
  acharObs,
  abrirObsEscondido,
  ObsControle,
};
