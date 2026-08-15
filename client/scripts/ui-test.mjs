/**
 * Teste da interface do renderer.
 *
 * Carrega o index.html real com o bundle de produção dentro de um Chromium
 * headless, troca a ponte do Electron (window.pinducall) por um stub e dirige
 * a UI como uma pessoa faria: preenche o formulário, entra na sala, manda
 * mensagem no chat e confere o que aparece na tela.
 *
 *   node scripts/ui-test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');
const rendererDir = path.join(clientDir, 'renderer');
const serverDir = path.resolve(clientDir, '..', 'server');

const SIGNALING_PORT = 4996;
const STATIC_PORT = 4995;

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.error(`  FALHA ${label} ${detail}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];

    // O Chromium (em modo headed) pede /favicon.ico sozinho; sem isto vira um
    // 404 no console que faz o teste reclamar de "erro inesperado".
    if (urlPath === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const filePath = path.join(rendererDir, urlPath);

    if (!filePath.startsWith(rendererDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('não encontrado');
      return;
    }

    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });

  return new Promise((resolve) => server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server)));
}

function startSignalingServer() {
  // Chat e timers são persistidos em disco. Sem limpar, sobras de uma execução
  // aparecem na próxima e os testes passam (ou falham) por motivo errado.
  const dataDir = path.join(serverDir, 'data-test');
  fs.rmSync(dataDir, { recursive: true, force: true });

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(SIGNALING_PORT),
      ROOM_PASSWORD: 'uiteste',
      MEDIASOUP_WORKERS: '1',
      RTC_MIN_PORT: '47000',
      RTC_MAX_PORT: '47040',
      ANNOUNCED_IP: '127.0.0.1',
      DATA_DIR: dataDir,
    },
  });

  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));

  return {
    child,
    async ready() {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (/PinduCcall no ar/.test(output)) return;
        if (child.exitCode !== null) throw new Error(`servidor morreu:\n${output}`);
        await sleep(200);
      }
      throw new Error(`servidor não subiu:\n${output}`);
    },
  };
}

/** Stub da ponte do Electron, injetado antes de qualquer script da página. */
const bridgeStub = (port) => `
window.pinducall = {
  __saved: {},
  screen: {
    list: async () => (window.pinducall.__semTibia
      ? [
        { id: 'screen:0:0', name: 'Tela inteira', kind: 'screen', thumbnail: null, appIcon: null, miniaturaVazia: false },
        { id: 'window:12:0', name: 'Bloco de Notas', kind: 'window', thumbnail: null, appIcon: null, miniaturaVazia: false },
      ]
      : [
        { id: 'screen:0:0', name: 'Tela inteira', kind: 'screen', thumbnail: null, appIcon: null, miniaturaVazia: false },
        { id: 'window:12:0', name: 'Bloco de Notas', kind: 'window', thumbnail: null, appIcon: null, miniaturaVazia: false },
        { id: 'window:99:0', name: 'Tibia - Caucau', kind: 'window', thumbnail: null, appIcon: null, miniaturaVazia: true,
          dica: 'Tibia - Caucau está travado contra cópia. Trocar o motor gráfico não resolve mais: a trava está ligada em DirectX 5, DirectX 9 e OpenGL. Trocar o motor gráfico não resolve mais: a trava está ligada em DirectX 5, DirectX 9 e OpenGL. A saída é a aba "Câmera / OBS" aqui do lado — no OBS, clique em Iniciar Câmera Virtual e escolha ela aqui.' },
      ]),
    select: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    // O processo principal só devolve aviso quando o jogo está aberto e fora da lista.
    avisos: async (nomes) => (nomes.some((n) => /tibia/i.test(n))
      ? [{ janela: 'Tibia - Caucau', naLista: true, aviso: 'A janela "Tibia - Caucau" vai sair preta para todo mundo: o Windows está com a trava de cópia ligada nela. Trocar o motor gráfico não resolve mais: a trava está ligada em DirectX 5, DirectX 9 e OpenGL. A saída é a aba "Câmera / OBS" aqui do lado — no OBS, clique em Iniciar Câmera Virtual e escolha ela aqui.' }]
      : [{ janela: 'Tibia - Caucau', naLista: false, aviso: '"Tibia - Caucau" está aberto mas não aparece na lista: o Windows está com a trava de cópia ligada nela. Trocar o motor gráfico não resolve mais: a trava está ligada em DirectX 5, DirectX 9 e OpenGL. A saída é a aba "Câmera / OBS" aqui do lado — no OBS, clique em Iniciar Câmera Virtual e escolha ela aqui.' }]),
  },
  settings: {
    get: async () => ({
      serverUrl: 'ws://127.0.0.1:${port}/ws',
      roomId: 'geral',
      displayName: '',
      password: '',
      rememberPassword: false,
      inputDeviceId: 'default',
      outputDeviceId: 'default',
      micVolume: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }),
    set: async (values) => { Object.assign(window.pinducall.__saved, values); return values; },
  },
  app: {
    info: async () => ({
      version: '1.0.0',
      platform: 'win32',
      electron: '33.0.0',
      chrome: '130',
      defaultServerUrl: 'ws://127.0.0.1:${port}/ws',
      modoCaptura: 'moderno',
      modosDeCaptura: [
        { id: 'moderno', rotulo: 'Moderno (Windows Graphics Capture)' },
        { id: 'automatico', rotulo: 'Automático (o que o Windows escolher)' },
        { id: 'antigo', rotulo: 'Antigo (GDI/DirectX)' },
      ],
    }),
    openExternal: () => {},
    flashTaskbar: () => {},
    setModoCaptura: async (modo) => { window.pinducall.__modoPedido = modo; return { ok: true }; },
  },
  obs: {
    disponivel: async () => ({ ok: false, motivo: 'so-windows' }),
    iniciar: async () => ({ ok: true }),
    parar: async () => ({ ok: true }),
  },
  onToggleMute: () => () => {},
  onDeepLink: (handler) => { window.__dispararConvite = handler; return () => {}; },
};
`;

async function openClient(browser, port) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.addInitScript(bridgeStub(SIGNALING_PORT));
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/`);

  return { page, errors };
}

/**
 * Espera a lista de salas chegar do servidor, clica na sala pelo id e espera
 * o popup "Entrar na sala" abrir. O nome já precisa estar preenchido antes.
 */
async function escolherSala(page, roomId) {
  // Se um popup de "Entrar" ficou aberto (ex.: teste de senha errada), fecha antes.
  if (await page.isVisible('#entrar-modal:not(.hidden)')) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#entrar-modal', { state: 'hidden', timeout: 5_000 });
  }
  await page.waitForSelector(`#room-list .room[data-id="${roomId}"]`, { timeout: 20_000 });
  await page.click(`#room-list .room[data-id="${roomId}"]`);
  await page.waitForSelector('#entrar-modal:not(.hidden)', { timeout: 10_000 });
}

async function joinRoom(page, name, roomId = 'geral', senha = 'uiteste') {
  await page.fill('#input-name', name);
  await escolherSala(page, roomId);
  await page.fill('#input-password', senha);
  await page.click('#btn-connect');
  await page.waitForSelector('#room-screen:not(.hidden)', { timeout: 20_000 });
}

async function main() {
  console.log('\nSubindo servidor e servidor estático para o teste de UI...\n');

  const staticServer = await startStaticServer();
  const signaling = startSignalingServer();
  await signaling.ready();

  // Permite forçar um Chromium específico (útil em ambientes onde o "headless
  // shell" do Playwright não está instalado — aí aponta-se o chrome completo e
  // roda-se headed sob um display virtual). No Windows normal, nada disso vale
  // e o Playwright usa o navegador que ele mesmo baixou.
  const chromeForcado = process.env.PINDUCALL_CHROME;
  const headed = Boolean(chromeForcado);

  const browser = await chromium.launch({
    headless: !headed,
    ...(chromeForcado ? { executablePath: chromeForcado } : {}),
    args: [
      '--no-sandbox',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Aceita getDisplayMedia sem picker, para o teste conseguir compartilhar tela.
      '--auto-select-desktop-capture-source=Entire screen',
      '--allow-http-screen-capture',
    ],
  });

  try {
    const alice = await openClient(browser, SIGNALING_PORT);

    check(
      'tela de conexão aparece primeiro',
      await alice.page.isVisible('#connect-screen') && await alice.page.isHidden('#room-screen'),
    );
    // --- Lista de salas ----------------------------------------------------
    await alice.page.waitForSelector('#room-list .room[data-id="geral"]', { timeout: 20_000 });
    check('a lista de salas vem do servidor', true);
    check(
      'a sala mostra quantas pessoas tem',
      /vazia/.test(await alice.page.textContent('#room-list .room[data-id="geral"]')),
      await alice.page.textContent('#room-list .room[data-id="geral"]'),
    );
    check(
      'a tela de entrada não tem campo de servidor nenhum',
      (await alice.page.locator('#input-server').count()) === 0
        && (await alice.page.locator('#btn-open-server').count()) === 0,
    );
    check(
      'o rodapé mostra o servidor fixo em uso',
      (await alice.page.textContent('#server-status')).includes(`127.0.0.1:${SIGNALING_PORT}`),
      await alice.page.textContent('#server-status'),
    );
    check(
      'o indicador do servidor fica verde quando ele responde',
      await alice.page.locator('#server-status.server-status--on').count() === 1,
    );

    // O nome é o único campo obrigatório da tela principal.
    await alice.page.fill('#input-name', 'Alice');

    // Senhas diferentes precisam ser barradas antes de ir ao servidor.
    await alice.page.click('#btn-open-create');
    await alice.page.fill('#create-nome', 'Hunt da Madruga');
    await alice.page.fill('#create-senha', 'senha-turma');
    await alice.page.fill('#create-senha2', 'senha-diferente');
    await alice.page.click('#btn-create');
    await alice.page.waitForSelector('#create-error:not(.hidden)', { timeout: 10_000 });
    check(
      'senhas diferentes barram a criação antes de ir ao servidor',
      /iguais/i.test(await alice.page.textContent('#create-error')),
    );

    check(
      'criar sala não pede código de servidor nenhum',
      (await alice.page.locator('#create-form input').count()) === 3,
      String(await alice.page.locator('#create-form input').count()),
    );

    await alice.page.fill('#create-senha2', 'senha-turma');
    await alice.page.fill('#input-name', 'Alice');
    await alice.page.click('#btn-create');
    await alice.page.waitForSelector('#room-screen:not(.hidden)', { timeout: 20_000 });
    check(
      'criar sala já entra nela com o nome certo',
      (await alice.page.textContent('#room-title')) === 'Hunt da Madruga',
      await alice.page.textContent('#room-title'),
    );

    await alice.page.click('#btn-leave');
    await alice.page.waitForSelector('#connect-screen:not(.hidden)', { timeout: 15_000 });
    await alice.page.waitForSelector('#room-list .room[data-id="hunt-da-madruga"]', { timeout: 20_000 });
    check('a sala criada passa a aparecer na lista', true);

    // Senha errada precisa mostrar erro sem travar a tela.
    await alice.page.fill('#input-name', 'Alice');
    await escolherSala(alice.page, 'geral');
    await alice.page.fill('#input-password', 'errada');
    await alice.page.click('#btn-connect');
    await alice.page.waitForSelector('#connect-error:not(.hidden)', { timeout: 15_000 });
    check(
      'senha errada mostra mensagem de erro',
      /senha/i.test(await alice.page.textContent('#connect-error')),
    );

    // Agora com a senha certa.
    await joinRoom(alice.page, 'Alice');
    check('entrar leva para a tela da sala', await alice.page.isVisible('#room-screen'));
    check('título da sala e exibido', (await alice.page.textContent('#room-title')) === 'geral');
    check(
      'seu próprio nome aparece na barra inferior',
      (await alice.page.textContent('#self-name')) === 'Alice',
    );
    check(
      'mensagem de sistema de entrada aparece no chat',
      /Você entrou/.test(await alice.page.textContent('#chat-messages')),
    );

    // Segunda pessoa.
    const bob = await openClient(browser, SIGNALING_PORT);
    await joinRoom(bob.page, 'Bob');

    await alice.page.waitForSelector('.peer[data-peer-id]', { timeout: 10_000 });
    check('Alice vê o Bob na lista de participantes', (await alice.page.textContent('#peer-list')).includes('Bob'));
    check(
      'contador mostra 2 pessoas',
      /2 \/ 10/.test(await alice.page.textContent('#room-count')),
      await alice.page.textContent('#room-count'),
    );

    // Chat.
    await bob.page.fill('#chat-input', 'oi Alice');
    await bob.page.press('#chat-input', 'Enter');
    await alice.page.waitForFunction(
      () => document.getElementById('chat-messages').textContent.includes('oi Alice'),
      { timeout: 10_000 },
    );
    check('mensagem do Bob aparece na tela da Alice', true);
    check(
      'autor da mensagem e exibido',
      (await alice.page.textContent('#chat-messages')).includes('Bob'),
    );
    check('campo de chat e limpo após enviar', (await bob.page.inputValue('#chat-input')) === '');

    // --- Arquivo no chat ---------------------------------------------------
    const pastaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinducall-anexo-'));

    // O clipe abre o seletor de arquivos do sistema.
    const [seletor] = await Promise.all([
      bob.page.waitForEvent('filechooser', { timeout: 15_000 }),
      bob.page.click('#btn-anexo'),
    ]);
    check('o clipe abre o seletor de arquivos', Boolean(seletor));

    /**
     * Solta um arquivo em cima do chat, como quem arrasta do Explorer.
     * É o caminho que dá para dirigir de fora do navegador sem depender do
     * seletor nativo, e exercita o mesmo envio do botão.
     */
    async function soltarNoChat(page, nome, conteudo, tipo = 'text/plain') {
      await page.evaluate(
        ({ nome, conteudo, tipo }) => {
          const arquivo = new File([conteudo], nome, { type: tipo });
          const dados = new DataTransfer();
          dados.items.add(arquivo);
          document
            .getElementById('chat-panel')
            .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dados }));
        },
        { nome, conteudo, tipo },
      );
    }

    await soltarNoChat(bob.page, 'relatório da hunt.txt', 'loot: 1.234.567 gp\nwaste: 300.000 gp\n');

    await alice.page.waitForSelector('#chat-messages .arquivo', { timeout: 25_000 });
    check('o arquivo do Bob aparece no chat da Alice', true);
    check(
      'o cartão mostra o nome do arquivo',
      (await alice.page.textContent('#chat-messages .arquivo')).includes('relatório da hunt.txt'),
      await alice.page.textContent('#chat-messages .arquivo'),
    );
    check(
      'o cartão mostra tamanho e prazo',
      /some em 24h/.test(await alice.page.textContent('.arquivo__meta')),
      await alice.page.textContent('.arquivo__meta'),
    );
    check(
      'o cartão oferece o download',
      (await alice.page.textContent('.arquivo__baixar')) === 'Baixar',
    );
    check('a barra de progresso some no fim', await bob.page.isHidden('#upload-bar'));

    // Executável precisa ser recusado antes de subir qualquer byte.
    await soltarNoChat(bob.page, 'jogo.exe', 'MZ', 'application/octet-stream');
    await bob.page.waitForFunction(
      () => /não é aceito/i.test(document.getElementById('toasts')?.textContent ?? ''),
      { timeout: 15_000 },
    );
    check('executável é recusado com recado na tela', true);
    check(
      'o executável não vira mensagem no chat',
      !(await alice.page.textContent('#chat-messages')).includes('jogo.exe'),
    );

    fs.rmSync(pastaTmp, { recursive: true, force: true });

    // Botão de mudo.
    await alice.page.click('#btn-mic');
    await alice.page.waitForFunction(
      () => document.getElementById('btn-mic').classList.contains('icon-btn--on'),
      { timeout: 5000 },
    );
    check('botão de microfone marca estado mudo', true);
    await bob.page.waitForFunction(
      () => document.getElementById('peer-list').innerHTML.includes('peer__badge--muted'),
      { timeout: 8000 },
    );
    check('Bob vê o ícone de mudo da Alice', true);
    await alice.page.click('#btn-mic');

    // Picker de tela (a captura em si exige Electron; aqui validamos a UI).
    await alice.page.click('#btn-share');
    await alice.page.waitForSelector('#screen-picker:not(.hidden)', { timeout: 5000 });
    check('modal de compartilhamento abre', true);
    check('picker lista as telas disponíveis', (await alice.page.textContent('#source-grid')).includes('Tela inteira'));
    check('botão compartilhar começa desabilitado', await alice.page.isDisabled('#btn-start-share'));

    await alice.page.click('.source');
    check('escolher uma fonte habilita o botão', !(await alice.page.isDisabled('#btn-start-share')));

    await alice.page.click('.tab[data-tab="window"]');
    check('aba de janelas filtra a lista', (await alice.page.textContent('#source-grid')).includes('Bloco de Notas'));

    await alice.page.keyboard.press('Escape');
    check('Escape fecha o modal', await alice.page.isHidden('#screen-picker'));

    // --- Compartilhamento de tela de verdade, atravessando o SFU -------------
    await alice.page.click('#btn-share');
    await alice.page.waitForSelector('#screen-picker:not(.hidden)', { timeout: 5000 });
    await alice.page.click('.tab[data-tab="screen"]');
    await alice.page.click('.source');
    await alice.page.click('#btn-start-share');

    const sharing = await alice.page
      .waitForSelector('#self-preview:not(.hidden)', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check('a prévia da própria tela aparece ao compartilhar', sharing);

    if (sharing) {
      // Espera o primeiro quadro decodificar: amostrar uma vez só dava corrida.
      const previewPlaying = await alice.page
        .waitForFunction(
          () => {
            const video = document.getElementById('self-preview-video');
            return Boolean(video?.srcObject) && video.videoWidth > 0;
          },
          { timeout: 15_000 },
        )
        .then(() => true)
        .catch(() => false);
      check('a prévia está tocando o stream local', previewPlaying);

      // O monitoramento lê getStats() do producer a cada 2s. A banda só aparece
      // na segunda amostra, porque depende da diferença entre duas leituras.
      const stats = await alice.page
        .waitForFunction(
          () => {
            const text = document.getElementById('self-preview-stats').textContent;
            return /\d+x\d+/.test(text) && /bps/.test(text) ? text : false;
          },
          { timeout: 30_000 },
        )
        .then((handle) => handle.jsonValue())
        .catch(() => null);
      check('o monitoramento mostra a resolução enviada', /\d+x\d+/.test(stats ?? ''), String(stats));
      check('o monitoramento mostra os quadros por segundo', /\d+ fps/.test(stats ?? ''), String(stats));
      check('o monitoramento mostra a banda em uso', /bps/.test(stats ?? ''), String(stats));

      // Ampliar / reduzir a prévia.
      await alice.page.click('#btn-preview-size');
      check('o botão amplia a prévia', await alice.page.evaluate(() =>
        document.getElementById('self-preview').classList.contains('self-preview--large'),
      ));
      await alice.page.click('#btn-preview-size');
      check('o botão reduz a prévia de volta', await alice.page.evaluate(() =>
        !document.getElementById('self-preview').classList.contains('self-preview--large'),
      ));

      // O outro lado recebe o vídeo?
      const bobGotScreen = await bob.page
        .waitForFunction(
          () => {
            const video = document.querySelector('#stage-grid .tile video');
            return Boolean(video && video.videoWidth > 0);
          },
          { timeout: 25_000 },
        )
        .then(() => true)
        .catch(() => false);
      check('Bob recebe a tela compartilhada da Alice', bobGotScreen);
      check(
        'o tile tem botão de tela cheia',
        (await bob.page.locator('#stage-grid .tile .tile__full').count()) === 1,
      );
      check(
        'o palco do Bob mostra quem está compartilhando',
        /Alice/.test(await bob.page.textContent('#stage-title')),
        await bob.page.textContent('#stage-title'),
      );
      check(
        'a lista do Bob marca a Alice como compartilhando',
        (await bob.page.innerHTML('#peer-list')).includes('peer__rec'),
      );

      // --- Janela que o Windows não consegue capturar ---------------------
      await bob.page.click('#btn-share');
      await bob.page.waitForSelector('#source-grid .source', { timeout: 15_000 });
      await bob.page.click('.tab[data-tab="window"]');
      await bob.page.waitForSelector('#source-grid .source--cega', { timeout: 10_000 });
      check('janela sem imagem ganha aviso na hora de escolher', true);
      check(
        'o aviso aparece só na janela problemática',
        (await bob.page.locator('#source-grid .source--cega').count()) === 1,
        String(await bob.page.locator('#source-grid .source--cega').count()),
      );
      check(
        'o aviso avisa que pode ir preto',
        (await bob.page.textContent('.source__aviso')).includes('pode ir preto'),
      );
      const dica = await bob.page.textContent('#source-dica');
      check(
        'a dica manda usar a câmera virtual, que é a saída que sobrou',
        /OBS/.test(dica) && /C\u00e2mera Virtual/i.test(dica),
        dica,
      );
      check('a dica diz de qual janela está falando', /Tibia/.test(dica), dica);
      check(
        'a dica explica que a trava é do Windows, não do app',
        /trava de cópia/i.test(dica) && /Windows/.test(dica),
        dica,
      );
      check(
        'a dica diz o que vai acontecer com quem assiste',
        /sair preta para todo mundo/i.test(dica),
        dica,
      );
      check(
        'a dica avisa que trocar o motor gráfico não adianta',
        /não resolve mais/i.test(dica),
        dica,
      );
      check('existe o botão de procurar de novo', await bob.page.isVisible('#btn-source-refresh'));

      // Câmera virtual: a saída para janela que o Windows proíbe copiar.
      await bob.page.click('.tab[data-tab="camera"]');
      await bob.page.waitForTimeout(300);
      const dicaCamera = await bob.page.textContent('#source-dica');
      check(
        'a aba de câmera explica para que serve',
        /OBS/.test(dicaCamera) && /Câmera Virtual|C\u00e2mera Virtual|câmera virtual/i.test(dicaCamera),
        dicaCamera,
      );
      check(
        'a câmera falsa do teste aparece como fonte',
        (await bob.page.locator('#source-grid .source').count()) >= 1,
      );
      const idCamera = await bob.page.getAttribute('#source-grid .source', 'data-source-id');
      check('a fonte de câmera é identificada como câmera', String(idCamera).startsWith('camera:'), String(idCamera));
      await bob.page.click('.tab[data-tab="screen"]');
      check('na aba de telas a dica some', await bob.page.isHidden('#source-dica'));

      // O caso que o modo moderno criou: a janela protegida some da lista
      // inteira. Sem aviso, a pessoa fica procurando um jogo que está aberto.
      await bob.page.evaluate(() => { window.pinducall.__semTibia = true; });
      await bob.page.click('.tab[data-tab="window"]');
      await bob.page.click('#btn-source-refresh');
      // A lista é recarregada de forma assíncrona: espere o jogo sumir da grade
      // antes de ler, senão o teste lê a tela antiga e passa por engano.
      await bob.page.waitForFunction(
        () => document.querySelectorAll('#source-grid .source--cega').length === 0
          && /não aparece na lista/i.test(document.getElementById('source-dica').textContent),
        null,
        { timeout: 15_000 },
      );
      const sumiu = await bob.page.textContent('#source-dica');
      check(
        'jogo aberto que sumiu da lista vira aviso',
        /Tibia/.test(sumiu) && /não aparece na lista/i.test(sumiu),
        sumiu,
      );
      check('o aviso de sumiço também aponta a câmera virtual', /OBS/.test(sumiu), sumiu);
      check(
        'nenhuma janela ganha etiqueta de preto quando o jogo sumiu',
        (await bob.page.locator('#source-grid .source--cega').count()) === 0,
      );
      await bob.page.evaluate(() => { window.pinducall.__semTibia = false; });
      await bob.page.click("#screen-picker .modal__header .icon-btn");
      await bob.page.waitForSelector('#screen-picker', { state: 'hidden', timeout: 10_000 });

      // Parar pelo botão da prévia.
      await alice.page.click('#btn-preview-stop');
      await alice.page.waitForSelector('#self-preview', { state: 'hidden', timeout: 10_000 });
      check('parar pela prévia esconde a prévia', await alice.page.isHidden('#self-preview'));
      check(
        'o botão volta a oferecer compartilhar',
        (await alice.page.textContent('#btn-share')) === 'Compartilhar tela',
      );

      const bobTileGone = await bob.page
        .waitForFunction(() => document.querySelectorAll('#stage-grid .tile').length === 0, {
          timeout: 15_000,
        })
        .then(() => true)
        .catch(() => false);
      check('a tela some do palco do Bob quando para', bobTileGone);
    }

    // =========================================================================
    // Painel do Tibia: timers, split e DJ
    // =========================================================================

    check('o painel do Tibia aparece na coluna da direita', await alice.page.isVisible('#tibia-panel'));
    check(
      'o chat fica abaixo do painel',
      await alice.page.evaluate(() => {
        const painel = document.getElementById('tibia-panel').getBoundingClientRect();
        const chat = document.getElementById('chat-panel').getBoundingClientRect();
        return chat.top >= painel.bottom - 2 && chat.left === painel.left;
      }),
    );
    check('o painel tem as três abas', (await alice.page.locator('.ttab').count()) === 3);

    // --- Timers --------------------------------------------------------------
    const mmTexto = await alice.page.textContent('#timer-list');
    check('a sala já vem com o timer da mastermind', /Mastermind Potion/.test(mmTexto), mmTexto);
    check(
      'o timer parado mostra a duração cheia',
      /10:00/.test(await alice.page.textContent('#timer-list')),
      await alice.page.textContent('#timer-list'),
    );

    // Alice inicia -> tem que contar no PC do Bob também.
    await alice.page.click('.timer[data-id="mastermind"] .timer__btn--play');

    const bobContando = await bob.page
      .waitForFunction(
        () => {
          const item = document.querySelector('.timer[data-id="mastermind"]');
          if (!item?.classList.contains('timer--rodando')) return false;
          const t = item.querySelector('.timer__tempo').textContent;
          return t !== '10:00' && /^0?9:\d\d$/.test(t);
        },
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    check('timer iniciado por um conta na tela do outro', bobContando);

    check(
      'o aviso de quem iniciou chega',
      await bob.page.evaluate(() => document.querySelector('.timer[data-id="mastermind"]').classList.contains('timer--rodando')),
    );

    // Bob para -> volta ao estado parado na tela da Alice.
    await bob.page.click('.timer[data-id="mastermind"] .timer__btn--play');
    const aliceParou = await alice.page
      .waitForFunction(
        () => !document.querySelector('.timer[data-id="mastermind"]')?.classList.contains('timer--rodando'),
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    check('parar o timer também vale para a sala toda', aliceParou);

    // Criar e remover um timer personalizado.
    await alice.page.fill('#timer-nome', 'Boss sala 2');
    await alice.page.fill('#timer-min', '1');
    await alice.page.fill('#timer-seg', '30');
    await alice.page.click('#timer-form button[type="submit"]');

    const bobViuNovo = await bob.page
      .waitForFunction(() => document.getElementById('timer-list').textContent.includes('Boss sala 2'), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    check('timer criado por um aparece para o outro', bobViuNovo);
    check(
      'a duração do timer criado está certa',
      /01:30/.test(await bob.page.textContent('#timer-list')),
      await bob.page.textContent('#timer-list'),
    );
    check('o campo de nome é limpo após criar', (await alice.page.inputValue('#timer-nome')) === '');

    check(
      'o timer fixo não oferece botão de remover',
      (await alice.page.locator('.timer[data-id="mastermind"] .timer__btn--del').count()) === 0,
    );

    // Espera o timer aparecer na tela da Alice também: o broadcast chega em
    // cada cliente no seu tempo, e antes disso o id ainda não existe aqui.
    const idNovo = await alice.page
      .waitForFunction(
        () => {
          const item = [...document.querySelectorAll('.timer')].find((i) =>
            i.textContent.includes('Boss sala 2'),
          );
          return item?.dataset.id ?? false;
        },
        { timeout: 10_000 },
      )
      .then((handle) => handle.jsonValue());
    check('o timer criado também aparece para quem criou', Boolean(idNovo), String(idNovo));
    await alice.page.click(`.timer[data-id="${idNovo}"] .timer__btn--del`);
    const bobViuRemocao = await bob.page
      .waitForFunction(() => !document.getElementById('timer-list').textContent.includes('Boss sala 2'), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    check('remover timer vale para a sala toda', bobViuRemocao);

    // --- Split de loot -------------------------------------------------------
    await alice.page.click('.ttab[data-ttab="split"]');
    check('a aba de split abre', await alice.page.isVisible('#ttab-split'));
    check('a aba de timers fecha ao trocar', await alice.page.isHidden('#ttab-timers'));

    const LOG = [
      'Session data: From 2026-08-13, 20:00:00 to 2026-08-13, 22:00:00',
      'Session: 02:00h',
      'Loot Type: Leader',
      'Loot: 1,000,000',
      'Supplies: 400,000',
      'Balance: 600,000',
      'Caucau (Leader)',
      '    Loot: 800,000',
      '    Supplies: 100,000',
      '    Balance: 700,000',
      '    Damage: 1,000,000',
      '    Healing: 200,000',
      'Mago Ducca',
      '    Loot: 200,000',
      '    Supplies: 300,000',
      '    Balance: -100,000',
      '    Damage: 900,000',
      '    Healing: 150,000',
    ].join('\n');

    await alice.page.fill('#split-log', 'isso aqui não é um log');
    await alice.page.click('#split-calc');
    check(
      'log inválido explica o que fazer',
      (await alice.page.textContent('#split-result')).includes('Session data'),
    );

    await alice.page.fill('#split-log', LOG);
    await alice.page.click('#split-calc');
    const resultado = await alice.page.textContent('#split-result');
    check('o split reconhece os dois players', /2 players/.test(resultado), resultado);
    check('a parte de cada um é calculada', /300k/.test(resultado), resultado);
    check(
      'quem lucrou mais paga quem lucrou menos',
      /Caucau.*400k.*Mago Ducca/s.test(resultado),
      resultado,
    );

    await alice.page.click('#split-send');
    const bobViuSplit = await bob.page
      .waitForFunction(() => document.getElementById('chat-messages').textContent.includes('Split da hunt'), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    check('o split pode ser mandado no chat da sala', bobViuSplit);

    // --- Modo DJ -------------------------------------------------------------
    await alice.page.click('.ttab[data-ttab="dj"]');
    check('a aba do DJ abre', await alice.page.isVisible('#ttab-dj'));
    check(
      'começa sem ninguém no comando',
      /Ninguém está tocando/.test(await alice.page.textContent('#dj-status')),
    );

    await alice.page.click('#dj-claim');
    const aliceDj = await alice.page
      .waitForFunction(() => document.getElementById('dj-status').textContent.includes('Você está no comando'), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    check('assumir o comando da música funciona', aliceDj);
    check('as ferramentas de DJ aparecem para quem assumiu', await alice.page.isVisible('#dj-owner-tools'));
    check('o botão de assumir some', await alice.page.isHidden('#dj-claim'));

    await bob.page.click('.ttab[data-ttab="dj"]');
    const bobViuDj = await bob.page
      .waitForFunction(() => document.getElementById('dj-status').textContent.includes('Alice'), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    check('a sala vê quem está no comando da música', bobViuDj);
    check('quem não é DJ não vê as ferramentas', await bob.page.isHidden('#dj-owner-tools'));
    check('os controles de música ficam visíveis para todos', await bob.page.isVisible('#dj-play'));

    // O comando de quem não é DJ tem que viajar até o DJ sem erro.
    await bob.page.click('#dj-next');
    await sleep(600);

    await alice.page.click('#dj-release');
    const soltou = await bob.page
      .waitForFunction(() => document.getElementById('dj-status').textContent.includes('Ninguém está tocando'), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    check('soltar o comando avisa a sala', soltou);

    await alice.page.click('.ttab[data-ttab="timers"]');

    // Ocultar o chat.
    await alice.page.click('#btn-toggle-chat');
    check('botão esconde o painel de chat', await alice.page.isHidden('#chat-panel'));
    await alice.page.click('#btn-toggle-chat');
    check('botão mostra o chat de novo', await alice.page.isVisible('#chat-panel'));

    // Configurações.
    await alice.page.click('#btn-settings');
    await alice.page.waitForSelector('#settings-modal:not(.hidden)', { timeout: 5000 });
    check('modal de configurações abre', true);

    // As configurações agora vêm em abas; a de Perfil abre primeiro com o avatar.
    check(
      'a aba Perfil traz o seletor de avatar',
      (await alice.page.locator('#avatar-emojis .pick-emoji').count()) > 1
        && (await alice.page.locator('#avatar-cores .pick-cor').count()) >= 1,
    );

    // Áudio numa aba própria.
    await alice.page.click('.set-tab[data-set="audio"]');
    check(
      'lista de microfones foi preenchida',
      (await alice.page.locator('#select-input option').count()) >= 1,
    );
    check(
      'lista de saídas de áudio foi preenchida',
      (await alice.page.locator('#select-output option').count()) >= 1,
    );

    // Modo de captura: fica na aba "Tela". É o que resolve jogo aparecendo
    // preto, então precisa aparecer, começar no que o app usa e valer ao trocar.
    await alice.page.click('.set-tab[data-set="tela"]');
    check(
      'o modo de captura aparece nas configurações',
      await alice.page.isVisible('#select-captura'),
    );
    check(
      'o modo de captura vem marcado no que está em uso',
      (await alice.page.inputValue('#select-captura')) === 'moderno',
    );
    await alice.page.selectOption('#select-captura', 'antigo');
    check(
      'trocar o modo de captura chega no processo principal',
      (await alice.page.evaluate(() => window.pinducall.__modoPedido)) === 'antigo',
    );
    await alice.page.selectOption('#select-captura', 'moderno');

    // Regressão: sem color-scheme dark, o popup nativo do <select> abre em modo
    // claro e as opções ficam brancas no branco — a lista parece vazia.
    const selectLook = await alice.page.evaluate(() => {
      const option = document.querySelector('#select-input option');
      const style = getComputedStyle(option);
      const parse = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);
      const luma = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return {
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        bgLuma: luma(parse(style.backgroundColor)),
        textLuma: luma(parse(style.color)),
      };
    });
    check(
      'o tema declara color-scheme dark',
      selectLook.colorScheme.includes('dark'),
      selectLook.colorScheme,
    );
    check(
      'as opções do select têm contraste (texto claro sobre fundo escuro)',
      selectLook.textLuma - selectLook.bgLuma > 0.4,
      `fundo=${selectLook.bgLuma.toFixed(2)} texto=${selectLook.textLuma.toFixed(2)}`,
    );
    await alice.page.click('#settings-modal .modal__footer [data-close]');
    check('modal de configurações fecha', await alice.page.isHidden('#settings-modal'));

    // --- Convite -----------------------------------------------------------
    await alice.page.click('#btn-invite');
    await alice.page.waitForFunction(
      () => /\/c\//.test(document.getElementById('invite-url')?.value ?? ''),
      { timeout: 15_000 },
    );
    const linkConvite = await alice.page.inputValue('#invite-url');
    check('o botão Convidar gera um link', /\/c\/[A-Za-z0-9_-]{16,}$/.test(linkConvite), linkConvite);
    check(
      'o modal diz para qual sala é o convite',
      (await alice.page.textContent('#invite-sala')) === 'geral',
      await alice.page.textContent('#invite-sala'),
    );
    check(
      'o modal mostra a validade do link',
      /24 horas/.test(await alice.page.textContent('#invite-validade')),
      await alice.page.textContent('#invite-validade'),
    );
    await alice.page.click("#invite-modal .modal__footer .btn");

    const token = linkConvite.split('/c/')[1];
    const deepLink = `pinduccall://entrar?t=${token}&srv=${encodeURIComponent(`ws://127.0.0.1:${SIGNALING_PORT}/ws`)}`;

    // Convidado novo: nunca abriu o app, então não tem nome salvo.
    const visita = await openClient(browser, SIGNALING_PORT);
    await visita.page.waitForSelector('#room-list .room[data-id="geral"]', { timeout: 20_000 });

    await visita.page.evaluate((url) => window.__dispararConvite(url), deepLink);
    await visita.page.waitForSelector('#guest-modal:not(.hidden)', { timeout: 15_000 });
    check('convite sem nome salvo pede só o nome', true);
    check(
      'o popup diz para qual sala a pessoa foi chamada',
      (await visita.page.textContent('#guest-sala')) === 'geral',
      await visita.page.textContent('#guest-sala'),
    );

    await visita.page.fill('#guest-nome', 'Visita');
    await visita.page.click('#btn-guest-enter');
    await visita.page.waitForSelector('#room-screen:not(.hidden)', { timeout: 25_000 });
    check('o convidado entra direto na sala, sem senha', true);
    check(
      'o convidado cai na sala certa',
      (await visita.page.textContent('#room-title')) === 'geral',
      await visita.page.textContent('#room-title'),
    );
    check(
      'o nome escolhido no popup é usado',
      (await visita.page.textContent('#self-name')) === 'Visita',
    );
    await alice.page.waitForFunction(
      () => document.getElementById('peer-list').textContent.includes('Visita'),
      { timeout: 15_000 },
    );
    check('quem já estava na sala vê o convidado chegar', true);

    // Com o nome já salvo, o convite entra sem perguntar nada.
    await visita.page.click('#btn-leave');
    await visita.page.waitForSelector('#connect-screen:not(.hidden)', { timeout: 15_000 });
    await visita.page.evaluate((url) => window.__dispararConvite(url), deepLink);
    await visita.page.waitForSelector('#room-screen:not(.hidden)', { timeout: 25_000 });
    check('na segunda vez o convite entra sem perguntar nada', true);
    check('o popup de nome não reaparece', await visita.page.isHidden('#guest-modal'));

    // Convite inventado precisa falhar com recado, não em silêncio.
    await visita.page.click('#btn-leave');
    await visita.page.waitForSelector('#connect-screen:not(.hidden)', { timeout: 15_000 });
    await visita.page.evaluate(
      (srv) => window.__dispararConvite(`pinduccall://entrar?t=tokeninventado123&srv=${encodeURIComponent(srv)}`),
      `ws://127.0.0.1:${SIGNALING_PORT}/ws`,
    );
    await visita.page.waitForSelector('#toasts .toast--error', { timeout: 15_000 });
    check(
      'convite falso explica o que houve',
      /expirou|não existe/i.test(await visita.page.textContent('#toasts .toast--error')),
      await visita.page.textContent('#toasts .toast--error'),
    );

    await visita.page.close();

    // Sair.
    await alice.page.click('#btn-leave');
    await alice.page.waitForSelector('#connect-screen:not(.hidden)', { timeout: 10_000 });
    check('sair volta para a tela de conexão', await alice.page.isHidden('#room-screen'));

    await bob.page.waitForFunction(
      () => document.getElementById('chat-messages').textContent.includes('saiu da sala'),
      { timeout: 10_000 },
    );
    check('Bob e avisado de que a Alice saiu', true);

    // O erro de senha incorreta e provocado de proposito la em cima.
    const allErrors = [...alice.errors, ...bob.errors].filter(
      (message) =>
        !/Senha da sala incorreta|convite (expirou|falhou)|Este convite expirou|não é aceito aqui/i.test(
          message,
        ),
    );
    check('nenhum erro de JavaScript inesperado no console', allErrors.length === 0, allErrors.join(' | '));
  } finally {
    await browser.close();
    staticServer.close();
    signaling.child.kill('SIGTERM');
    await sleep(600);
    if (signaling.child.exitCode === null) signaling.child.kill('SIGKILL');
  }

  console.log(`\n${checks - failures}/${checks} verificações passaram.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nTeste de UI explodiu:', error);
  process.exit(1);
});
