#!/usr/bin/env bash
#
# Aplica uma nova versão do código que já foi copiada para /opt/pinducall
# e reinicia o serviço, mostrando se subiu.
#
#   sudo bash /opt/pinducall/deploy/atualizar.sh
#
set -euo pipefail

APP_DIR=/opt/pinducall
PORTA="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 || echo 4000)"

chown -R pinducall:pinducall "$APP_DIR"
systemctl restart pinducall

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORTA/health" >/dev/null 2>&1; then
    echo "OK - servidor respondendo:"
    curl -fsS "http://127.0.0.1:$PORTA/health"
    exit 0
  fi
  sleep 1
done

echo "O servidor não respondeu depois de 30s." >&2
journalctl -u pinducall -n 60 --no-pager >&2
exit 1
