@echo off
REM ===========================================================================
REM  Abre o diagnostico de captura do PinduCcall.
REM  So le informacao do Windows - nao muda nada no computador.
REM  Deixe o Tibia ABERTO antes de rodar.
REM ===========================================================================
title PinduCcall - diagnostico de captura
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\scripts\diagnostico-captura.ps1"
