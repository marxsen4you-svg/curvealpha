#!/usr/bin/env bash
# CurveAlpha V5 installer for Ubuntu 24.04. Paper mode.
# First run: installs Node 22, sets up a read only deploy key for the private repo,
# clones, builds, asks for the gRPC endpoint, and starts a systemd service.
# Every later run: pulls the latest code, rebuilds and restarts.
#   sudo bash install.sh
set -euo pipefail

REPO_SSH="git@github.com:marxsen4you-svg/curvealpha.git"
APP_USER="curvealpha"
APP_DIR="/opt/curvealpha"
KEY="/home/${APP_USER}/.ssh/curvealpha_deploy"
SERVICE="/etc/systemd/system/curvealpha.service"

if [[ $EUID -ne 0 ]]; then echo "Run this with sudo: sudo bash install.sh"; exit 1; fi

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

say "Installing system packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssh-client sudo >/dev/null

need_node=1
if command -v node >/dev/null; then
  v=$(node -p 'process.versions.node')
  IFS=. read -r maj min _ <<<"$v"
  if (( maj > 22 || (maj == 22 && min >= 13) )); then need_node=0; fi
fi
if (( need_node )); then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if (( mem_kb < 1800000 )) && ! swapon --show | grep -q .; then
  say "Low memory detected, adding a 2 GB swap file so the build does not fail"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
as_app() { sudo -u "$APP_USER" -H "$@"; }

install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/${APP_USER}/.ssh"
if [[ ! -f "$KEY" ]]; then
  as_app ssh-keygen -q -t ed25519 -N "" -C "curvealpha-vps" -f "$KEY"
fi
as_app bash -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts"
export GIT_SSH_COMMAND="ssh -i ${KEY} -o IdentitiesOnly=yes"

until as_app env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" git ls-remote "$REPO_SSH" >/dev/null 2>&1; do
  say "One time step: give this server read access to the repo"
  echo "1. Open https://github.com/marxsen4you-svg/curvealpha/settings/keys/new"
  echo "2. Title: VPS. Paste this key. Leave write access unchecked. Click Add key."
  echo
  cat "${KEY}.pub"
  echo
  read -rp "Press Enter once the key is added... " _
done

install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  say "Pulling latest code"
  as_app env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" git -C "$APP_DIR" pull --ff-only
else
  say "Cloning the repo"
  as_app env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" git clone -q "$REPO_SSH" "$APP_DIR"
fi
as_app git -C "$APP_DIR" config core.sshCommand "$GIT_SSH_COMMAND"

say "Installing dependencies and building"
cd "$APP_DIR"
as_app npm ci --no-audit --no-fund --loglevel=error
as_app npm run build --silent

ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  say "gRPC settings (typed here, saved only in $ENV_FILE, readable only by the service)"
  read -rp "Yellowstone gRPC endpoint URL (for example https://name.provider.com:443): " grpc
  read -rsp "gRPC x-token (press Enter if your provider has none): " token; echo
  read -rp "Solana RPC URL (press Enter for the public one, fine for paper mode): " rpc
  read -rp "Starting paper bankroll in SOL (press Enter for 2): " sol
  umask 077
  cat > "$ENV_FILE" <<EOF
CURVEALPHA_MODE=paper
CURVEALPHA_GRPC_ENDPOINT=${grpc}
CURVEALPHA_GRPC_TOKEN=${token}
CURVEALPHA_RPC_URL=${rpc:-https://api.mainnet-beta.solana.com}
CURVEALPHA_PAPER_SOL=${sol:-2}
CURVEALPHA_DATA_DIR=${APP_DIR}/data
CURVEALPHA_DASHBOARD_PORT=7420
EOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  unset token
fi

cat > "$SERVICE" <<EOF
[Unit]
Description=CurveAlpha V5
After=network-online.target
Wants=network-online.target

[Service]
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) --env-file=${ENV_FILE} dist/cli.js run
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now curvealpha >/dev/null 2>&1
systemctl restart curvealpha
sleep 8

say "Status"
systemctl --no-pager --lines=0 status curvealpha | head -5 || true
journalctl -u curvealpha --no-pager -n 15

ip=$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
say "Done"
echo "Live log:   journalctl -u curvealpha -f"
echo "Dashboard:  on your own computer run"
echo "              ssh -L 7420:127.0.0.1:7420 root@${ip}"
echo "            then open http://127.0.0.1:7420"
echo "Update:     sudo bash ${APP_DIR}/deploy/install.sh"
echo "Change gRPC settings: sudo nano ${ENV_FILE} && sudo systemctl restart curvealpha"
