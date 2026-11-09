@echo off
title AnubeLive
cd /d "%~dp0"
python serve.py
if errorlevel 1 (
  echo.
  echo Nao foi possivel arrancar. Confirma que o Python esta instalado.
  pause
)
