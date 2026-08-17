#!/usr/bin/env bash
# Atualiza o servidor do PinduCcall: envia o codigo novo e reinicia o servico.
# Uso (no Git Bash, dentro da pasta teamlink):  bash atualizar-servidor.sh
set -e
cd "$(dirname "$0")"

SERVIDOR="ubuntu@201.54.18.186"
CHAVE="pinducall_vps"

echo "==> 1/2  Enviando os arquivos para o servidor..."
scp -i "$CHAVE" server/src/peer.js server/src/signaling.js server/src/room.js "$SERVIDOR:~/"

echo "==> 2/2  Aplicando no servidor e reiniciando..."
ssh -i "$CHAVE" "$SERVIDOR" "sudo cp ~/peer.js /opt/pinducall/src/peer.js && sudo cp ~/signaling.js /opt/pinducall/src/signaling.js && sudo cp ~/room.js /opt/pinducall/src/room.js && sudo systemctl restart pinducall && systemctl is-active pinducall"

echo ""
echo "==> Pronto. Se apareceu 'active' logo acima, o servidor esta atualizado."
