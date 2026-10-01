# dotfiles

Personal macOS configuration managed with [chezmoi](https://www.chezmoi.io/),
with [Homebrew](https://brew.sh/) for packages.

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
2. Installs Homebrew if missing (its installer may ask for your administrator password).
3. Initializes Homebrew and installs chezmoi with `brew` if missing.
4. Initializes this repository with `chezmoi init`, then pulls and applies the
   latest committed configuration with `chezmoi update`. Rerunning bootstrap
   refreshes an existing chezmoi checkout before applying its setup hooks.

**When the Command Line Tools installer opens, finish installing and rerun
`bash bootstrap.sh`.** The first run exits without installing the remaining tools.
Already installed prerequisites are reused on subsequent runs. Homebrew uses
`/opt/homebrew` on Apple Silicon and `/usr/local` on Intel Macs. The bootstrap
and managed Zsh configuration initialize it with `brew shellenv`.

Applying the repository installs the CLI tools and apps listed in `Brewfile`
through Homebrew, installs cmake-format with uv, downloads shell scripts and
tmux plugins, and writes managed configuration.
The package hook runs on first apply and whenever
`Brewfile` changes. Existing package versions are not automatically upgraded.

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

## Terminal setup

| Tool | Managed configuration | Behavior |
| --- | --- | --- |
| tmux | `~/.tmux.conf` | Ctrl-Space prefix, Alt-arrow pane navigation, Nord theme, tmux-fzf and extrakto |
| Ghostty | `~/.config/ghostty/config.ghostty` | Nord colors, bundled 14-point font, window padding |
| Atuin | `~/.config/atuin/config.toml` | Local history, fuzzy Ctrl-R search; normal Up-arrow behavior |
| Zsh | `~/.zshrc` | Igloo prompt, tool PATH, mise, fzf, Atuin, zoxide, and syntax highlighting |
| ccache | `~/.config/ccache/ccache.conf` | 50 GB maximum cache size |
| LazyVim | `~/.config/nvim/` | Managed Neovim configuration |

The managed `.zshrc` sources `~/.zshrc.local` for machine-specific additions.
Managed aliases cover navigation (`..`, `...`, `c`), file listings (`ll`, `la`,
`lt`), Git (`g`, `gs`, `gd`, `gds`, `gl`), and tools (`lg`, `n`, `cz`).
Define aliases in `~/.zshrc.local` to override these defaults.
Before the first apply on an existing Mac, review `chezmoi diff` and move any
existing shell customizations you want to retain into that local file. Avoid
adding a second Atuin initialization there.

Igloo provides Nord's bracketed, multiline prompt, showing the username, time,
current directory, and Git branch/status/short commit when inside a repository.
The hostname appears in SSH sessions; background jobs and failed commands
add status indicators. Set `IGLOO_ZSH_PROMPT_THEME_ALWAYS_SHOW_USER=false` or
`IGLOO_ZSH_PROMPT_THEME_HIDE_TIME=true` in `~/.zshrc.local` to hide those segments.
Run `prompt -h igloo` for the theme's full configuration help.

chezmoi installs the upstream theme at `~/.config/zsh/prompts/prompt_igloo_setup`
and Git's prompt helper at `~/.config/zsh/git-prompt.sh`, using pinned,
checksum-verified files from `.chezmoiexternal.toml`. The first apply requires
network access.

`zsh-syntax-highlighting` colors commands as you type. Its script is loaded last,
after local customizations, fzf, Atuin, and the other shell integrations.

The Zsh configuration is generated from `dot_zshrc.tmpl`. On macOS with hostname
`c0c7db20dcdc` (this Amazon work Mac), chezmoi includes a conditional branch that
prepends `~/.toolbox/bin` to PATH. Update the hostname condition if this Mac is
renamed.

Open a new terminal after applying. Start tmux with `tmux new -s main`.
Within tmux, press Ctrl-Space, then:

- `c`: open a window in the current directory.
- `%`: split into left/right panes; `"`: split into top/bottom panes.
- `d`: detach; `R` (Shift-R): reload the configuration.
- `F` (Shift-F): open tmux-fzf to manage sessions, windows, and panes.
- `Tab`: open extrakto to fuzzy-select text from terminal output; use Tab to
  insert a selection or Enter to copy it to the clipboard.

Alt-arrow keys move between panes without the prefix. Windows and panes start
at 1, mouse support is disabled, and pane history retains 10,000 lines.
Key bindings and behavior are translated from `modules/home/shell.nix` in
`vps-nix`. The configuration fixes the source's `update-environment -r` line to
reset the default variable list with `set -gu update-environment`.

Nord tmux supplies the status bar, window styles, pane borders, messages, and
clock colors. Its theme uses the terminal's ANSI palette, so Ghostty also loads
its built-in Nord theme.

chezmoi installs tmux-fzf, extrakto, and Nord tmux under `~/.tmux/plugins` from
the pinned, checksum-verified archives in `.chezmoiexternal.toml`. The first
apply requires network access; fzf and Python are installed through Homebrew.
To update a plugin, change its commit in the archive URL and update its SHA256
checksum.

Ghostty configuration reloads with Cmd-Shift-comma;
macOS-specific Ghostty configuration may override the managed XDG file.

To import your existing shell history once:

```sh
atuin import auto
```

Atuin account setup and history sync are optional. To enable automatic sync,
configure your account and change `auto_sync` in the managed config to `true`.
Keep Atuin databases, credentials, and encryption keys outside this repository.

## Developer tools

`Brewfile` includes CMake, Ninja, ccache, OpenSSL 3, Python, Go, D2 (d2lang), samply,
zx, AWS CLI, Colima, Docker CLI, eza, bat, aria2, ripgrep, lazygit, lnav,
hyperfine, nnn, Typst, Obsidian, Raycast, GitHub CLI, gita, jq, yq, just, LLVM,
clang-format, mise, git-delta, ShellCheck, Rust (including Cargo), Bun, and
AeroSpace, Worktrunk, HTTPie CLI, watchexec, Discord, and Zen Browser, alongside
the terminal tools.

[cmake-format](https://cmake-format.readthedocs.io/en/latest/installation.html)
is supplied by `cmakelang[YAML]==0.6.13`, installed with uv using Python 3.11.
The package hook handles this after installing uv. Its executables are available
under `~/.local/bin`.

The shell sets `CCACHE_CONFIGPATH` to the managed configuration, whose
`max_size = 50GB` sets a decimal 50 GB limit without preallocating that space.
Use ccache with a CMake project explicitly:

```sh
cmake -S . -B build -G Ninja \
  -DCMAKE_C_COMPILER_LAUNCHER=ccache \
  -DCMAKE_CXX_COMPILER_LAUNCHER=ccache
cmake --build build
ccache --show-stats
```

zoxide provides `z` and `zi`; Go-installed tools in `~/go/bin` and Cargo-installed
tools in `~/.cargo/bin` are on PATH. fzf supplies Ctrl-T file selection and Alt-C
directory selection; Atuin retains Ctrl-R. fd and ripgrep are also installed.
Colima is installed without starting a VM automatically. Start its Docker runtime
when needed with `colima start`, then use the installed `docker` CLI.
Obsidian vaults and AWS credentials stay outside the dotfiles repository.

### AeroSpace

[AeroSpace](https://nikitabobko.github.io/AeroSpace/guide) is installed from
`nikitabobko/tap/aerospace`. Its managed configuration is `~/.aerospace.toml`.
Open AeroSpace once and grant Accessibility access in System Settings when
prompted. The configuration enables tiling and starts AeroSpace at login.

- Option-H/J/K/L: focus left/down/up/right.
- Option-Shift-H/J/K/L: move the focused window.
- Option-1 through Option-9: switch workspaces.
- Option-Shift-1 through Option-Shift-9: move a window to a workspace.
- Option-slash: toggle horizontal/vertical tiles; Option-comma: accordion layout.
- Option-F: toggle fullscreen; Option-Shift-Space: toggle floating/tiling.
- Option-Shift-R: reload the configuration.

Use only one AeroSpace configuration location; an existing
`~/.config/aerospace/aerospace.toml` alongside `~/.aerospace.toml` is ambiguous.
Bun is installed from `oven-sh/bun/bun`; Cargo comes with the `rust` package.

### Worktrunk

[Worktrunk](https://worktrunk.dev/) is installed as `worktrunk`; its command is
`wt`. The managed Zsh configuration initializes its shell integration so
`wt switch` changes your current directory. Open a new terminal after applying.

```sh
wt list
wt switch --create my-feature
wt switch main
```

### Git and mise

The managed `~/.gitconfig` configures:

- User: Sebastiaan Gerritsen (`sebastiaan@ducklabs.com`).
- Default branch for new repositories: `main`.
- `git pull`: fast-forward when possible, otherwise merge instead of rebasing.
  Conflicts remain for manual resolution.
- Automatic coloring for terminal output (`color.ui = auto`).
- delta as Git's pager and interactive diff filter, using Nord syntax
  highlighting and colors for a dark background.
- Global ignore rules in `~/.config/git/ignore` for mise configuration files,
  environment/local variants, lockfiles, and mise configuration directories.

These ignore rules affect untracked files in all repositories. Existing tracked
mise files remain tracked. Use `git add -f` if you intentionally want to commit a
new mise file despite the global ignore rules.

mise is activated in Zsh for per-project tool versions and environments.
Choose versions with `mise use`; no language versions are installed through mise
automatically by these dotfiles.

### LazyVim

[LazyVim](https://www.lazyvim.org/) is configured under `~/.config/nvim` and runs
with `nvim`. The first launch downloads lazy.nvim and installs LazyVim's plugins;
network access is required. Run `:LazyHealth` afterward to check the setup.
Neovim, fd, fzf, tree-sitter-cli, and ripgrep are installed for its standard tools.
Ghostty already provides a bundled font with the icons LazyVim uses.

Keep customizations in `lua/config/` and plugin specs in `lua/plugins/` in this
repository. Plugin updates are managed with `:Lazy update`; review and optionally
import `~/.config/nvim/lazy-lock.json` with chezmoi to track exact plugin versions.
Review the diff before applying over an existing Neovim configuration.

The package list lives in `Brewfile`. To reinstall missing packages manually:

```sh
brew bundle install --no-upgrade --file=~/Brewfile
```

The hook uses `--no-upgrade` to install missing packages while keeping existing
versions. Third-party taps for Bun and AeroSpace are declared in the Brewfile.
Their individual package entries use `trusted: true`, so Homebrew Bundle grants
trust before installing them without trusting every package in either tap.
See [Homebrew's Brewfile trust documentation](https://docs.brew.sh/Brew-Bundle-and-Brewfile#advanced-brewfiles).

If an older checkout fails with `refusing to load formula ... from untrusted tap`,
trust the two packages explicitly and rerun the bootstrap script:

```sh
brew trust --formula oven-sh/bun/bun
brew trust --cask nikitabobko/tap/aerospace
bash bootstrap.sh
```

Commit and push the updated Brewfile, then run `chezmoi update` on other Macs to
apply the persistent trust declarations.

## Update an existing Mac

```sh
chezmoi update
```

This pulls and applies the latest committed configuration. If `Brewfile` changed,
the package hook installs newly listed packages. Removing a package from the list
does not uninstall it. To upgrade installed packages separately, run `brew upgrade`.

## An old package hook still asks for the previous package manager

The checkout under `~/.local/share/chezmoi` may be behind your dotfiles repo.
Commit and push the Homebrew changes to GitHub, then run:

```sh
chezmoi update
```

This pulls the updated package hook before applying it. If you downloaded
`bootstrap.sh` earlier, download it again after pushing the change. Updates may
stop if the chezmoi checkout contains conflicting local edits; preserve those
edits and resolve the Git conflict before retrying.
