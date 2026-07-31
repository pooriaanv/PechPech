#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  PechPech — Interactive Setup  (install.sh)
#  Run from project root:  bash install.sh
#  The existing start.sh is NOT touched by this script.
# ─────────────────────────────────────────────────────────────────

IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$ROOT/server/src/server.js" ]]; then
  echo "Error: Run this script from the PechPech project root." >&2
  exit 1
fi

# ── Colors (only when stdout is a real terminal) ──────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'    GREEN='\033[0;32m'  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'   CYAN='\033[0;36m'   MAGENTA='\033[0;35m'
  BOLD='\033[1m'      DIM='\033[2m'        NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
fi

# ── Output helpers ────────────────────────────────────────────────
step()  { echo -e "\n${BOLD}${BLUE}  ━━  $*${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC}  $*"; }
info()  { echo -e "  ${CYAN}ℹ${NC}  $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC}  $*"; }
die()   { echo -e "\n  ${RED}✗  Fatal: $*${NC}\n" >&2; exit 1; }
hr()    { echo -e "\n  ${DIM}$(printf '─%.0s' $(seq 1 60))${NC}"; }

ask_input() {     # ask_input <label> <default>
  local label="$1" default="$2" result
  echo -ne "  ${MAGENTA}?${NC}  ${BOLD}${label}${NC}  ${DIM}[${default}]${NC}:  " >&2
  read -r result
  printf '%s' "${result:-$default}"
}

ask_secret() {    # ask_secret <label>
  local label="$1" result
  echo -ne "  ${MAGENTA}?${NC}  ${BOLD}${label}${NC}  ${DIM}[leave blank to skip]${NC}:  " >&2
  read -rs result
  echo >&2
  printf '%s' "$result"
}

ask_yn() {        # ask_yn <question> [default=y] — returns 0=yes 1=no
  local q="$1" default="${2:-y}" answer prompt
  [[ "$default" == "y" ]] && prompt="Y/n" || prompt="y/N"
  echo -ne "  ${MAGENTA}?${NC}  ${BOLD}${q}${NC}  ${DIM}[${prompt}]${NC}:  "
  read -r answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}

# Spinner — spin_start <msg>; … ; spin_stop
_spin_pid=""
spin_start() {
  local msg="$1"
  ( i=0
    frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    while true; do
      printf "\r  ${CYAN}%s${NC}  %s" "${frames[$((i % 10))]}" "$msg"
      sleep 0.1
      i=$((i+1))
    done
  ) &
  _spin_pid=$!
}
spin_stop() {
  if [[ -n "$_spin_pid" ]]; then
    kill "$_spin_pid" 2>/dev/null
    wait "$_spin_pid" 2>/dev/null
    _spin_pid=""
    printf "\r\033[K"
  fi
}
trap 'spin_stop' EXIT INT TERM

# ── Header ────────────────────────────────────────────────────────
clear 2>/dev/null || true
echo ""
echo -e "${BOLD}${CYAN}  ██████╗  ███████╗  ██████╗ ██╗  ██╗   ██████╗  ███████╗  ██████╗ ██╗  ██╗${NC}"
echo -e "${BOLD}${CYAN}  ██╔══██╗ ██╔════╝ ██╔════╝ ██║  ██║   ██╔══██╗ ██╔════╝ ██╔════╝ ██║  ██║${NC}"
echo -e "${BOLD}${CYAN}  ██████╔╝ █████╗    ██║     ███████║   ██████╔╝ █████╗    ██║     ███████║${NC}"
echo -e "${BOLD}${CYAN}  ██╔═══╝  ██╔══╝    ██║     ██╔══██║   ██╔═══╝  ██╔══╝    ██║     ██╔══██║${NC}"
echo -e "${BOLD}${CYAN}  ██║      ███████╗ ╚██████╗ ██║  ██║   ██║      ███████╗ ╚██████╗ ██║  ██║${NC}"
echo -e "${BOLD}${CYAN}  ╚═╝      ╚══════╝  ╚═════╝ ╚═╝  ╚═╝   ╚═╝      ╚══════╝  ╚═════╝ ╚═╝  ╚═╝${NC}"
echo ""
echo -e "  ${DIM}Meeting Minutes Generator — Interactive Setup${NC}"
hr; echo ""

# ── OS detection ──────────────────────────────────────────────────
OS="unknown"
PKG_MGR=""
case "$(uname)" in
  Darwin) OS="mac" ;;
  Linux)
    OS="linux"
    if   command -v apt-get &>/dev/null; then PKG_MGR="apt"
    elif command -v dnf     &>/dev/null; then PKG_MGR="dnf"
    elif command -v yum     &>/dev/null; then PKG_MGR="yum"
    elif command -v pacman  &>/dev/null; then PKG_MGR="pacman"
    fi
    ;;
  MINGW*|CYGWIN*|MSYS*) OS="windows" ;;
esac

# ─────────────────────────────────────────────────────────────────
#  MODE SELECTION
# ─────────────────────────────────────────────────────────────────

echo -e "  ${BOLD}How would you like to run PechPech?${NC}"
echo ""
echo -e "  ${BOLD}  1  With Docker${NC}  ${GREEN}← recommended${NC}"
echo -e "  ${DIM}     Everything runs in an isolated container — clean, portable, easy to reset.${NC}"
echo -e "  ${DIM}     Works the same on macOS, Linux, and Windows (via Docker Desktop).${NC}"
echo ""
echo -e "  ${BOLD}  2  Without Docker${NC}"
echo -e "  ${DIM}     Installs everything directly on your machine.${NC}"
echo -e "  ${DIM}     Node.js + ffmpeg required.${NC}"
echo ""

MODE=""
while [[ ! "$MODE" =~ ^[12]$ ]]; do
  echo -ne "  ${MAGENTA}?${NC}  ${BOLD}Your choice${NC}  ${DIM}[1]${NC}:  "
  read -r MODE
  MODE="${MODE:-1}"
done


# ═════════════════════════════════════════════════════════════════
#  WITH DOCKER
# ═════════════════════════════════════════════════════════════════

if [[ "$MODE" == "1" ]]; then

  # ── Docker check ───────────────────────────────────────────────
  step "Checking Docker"

  if ! command -v docker &>/dev/null; then
    echo -e "  ${RED}✗${NC}  Docker not found."
    info "Install Docker Desktop from https://docker.com"
    die "Docker is required for this mode."
  fi
  if ! docker info &>/dev/null 2>&1; then
    echo -e "  ${RED}✗${NC}  Docker daemon is not running."
    info "Start Docker Desktop and try again."
    die "Docker daemon not running."
  fi
  DOCKER_VER=$(docker --version | awk '{print $3}' | tr -d ',')
  ok "Docker ${DOCKER_VER}"

  # Check docker compose — use an array so "docker compose" is always two words,
  # not one (IFS=$'\n\t' removes space from word-splitting on plain $VAR).
  if docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD=("docker" "compose")
  elif command -v docker-compose &>/dev/null; then
    warn "Using legacy docker-compose. Consider upgrading to Docker Desktop."
    COMPOSE_CMD=("docker-compose")
  else
    die "Docker Compose not found. Install Docker Desktop (it includes Compose)."
  fi
  ok "Docker Compose: ${COMPOSE_CMD[*]}"

  # ── LLM selection ─────────────────────────────────────────────
  step "LLM selection"

  echo ""
  echo -e "  ${BOLD}Which LLM should power meeting minutes?${NC}"
  echo ""
  echo -e "  ${BOLD}  1  OpenAI (ChatGPT)${NC}"
  echo -e "  ${DIM}     Just needs an API key from platform.openai.com${NC}"
  echo ""
  echo -e "  ${BOLD}  2  Google Gemini${NC}"
  echo -e "  ${DIM}     Just needs an API key from aistudio.google.com${NC}"
  echo ""
  echo -e "  ${BOLD}  3  Custom API${NC}   ${DIM}(OpenAI-compatible endpoint)${NC}"
  echo -e "  ${DIM}     Connect to any /chat/completions API — DeepSeek, Ollama, etc.${NC}"
  echo ""
  echo -e "  ${BOLD}  4  Custom CLI${NC}   ${DIM}(any local CLI tool)${NC}"
  echo -e "  ${DIM}     You manage installation inside the container yourself.${NC}"
  echo ""

  LLM_NUM=""
  while [[ ! "$LLM_NUM" =~ ^[1-4]$ ]]; do
    echo -ne "  ${MAGENTA}?${NC}  ${BOLD}Choice${NC}  ${DIM}[1]${NC}:  "
    read -r LLM_NUM
    LLM_NUM="${LLM_NUM:-1}"
  done

  D_LLM_CLI=""
  D_LLM_ARG="none"
  D_LLM_CMD=""
  D_LLM_API_URL=""
  D_LLM_API_KEY=""
  D_LLM_API_MODEL=""

  case "$LLM_NUM" in
    1) D_LLM_CLI="openai"
       echo ""
       D_LLM_API_KEY=$(ask_secret "OpenAI API key")
       D_LLM_API_MODEL=$(ask_input "Model name" "gpt-4o")
       ;;
    2) D_LLM_CLI="gemini-api"
       echo ""
       D_LLM_API_KEY=$(ask_secret "Gemini API key")
       D_LLM_API_MODEL=$(ask_input "Model name" "gemini-2.0-flash")
       ;;
    3) D_LLM_CLI="api"
       echo ""
       D_LLM_API_URL=$(ask_input "API base URL" "https://api.openai.com/v1")
       D_LLM_API_KEY=$(ask_secret "API key")
       D_LLM_API_MODEL=$(ask_input "Model name" "gpt-4o")
       ;;
    4) D_LLM_CLI="custom"
       echo ""
       D_LLM_CMD=$(ask_input "Custom CLI command" "my-llm")
       warn "Custom mode: ensure the command is installed inside the container image."
       ;;
  esac

  # ── STT selection ──────────────────────────────────────────────
  step "STT selection"

  echo ""
  echo -e "  ${BOLD}Which service should transcribe your recordings?${NC}"
  echo ""
  echo -e "  ${BOLD}  1  Local / self-hosted${NC}  ${DIM}(Whisper-compatible endpoint)${NC}  ${GREEN}← default${NC}"
  echo -e "  ${BOLD}  2  OpenAI Whisper${NC}"
  echo -e "  ${BOLD}  3  Google Gemini${NC}"
  echo ""

  STT_NUM=""
  while [[ ! "$STT_NUM" =~ ^[1-3]$ ]]; do
    echo -ne "  ${MAGENTA}?${NC}  ${BOLD}Choice${NC}  ${DIM}[1]${NC}:  "
    read -r STT_NUM
    STT_NUM="${STT_NUM:-1}"
  done

  D_STT_PROVIDER=""
  D_STT_URL=""
  D_STT_KEY=""
  D_STT_MODEL=""
  case "$STT_NUM" in
    1) D_STT_PROVIDER="custom"
       echo ""
       info "The container can't reach 'localhost' on your host — use host.docker.internal instead."
       D_STT_URL=$(ask_input "STT base URL" "http://host.docker.internal:8080/v1")
       D_STT_KEY=$(ask_secret "API key (leave blank for local servers)")
       D_STT_MODEL=$(ask_input "Model name" "whisper-1")
       ;;
    2) D_STT_PROVIDER="openai"
       echo ""
       D_STT_KEY=$(ask_secret "OpenAI API key")
       D_STT_MODEL=$(ask_input "Model name" "whisper-1")
       ;;
    3) D_STT_PROVIDER="gemini"
       echo ""
       D_STT_KEY=$(ask_secret "Gemini API key")
       D_STT_MODEL=$(ask_input "Model name" "gemini-2.0-flash")
       ;;
  esac

  D_PORT=$(ask_input "Host port" "3456")

  # ── Write .env ─────────────────────────────────────────────────
  step "Writing .env"

  {
    echo "MODE=docker"
    echo "PECHPECH_PORT=${D_PORT}"
    echo "LLM_CLI=${D_LLM_ARG}"
  } > "$ROOT/.env"

  ok ".env written."

  # ── Write config.json (LLM + STT settings) ────────────────────
  step "Writing config.json"
  node -e "
    const fs = require('fs');
    const cfg = {
      sttProvider: process.argv[1] || 'custom',
      sttUrl:      process.argv[2] || 'http://localhost:8080/v1',
      sttKey:      process.argv[3] || '',
      sttModel:    process.argv[4] || 'whisper-1',
      llmCli:      process.argv[5] || 'openai',
      llmCommand:  process.argv[6] || '',
      llmApiUrl:   process.argv[7] || '',
      llmApiKey:   process.argv[8] || '',
      llmApiModel: process.argv[9] || '',
    };
    fs.writeFileSync(process.argv[10], JSON.stringify(cfg, null, 2) + '\n');
  " \
    "$D_STT_PROVIDER" \
    "$D_STT_URL" \
    "$D_STT_KEY" \
    "$D_STT_MODEL" \
    "$D_LLM_CLI" \
    "$D_LLM_CMD" \
    "$D_LLM_API_URL" \
    "$D_LLM_API_KEY" \
    "$D_LLM_API_MODEL" \
    "$ROOT/server/src/config.json"
  ok "config.json written."

  # ── Build ──────────────────────────────────────────────────────
  step "Building Docker image"
  echo ""
  info "First run takes a few minutes: downloading base image + installing dependencies."
  info "Subsequent runs use the cache and are much faster."
  echo ""

  spin_start "Building (grab a coffee)…"
  "${COMPOSE_CMD[@]}" -f "$ROOT/docker-compose.yml" build &
  BUILD_PID=$!
  wait $BUILD_PID
  BUILD_EXIT=$?
  spin_stop
  if [[ $BUILD_EXIT -ne 0 ]]; then
    die "Docker build failed. Run:  ${COMPOSE_CMD[*]} -f docker-compose.yml build  to see the full output."
  fi
  ok "Image built successfully."

  # ── Start ──────────────────────────────────────────────────────
  step "Starting container"

  spin_start "Starting pechpech-helper container…"
  "${COMPOSE_CMD[@]}" -f "$ROOT/docker-compose.yml" up -d &
  UP_PID=$!
  wait $UP_PID
  UP_EXIT=$?
  spin_stop
  if [[ $UP_EXIT -ne 0 ]]; then
    die "Container failed to start. Check:  docker logs pechpech-helper"
  fi
  ok "Container started."

  spin_start "Waiting for helper to become ready…"
  HEALTHY=false
  for _ in $(seq 1 24); do
    sleep 0.5
    if curl -sf "http://127.0.0.1:${D_PORT}/health" &>/dev/null; then
      HEALTHY=true; break
    fi
  done
  spin_stop
  if $HEALTHY; then
    ok "Helper ready at http://127.0.0.1:${D_PORT}"
  else
    warn "Helper didn't respond — run:  docker logs pechpech-helper"
  fi

  # ── Auto-start ─────────────────────────────────────────────────
  step "Auto-start on login (optional)"
  echo ""
  info "The launcher can start the container automatically every time you log in."
  info "You can always start it manually instead:  node launcher/index.js"
  echo ""
  if ask_yn "Register PechPech to start at login?"; then
    if node "$ROOT/launcher/index.js" --install; then
      ok "Auto-start enabled."
    else
      warn "Auto-start setup failed — try running manually: node launcher/index.js --install"
    fi
  fi

  # ── Summary ────────────────────────────────────────────────────
  hr
  echo ""
  echo -e "  ${BOLD}${GREEN}PechPech is running in Docker!${NC}"
  echo ""
  ok "Container:  pechpech-helper"
  ok "Endpoint:   http://127.0.0.1:${D_PORT}"
  ok "LLM:        ${D_LLM_CLI}  (change anytime in extension settings)"
  ok "STT:        ${D_STT_PROVIDER}  (change anytime in extension settings)"
  echo ""
  echo -e "  ${BOLD}Docker commands:${NC}"
  echo -e "  ${DIM}  ${COMPOSE_CMD[*]} logs -f          — live logs${NC}"
  echo -e "  ${DIM}  ${COMPOSE_CMD[*]} down             — stop${NC}"
  echo -e "  ${DIM}  ${COMPOSE_CMD[*]} up -d            — restart${NC}"
  echo -e "  ${DIM}  docker exec -it pechpech-helper sh   — shell into container${NC}"
  echo ""
  echo -e "  ${BOLD}Load the Chrome extension:${NC}"
  echo -e "  ${DIM}  1. Open ${CYAN}chrome://extensions${NC}"
  echo -e "  ${DIM}  2. Enable ${BOLD}Developer mode${NC}${DIM} (top-right toggle)${NC}"
  echo -e "  ${DIM}  3. Click ${BOLD}Load unpacked${NC}"
  echo -e "  ${DIM}  4. Select the ${BOLD}extension/${NC}${DIM} folder in this project${NC}"
  echo ""
  hr
  echo ""

  echo -e "  ${BOLD}Launching PechPech now…${NC}  ${DIM}(Ctrl-C to stop)${NC}"
  echo ""
  exec node "$ROOT/launcher/index.js"


# ═════════════════════════════════════════════════════════════════
#  WITHOUT DOCKER
# ═════════════════════════════════════════════════════════════════

else

  # ── Node.js ────────────────────────────────────────────────────
  step "Checking Node.js"

  if ! command -v node &>/dev/null; then
    echo ""
    echo -e "  ${RED}✗${NC}  Node.js not found."
    echo ""
    info "PechPech requires Node.js v18 or later."
    info "Install it with one of:"
    echo ""
    echo -e "  ${DIM}  nvm (recommended):   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash${NC}"
    echo -e "  ${DIM}                       then: nvm install 20${NC}"
    echo -e "  ${DIM}  Homebrew (macOS):    brew install node${NC}"
    echo -e "  ${DIM}  Direct download:     https://nodejs.org${NC}"
    echo ""
    die "Please install Node.js v18+ and re-run this script."
  fi

  NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
  MAJOR="${NODE_VER%%.*}"
  if (( MAJOR < 18 )); then
    echo -e "  ${RED}✗${NC}  Node.js ${NODE_VER} found — but v18+ is required."
    info "Upgrade: nvm install 20  or  https://nodejs.org"
    die "Please upgrade Node.js and re-run."
  fi
  ok "Node.js v${NODE_VER}"

  # ── ffmpeg ─────────────────────────────────────────────────────
  step "Audio preprocessing (ffmpeg)"

  FFMPEG_OK=false

  if command -v ffmpeg &>/dev/null; then
    FFMPEG_VER=$(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')
    ok "ffmpeg ${FFMPEG_VER} — already installed"
    FFMPEG_OK=true
  else
    warn "ffmpeg not found."
    echo ""
    info "ffmpeg improves speech recognition accuracy by cleaning your audio:"
    info "noise reduction, volume normalization, resampling to 16 kHz."
    info "Without it, recordings are sent as-is — still works for clear audio."
    echo ""

    if ask_yn "Install ffmpeg now?"; then
      echo ""
      if [[ "$OS" == "mac" ]]; then
        if command -v brew &>/dev/null; then
          info "Running: brew install ffmpeg  (this may take a few minutes)"
          echo ""
          BREW_OUT=$(brew install ffmpeg 2>&1)
          BREW_EXIT=$?
          if [[ $BREW_EXIT -eq 0 ]]; then
            ok "ffmpeg installed via Homebrew."
            FFMPEG_OK=true
          else
            # Check for the macOS-version-too-new error (Homebrew not yet updated for this OS)
            if echo "$BREW_OUT" | grep -q "unknown or unsupported macOS version"; then
              warn "Homebrew doesn't support your macOS version yet."
              echo ""
              info "A static ffmpeg binary can be downloaded from evermeet.cx (no dependencies)."
              echo ""
              if ask_yn "Download and install static ffmpeg binary now?"; then
                echo ""
                spin_start "Downloading ffmpeg…"
                curl -fsSL "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" -o /tmp/ffmpeg.zip
                spin_stop
                if unzip -o /tmp/ffmpeg.zip -d /tmp/ffmpeg-bin \
                   && sudo mv /tmp/ffmpeg-bin/ffmpeg /usr/local/bin/ffmpeg \
                   && sudo chmod +x /usr/local/bin/ffmpeg; then
                  ok "ffmpeg installed to /usr/local/bin/ffmpeg"
                  FFMPEG_OK=true
                else
                  warn "Installation failed — try manually: https://evermeet.cx/ffmpeg"
                fi
                rm -rf /tmp/ffmpeg.zip /tmp/ffmpeg-bin
              fi
            else
              warn "Homebrew install failed."
              echo "$BREW_OUT" | tail -5
              info "Try manually: https://ffmpeg.org/download.html"
            fi
          fi
        else
          warn "Homebrew not found."
          echo ""
          if ask_yn "Install Homebrew now? (needed to install ffmpeg)"; then
            echo ""
            info "Running Homebrew installer…"
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            # Source brew into the current shell after install
            for brew_path in /opt/homebrew/bin/brew /usr/local/bin/brew; do
              [[ -f "$brew_path" ]] && eval "$("$brew_path" shellenv)" && break
            done
            if command -v brew &>/dev/null; then
              info "Running: brew install ffmpeg"
              echo ""
              if brew install ffmpeg; then
                ok "ffmpeg installed via Homebrew."
                FFMPEG_OK=true
              else
                warn "brew install ffmpeg failed."
              fi
            else
              warn "Homebrew installed but brew not in PATH yet — open a new terminal and re-run this script."
            fi
          else
            warn "Skipping ffmpeg — audio will be sent to STT without preprocessing."
          fi
        fi

      elif [[ "$OS" == "linux" ]]; then
        case "$PKG_MGR" in
          apt)
            info "Running: sudo apt-get install -y ffmpeg"
            echo ""
            if sudo apt-get install -y ffmpeg; then
              ok "ffmpeg installed."; FFMPEG_OK=true
            else
              warn "apt install failed. Try manually: sudo apt-get install ffmpeg"
            fi ;;
          dnf)
            info "Running: sudo dnf install -y ffmpeg"
            echo ""
            if sudo dnf install -y ffmpeg; then
              ok "ffmpeg installed."; FFMPEG_OK=true
            else
              warn "dnf install failed. Try: sudo dnf install ffmpeg"
            fi ;;
          yum)
            info "Running: sudo yum install -y ffmpeg"
            echo ""
            if sudo yum install -y ffmpeg; then
              ok "ffmpeg installed."; FFMPEG_OK=true
            else
              warn "yum install failed."
            fi ;;
          pacman)
            info "Running: sudo pacman -S --noconfirm ffmpeg"
            echo ""
            if sudo pacman -S --noconfirm ffmpeg; then
              ok "ffmpeg installed."; FFMPEG_OK=true
            else
              warn "pacman install failed."
            fi ;;
          *)
            warn "Cannot detect your package manager. Install ffmpeg manually:"
            info "  https://ffmpeg.org/download.html" ;;
        esac

      elif [[ "$OS" == "windows" ]]; then
        if command -v choco &>/dev/null; then
          if ask_yn "Install ffmpeg via Chocolatey?"; then
            if choco install ffmpeg -y; then
              ok "ffmpeg installed."; FFMPEG_OK=true
            else
              warn "choco install failed."
            fi
          fi
        elif command -v winget &>/dev/null; then
          if ask_yn "Install ffmpeg via winget?"; then
            if winget install --id Gyan.FFmpeg -e; then
              ok "ffmpeg installed."; FFMPEG_OK=true
            else
              warn "winget install failed."
            fi
          fi
        else
          warn "Cannot find choco or winget. Install ffmpeg manually: https://ffmpeg.org/download.html"
          warn "After installing, re-run this script."
        fi
      fi
    else
      warn "Skipping ffmpeg — audio will be sent to STT without preprocessing."
    fi
  fi

  # ── npm install ────────────────────────────────────────────────
  step "Installing Node.js dependencies"

  spin_start "Running npm install…"
  (cd "$ROOT/server" && npm install --silent) &
  NPM_PID=$!
  if wait $NPM_PID; then
    spin_stop; ok "Dependencies ready."
  else
    spin_stop; die "npm install failed. Check the output above."
  fi

  # ── Configure ──────────────────────────────────────────────────
  step "Configuration"

  CFG_PORT=$(ask_input "Helper port" "3456")

  echo ""
  echo -e "  ${BOLD}LLM${NC}"
  echo -e "  ${DIM}The AI assistant used to generate meeting minutes.${NC}"
  echo -e "  ${DIM}All settings can also be changed later from the extension's settings panel.${NC}"
  echo ""
  echo -e "    ${BOLD}1${NC}  OpenAI (ChatGPT)"
  echo -e "    ${BOLD}2${NC}  Google Gemini"
  echo -e "    ${BOLD}3${NC}  Custom API   ${DIM}(OpenAI-compatible endpoint)${NC}"
  echo -e "    ${BOLD}4${NC}  Custom CLI   ${DIM}(any local CLI tool)${NC}"
  echo ""

  LLM_NUM=""
  while [[ ! "$LLM_NUM" =~ ^[1-4]$ ]]; do
    echo -ne "  ${MAGENTA}?${NC}  ${BOLD}Choice${NC}  ${DIM}[1]${NC}:  "
    read -r LLM_NUM
    LLM_NUM="${LLM_NUM:-1}"
  done

  CFG_LLM_CLI=""
  CFG_LLM_CMD=""
  CFG_LLM_API_URL=""
  CFG_LLM_API_KEY=""
  CFG_LLM_API_MODEL=""
  case "$LLM_NUM" in
    1) CFG_LLM_CLI="openai"
       echo ""
       CFG_LLM_API_KEY=$(ask_secret "OpenAI API key")
       CFG_LLM_API_MODEL=$(ask_input "Model name" "gpt-4o")
       ;;
    2) CFG_LLM_CLI="gemini-api"
       echo ""
       CFG_LLM_API_KEY=$(ask_secret "Gemini API key")
       CFG_LLM_API_MODEL=$(ask_input "Model name" "gemini-2.0-flash")
       ;;
    3) CFG_LLM_CLI="api"
       echo ""
       CFG_LLM_API_URL=$(ask_input "API base URL" "https://api.openai.com/v1")
       CFG_LLM_API_KEY=$(ask_secret "API key")
       CFG_LLM_API_MODEL=$(ask_input "Model name" "gpt-4o")
       ;;
    4) echo ""
       CFG_LLM_CLI="custom"
       CFG_LLM_CMD=$(ask_input "Full command to run your LLM" "my-llm")
       ;;
  esac

  echo ""
  echo -e "  ${BOLD}STT (Speech-to-Text)${NC}"
  echo -e "  ${DIM}Converts your recorded audio into a transcript before summarizing.${NC}"
  echo ""
  echo -e "    ${BOLD}1${NC}  Local / self-hosted  ${DIM}(Whisper-compatible endpoint)${NC}  — default"
  echo -e "    ${BOLD}2${NC}  OpenAI Whisper"
  echo -e "    ${BOLD}3${NC}  Google Gemini"
  echo ""

  STT_NUM=""
  while [[ ! "$STT_NUM" =~ ^[1-3]$ ]]; do
    echo -ne "  ${MAGENTA}?${NC}  ${BOLD}Choice${NC}  ${DIM}[1]${NC}:  "
    read -r STT_NUM
    STT_NUM="${STT_NUM:-1}"
  done

  CFG_STT_PROVIDER=""
  CFG_STT_URL=""
  CFG_STT_KEY=""
  CFG_STT_MODEL=""
  case "$STT_NUM" in
    1) CFG_STT_PROVIDER="custom"
       echo ""
       CFG_STT_URL=$(ask_input "STT base URL" "http://localhost:8080/v1")
       CFG_STT_KEY=$(ask_secret "API key (leave blank for local servers)")
       CFG_STT_MODEL=$(ask_input "Model name" "whisper-1")
       ;;
    2) CFG_STT_PROVIDER="openai"
       echo ""
       CFG_STT_KEY=$(ask_secret "OpenAI API key")
       CFG_STT_MODEL=$(ask_input "Model name" "whisper-1")
       ;;
    3) CFG_STT_PROVIDER="gemini"
       echo ""
       CFG_STT_KEY=$(ask_secret "Gemini API key")
       CFG_STT_MODEL=$(ask_input "Model name" "gemini-2.0-flash")
       ;;
  esac

  echo ""
  info "LLM and STT settings can be changed anytime from the extension's settings panel."

  # ── Quick health check ─────────────────────────────────────────
  step "Verify installation"
  echo ""
  if ask_yn "Start the helper now for a quick test?"; then
    echo ""
    info "Starting local helper on port ${CFG_PORT}…"
    PECHPECH_PORT="${CFG_PORT}" node "$ROOT/server/src/server.js" &
    H_PID=$!
    HEALTHY=false
    for _ in $(seq 1 20); do
      sleep 0.4
      if curl -sf "http://127.0.0.1:${CFG_PORT}/health" &>/dev/null; then
        HEALTHY=true; break
      fi
    done
    if $HEALTHY; then
      ok "Helper responded at http://127.0.0.1:${CFG_PORT}/health"
    else
      warn "No response within 8 s — check for errors in the output above."
    fi
    kill $H_PID 2>/dev/null
    wait $H_PID 2>/dev/null
    echo ""
    info "The test process was stopped. Start it again with:  node server/src/server.js"
  fi

  # ── Write .env (infrastructure only) ─────────────────────────
  step "Writing .env"
  {
    echo "MODE=native"
    echo "PECHPECH_PORT=${CFG_PORT}"
  } > "$ROOT/.env"
  ok ".env written."

  # ── Write config.json (LLM + STT settings) ────────────────────
  step "Writing config.json"
  node -e "
    const fs = require('fs');
    const cfg = {
      sttProvider: process.argv[1] || 'custom',
      sttUrl:      process.argv[2] || 'http://localhost:8080/v1',
      sttKey:      process.argv[3] || '',
      sttModel:    process.argv[4] || 'whisper-1',
      llmCli:      process.argv[5] || 'openai',
      llmCommand:  process.argv[6] || '',
      llmApiUrl:   process.argv[7] || '',
      llmApiKey:   process.argv[8] || '',
      llmApiModel: process.argv[9] || '',
    };
    fs.writeFileSync(process.argv[10], JSON.stringify(cfg, null, 2) + '\n');
  " \
    "$CFG_STT_PROVIDER" \
    "$CFG_STT_URL" \
    "$CFG_STT_KEY" \
    "$CFG_STT_MODEL" \
    "$CFG_LLM_CLI" \
    "$CFG_LLM_CMD" \
    "$CFG_LLM_API_URL" \
    "$CFG_LLM_API_KEY" \
    "$CFG_LLM_API_MODEL" \
    "$ROOT/server/src/config.json"
  ok "config.json written."

  # ── Auto-start ─────────────────────────────────────────────────
  step "Auto-start on login (optional)"
  echo ""
  info "The launcher can start PechPech automatically every time you log in."
  info "You can always start it manually instead:  node launcher/index.js"
  echo ""
  if ask_yn "Register PechPech to start at login?"; then
    if node "$ROOT/launcher/index.js" --install; then
      ok "Auto-start enabled."
    else
      warn "Auto-start setup failed — try running manually: node launcher/index.js --install"
    fi
  fi

  # ── Summary ────────────────────────────────────────────────────
  hr
  echo ""
  echo -e "  ${BOLD}${GREEN}Setup complete!${NC}"
  echo ""
  $FFMPEG_OK && ok "Audio preprocessing: ffmpeg active" \
             || warn "Audio preprocessing: ffmpeg not installed — audio sent raw to STT"
  ok "LLM:  ${CFG_LLM_CLI}  (change anytime in extension settings)"
  ok "STT:  ${CFG_STT_PROVIDER}  (change anytime in extension settings)"
  echo ""
  echo -e "  ${BOLD}To start PechPech:${NC}"
  echo -e "  ${DIM}  node server/src/server.js${NC}    ← simple, foreground"
  echo -e "  ${DIM}  node launcher/index.js${NC}         ← with notifications"
  echo ""
  echo -e "  ${BOLD}Load the Chrome extension:${NC}"
  echo -e "  ${DIM}  1. Open ${CYAN}chrome://extensions${NC}"
  echo -e "  ${DIM}  2. Enable ${BOLD}Developer mode${NC}${DIM} (top-right toggle)${NC}"
  echo -e "  ${DIM}  3. Click ${BOLD}Load unpacked${NC}"
  echo -e "  ${DIM}  4. Select the ${BOLD}extension/${NC}${DIM} folder in this project${NC}"
  echo ""
  hr
  echo ""

  echo -e "  ${BOLD}Launching PechPech now…${NC}  ${DIM}(Ctrl-C to stop)${NC}"
  echo ""
  exec node "$ROOT/launcher/index.js"

fi  # end mode branches
