@echo off
REM ===========================================================================
REM  Tira uma foto da tela por tres caminhos diferentes e salva em PNG.
REM  So le a tela - nao muda nada no computador.
REM  Deixe o TIBIA aberto e visivel antes de rodar.
REM ===========================================================================
title PinduCcall - teste de captura
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\scripts\teste-de-captura.ps1"
