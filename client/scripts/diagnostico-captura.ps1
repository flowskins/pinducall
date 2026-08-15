# =============================================================================
#  PinduCcall - diagnóstico de captura de janela
# =============================================================================
#  Só LÊ informação do Windows: nada é alterado, instalado ou enviado para
#  lugar nenhum. O resultado fica em diagnostico-captura.txt, ao lado deste
#  arquivo.
#
#  Para que serve: descobrir POR QUE uma janela sai preta (ou some da lista) na
#  hora de compartilhar. A resposta que interessa é a "trava de cópia" — o
#  Windows tem uma marca por janela (display affinity) que o próprio programa
#  liga para proibir qualquer captura. Se estiver ligada, nenhum aplicativo do
#  mundo consegue copiar aquela janela; se estiver desligada, o problema é
#  outro e a busca continua em outro lugar.
#
#  Rode com o Tibia ABERTO, do jeito que ele fica quando a tela vai preta.
# =============================================================================

$ErrorActionPreference = 'Stop'
$saida = Join-Path $PSScriptRoot 'diagnostico-captura.txt'
$linhas = New-Object System.Collections.Generic.List[string]

function Diga([string]$texto) {
  Write-Host $texto
  $linhas.Add($texto)
}

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class PinduDiag {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr param);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder texto, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint afinidade);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int atributo, out int valor, int tamanho);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Esq, Topo, Dir, Baixo; }

  public class Janela {
    public IntPtr Handle;
    public string Titulo;
    public uint Pid;
    public uint Afinidade;
    public bool AfinidadeLida;
    public int Cloaked;
    public int Largura;
    public int Altura;
  }

  public static List<Janela> Listar() {
    var achadas = new List<Janela>();

    EnumWindows(delegate(IntPtr hWnd, IntPtr param) {
      if (!IsWindowVisible(hWnd)) return true;

      int tamanho = GetWindowTextLength(hWnd);
      if (tamanho <= 0) return true;

      var texto = new StringBuilder(tamanho + 2);
      GetWindowText(hWnd, texto, texto.Capacity);

      var item = new Janela();
      item.Handle = hWnd;
      item.Titulo = texto.ToString();

      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      item.Pid = pid;

      uint afinidade;
      item.AfinidadeLida = GetWindowDisplayAffinity(hWnd, out afinidade);
      item.Afinidade = afinidade;

      int escondida = 0;
      // 14 = DWMWA_CLOAKED: janela que existe mas o compositor não desenha.
      DwmGetWindowAttribute(hWnd, 14, out escondida, 4);
      item.Cloaked = escondida;

      RECT r;
      if (GetWindowRect(hWnd, out r)) {
        item.Largura = r.Dir - r.Esq;
        item.Altura = r.Baixo - r.Topo;
      }

      achadas.Add(item);
      return true;
    }, IntPtr.Zero);

    return achadas;
  }
}
"@

function NomeDaAfinidade([uint32]$valor, [bool]$lida) {
  if (-not $lida) { return 'nao foi possivel ler' }
  switch ($valor) {
    0  { 'NONE - sem trava, pode copiar' }
    1  { 'WDA_MONITOR - TRAVADA: sai preta em qualquer captura' }
    17 { 'WDA_EXCLUDEFROMCAPTURE - TRAVADA: some das capturas' }
    default { "desconhecida ($valor)" }
  }
}

Diga '============================================================'
Diga ' PinduCcall - diagnostico de captura'
Diga " $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')"
Diga '============================================================'
Diga ''

# --- Ambiente ---------------------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem
Diga "Windows: $($os.Caption) - build $($os.BuildNumber)"
try {
  $display = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion
  if ($display) { Diga "Versao:  $display" }
} catch { }

foreach ($gpu in Get-CimInstance Win32_VideoController) {
  Diga "Video:   $($gpu.Name) (driver $($gpu.DriverVersion))"
}
Diga ''

# --- Janelas ----------------------------------------------------------------
$janelas = [PinduDiag]::Listar()
Diga "Janelas visiveis com titulo: $($janelas.Count)"
Diga ''

$processos = @{}
foreach ($p in Get-Process) { $processos[[uint32]$p.Id] = $p.ProcessName }

$alvo = $janelas | Where-Object {
  $_.Titulo -match '(?i)tibia' -or $processos[$_.Pid] -match '(?i)tibia|^client$|otclient'
}

if ($alvo.Count -eq 0) {
  Diga '>>> Nenhuma janela do Tibia encontrada.'
  Diga '    O jogo precisa estar ABERTO enquanto este diagnostico roda.'
  Diga '    (Se ele estiver aberto mesmo assim, o titulo da janela mudou —'
  Diga '     olhe a lista completa no fim do arquivo.)'
} else {
  Diga '>>> JANELAS DO JOGO'
  foreach ($j in $alvo) {
    Diga ''
    Diga "  Titulo........: $($j.Titulo)"
    Diga "  Programa......: $($processos[$j.Pid]) (pid $($j.Pid))"
    Diga "  Tamanho.......: $($j.Largura)x$($j.Altura)"
    Diga "  Escondida(DWM): $($j.Cloaked)"
    Diga "  TRAVA DE COPIA: $(NomeDaAfinidade $j.Afinidade $j.AfinidadeLida)"
  }
  Diga ''
  $travadas = @($alvo | Where-Object { $_.AfinidadeLida -and $_.Afinidade -ne 0 })
  if ($travadas.Count -gt 0) {
    Diga '  VEREDITO: o proprio jogo pediu ao Windows para nao ser copiado.'
    Diga '            Nenhum programa de captura passa por isso - a saida e'
    Diga '            trocar o motor grafico do jogo (Opcoes > Graficos >'
    Diga '            Avancado > OpenGL).'
  } else {
    Diga '  VEREDITO: a janela NAO esta travada contra copia.'
    Diga '            Entao a tela preta vem de outro lugar (placa de video,'
    Diga '            modo de desenho do jogo, overlay). Mande este arquivo.'
  }
}

Diga ''
Diga '------------------------------------------------------------'
Diga 'LISTA COMPLETA (titulo | programa | trava)'
Diga '------------------------------------------------------------'
foreach ($j in $janelas | Sort-Object Titulo) {
  $marca = if ($j.AfinidadeLida -and $j.Afinidade -ne 0) { 'TRAVADA' } else { 'livre' }
  Diga ("  {0,-45} | {1,-18} | {2}" -f $j.Titulo, $processos[$j.Pid], $marca)
}

Diga ''
Diga "Arquivo salvo em: $saida"

Set-Content -Path $saida -Value $linhas -Encoding UTF8
Write-Host ''
Write-Host 'Pronto. Pode fechar esta janela.' -ForegroundColor Green
if ($Host.Name -eq 'ConsoleHost') { Read-Host 'Enter para sair' | Out-Null }
