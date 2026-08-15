/**
 * Smoke test do servidor: sobe o processo de verdade, conecta um cliente
 * WebSocket, entra na sala, cria transports, manda chat e valida as respostas.
 *
 *   npm run smoke
 *
 * Não substitui um teste com mídia real, mas prova que a API do mediasoup,
 * a sinalização e o roteamento de eventos estao coerentes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');

const PORT = 4999;
let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FALHA ${label} ${detail}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch com prazo: sem isso, um servidor travado trava o teste inteiro. */
async function pegar(url, opcoes = {}) {
  return fetch(url, { ...opcoes, signal: AbortSignal.timeout(15_000) });
}

/** Cliente RPC mínimo, espelhando o protocolo de lib/rpc.js. */
class TestClient {
  constructor(url) {
    this.url = url;
    this.pending = new Map();
    this.notifications = [];
    this.seq = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.t === 'res') {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (message.ok) entry.resolve(message.data);
          else entry.reject(new Error(message.error?.message ?? 'erro desconhecido'));
        } else if (message.t === 'notify') {
          this.notifications.push(message);
        }
      });
    });
  }

  request(method, data = {}) {
    const id = `t${(this.seq += 1)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ t: 'req', id, method, data }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout em "${method}"`));
      }, 10_000);
    });
  }

  received(method) {
    return this.notifications.filter((n) => n.method === method);
  }

  close() {
    this.ws?.close();
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + 30_000;
  let output = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  while (Date.now() < deadline) {
    if (/PinduCcall no ar/.test(output)) return output;
    if (child.exitCode !== null) throw new Error(`Servidor morreu no boot:\n${output}`);
    await sleep(200);
  }
  throw new Error(`Servidor não subiu a tempo:\n${output}`);
}

async function main() {
  console.log('\nSubindo o servidor em modo de teste...\n');

  // Chat e timers ficam em disco: limpamos para cada execução começar do zero.
  const dataDir = path.join(serverDir, 'data-test');
  fs.rmSync(dataDir, { recursive: true, force: true });

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_PASSWORD: 'senha-de-teste',
      DEFAULT_ROOM: 'teste',
      MEDIASOUP_WORKERS: '1',
      RTC_MIN_PORT: '45000',
      RTC_MAX_PORT: '45020',
      ANNOUNCED_IP: '127.0.0.1',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'info',
    },
  });

  try {
    await waitForServer(child);
    console.log('Servidor no ar. Rodando verificações:\n');

    // --- Cliente A ---------------------------------------------------------
    const alice = new TestClient(`ws://127.0.0.1:${PORT}/ws`);
    await alice.connect();
    check('cliente conecta no WebSocket', true);

    // Senha errada precisa ser recusada.
    let rejected = false;
    try {
      await alice.request('join', { displayName: 'Intruso', password: 'errada', roomId: 'teste' });
    } catch {
      rejected = true;
    }
    check('senha errada e recusada', rejected);

    // --- Catálogo de salas -------------------------------------------------
    const lobby = await alice.request('listarSalas');
    check(
      'listarSalas mostra a sala padrão',
      lobby.salas.some((s) => s.id === 'teste'),
      JSON.stringify(lobby.salas),
    );
    check('listarSalas nunca devolve senha', !JSON.stringify(lobby.salas).includes('senha'));
    let senhaCurta = false;
    try {
      await alice.request('criarSala', { nome: 'Turma B', senha: '12' });
    } catch {
      senhaCurta = true;
    }
    check('senha de sala com menos de 4 caracteres e recusada', senhaCurta);

    const nova = await alice.request('criarSala', {
      nome: 'Hunt da Madruga',
      senha: 'senha-da-turma',
      displayName: 'Alice',
    });
    check('criarSala normaliza o nome em id', nova.id === 'hunt-da-madruga', `(recebido ${nova.id})`);
    check('criarSala devolve o nome bonito', nova.nome === 'Hunt da Madruga');

    let duplicada = false;
    try {
      await alice.request('criarSala', {
        nome: 'hunt da madruga',
        senha: 'outra-senha',
      });
    } catch {
      duplicada = true;
    }
    check('sala com nome repetido e recusada', duplicada);

    let salaInexistente = false;
    try {
      await alice.request('getRouterRtpCapabilities', { roomId: 'nao-existe-essa' });
    } catch {
      salaInexistente = true;
    }
    check('sala não cadastrada não cria router', salaInexistente);

    const lobby2 = await alice.request('listarSalas');
    check('a sala nova aparece na lista', lobby2.salas.some((s) => s.id === 'hunt-da-madruga'));
    check(
      'sala recém-criada aparece vazia',
      lobby2.salas.find((s) => s.id === 'hunt-da-madruga')?.pessoas === 0,
    );

    // A senha da sala nova não pode valer na sala antiga.
    let senhaCruzada = false;
    try {
      await alice.request('join', {
        displayName: 'Alice',
        password: 'senha-da-turma',
        roomId: 'teste',
      });
    } catch {
      senhaCruzada = true;
    }
    check('senha de uma sala não abre outra', senhaCruzada);

    const caps = await alice.request('getRouterRtpCapabilities', { roomId: 'teste' });
    check(
      'router expõe rtpCapabilities com opus',
      caps.routerRtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus'),
    );
    check(
      'router expõe VP8 para compartilhamento de tela',
      caps.routerRtpCapabilities.codecs.some((c) => c.mimeType === 'video/VP8'),
    );

    const joined = await alice.request('join', {
      displayName: 'Alice',
      password: 'senha-de-teste',
      roomId: 'teste',
      rtpCapabilities: caps.routerRtpCapabilities,
    });
    check('join retorna peerId', typeof joined.peerId === 'string' && joined.peerId.length > 0);
    check('join retorna limite de 10 pessoas', joined.maxPeers === 10, `(recebido ${joined.maxPeers})`);
    check('join retorna histórico de chat', Array.isArray(joined.chatHistory));

    const sendTransport = await alice.request('createWebRtcTransport', { direction: 'send' });
    check('transport de envio criado', typeof sendTransport.id === 'string');
    check(
      'transport traz ICE candidates',
      Array.isArray(sendTransport.iceCandidates) && sendTransport.iceCandidates.length > 0,
      `(recebido ${sendTransport.iceCandidates?.length})`,
    );
    check(
      'ICE anuncia o endereço configurado',
      sendTransport.iceCandidates.some((c) => c.address === '127.0.0.1' || c.ip === '127.0.0.1'),
      JSON.stringify(sendTransport.iceCandidates?.[0] ?? {}),
    );
    check(
      'ha candidato UDP e TCP',
      sendTransport.iceCandidates.some((c) => c.protocol === 'udp') &&
        sendTransport.iceCandidates.some((c) => c.protocol === 'tcp'),
    );
    check('transport traz dtlsParameters', Boolean(sendTransport.dtlsParameters?.fingerprints?.length));

    const recvTransport = await alice.request('createWebRtcTransport', { direction: 'recv' });
    check('transport de recepção criado', typeof recvTransport.id === 'string');

    // --- Cliente B ---------------------------------------------------------
    const bob = new TestClient(`ws://127.0.0.1:${PORT}/ws`);
    await bob.connect();
    const bobJoin = await bob.request('join', {
      displayName: 'Bob',
      password: 'senha-de-teste',
      roomId: 'teste',
      rtpCapabilities: caps.routerRtpCapabilities,
    });
    check('segunda pessoa entra na mesma sala', bobJoin.peers.length === 1, `(viu ${bobJoin.peers.length} peers)`);
    check('segunda pessoa vê o nome da primeira', bobJoin.peers[0]?.displayName === 'Alice');

    await sleep(200);
    check('Alice foi notificada da entrada de Bob', alice.received('peerJoined').length === 1);

    // --- Chat --------------------------------------------------------------
    const message = await bob.request('chat', { text: '  ola pessoal  ' });
    check('mensagem de chat e salva com texto limpo', message.text === 'ola pessoal');

    await sleep(200);
    const chatNotify = alice.received('chatMessage');
    check('chat chega para os outros participantes', chatNotify.length === 1);
    check('chat traz o nome de quem enviou', chatNotify[0]?.data?.displayName === 'Bob');

    // Anti-flood.
    let flooded = false;
    try {
      for (let i = 0; i < 15; i += 1) await bob.request('chat', { text: `spam ${i}` });
    } catch (error) {
      flooded = /muitas mensagens/i.test(error.message);
    }
    check('anti-flood do chat dispara', flooded);

    // --- Estado ------------------------------------------------------------
    const state = await bob.request('setState', { micMuted: true });
    check('mute e refletido no estado', state.state.micMuted === true);
    await sleep(200);
    check('mute e propagado aos outros', alice.received('peerUpdated').length >= 1);

    // --- Tibia: timers de hunt ----------------------------------------------
    const tibia = await alice.request('tibiaGetState');
    check(
      'sala nasce com o timer da mastermind potion',
      tibia.timers.some((t) => t.id === 'mastermind' && t.dur === 600 && t.repete),
      JSON.stringify(tibia.timers.map((t) => t.nome)),
    );
    check('o estado dos timers vem com o relógio do servidor', typeof tibia.now === 'number');

    const bob2 = new TestClient(`ws://127.0.0.1:${PORT}/ws`);
    await bob2.connect();
    await bob2.request('join', {
      displayName: 'Bob',
      password: 'senha-de-teste',
      roomId: 'teste',
      rtpCapabilities: caps.routerRtpCapabilities,
    });

    const iniciado = await bob2.request('timerStart', { id: 'mastermind' });
    const mm = iniciado.timers.find((t) => t.id === 'mastermind');
    check('iniciar timer define o fim no futuro', mm.endAt > iniciado.now, `${mm.endAt} vs ${iniciado.now}`);
    check(
      'o fim bate com a duração do timer',
      Math.abs(mm.endAt - iniciado.now - 600_000) < 2000,
      `${mm.endAt - iniciado.now}ms`,
    );

    await sleep(250);
    check('o timer iniciado é transmitido para a sala toda', alice.received('tibiaUpdate').length >= 1);
    check(
      'quem iniciou aparece no aviso',
      alice.received('tibiaLog').some((n) => /Bob iniciou o timer Mastermind/.test(n.data?.texto ?? '')),
      JSON.stringify(alice.received('tibiaLog').map((n) => n.data?.texto)),
    );

    const parado = await bob2.request('timerStop', { id: 'mastermind' });
    check('parar timer zera o fim', parado.timers.find((t) => t.id === 'mastermind').endAt === null);

    const comNovo = await alice.request('timerAdd', { nome: 'Boss sala 2', dur: 90, repete: false });
    const criado = comNovo.timers.find((t) => t.nome === 'Boss sala 2');
    check('timer personalizado é criado', Boolean(criado) && criado.dur === 90 && !criado.repete);

    let recusou = false;
    try {
      await alice.request('timerRemove', { id: 'mastermind' });
    } catch (error) {
      recusou = /não pode ser removido/i.test(error.message);
    }
    check('o timer fixo não pode ser removido', recusou);

    const semNovo = await alice.request('timerRemove', { id: criado.id });
    check('timer personalizado é removido', !semNovo.timers.some((t) => t.id === criado.id));

    let duracaoRuim = false;
    try {
      await alice.request('timerAdd', { nome: 'zero', dur: 0 });
    } catch (error) {
      duracaoRuim = /inv(á|a)lida/i.test(error.message);
    }
    check('duração inválida é recusada', duracaoRuim);

    // Timer curto que repete: prova o alarme e o reinício automático.
    const curto = await alice.request('timerAdd', { nome: 'Bip', dur: 5, repete: true });
    const bip = curto.timers.find((t) => t.nome === 'Bip');
    await alice.request('timerStart', { id: bip.id });
    console.log('        (esperando 6s o timer curto disparar...)');
    await sleep(6200);

    const disparou = alice.received('timerFinished').filter((n) => n.data?.id === bip.id);
    check('o alarme dispara quando o timer acaba', disparou.length >= 1, `${disparou.length} disparos`);
    check('o alarme informa que o timer repete', disparou[0]?.data?.repete === true);

    const depois = await alice.request('tibiaGetState');
    const bipDepois = depois.timers.find((t) => t.id === bip.id);
    check(
      'timer que repete reinicia sozinho',
      bipDepois.endAt !== null && bipDepois.endAt > depois.now,
      JSON.stringify(bipDepois),
    );
    await alice.request('timerRemove', { id: bip.id });

    // --- Modo DJ -------------------------------------------------------------
    const djVazio = await alice.request('djGetState');
    check('a sala começa sem ninguém no comando da música', djVazio.peerId === null);

    const djAlice = await alice.request('djClaim');
    check('assumir o comando da música funciona', djAlice.nome === 'Alice');

    let djOcupado = false;
    try {
      await bob2.request('djClaim');
    } catch (error) {
      djOcupado = /já está no comando/i.test(error.message);
    }
    check('outra pessoa não rouba o comando da música', djOcupado);

    await alice.request('djUpdate', { faixa: 'Rock 1', tocando: true, indice: 0, total: 3 });
    await sleep(200);
    const djVisto = bob2.received('djUpdate').at(-1);
    check('a sala vê o que está tocando', djVisto?.data?.faixa === 'Rock 1' && djVisto?.data?.tocando === true);

    let semPermissao = false;
    try {
      await bob2.request('djUpdate', { faixa: 'Hack', tocando: false });
    } catch (error) {
      semPermissao = /não está no comando/i.test(error.message);
    }
    check('quem não é DJ não altera o que está tocando', semPermissao);

    await bob2.request('djCommand', { acao: 'next' });
    await sleep(200);
    const comando = alice.received('djCommand').at(-1);
    check('qualquer um pode mandar pular, e o comando chega no DJ', comando?.data?.acao === 'next');
    check('o comando diz quem pediu', comando?.data?.de === 'Bob');

    let acaoRuim = false;
    try {
      await bob2.request('djCommand', { acao: 'formatar-hd' });
    } catch (error) {
      acaoRuim = /inv(á|a)lido/i.test(error.message);
    }
    check('comando de música desconhecido é recusado', acaoRuim);

    bob2.close();
    await sleep(400);

    await alice.request('djRelease');
    check('soltar o comando da música funciona', (await alice.request('djGetState')).peerId === null);

    // --- Saída -------------------------------------------------------------
    bob.close();
    await sleep(400);
    // Confere o peerId em vez de contar: o teste do DJ também conecta e sai.
    check(
      'saída de participante é notificada',
      alice.received('peerLeft').some((n) => n.data?.peerId === bobJoin.peerId),
      JSON.stringify(alice.received('peerLeft').map((n) => n.data?.peerId)),
    );

    const info = await alice.request('getRoomInfo');
    check('sala volta a ter 1 pessoa', info.peerCount === 1, `(tem ${info.peerCount})`);

    // --- Arquivos no chat --------------------------------------------------
    const baseHttp = `http://127.0.0.1:${PORT}`;
    const conteudo = Buffer.from('relatorio da hunt\nloot: 1.234.567 gp\n', 'utf8');

    let semExtensao = false;
    try {
      await alice.request('pedirEnvioDeArquivo', {
        nome: 'virus.exe',
        tamanho: 10,
        tipo: 'application/octet-stream',
      });
    } catch {
      semExtensao = true;
    }
    check('arquivo executável é recusado', semExtensao);

    let grandeDemais = false;
    try {
      await alice.request('pedirEnvioDeArquivo', {
        nome: 'filme.mp4',
        tamanho: 900 * 1024 * 1024,
        tipo: 'video/mp4',
      });
    } catch {
      grandeDemais = true;
    }
    check('arquivo acima do limite é recusado', grandeDemais);

    const permissao = await alice.request('pedirEnvioDeArquivo', {
      nome: 'relatório da hunt.txt',
      tamanho: conteudo.length,
      tipo: 'text/plain',
    });
    check('o servidor devolve a URL de envio', /\/arquivo\?t=/.test(permissao.url), permissao.url);

    const antesDoUpload = alice.received('chatMessage').length;
    const envio = await pegar(permissao.url, {
      method: 'POST',
      body: conteudo,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const respostaEnvio = await envio.json();
    check('o upload é aceito', envio.status === 200, `(status ${envio.status})`);
    check('o arquivo recebe um token de download', typeof respostaEnvio.token === 'string');
    check(
      'o tamanho gravado bate com o enviado',
      respostaEnvio.tamanho === conteudo.length,
      `${respostaEnvio.tamanho} != ${conteudo.length}`,
    );
    check(
      'o arquivo vale por 24 horas',
      Math.round((respostaEnvio.expiraEm - Date.now()) / 3_600_000) === 24,
    );

    await sleep(300);
    const avisos = alice.received('chatMessage');
    const mensagemArquivo = avisos[avisos.length - 1]?.data;
    check('o arquivo vira mensagem no chat da sala', avisos.length > antesDoUpload);
    check(
      'a mensagem traz nome e tamanho do arquivo',
      mensagemArquivo?.arquivo?.nome === 'relatório da hunt.txt' &&
        mensagemArquivo?.arquivo?.tamanho === conteudo.length,
      JSON.stringify(mensagemArquivo?.arquivo),
    );
    check('a mensagem diz quem enviou', mensagemArquivo?.displayName === 'Alice');

    // O mesmo ticket não pode servir duas vezes.
    const repetido = await pegar(permissao.url, {
      method: 'POST',
      body: conteudo,
      headers: { 'content-type': 'application/octet-stream' },
    });
    await repetido.text();
    check('o ticket de envio só serve uma vez', repetido.status === 403, `(status ${repetido.status})`);

    const baixado = await pegar(`${baseHttp}/arquivo/${respostaEnvio.token}`);
    const bytes = Buffer.from(await baixado.arrayBuffer());
    check('o download responde', baixado.status === 200, `(status ${baixado.status})`);
    check('o conteúdo baixado é idêntico ao enviado', bytes.equals(conteudo));
    check(
      'o download vem como anexo, nunca renderizado',
      (baixado.headers.get('content-disposition') ?? '').startsWith('attachment'),
      baixado.headers.get('content-disposition') ?? '',
    );
    check(
      'o tipo é genérico, para o navegador não executar nada',
      baixado.headers.get('content-type') === 'application/octet-stream',
    );
    check(
      'o nome com acento sobrevive no cabeçalho',
      (baixado.headers.get('content-disposition') ?? '').includes("filename*=UTF-8''"),
    );

    const semArquivo = await pegar(`${baseHttp}/arquivo/tokendementira123`);
    await semArquivo.text();
    check('token de arquivo inválido devolve 404', semArquivo.status === 404);

    const semTicket = await pegar(`${baseHttp}/arquivo?t=inventado`, {
      method: 'POST',
      body: conteudo,
    });
    await semTicket.text();
    check('upload sem autorização é recusado', semTicket.status === 403, `(status ${semTicket.status})`);

    // --- Convites ----------------------------------------------------------
    const convite = await alice.request('criarConvite');
    check('criarConvite devolve token', typeof convite.token === 'string' && convite.token.length >= 16);
    check(
      'a url do convite aponta para /c/<token>',
      convite.url.endsWith(`/c/${convite.token}`),
      convite.url,
    );
    check(
      'o convite vale por 24 horas',
      Math.round((convite.expiraEm - Date.now()) / 3_600_000) === 24,
      String(convite.expiraEm),
    );

    const convite2 = await alice.request('criarConvite');
    check('clicar de novo reaproveita o mesmo link', convite2.token === convite.token);

    const visto = await alice.request('verConvite', { token: convite.token });
    check('verConvite diz de qual sala é o link', visto.roomId === 'teste', visto.roomId);
    check('verConvite traz o nome bonito da sala', visto.nome === 'teste', visto.nome);

    let conviteInvalido = false;
    try {
      await alice.request('verConvite', { token: 'nao-existe-esse-token' });
    } catch {
      conviteInvalido = true;
    }
    check('convite inventado é recusado', conviteInvalido);

    // Um convidado entra sem senha nenhuma, só com o token.
    const convidado = new TestClient(`ws://127.0.0.1:${PORT}/ws`);
    await convidado.connect();

    let semPeer = false;
    try {
      await convidado.request('criarConvite');
    } catch {
      semPeer = true;
    }
    check('quem não está na sala não gera convite', semPeer);

    const capsConvidado = await convidado.request('getRouterRtpCapabilities', { roomId: visto.roomId });
    const entrada = await convidado.request('join', {
      displayName: 'Convidada',
      convite: convite.token,
      rtpCapabilities: capsConvidado.routerRtpCapabilities,
    });
    check('convite entra na sala sem senha', entrada.roomId === 'teste', entrada.roomId);
    check('o convidado recebe o nome da sala', entrada.roomName === 'teste');

    let tokenPodre = false;
    const intruso = new TestClient(`ws://127.0.0.1:${PORT}/ws`);
    await intruso.connect();
    try {
      await intruso.request('join', { displayName: 'Intruso', convite: 'token-que-nao-existe' });
    } catch {
      tokenPodre = true;
    }
    check('convite falso não entra', tokenPodre);
    intruso.close();

    convidado.close();
    await sleep(300);

    alice.close();
    await sleep(300);

    // --- Landing page e download -------------------------------------------
    const base = `http://127.0.0.1:${PORT}`;

    const paginaConvite = await pegar(`${base}/c/${convite.token}`);
    const htmlConvite = await paginaConvite.text();
    check('a página do convite responde', paginaConvite.status === 200, `(status ${paginaConvite.status})`);
    check('a página do convite mostra a sala', htmlConvite.includes('teste'));
    check('a página do convite abre o app pelo protocolo', htmlConvite.includes('pinduccall://entrar?t='));
    check('a página do convite oferece o download', htmlConvite.includes('#baixar'));
    check(
      'a página do convite não vaza no Referer',
      paginaConvite.headers.get('referrer-policy') === 'no-referrer',
    );

    const conviteMorto = await pegar(`${base}/c/naoexisteessetoken123`);
    check('convite inexistente devolve 404', conviteMorto.status === 404, `(status ${conviteMorto.status})`);

    const home = await pegar(`${base}/`);
    const homeHtml = await home.text();
    check('a landing page responde em /', home.status === 200, `(status ${home.status})`);
    check(
      'a landing page vem como HTML',
      (home.headers.get('content-type') ?? '').startsWith('text/html'),
      home.headers.get('content-type') ?? '',
    );
    check('a landing page fala do PinduCcall', /PinduCcall/.test(homeHtml));
    check('a landing page tem área de download', /id="baixar"/.test(homeHtml));

    const saude = await pegar(`${base}/health`);
    const saudeJson = await saude.json();
    check('/health continua devolvendo JSON', saudeJson.status === 'ok');
    check('/health traz o endereço anunciado', saudeJson.announcedAddress === '127.0.0.1');

    const imagem = await pegar(`${base}/imagens/mascote.webp`);
    check('as imagens do site são servidas', imagem.status === 200 && imagem.headers.get('content-type') === 'image/webp');

    const leiaMe = await pegar(`${base}/download/LEIA-ME.txt`);
    check('a pasta de download é servida', leiaMe.status === 200, `(status ${leiaMe.status})`);

    // Nenhuma dessas formas pode alcançar arquivo fora de public/.
    for (const ataque of ['/../package.json', '/..%2fpackage.json', '/imagens/../../package.json', '/%2e%2e/package.json']) {
      const fuga = await pegar(`${base}${ataque}`, { redirect: 'manual' });
      const corpo = await fuga.text();
      check(
        `"${ataque}" não escapa da pasta public`,
        fuga.status !== 200 || !corpo.includes('"pinducall-server"'),
        `(status ${fuga.status})`,
      );
    }

    const inexistente = await pegar(`${base}/nao-existe`);
    check('caminho inexistente devolve 404', inexistente.status === 404, `(status ${inexistente.status})`);
  } finally {
    child.kill('SIGTERM');
    await sleep(500);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  await testarExpiracao();

  console.log(`\n${checks - failures}/${checks} verificações passaram.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Salas vazias somem depois de 24h. Aqui o prazo é encurtado para segundos,
 * senão o teste levaria um dia.
 */
async function testarExpiracao() {
  console.log('\n  -- expiração de salas vazias (prazo encurtado) --\n');

  const PORTA = PORT + 1;
  const dataDir = path.join(serverDir, 'data-expira');
  fs.rmSync(dataDir, { recursive: true, force: true });

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORTA),
      ROOM_PASSWORD: 'fixa',
      DEFAULT_ROOM: 'casa',
      MEDIASOUP_WORKERS: '1',
      RTC_MIN_PORT: '45100',
      RTC_MAX_PORT: '45120',
      ANNOUNCED_IP: '127.0.0.1',
      DATA_DIR: dataDir,
      SALA_EXPIRA_HORAS: '0.0009', // ~3,2 segundos
      ARQUIVO_HORAS: '0.0009',
      LIMPEZA_MINUTOS: '0.017', // ~1 segundo
    },
  });

  try {
    await waitForServer(child);

    const cliente = new TestClient(`ws://127.0.0.1:${PORTA}/ws`);
    await cliente.connect();

    const sala = await cliente.request('criarSala', { nome: 'Passageira', senha: 'abcd1234' });
    const caps = await cliente.request('getRouterRtpCapabilities', { roomId: sala.id });
    await cliente.request('join', {
      displayName: 'Fulano',
      roomId: sala.id,
      password: 'abcd1234',
      rtpCapabilities: caps.routerRtpCapabilities,
    });
    await cliente.request('chat', { text: 'oi' });

    const convite = await cliente.request('criarConvite');
    const lista = await cliente.request('listarSalas');
    check(
      'sala com gente dentro não tem prazo de validade',
      lista.salas.find((s) => s.id === sala.id)?.expiraEm === null,
      JSON.stringify(lista.salas.find((s) => s.id === sala.id)),
    );
    check(
      'a sala padrão é marcada como fixa',
      lista.salas.find((s) => s.id === 'casa')?.fixa === true,
    );

    const arquivoChat = path.join(dataDir, `chat-${sala.id}.jsonl`);
    check('o chat da sala foi gravado', fs.existsSync(arquivoChat));

    // Um arquivo enviado aqui tem o mesmo prazo curto.
    const corpo = Buffer.from('anexo passageiro');
    const permissao = await cliente.request('pedirEnvioDeArquivo', {
      nome: 'anexo.txt',
      tamanho: corpo.length,
      tipo: 'text/plain',
    });
    const envio = await pegar(permissao.url, {
      method: 'POST',
      body: corpo,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const dadosEnvio = await envio.json();
    const urlArquivo = `http://127.0.0.1:${PORTA}/arquivo/${dadosEnvio.token}`;

    const antes = await pegar(urlArquivo);
    await antes.arrayBuffer();
    check('o arquivo baixa enquanto está no prazo', antes.status === 200);
    check('o arquivo existe em disco', fs.readdirSync(path.join(dataDir, 'arquivos')).length > 0);

    // Sai: começa a contagem.
    cliente.close();
    await sleep(500);

    const observador = new TestClient(`ws://127.0.0.1:${PORTA}/ws`);
    await observador.connect();

    const lista2 = await observador.request('listarSalas');
    const vazia = lista2.salas.find((s) => s.id === sala.id);
    check('sala vazia ganha data para expirar', typeof vazia?.expiraEm === 'number', JSON.stringify(vazia));
    check('a sala ainda existe logo depois de esvaziar', Boolean(vazia));

    // Espera o prazo passar e a faxina rodar.
    console.log('        (esperando ~5s a sala vazia expirar...)');
    await sleep(5200);

    const lista3 = await observador.request('listarSalas');
    check(
      'sala vazia some depois do prazo',
      !lista3.salas.some((s) => s.id === sala.id),
      JSON.stringify(lista3.salas.map((s) => s.id)),
    );
    check('a sala fixa continua de pé', lista3.salas.some((s) => s.id === 'casa'));
    check('o histórico de chat da sala apagada foi junto', !fs.existsSync(arquivoChat));
    check(
      'os timers da sala apagada foram junto',
      !fs.existsSync(path.join(dataDir, `tibia-${sala.id}.json`)),
    );

    let conviteMorreu = false;
    try {
      await observador.request('verConvite', { token: convite.token });
    } catch {
      conviteMorreu = true;
    }
    check('o convite da sala apagada para de funcionar', conviteMorreu);

    const depois = await pegar(urlArquivo);
    await depois.text();
    check('o arquivo vencido não baixa mais', depois.status === 404, `(status ${depois.status})`);
    check(
      'o arquivo vencido some do disco',
      fs.readdirSync(path.join(dataDir, 'arquivos')).length === 0,
      JSON.stringify(fs.readdirSync(path.join(dataDir, 'arquivos'))),
    );

    let naoEntraMais = false;
    try {
      await observador.request('join', {
        displayName: 'Atrasado',
        roomId: sala.id,
        password: 'abcd1234',
      });
    } catch {
      naoEntraMais = true;
    }
    check('não dá para entrar numa sala que expirou', naoEntraMais);

    observador.close();
    await sleep(200);
  } finally {
    child.kill('SIGTERM');
    await sleep(500);
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nSmoke test explodiu:', error);
  process.exit(1);
});
