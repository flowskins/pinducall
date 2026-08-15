@echo off
REM ===========================================================================
REM  Fica olhando a trava de copia das janelas do Tibia e avisa na hora que
REM  ela liga ou desliga. So le - nao muda nada no computador.
REM  Deixe esta janela de lado e va mexendo nas opcoes do jogo.
REM ===========================================================================
title PinduCcall - monitor da trava
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\scripts\monitor-trava.ps1"
