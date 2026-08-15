# =============================================================================
#  PinduCcall - monitor da trava de copia
# =============================================================================
#  Fica olhando TODAS as janelas do cliente do Tibia e avisa na hora quando a
#  trava de copia liga ou desliga. So LE: nada e alterado no sistema.
#
#  Para que serve: em vez de trocar uma opcao no jogo, fechar, rodar um teste e
#  torcer, voce deixa esta janela aberta de lado e vai mexendo nas opcoes do
#  Tibia. A cada mudanca aqui aparece na hora se destravou. Serve para achar
#  QUAL ajuste destrava - OpenGL, modo janela, o que for.
#
#  Fecha sozinho depois de 5 minutos, ou com Ctrl+C.
# =============================================================================

$ErrorActionPreference = 'Continue'

$registro = Join-Path $PSScriptRoot 'monitor-trava.txt'
Set-Content -Path $registro -Value "monitor da trava - $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')" -Encoding UTF8

Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class PcMon{
 public delegate bool Cb(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr pai,Cb cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int m);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int m);
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}

 // Toda janela (e filha de janela) que pertenca a um dos processos pedidos.
 public static List<string> Ler(uint[] pids){
  var fora=new List<string>();
  EnumWindows(delegate(IntPtr h,IntPtr p){
   Ver(h,pids,fora);
   EnumChildWindows(h,delegate(IntPtr f,IntPtr q){ Ver(f,pids,fora); return true; },IntPtr.Zero);
   return true;
  },IntPtr.Zero);
  return fora;
 }

 static void Ver(IntPtr h,uint[] pids,List<string> fora){
  uint pid; GetWindowThreadProcessId(h,out pid);
  bool nosso=false;
  foreach(uint p in pids) if(p==pid) nosso=true;
  if(!nosso) return;

  uint af; if(!GetWindowDisplayAffinity(h,out af)) af=999;
  RECT r; GetWindowRect(h,out r);

  var titulo=new StringBuilder(GetWindowTextLength(h)+2);
  GetWindowText(h,titulo,titulo.Capacity);
  var classe=new StringBuilder(128);
  GetClassName(h,classe,classe.Capacity);

  // Janela minimizada mede 160x28 no Windows, o que confunde na leitura:
  // parece uma janelinha qualquer quando na verdade e o jogo encolhido.
  string estado = IsIconic(h) ? "MINIMIZADA" : (IsWindowVisible(h) ? "visivel" : "oculta");
  fora.Add(af+"\t"+(r.R-r.L)+"x"+(r.B-r.T)+"\t"+estado+"\t"+classe+"\t"+titulo);
 }
}
"@

# O cliente guarda o motor grafico escolhido num arquivo de configuracao.
# Ler esse numero junto com a trava mostra na hora qual motor esta ligado.
$MOTORES = @{ 0 = 'DirectX 5'; 1 = 'OpenGL'; 2 = 'DirectX 9'; 3 = 'Software' }

function MotorAtual() {
  foreach ($raiz in @($env:LOCALAPPDATA, $env:APPDATA, $env:USERPROFILE)) {
    if (-not $raiz) { continue }
    $achados = Get-ChildItem -Path $raiz -Filter 'clientoptions.json' -Recurse -ErrorAction SilentlyContinue -Depth 6 |
      Select-Object -First 1
    if ($achados) {
      try {
        $json = Get-Content $achados.FullName -Raw | ConvertFrom-Json
        $n = $json.renderer
        $nome = if ($MOTORES.ContainsKey([int]$n)) { $MOTORES[[int]$n] } else { "codigo $n" }
        return "$nome  (renderer=$n em $($achados.FullName))"
      } catch { return 'nao consegui ler o clientoptions.json' }
    }
  }
  return 'clientoptions.json nao encontrado'
}

function Nota([string]$texto, [string]$cor = 'Gray') {
  Write-Host $texto -ForegroundColor $cor
  Add-Content -Path $registro -Value $texto -Encoding UTF8
}

Write-Host ''
Write-Host '=== Monitor da trava de copia ===============================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Deixe esta janela de lado e va mexendo nas opcoes do Tibia.'
Write-Host 'Sugestao de ordem:'
Write-Host '   1. Options > MARQUE "Show Advanced Options" > Graphics'
Write-Host '      (sem marcar essa caixa, o motor grafico nem aparece)'
Write-Host '   2. no menu de motor grafico, passe por TODAS as opcoes:'
Write-Host '      Software / OpenGL / DirectX (Compatibility) / DirectX (Performance)'
Write-Host '   3. o cliente pode pedir para reiniciar - pode reiniciar, o monitor continua'
Write-Host ''
Write-Host 'Cada mudanca aparece aqui na hora. Ctrl+C para sair.' -ForegroundColor DarkGray
Write-Host ''

$fim = (Get-Date).AddMinutes(5)
$anterior = ''
$batida = 0

while ((Get-Date) -lt $fim) {
  $pids = @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match '(?i)^client$|tibia|otclient' } |
    ForEach-Object { [uint32]$_.Id })

  if ($pids.Count -eq 0) {
    $agora = 'SEM O TIBIA ABERTO'
  } else {
    $janelas = [PcMon]::Ler($pids)
    $travadas = @($janelas | Where-Object { $_ -match '^(1|17)\t' })
    $agora = if ($travadas.Count -gt 0) { "TRAVADA ($($travadas.Count) janela(s))" } else { 'LIVRE' }
  }

  if ($agora -ne $anterior) {
    $hora = Get-Date -Format 'HH:mm:ss'
    if ($agora -eq 'LIVRE') {
      Nota ''
      Nota "[$hora] >>> DESTRAVOU! Foi o ultimo ajuste que voce mexeu. <<<" 'Green'
      Nota '            Volte ao PinduCcall e clique em "procurar de novo".' 'Green'
    } elseif ($agora -like 'TRAVADA*') {
      Nota "[$hora] $agora - o jogo ainda esta bloqueando a copia." 'Yellow'
    } else {
      Nota "[$hora] $agora" 'DarkGray'
    }

    # Detalhe de cada janela, para nao ficar duvida de qual e qual.
    if ($pids.Count -gt 0) {
      foreach ($j in $janelas) {
        $campos = $j -split "`t"
        $marca = if ($campos[0] -eq '0') { 'livre  ' } else { 'TRAVADA' }
        Nota ("      {0}  {1,-12} {2,-8} {3} {4}" -f $marca, $campos[1], $campos[2], $campos[3], $campos[4]) 'DarkGray'
      }
    }
    if ($pids.Count -gt 0) { Nota ("      motor grafico no arquivo do cliente: " + (MotorAtual)) 'DarkCyan' }
    $anterior = $agora
  }

  Start-Sleep -Milliseconds 900
  $batida++
  if ($batida % 20 -eq 0) { Write-Host '.' -NoNewline -ForegroundColor DarkGray }
}

Write-Host ''
Nota "Fim do monitoramento. Registro em: $registro"
Read-Host 'Enter para sair' | Out-Null
