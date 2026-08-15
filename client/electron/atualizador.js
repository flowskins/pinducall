const { app, ipcMain, shell } = require('electron');
const https = require('node:https');

/**
 * Auto-atualização do PinduCcall, via GitHub Releases.
 *
 * Toda vez que o app abre ele pergunta ao GitHub se existe uma versão nova.
 *  - Versão INSTALADA (NSIS): o electron-updater baixa sozinho em segundo plano
 *    e aplica quando a pessoa fecha o app (ou na hora, se ela clicar "reiniciar").
 *    O provedor "github" vem embutido no app-update.yml (gerado do package.json).
 *  - Versão PORTÁTIL: não dá para se instalar sozinha, então só olhamos a última
 *    release pela API do GitHub e avisamos que saiu versão nova.
 */

/** Repositório que hospeda as releases. */
const REPO = 'flowskins/pinducall';

/** Página onde a pessoa baixa o app na mão (botões apontam pro GitHub). */
const PAGINA_DOWNLOAD = 'https://pinducall.vercel.app/#baixar';

let janelaRef = null;

/** Manda o estado da atualização para a interface (se a janela ainda existir). */
function avisar(status, dados = {}) {
  try {
    janelaRef?.webContents?.send('update:status', { status, ...dados });
  } catch {
    /* janela já fechou */
  }
}

/** True quando estamos rodando a versão portátil (não instalada). */
function ehPortatil() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

/** GET simples em HTTPS, devolvendo o corpo como texto. */
function baixarTexto(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let txt = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (txt += c));
      res.on('end', () => resolve(txt));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('tempo esgotado')));
  });
}

/** Compara "1.7.7" > "1.7.6" numericamente, campo a campo. */
function versaoMaior(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/** Portátil: olha a última release no GitHub e avisa se saiu versão nova. */
async function checarPortatil() {
  try {
    const json = await baixarTexto(`https://api.github.com/repos/${REPO}/releases/latest`, {
      'User-Agent': 'PinduCcall',
      Accept: 'application/vnd.github+json',
    });
    const dados = JSON.parse(json);
    const tag = String(dados.tag_name ?? '').replace(/^v/i, '');
    if (tag && versaoMaior(tag, app.getVersion())) {
      avisar('disponivel-manual', { versao: tag, url: PAGINA_DOWNLOAD });
    }
  } catch (erro) {
    console.warn('[update] checagem (portátil) falhou:', erro.message);
  }
}

/**
 * Liga a auto-atualização. Chamar uma vez, logo depois de abrir a janela.
 * @param {import('electron').BrowserWindow} janela
 */
function configurarAtualizador(janela) {
  janelaRef = janela;

  // "Reiniciar agora" fecha o app e aplica a atualização já baixada.
  ipcMain.handle('update:reiniciar', () => {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.quitAndInstall(false, true);
    } catch (erro) {
      console.warn('[update] não consegui reiniciar para atualizar:', erro.message);
    }
    return { ok: true };
  });

  // Portátil: abre a página de download.
  ipcMain.handle('update:abrir-download', () => {
    shell.openExternal(PAGINA_DOWNLOAD);
    return { ok: true };
  });

  // Em desenvolvimento não há o que atualizar.
  if (!app.isPackaged) return;

  if (ehPortatil()) {
    checarPortatil();
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (erro) {
    console.warn('[update] electron-updater indisponível:', erro.message);
    return;
  }

  autoUpdater.autoDownload = true;
  // Aplica ao fechar o app, sem interromper ninguém no meio de uma call.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => avisar('baixando', { versao: info?.version }));
  autoUpdater.on('update-not-available', () => avisar('atual'));
  autoUpdater.on('download-progress', (p) =>
    avisar('progresso', { percent: Math.round(p?.percent ?? 0) }),
  );
  autoUpdater.on('update-downloaded', (info) => avisar('pronta', { versao: info?.version }));
  autoUpdater.on('error', (err) => {
    console.warn('[update] erro:', err?.message);
  });

  autoUpdater
    .checkForUpdates()
    .catch((err) => console.warn('[update] checagem falhou:', err?.message));
}

module.exports = { configurarAtualizador };
