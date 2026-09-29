# dotfiles

Personal macOS configuration managed with [chezmoi](https://www.chezmoi.io/),
with [nanobrew](https://github.com/justrach/nanobrew) for packages.

## Bootstrap a new Mac

Run these commands in Terminal as your normal user:

```sh
curl -fsSL https://raw.githubusercontent.com/sebastiaan-dev/dotfiles/main/bootstrap.sh -o bootstrap.sh
bash bootstrap.sh
```

The download command works after `bootstrap.sh` has been committed and pushed to
`main`, provided the repository is publicly accessible. You can inspect the
script before running it.

The script:

1. Requests Apple's Command Line Tools if missing; full Xcode is not required.
2. Installs nanobrew if missing (its installer may ask for your administrator password).
3. Installs chezmoi in `~/.local/bin` if missing.
4. Fetches this repository and applies its configuration with `chezmoi init --apply`.

**When the Command Line Tools installer opens, finish installing and rerun
`bash bootstrap.sh`.** The first run exits without installing the remaining tools.
Already installed prerequisites are reused on subsequent runs.

Applying the repository also runs any chezmoi setup scripts it contains. This
repository currently has no managed configuration or package-install hooks;
bootstrap prepares the tools, and configurations can be added incrementally.

## Private repository

A private repository requires authenticated access for both the script download
and the chezmoi clone. Retrieve `bootstrap.sh` using authenticated GitHub access or
copy it from your existing Mac. After configuring GitHub SSH access on the new Mac:

```sh
DOTFILES_REPO=git@github.com:sebastiaan-dev/dotfiles.git bash bootstrap.sh
```

## Add configuration

Import existing files, then commit and push from chezmoi's source directory:

```sh
chezmoi add ~/.zshrc ~/.gitconfig
chezmoi cd
git add .
git commit -m "Add shell and Git configuration"
git push
exit
```

The default source directory is `~/.local/share/chezmoi`; it is a separate checkout
from any repository under `~/repos`. Make subsequent edits in the checkout you
intend to commit, and pull changes into the other checkout when needed.

Include this in your managed `~/.zshrc` so the installed tools are available in
new terminals:

```sh
export PATH="$HOME/.local/bin:/opt/nanobrew/prefix/bin:$PATH"
```

For packages, add a Brewfile and a chezmoi package-install script that runs
`nb bundle install` after the file has been applied. Keep plaintext credentials,
private keys, caches, and application data out of the repository.

## Update an existing Mac

```sh
chezmoi update
```

This pulls and applies the latest committed configuration, including any setup
scripts. It does not automatically upgrade installed packages.
