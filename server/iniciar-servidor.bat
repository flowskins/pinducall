@echo off
setlocal
title PinduCcall - servidor da sala
cd /d "%~dp0"

echo ==========================================
echo   PinduCcall - servidor
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado.
  echo.
  echo Instale a versao LTS em https://nodejs.org e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo Node.js detectado: %NODEVER%
echo.

if not exist "node_modules\" (
  echo Primeira execucao: baixando as dependencias. Isso leva alguns minutos...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERRO] A instalacao falhou. Confira sua conexao e tente de novo.
    pause
    exit /b 1
  )
  echo.
)

if not exist ".env" (
  if exist ".env.example" (
    echo Criando o arquivo .env a partir do modelo...
    copy /y ".env.example" ".env" >nul
    echo.
    echo [ATENCAO] Abra o arquivo .env e troque a ROOM_PASSWORD antes de convidar
    echo           alguem. O servidor vai subir mesmo assim.
    echo.
  )
)

echo Iniciando o servidor. Deixe esta janela ABERTA enquanto a sala estiver em uso.
echo Para desligar, feche a janela ou pressione Ctrl+C.
echo.

node src/index.js

echo.
echo O servidor foi encerrado.
pause
