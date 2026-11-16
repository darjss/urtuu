#!/bin/sh
# urtuu join: trades a one-time invite code for a token, then adds the urtuu MCP server and skill to Claude Code.
# Usage: curl -fsSL https://urtuu.darjs.dev/join.sh | sh -s <invite-code>
set -eu

main() {
  code="${1:?usage: sh join.sh <invite-code>}"
  url="${URTUU_URL:-https://urtuu.darjs.dev}"
  skill="https://raw.githubusercontent.com/darjss/urtuu/main/skills/urtuu/SKILL.md"

  login=$(gh api user -q .login 2>/dev/null || true)
  [ -n "$login" ] || login=$(git config --get github.user 2>/dev/null || true)
  [ -n "$login" ] || fail "no GitHub login found. Run 'gh auth login' or 'git config --global github.user <login>'."

  reply=$(curl -sS --fail-with-body -X POST "$url/join" \
    --data-urlencode "code=$code" --data-urlencode "login=$login") || fail "$reply"
  login=$(printf '%s\n' "$reply" | sed -n 1p)
  token=$(printf '%s\n' "$reply" | sed -n 2p)

  # The watch command reads the token from here.
  dir="$HOME/.config/urtuu"
  mkdir -p "$dir"
  (umask 077 && printf '%s\n' "$token" > "$dir/token")

  command -v claude >/dev/null || fail "claude not found. Your token is in $dir/token."
  claude mcp remove --scope user urtuu >/dev/null 2>&1 || true
  claude mcp add --scope user --transport http urtuu "$url/mcp" \
    --header "Authorization: Bearer $token" >/dev/null

  mkdir -p "$HOME/.claude/skills/urtuu"
  curl -fsS "$skill" -o "$HOME/.claude/skills/urtuu/SKILL.md" || echo "urtuu: skill download failed, skipping"

  forget_old_install
  echo "urtuu: joined as $login. Restart Claude Code, then ask it to read the urtuu channel."
}

# Earlier versions ran a local process and a prompt hook. Neither exists anymore.
forget_old_install() {
  rm -rf "$HOME/.local/share/urtuu"
  settings="$HOME/.claude/settings.json"
  [ -f "$settings" ] && command -v node >/dev/null || return 0
  node - "$settings" <<'JS'
const fs = require("fs");
const file = process.argv[2];
try {
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const hooks = settings.hooks?.UserPromptSubmit;
  if (!hooks) process.exit(0);
  const kept = hooks.filter((entry) => !JSON.stringify(entry).includes("urtuu/token"));
  if (kept.length === hooks.length) process.exit(0);
  if (kept.length) settings.hooks.UserPromptSubmit = kept;
  else delete settings.hooks.UserPromptSubmit;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
} catch {}
JS
}

fail() {
  echo "urtuu: $1" >&2
  exit 1
}

main "$@"
