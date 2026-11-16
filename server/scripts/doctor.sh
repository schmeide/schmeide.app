#!/usr/bin/env bash
# `make doctor`: checks everything the dev-mode server needs and prints the fix for each failure.
set -uo pipefail

failed=0
ok() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n        fix: %s\n' "$1" "$2"
  failed=1
}

echo "Schmeide doctor"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is not installed" "install Docker Desktop: https://docs.docker.com/get-docker/"
elif ! docker info >/dev/null 2>&1; then
  fail "the Docker daemon is not running" "Start Docker Desktop, then rerun make doctor"
else
  ok "docker is running"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node is not on PATH" "run make setup (installs nvm and the version in .nvmrc)"
elif (($(node --version | sed 's/^v\([0-9]*\).*/\1/') < 24)); then
  fail "node $(node --version) is too old (24 or newer needed)" "run make setup (installs the version in .nvmrc)"
else
  ok "node $(node --version)"
fi

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | cut -d' ' -f3)"
else
  fail "git is not on PATH" "install the Xcode command line tools: xcode-select --install"
fi

# Apple's /usr/bin/make 3.81 ignores .SHELLFLAGS, so every Makefile target here and in projects fails.
gnu_make=""
for candidate in gmake make; do
  bin="$(command -v "$candidate" || true)"
  if [[ -n "$bin" ]] && [[ "$("$bin" --version 2>/dev/null | head -1)" =~ GNU\ Make\ ([0-9]+) ]] && ((BASH_REMATCH[1] >= 4)); then
    gnu_make="$bin"
    break
  fi
done
if [[ -n "$gnu_make" ]]; then
  ok "GNU make 4+: $gnu_make"
else
  fail "GNU make 4 or newer not found (Apple's make is 3.81)" "install GNU make: brew install make"
fi

claude_bin="${SCHMEIDE_CLAUDE_BIN:-$(command -v claude || true)}"
if [[ -z "$claude_bin" ]]; then
  fail "claude is not on PATH" "install Claude Code (https://code.claude.com) and run claude once to log in"
else
  # A tiny headless prompt proves the CLI is logged in. Haiku keeps it cheap.
  limit=()
  if command -v timeout >/dev/null 2>&1; then limit=(timeout 90); fi
  reply="$(cd "${TMPDIR:-/tmp}" && "${limit[@]}" "$claude_bin" -p "Reply with the single word OK" \
    --model haiku --setting-sources project --tools "" --output-format text 2>&1)"
  if [[ "$reply" == *OK* ]]; then
    ok "claude $("$claude_bin" --version | cut -d' ' -f1) answers headless prompts"
  else
    fail "claude did not answer a headless prompt: ${reply:0:200}" "run claude in a terminal and log in (/login)"
  fi
fi

template="${SCHMEIDE_TEMPLATE:-https://github.com/schmeide/template.git}"
if git ls-remote --heads "$template" >/dev/null 2>&1; then
  ok "template reachable: $template"
else
  fail "template not reachable: $template" "set SCHMEIDE_TEMPLATE to a git URL or local path of the Schmeide template"
fi

# What publishes a port: a Docker container (by name) or a host process.
port_owner() {
  local container
  container="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E ":$1->" | cut -d' ' -f1 | head -1)"
  if [[ -n "$container" ]]; then
    echo "container $container"
  else
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'
  fi
}

# Ports held by this repo's own Compose services or a running server are fine.
own_ports=" $(docker compose ps --format '{{range .Publishers}}{{.PublishedPort}} {{end}}' 2>/dev/null | tr '\n' ' ') "
for port in 5440 5441 7233 8233 "${PORT:-3100}" 5173; do
  owner="$(port_owner "$port")"
  if [[ "$own_ports" == *" $port "* ]]; then
    ok "port $port is used by this repo's infrastructure"
  elif [[ -n "$owner" ]]; then
    fail "port $port is in use by $owner" "stop that process or container (or a make serve already running), then rerun make doctor"
  else
    ok "port $port is free"
  fi
done

# Each built app is the Compose project schmeide-<slug>, on web port 8100 + n (test database 5600 + n).
data_dir="${SCHMEIDE_DATA_DIR:-$HOME/.schmeide}"
apps="$({
  docker ps -a --format '{{.Label "com.docker.compose.project"}}'
  docker volume ls --format '{{.Label "com.docker.compose.project"}}'
} 2>/dev/null | grep '^schmeide-' | sort -u)"
for app in $apps; do
  slug="${app#schmeide-}"
  if [[ -d "$data_dir/projects/$slug" ]]; then
    ok "app $slug has containers or volumes and its project workspace"
  else
    fail "containers or volumes left over from a deleted project: $app" \
      "docker compose -p $app down --volumes --remove-orphans"
  fi
done
busy_app_ports=()
for ((n = 0; n < 20; n++)); do
  for port in $((8100 + n)) $((5600 + n)); do
    owner="$(port_owner "$port")"
    if [[ -n "$owner" && "$owner" != "container schmeide-"* ]]; then busy_app_ports+=("$port by $owner"); fi
  done
done
if ((${#busy_app_ports[@]} == 0)); then
  ok "app ports 8100-8119 and 5600-5619 are free or used by built apps"
else
  fail "app ports in use by something else: ${busy_app_ports[*]}" \
    "stop those processes or containers; built apps take web ports from 8100 and test databases from 5600"
fi

if [[ $failed -ne 0 ]]; then
  echo "Some checks failed; apply the fixes above."
  exit 1
fi
echo "All good. Next: make serve"
