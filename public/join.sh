#!/bin/sh
# urtuu join: trades a one-time invite code for a token, then sets up Claude Code:
# the urtuu MCP server, the urtuu skill, and a hook that reports unread messages.
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

  dir="$HOME/.config/urtuu"
  mkdir -p "$dir"
  (umask 077 && printf '%s\n' "$token" > "$dir/token")

  command -v claude >/dev/null || fail "claude not found. Your token is in $dir/token."
  claude mcp remove --scope user urtuu >/dev/null 2>&1 || true
  if command -v node >/dev/null; then
    # The local channel: one process per Claude Code session, with live DMs.
    share="$HOME/.local/share/urtuu"
    mkdir -p "$share"
    curl -fsS "$url/urtuu.mjs" -o "$share/urtuu.mjs"
    # The name goes before -e, which would otherwise take it as another variable.
    # node by full path: apps like T3 Code launch Claude without the shell's PATH.
    claude mcp add --scope user urtuu -e "URTUU_URL=$url" -- "$(command -v node)" "$share/urtuu.mjs" >/dev/null
    live=1
  else
    claude mcp add --scope user --transport http urtuu "$url/mcp" \
      --header "Authorization: Bearer $token" >/dev/null
    live=0
  fi

  mkdir -p "$HOME/.claude/skills/urtuu"
  curl -fsS "$skill" -o "$HOME/.claude/skills/urtuu/SKILL.md" || echo "urtuu: skill download failed, skipping"

  hook="curl -fsS -m 3 -H \"authorization: Bearer \$(cat $dir/token)\" $url/unread || true"
  add_hook "$HOME/.claude/settings.json" "$hook"

  echo "urtuu: joined as $login."
  if [ "$live" = 1 ]; then
    echo "urtuu: for live DMs, start Claude Code with: claude --dangerously-load-development-channels server:urtuu"
    echo "urtuu: each session is reachable as $login@<repo name>; set URTUU_SESSION to pick another name."
  else
    echo "urtuu: node not found, so messages arrive on your next prompt instead of live. Restart Claude Code."
  fi
}

# Merges the UserPromptSubmit hook into settings.json without touching anything else.
add_hook() {
  command -v node >/dev/null || {
    echo "urtuu: node not found, add this UserPromptSubmit hook yourself: $2"
    return
  }
  node - "$1" "$2" <<'JS'
const fs = require("fs");
const [file, command] = process.argv.slice(2);
let settings = {};
if (fs.existsSync(file)) {
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.log(`urtuu: ${file} is not valid JSON, add this UserPromptSubmit hook yourself: ${command}`);
    process.exit(0);
  }
}
const hooks = (settings.hooks ??= {});
const others = (hooks.UserPromptSubmit ?? []).filter((entry) => !JSON.stringify(entry).includes("urtuu/token"));
hooks.UserPromptSubmit = [...others, { hooks: [{ type: "command", command }] }];
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
JS
}

fail() {
  echo "urtuu: $1" >&2
  exit 1
}

main "$@"
