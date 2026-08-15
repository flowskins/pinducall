# =============================================================================
#  PinduCcall - teste de captura (gera imagens)
# =============================================================================
#  Tira a mesma foto por tres caminhos diferentes do Windows e salva em PNG.
#  So LE a tela: nada e alterado, instalado ou enviado para lugar nenhum.
#
#  Serve para descobrir QUAL caminho enxerga o Tibia. Cada programa de captura
#  usa um deles, entao saber qual funciona diz exatamente o que o PinduCcall
#  precisa fazer:
#
#    1. tela-gdi.png        - copia da area de trabalho (jeito antigo)
#    2. janela-printwindow.png - pede a janela que se desenhe (PrintWindow)
#    3. janela-bitblt.png   - copia direta da janela (jeito antigo)
#
#  Deixe o Tibia ABERTO e VISIVEL na frente antes de rodar.
# =============================================================================

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$pasta = Join-Path $PSScriptRoot 'capturas'
New-Item -ItemType Directory -Force -Path $pasta | Out-Null

# Tudo que aparece na tela vai junto para um arquivo: se algum caminho falhar,
# o erro precisa sobreviver ao fechamento da janela.
$registro = Join-Path $pasta 'log.txt'
Set-Content -Path $registro -Value "teste de captura - $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')" -Encoding UTF8

function Nota([string]$texto) {
  Write-Host $texto
  Add-Content -Path $registro -Value $texto -Encoding UTF8
}

Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class PcCap{
 public delegate bool Cb(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int m);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);
 [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d,int x,int y,int w,int hh,IntPtr s,int sx,int sy,int rop);
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}

 public static IntPtr Achar(string parte){
  IntPtr achado=IntPtr.Zero;
  EnumWindows(delegate(IntPtr h,IntPtr p){
   if(!IsWindowVisible(h)) return true;
   int n=GetWindowTextLength(h); if(n<=0) return true;
   var sb=new StringBuilder(n+2); GetWindowText(h,sb,sb.Capacity);
   if(sb.ToString().ToLower().Contains(parte)){ achado=h; return false; }
   return true;
  },IntPtr.Zero);
  return achado;
 }
}
"@

function PorcentagemAcesa([System.Drawing.Bitmap]$img) {
  $acesos = 0
  $total = 0
  for ($y = 0; $y -lt $img.Height; $y += 16) {
    for ($x = 0; $x -lt $img.Width; $x += 16) {
      $c = $img.GetPixel($x, $y)
      $total++
      if ($c.R -gt 16 -or $c.G -gt 16 -or $c.B -gt 16) { $acesos++ }
    }
  }
  if ($total -eq 0) { return 0 }
  return [math]::Round(100 * $acesos / $total, 1)
}

function Salvar([System.Drawing.Bitmap]$img, [string]$nome, [string]$descricao) {
  $caminho = Join-Path $pasta $nome
  $img.Save($caminho, [System.Drawing.Imaging.ImageFormat]::Png)
  $luz = PorcentagemAcesa $img
  Nota ("  {0,-26} {1,6}% de pixels com imagem   ({2})" -f $nome, $luz, $descricao)
}

Write-Host ''
Write-Host '=== PinduCcall - teste de captura ==========================='
Write-Host ''
Nota 'Deixe o TIBIA visivel na frente. Comecando em 5 segundos...'
for ($i = 5; $i -gt 0; $i--) { Write-Host "  $i..."; Start-Sleep -Seconds 1 }
Write-Host ''

$hwnd = [PcCap]::Achar('tibia')
if ($hwnd -eq [IntPtr]::Zero) {
  Nota 'Nao achei a janela do Tibia. Abra o jogo e rode de novo.'
  Read-Host 'Enter para sair' | Out-Null
  exit 1
}

[PcCap]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800

$af = 0
[PcCap]::GetWindowDisplayAffinity($hwnd, [ref]$af) | Out-Null
Nota "Trava de copia da janela agora: $af  (0 = livre, 1 = WDA_MONITOR)"
Write-Host ''

$r = New-Object PcCap+RECT
[PcCap]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$jw = $r.R - $r.L
$jh = $r.B - $r.T
Nota "Janela do Tibia: ${jw}x${jh} em ($($r.L),$($r.T))"
Write-Host ''

# --- 1. Area de trabalho inteira, jeito antigo (CopyFromScreen = BitBlt) -----
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
try {
  $img1 = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g1 = [System.Drawing.Graphics]::FromImage($img1)
  $g1.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
  $g1.Dispose()
  Salvar $img1 'tela-gdi.png' 'area de trabalho inteira'
  $img1.Dispose()
} catch { Nota "  tela-gdi.png FALHOU: $($_.Exception.Message)" }

# --- 2. PrintWindow com PW_RENDERFULLCONTENT (2) ----------------------------
# Esta flag manda a janela se redesenhar para a captura; e o caminho que pega
# janela desenhada por DirectComposition, onde o BitBlt normal falha.
try {
  $img2 = New-Object System.Drawing.Bitmap $jw, $jh
  $g2 = [System.Drawing.Graphics]::FromImage($img2)
  $hdc2 = $g2.GetHdc()
  $ok2 = [PcCap]::PrintWindow($hwnd, $hdc2, 2)
  $g2.ReleaseHdc($hdc2)
  $g2.Dispose()
  Nota "  PrintWindow respondeu: $ok2"
  Salvar $img2 'janela-printwindow.png' 'PrintWindow(RENDERFULLCONTENT)'
  $img2.Dispose()
} catch { Nota "  janela-printwindow.png FALHOU: $($_.Exception.Message)" }

# --- 2b. PrintWindow sem flag (jeito classico) ------------------------------
try {
  $img2b = New-Object System.Drawing.Bitmap $jw, $jh
  $g2b = [System.Drawing.Graphics]::FromImage($img2b)
  $hdc2b = $g2b.GetHdc()
  [PcCap]::PrintWindow($hwnd, $hdc2b, 0) | Out-Null
  $g2b.ReleaseHdc($hdc2b)
  $g2b.Dispose()
  Salvar $img2b 'janela-printwindow-classico.png' 'PrintWindow sem flag'
  $img2b.Dispose()
} catch { Nota "  janela-printwindow-classico.png FALHOU: $($_.Exception.Message)" }

# --- 3. BitBlt direto do DC da janela ---------------------------------------
try {
  $img3 = New-Object System.Drawing.Bitmap $jw, $jh
  $g3 = [System.Drawing.Graphics]::FromImage($img3)
  $hdc3 = $g3.GetHdc()
  $origem = [PcCap]::GetWindowDC($hwnd)
  # 0x00CC0020 = SRCCOPY, 0x40000000 = CAPTUREBLT
  [PcCap]::BitBlt($hdc3, 0, 0, $jw, $jh, $origem, 0, 0, 0x40CC0020) | Out-Null
  [PcCap]::ReleaseDC($hwnd, $origem) | Out-Null
  $g3.ReleaseHdc($hdc3)
  $g3.Dispose()
  Salvar $img3 'janela-bitblt.png' 'copia direta da janela'
  $img3.Dispose()
} catch { Nota "  janela-bitblt.png FALHOU: $($_.Exception.Message)" }

Write-Host ''
Nota "Imagens salvas em: $pasta"
Write-Host ''
Write-Host 'Pronto. Pode fechar esta janela.' -ForegroundColor Green
Read-Host 'Enter para sair' | Out-Null
