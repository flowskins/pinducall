#!/usr/bin/env bash
#
# Instalador do servidor PinduCcall em Ubuntu 22.04/24.04 limpo.
#
#   sudo bash instalar.sh [SENHA_DA_SALA_PADRAO] [IP_PUBLICO]
#
# Tudo é opcional: sem argumentos ele sorteia a senha e mostra no fim.
# O IP público é descoberto automaticamente quando não informado.
# Pode rodar de novo em cima de uma instalação existente (é idempotente).
#
set -euo pipefail

sortear() { head -c 24 /dev/urandom | base64 | tr -d '+/=' | cut -c1-14; }

SENHA_SALA="${1:-$(sortear)}"
IP_PUBLICO="${2:-}"

APP_DIR=/opt/pinducall
APP_USER=pinducall
PORTA=4000
RTC_MIN=40000
RTC_MAX=40100

log() { echo -e "\n\033[1;32m==> $*\033[0m"; }

if [[ $EUID -ne 0 ]]; then
  echo "Rode como root (sudo bash instalar.sh ...)" >&2
  exit 1
fi

log "Pacotes básicos"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates ufw >/dev/null

if [[ -z "$IP_PUBLICO" ]]; then
  IP_PUBLICO="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
fi
if [[ -z "$IP_PUBLICO" ]]; then
  IP_PUBLICO="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)"
fi
log "IP público: $IP_PUBLICO"

if ! command -v node >/dev/null || [[ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)" -lt 20 ]]; then
  log "Instalando Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v)"

if ! id "$APP_USER" &>/dev/null; then
  log "Criando usuário $APP_USER"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

# O código já deve ter sido copiado para $APP_DIR antes de rodar este script.
if [[ ! -f "$APP_DIR/src/index.js" ]]; then
  echo "Não encontrei $APP_DIR/src/index.js. Copie o código do servidor para $APP_DIR primeiro." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/node_modules/mediasoup" ]]; then
  log "Instalando dependências (npm ci)"
  (cd "$APP_DIR" && npm ci --omit=dev)
fi

log "Escrevendo $APP_DIR/.env"
cat > "$APP_DIR/.env" <<EOF
# Gerado por deploy/instalar.sh
PORT=$PORTA
BIND_ADDRESS=0.0.0.0
ANNOUNCED_IP=$IP_PUBLICO
EXPOSE_INTERNAL_IP=false
ROOM_PASSWORD=$SENHA_SALA
MAX_ROOMS=30
CONVITE_HORAS=24
SALA_EXPIRA_HORAS=24
LIMPEZA_MINUTOS=15
ARQUIVO_HORAS=24
ARQUIVO_MAX_MB=25
ARQUIVO_SALA_MB=300
ARQUIVO_TOTAL_MB=3000
MAX_PEERS=10
DEFAULT_ROOM=geral
RTC_MIN_PORT=$RTC_MIN
RTC_MAX_PORT=$RTC_MAX
MAX_INCOMING_BITRATE=8000000
MEDIASOUP_LOG_LEVEL=warn
EOF
chmod 600 "$APP_DIR/.env"

mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Instalando o serviço systemd"
install -m 644 "$APP_DIR/deploy/pinducall.service" /etc/systemd/system/pinducall.service
systemctl daemon-reload
systemctl enable pinducall >/dev/null
systemctl restart pinducall

log "Firewall (ufw)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp    comment 'ssh' >/dev/null
ufw allow 443/tcp   comment 'ssh alternativo' >/dev/null
ufw allow $PORTA/tcp comment 'pinducall sinalizacao' >/dev/null
ufw allow $RTC_MIN:$RTC_MAX/udp comment 'pinducall midia udp' >/dev/null
ufw allow $RTC_MIN:$RTC_MAX/tcp comment 'pinducall midia tcp' >/dev/null
ufw --force enable >/dev/null
ufw status numbered

log "Aguardando o servidor subir"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORTA/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo
curl -fsS "http://127.0.0.1:$PORTA/health" || {
  echo "O servidor não respondeu. Veja: journalctl -u pinducall -n 80 --no-pager" >&2
  exit 1
}

cat <<EOF


================================================================
  PinduCcall no ar

  Servidor .............. ws://$IP_PUBLICO:$PORTA/ws
  Senha da sala "geral" . $SENHA_SALA
  Landing page .......... http://$IP_PUBLICO:$PORTA/

  Logs .......... journalctl -u pinducall -f
  Reiniciar ..... systemctl restart pinducall
  Salas ......... /opt/pinducall/data/salas.json
================================================================
EOF
