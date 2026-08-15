const { execFile } = require('node:child_process');

/**
 * Pergunta ao Windows quais janelas estão abertas e quais delas estão
 * TRAVADAS contra cópia.
 *
 * Existe uma marca por janela no Windows (display affinity) que o próprio
 * programa liga para proibir qualquer captura: `WDA_MONITOR` faz a janela sair
 * preta em qualquer gravação, e `WDA_EXCLUDEFROMCAPTURE` a some das capturas.
 * O Tibia liga isso quando está no motor gráfico DirectX — e é por isso que
 * nem trocar de API de captura resolve.
 *
 * Sem esta consulta, o app só consegue dizer "a miniatura veio preta, sei lá
 * por quê". Com ela, dá para dizer exatamente qual janela travou e o que
 * fazer. É leitura pura: nada é alterado no sistema.
 *
 * O caminho é o PowerShell do próprio Windows chamando duas funções do
 * user32. Se qualquer coisa der errado — política de execução, PowerShell
 * ausente, demora — devolve lista vazia e o app volta a se virar com a
 * miniatura preta.
 */

// Mantido curto de propósito: é código que roda na máquina de quem usa o app,
// então tem que caber na tela e ser conferível de bater o olho.
const SCRIPT = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class PcJan{
 public delegate bool Cb(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int m);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int m);
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 public static List<string> Ler(){
  var fora=new List<string>();
  EnumWindows(delegate(IntPtr h,IntPtr p){
   if(!IsWindowVisible(h)) return true;
   int n=GetWindowTextLength(h); if(n<=0) return true;
   var sb=new StringBuilder(n+2); GetWindowText(h,sb,sb.Capacity);
   var cls=new StringBuilder(128); GetClassName(h,cls,cls.Capacity);
   uint af; if(!GetWindowDisplayAffinity(h,out af)) af=0;
   uint pid; GetWindowThreadProcessId(h,out pid);
   fora.Add(af+"\\t"+pid+"\\t"+cls+"\\t"+sb.ToString());
   return true;
  },IntPtr.Zero);
  return fora;
 }
}
"@
[PcJan]::Ler() | ForEach-Object { $_ }
`;

const VALIDADE_MS = 5000;

let cache = { quando: 0, janelas: [] };
let emAndamento = null;

function rodarPowerShell() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (erro, saida) => resolve(erro ? '' : String(saida)),
    );
  });
}

function interpretar(texto) {
  return texto
    .split(/\r?\n/)
    .map((linha) => linha.split('\t'))
    .filter((campos) => campos.length >= 4)
    .map(([afinidade, pid, classe, ...resto]) => ({
      titulo: resto.join('\t').trim(),
      classe: String(classe ?? '').trim(),
      pid: Number(pid),
      // 0 = livre. 1 = WDA_MONITOR (sai preta). 17 = WDA_EXCLUDEFROMCAPTURE (some).
      afinidade: Number(afinidade),
      travada: Number(afinidade) !== 0,
    }))
    .filter((janela) => janela.titulo !== '');
}

/**
 * @param {number} [agora] injetável para teste
 * @returns {Promise<Array<{titulo: string, pid: number, afinidade: number, travada: boolean}>>}
 */
async function listarJanelas(agora = Date.now()) {
  if (process.platform !== 'win32') return [];
  if (agora - cache.quando < VALIDADE_MS) return cache.janelas;

  // Abrir o seletor de tela duas vezes seguidas não pode virar dois
  // PowerShell competindo.
  if (!emAndamento) {
    emAndamento = rodarPowerShell()
      .then((texto) => {
        cache = { quando: Date.now(), janelas: interpretar(texto) };
        return cache.janelas;
      })
      .catch(() => [])
      .finally(() => { emAndamento = null; });
  }

  return emAndamento;
}

module.exports = { listarJanelas, interpretar };
