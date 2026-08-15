# =============================================================================
# PinduCcall - libera as portas do servidor no Firewall do Windows
#
# Como rodar:
#   1. Clique com o botao direito neste arquivo
#   2. "Executar com o PowerShell"  (precisa aceitar o aviso de administrador)
#
# Ou, em um PowerShell como administrador:
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\liberar-firewall.ps1
#
# Para desfazer tudo depois:
#   .\liberar-firewall.ps1 -Remover
# =============================================================================

param(
  [int]$PortaSinalizacao = 4000,
  [int]$PortaMidiaInicial = 40000,
  [int]$PortaMidiaFinal = 40100,
  [switch]$Remover
)

$ErrorActionPreference = 'Stop'
$prefixo = 'PinduCcall'

function Test-Admin {
  $identidade = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identidade)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host ''
  Write-Host 'Este script precisa de permissao de administrador.' -ForegroundColor Yellow
  Write-Host 'Reabrindo com elevacao...' -ForegroundColor Yellow
  Write-Host ''

  $argumentos = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`"",
    '-PortaSinalizacao', $PortaSinalizacao,
    '-PortaMidiaInicial', $PortaMidiaInicial,
    '-PortaMidiaFinal', $PortaMidiaFinal
  )
  if ($Remover) { $argumentos += '-Remover' }

  Start-Process powershell -Verb RunAs -ArgumentList $argumentos
  exit
}

Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  PinduCcall - regras de firewall' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''

$regras = @(
  @{ Nome = "$prefixo - sinalizacao (TCP $PortaSinalizacao)"; Protocolo = 'TCP'; Portas = "$PortaSinalizacao" },
  @{ Nome = "$prefixo - midia UDP ($PortaMidiaInicial-$PortaMidiaFinal)"; Protocolo = 'UDP'; Portas = "$PortaMidiaInicial-$PortaMidiaFinal" },
  @{ Nome = "$prefixo - midia TCP ($PortaMidiaInicial-$PortaMidiaFinal)"; Protocolo = 'TCP'; Portas = "$PortaMidiaInicial-$PortaMidiaFinal" }
)

if ($Remover) {
  foreach ($regra in $regras) {
    if (Get-NetFirewallRule -DisplayName $regra.Nome -ErrorAction SilentlyContinue) {
      Remove-NetFirewallRule -DisplayName $regra.Nome
      Write-Host "  removida: $($regra.Nome)" -ForegroundColor DarkGray
    }
  }
  Write-Host ''
  Write-Host 'Regras removidas.' -ForegroundColor Green
  Write-Host ''
  Read-Host 'Pressione Enter para fechar'
  exit
}

foreach ($regra in $regras) {
  if (Get-NetFirewallRule -DisplayName $regra.Nome -ErrorAction SilentlyContinue) {
    Write-Host "  ja existia: $($regra.Nome)" -ForegroundColor DarkGray
    continue
  }

  New-NetFirewallRule `
    -DisplayName $regra.Nome `
    -Direction Inbound `
    -Action Allow `
    -Protocol $regra.Protocolo `
    -LocalPort $regra.Portas `
    -Profile Private, Domain `
    -Description 'Permite conexoes de voz, tela e chat do PinduCcall' | Out-Null

  Write-Host "  criada: $($regra.Nome)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Pronto. As portas estao liberadas para redes Privadas e de Dominio.' -ForegroundColor Green
Write-Host ''
Write-Host 'Observacoes:' -ForegroundColor Yellow
Write-Host '  - Se o Windows classificou sua rede como "Publica", mude para "Privada"'
Write-Host '    em Configuracoes > Rede e Internet, ou o firewall vai continuar bloqueando.'
Write-Host '  - Isto libera apenas o SEU computador. Se voce for usar port forwarding,'
Write-Host '    precisa liberar as mesmas portas no roteador tambem.'
Write-Host ''
Read-Host 'Pressione Enter para fechar'
