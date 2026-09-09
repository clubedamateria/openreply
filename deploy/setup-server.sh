#!/usr/bin/env bash
# Prepara um Ubuntu 22.04/24.04 zerado e sobe o OpenReply.
# Uso (no servidor):  bash setup-server.sh
set -euo pipefail

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi

# Oracle Cloud bloqueia 80/443 no iptables da imagem, além do security list
if command -v iptables >/dev/null; then
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT || true
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
  sudo netfilter-persistent save 2>/dev/null || true
fi

if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

cd "$(dirname "$0")/.."
sudo docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod pull
sudo docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d
echo
echo "Subiu. Health: https://$(grep ^SITE_ADDRESS deploy/.env.prod | cut -d= -f2)/api/health"
