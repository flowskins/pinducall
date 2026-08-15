/**
 * Teste de integração do app Electron de verdade.
 *
 * Sobe o processo principal (electron/main.js), abre a janela e conversa com
 * a ponte do preload (window.pinducall) exatamente como o renderer faz. É o que
 * cobre a parte que os testes em Chromium puro não alcançam: IPC, store de
 * preferências, desktopCapturer e o handler de getDisplayMedia.
 *
 *   xvfb-run -a node scripts/electron-test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');

// A versão vem do package.json: assim o teste não quebra a cada release.
const expectedVersion = JSON.parse(
  fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8'),
).version;

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

/**
 * Leitura da trava de cópia das janelas. O que roda no Windows é o PowerShell,
 * que não existe aqui — mas a parte que interpreta a resposta dele é JS puro e
 * é onde mora o risco de errar (linha torta, título com tabulação, lixo).
 */
async function testarLeitorDeJanelas() {
  const { interpretar, listarJanelas } = await import('../electron/janelas-windows.js');

  const janelas = interpretar(
    '0\t100\tNotepad\tBloco de Notas\r\n1\t200\tQt5QWindowIcon\tTibia - Messiah Two\r\n'
    + '17\t300\tChrome_WidgetWin_1\tNetflix\r\n\r\nlixo\r\n0\t400\tFoo\t',
  );

  check('lê uma janela por linha, ignorando lixo', janelas.length === 3, JSON.stringify(janelas));
  check('janela sem trava fica livre', janelas[0].travada === false);
  check(
    'WDA_MONITOR (1) conta como travada — é o caso do Tibia em DirectX',
    janelas[1].travada === true && janelas[1].titulo === 'Tibia - Messiah Two',
    JSON.stringify(janelas[1]),
  );
  check('WDA_EXCLUDEFROMCAPTURE (17) também conta como travada', janelas[2].travada === true);
  check('lê a classe da janela (usada pra apontar o OBS)', janelas[1].classe === 'Qt5QWindowIcon', JSON.stringify(janelas[1]));
  check('fora do Windows a consulta devolve lista vazia', (await listarJanelas()).length === 0);
}

async function main() {
  console.log('\nAbrindo o app Electron...\n');
  await testarLeitorDeJanelas();

  // userData isolado para o teste não sujar o perfil real.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinducall-test-'));

  // Aponta explicitamente para o Electron instalado no projeto: o Playwright
  // procura no node_modules dele, que pode ser outro diretório.
  const electronBinary = fs
    .readFileSync(path.join(clientDir, 'node_modules', 'electron', 'path.txt'), 'utf8')
    .trim();

  const app = await electron.launch({
    executablePath: path.join(clientDir, 'node_modules', 'electron', 'dist', electronBinary),
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`],
    cwd: clientDir,
  });

  const mainErrors = [];
  app.process().stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    // Ruído conhecido de container sem GPU/D-Bus/áudio; não indica problema no app.
    if (/GPU|dbus|bus\.cc|connect to the bus|libva|ALSA|Fontconfig|gbm|vulkan|sandbox/i.test(text)) return;
    mainErrors.push(text.trim());
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const pageErrors = [];
    window.on('pageerror', (error) => pageErrors.push(error.message));
    window.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    check('a janela principal abre', Boolean(window));
    check('o título da janela é PinduCcall', (await window.title()) === 'PinduCcall');

    // --- Ponte do preload ----------------------------------------------------
    const bridge = await window.evaluate(() => ({
      exists: typeof window.pinducall === 'object',
      screen: Object.keys(window.pinducall?.screen ?? {}),
      settings: Object.keys(window.pinducall?.settings ?? {}),
      app: Object.keys(window.pinducall?.app ?? {}),
      onToggleMute: typeof window.pinducall?.onToggleMute,
      onDeepLink: typeof window.pinducall?.onDeepLink,
      // O isolamento tem que estar valendo: nada de Node no renderer.
      nodeLeak: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
    }));

    check('a ponte window.pinducall existe', bridge.exists);
    check('expõe a API de tela', ['list', 'select', 'cancel', 'avisos'].every((k) => bridge.screen.includes(k)), JSON.stringify(bridge.screen));
    check('expõe a API de preferências', ['get', 'set'].every((k) => bridge.settings.includes(k)));
    check('expõe a API do app', ['info', 'openExternal', 'flashTaskbar'].every((k) => bridge.app.includes(k)));
    check('expõe o atalho de mudo', bridge.onToggleMute === 'function');
    check('expõe o canal de links de convite', bridge.onDeepLink === 'function');
    check('o renderer NÃO tem acesso ao Node (contextIsolation)', bridge.nodeLeak === false);

    // --- Informações do app --------------------------------------------------
    const info = await window.evaluate(() => window.pinducall.app.info());
    check(
      'app.info devolve a versão do package.json',
      info.version === expectedVersion,
      `${info.version} != ${expectedVersion}`,
    );
    check('app.info devolve a versão do Electron', /^\d+\./.test(info.electron ?? ''), info.electron);
    check(
      'app.info diz qual modo de captura está valendo',
      typeof info.modoCaptura === 'string' && info.modosDeCaptura?.some((m) => m.id === info.modoCaptura),
      JSON.stringify({ modoCaptura: info.modoCaptura, modos: info.modosDeCaptura }),
    );
    check(
      'o modo Moderno (WGC) está na lista — é o que enxerga jogo em DirectX',
      info.modosDeCaptura?.some((m) => m.id === 'moderno' && /Graphics Capture/i.test(m.rotulo)),
      JSON.stringify(info.modosDeCaptura),
    );
    check('a ponte expõe a troca de modo de captura', bridge.app.includes('setModoCaptura'));

    // Escolher o mesmo modo que já está valendo não pode reabrir o app —
    // senão abrir as configurações e mexer sem querer derrubaria a chamada.
    const mesmoModo = await window.evaluate(
      (modo) => window.pinducall.app.setModoCaptura(modo),
      info.modoCaptura,
    );
    check('escolher o modo atual não reabre o app', mesmoModo?.ok === true && mesmoModo?.reiniciou === false);
    check(
      'modo desconhecido é recusado',
      (await window.evaluate(() => window.pinducall.app.setModoCaptura('sei-la')))?.ok === false,
    );

    // --- Preferências --------------------------------------------------------
    const defaults = await window.evaluate(() => window.pinducall.settings.get());
    check('preferências trazem valores padrão', defaults.serverUrl?.startsWith('ws://'), defaults.serverUrl);

    const saved = await window.evaluate(() =>
      window.pinducall.settings.set({ displayName: 'Teste', roomId: 'sala-x', micVolume: 0.5 }),
    );
    check('settings.set devolve o estado atualizado', saved.displayName === 'Teste' && saved.roomId === 'sala-x');

    const reread = await window.evaluate(() => window.pinducall.settings.get());
    check('preferências persistem entre chamadas', reread.displayName === 'Teste' && reread.micVolume === 0.5);

    // A senha só pode ir para o disco se a pessoa pediu para lembrar.
    await window.evaluate(() => window.pinducall.settings.set({ password: 'segredo', rememberPassword: false }));
    const settingsFile = path.join(userDataDir, 'settings.json');
    const onDisk = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    check('a senha NÃO é gravada em disco sem "lembrar"', onDisk.password === '', JSON.stringify(onDisk.password));

    await window.evaluate(() => window.pinducall.settings.set({ password: 'segredo', rememberPassword: true }));
    const onDisk2 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('a senha é gravada quando "lembrar" está ligado', onDisk2.password === 'segredo');

    // --- desktopCapturer -----------------------------------------------------
    const sources = await window.evaluate(() => window.pinducall.screen.list());
    check('desktopCapturer lista fontes de tela', Array.isArray(sources) && sources.length > 0, `(${sources?.length} fontes)`);
    check(
      'cada fonte traz id, nome e tipo',
      sources.every((s) => s.id && typeof s.name === 'string' && ['screen', 'window'].includes(s.kind)),
      JSON.stringify(sources[0] ?? {}),
    );
    check('há pelo menos uma tela inteira disponível', sources.some((s) => s.kind === 'screen'));
    check(
      'cada fonte diz se a miniatura veio vazia',
      sources.every((s) => typeof s.miniaturaVazia === 'boolean'),
      JSON.stringify(sources.map((s) => s.miniaturaVazia)),
    );

    // Fora do Windows não há tasklist para consultar: precisa devolver lista
    // vazia em vez de explodir.
    const avisos = await window.evaluate(() =>
      window.pinducall.screen.avisos(['Bloco de Notas']),
    );
    check('screen.avisos responde sem quebrar', Array.isArray(avisos), JSON.stringify(avisos));

    const selected = await window.evaluate(
      (id) => window.pinducall.screen.select(id, true),
      sources.find((s) => s.kind === 'screen').id,
    );
    check('screen.select aceita a escolha', selected?.ok === true);

    // --- getDisplayMedia de verdade -----------------------------------------
    // Prova que o handler do processo principal devolve a fonte escolhida.
    const capture = await window.evaluate(async (id) => {
      await window.pinducall.screen.select(id, false);
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings?.() ?? {};
        stream.getTracks().forEach((t) => t.stop());
        return { ok: Boolean(track), width: settings.width ?? 0, height: settings.height ?? 0 };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }, sources.find((s) => s.kind === 'screen').id);

    check('getDisplayMedia entrega a tela escolhida', capture.ok === true, JSON.stringify(capture));
    check('a captura tem resolução válida', capture.width > 0 && capture.height > 0, JSON.stringify(capture));

    // Cancelar a escolha faz a próxima captura ser recusada, como esperado.
    const cancelled = await window.evaluate(async () => {
      await window.pinducall.screen.cancel();
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        stream.getTracks().forEach((t) => t.stop());
        return { captured: true };
      } catch (error) {
        return { captured: false, error: error.name };
      }
    });
    check('sem fonte escolhida a captura é recusada', cancelled.captured === false, JSON.stringify(cancelled));

    // --- Interface -----------------------------------------------------------
    check('a tela de conexão está visível', await window.isVisible('#connect-screen'));
    check('a tela da sala começa escondida', await window.isHidden('#room-screen'));
    check('os ícones dos botões foram renderizados', (await window.innerHTML('#btn-mic')).includes('<svg'));
    check(
      'a versão aparece nas configurações',
      (await window.textContent('#app-version')).includes(`PinduCcall ${expectedVersion}`),
      await window.textContent('#app-version'),
    );

    // Sem servidor no ar, a tela de entrada precisa avisar em vez de ficar muda.
    await window.waitForFunction(
      () => /fora do ar|endereço errado/i.test(document.getElementById('rooms-status')?.textContent ?? ''),
      null,
      { timeout: 30_000 },
    );
    check('sem servidor, a lista de salas explica o problema', true);
    check('a tela de entrada não mostra mais campo de IP', await window.isHidden('#input-server'));

    // O teste roda sem servidor: a falha de conexão do WebSocket e esperada.
    const rendererErrors = pageErrors.filter(
      (message) => !/WebSocket connection to .* failed/i.test(message),
    );
    check('nenhum erro de JavaScript no renderer', rendererErrors.length === 0, rendererErrors.join(' | '));
    check('nenhum erro no processo principal', mainErrors.length === 0, mainErrors.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Perfil separado: é o que permite abrir duas cópias e testar a sala sozinho.
  // ---------------------------------------------------------------------------
  const profileDir = path.join(path.dirname(userDataDir), 'PinduCcall-teste');
  fs.rmSync(profileDir, { recursive: true, force: true });

  const second = await electron.launch({
    executablePath: path.join(clientDir, 'node_modules', 'electron', 'dist', electronBinary),
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`, '--profile=teste'],
    cwd: clientDir,
  });

  try {
    const window = await second.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    check('o perfil extra abre normalmente', Boolean(window));

    // window.title() devolve o document.title da página; o título que aparece
    // na barra e na taskbar vem do processo principal.
    const osTitle = await second.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getTitle(),
    );
    check('o título da janela identifica o perfil', osTitle === 'PinduCcall (teste)', String(osTitle));

    await window.evaluate(() => window.pinducall.settings.set({ displayName: 'Segunda pessoa' }));

    check('o perfil extra grava em uma pasta própria', fs.existsSync(path.join(profileDir, 'settings.json')));

    const perfilSalvo = JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8'));
    const principalSalvo = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'));
    check(
      'as preferências dos dois perfis não se misturam',
      perfilSalvo.displayName === 'Segunda pessoa' && principalSalvo.displayName === 'Teste',
      `${perfilSalvo.displayName} / ${principalSalvo.displayName}`,
    );
  } finally {
    await second.close().catch(() => {});
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} verificações passaram.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nTeste do Electron explodiu:', error);
  process.exit(1);
});
