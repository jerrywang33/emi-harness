#!/usr/bin/env bash

set -euo pipefail

EMI_HARNESS_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.emi-harness"
CONFIG_FILE="$CONFIG_DIR/path"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILL_SOURCE="$EMI_HARNESS_HOME/skills/emi-harness"
SKILL_TARGET="$CODEX_HOME/skills/emi-harness"

required_paths=(
    "$EMI_HARNESS_HOME/AGENTS.md"
    "$EMI_HARNESS_HOME/harness/workflow/new-module.md"
    "$SKILL_SOURCE/SKILL.md"
)

for required_path in "${required_paths[@]}"; do
    if [ ! -e "$required_path" ]; then
        printf 'Invalid EMI Harness checkout; missing %s\n' "$required_path" >&2
        exit 1
    fi
done

mkdir -p "$CONFIG_DIR" "$CODEX_HOME/skills"
printf '%s\n' "$EMI_HARNESS_HOME" > "$CONFIG_FILE"

if [ -L "$SKILL_TARGET" ]; then
    if [ "$(readlink "$SKILL_TARGET")" != "$SKILL_SOURCE" ]; then
        printf 'Refusing to replace existing skill link: %s\n' "$SKILL_TARGET" >&2
        exit 1
    fi
elif [ -e "$SKILL_TARGET" ]; then
    printf 'Refusing to replace existing skill directory: %s\n' "$SKILL_TARGET" >&2
    exit 1
else
    ln -s "$SKILL_SOURCE" "$SKILL_TARGET"
fi

printf 'EMI_HARNESS_HOME=%s\n' "$EMI_HARNESS_HOME"
printf 'Path file: %s\n' "$CONFIG_FILE"
printf 'Codex skill: %s -> %s\n' "$SKILL_TARGET" "$SKILL_SOURCE"
