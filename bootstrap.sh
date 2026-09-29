#!/bin/bash
set -euo pipefail

# Override this with an SSH URL for a private repository if needed.
DOTFILES_REPO="${DOTFILES_REPO:-https://github.com/sebastiaan-dev/dotfiles.git}"

if [ "$(uname -s)" != Darwin ]; then
  echo 'This bootstrap script requires macOS.' >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  echo 'Run this script as your normal user, without sudo.' >&2
  exit 1
fi

# xcode-select opens an asynchronous installer; do not start Git before it finishes.
if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find clang >/dev/null 2>&1; then
  echo 'Requesting Apple Command Line Tools (full Xcode is not required).'
  if ! xcode-select --install; then
    echo 'The installer may already be open. Finish installation or check Software Update.' >&2
  fi
  echo 'Finish the installation, then rerun: bash bootstrap.sh'
  exit 1
fi

git --version >/dev/null
export PATH="$HOME/.local/bin:/opt/nanobrew/prefix/bin:$PATH"

bootstrap_tmp="$(mktemp -d)"
trap 'rm -rf "$bootstrap_tmp"' EXIT

if ! command -v nb >/dev/null 2>&1; then
  echo 'Installing nanobrew...'
  curl -fsSL https://nanobrew.trilok.ai/install -o "$bootstrap_tmp/nanobrew-install.sh"
  bash "$bootstrap_tmp/nanobrew-install.sh"
fi

# Install chezmoi independently so bootstrapping does not depend on bottle support.
if ! command -v chezmoi >/dev/null 2>&1; then
  echo 'Installing chezmoi...'
  mkdir -p "$HOME/.local/bin"
  curl -fsSL https://get.chezmoi.io -o "$bootstrap_tmp/chezmoi-install.sh"
  sh "$bootstrap_tmp/chezmoi-install.sh" -b "$HOME/.local/bin"
fi
chezmoi --version

printf 'Applying dotfiles from %s...\n' "$DOTFILES_REPO"
chezmoi init --apply "$DOTFILES_REPO"

echo 'Bootstrap complete. Open a new terminal to load your shell configuration.'
echo 'Include ~/.local/bin and /opt/nanobrew/prefix/bin in your managed shell PATH.'
