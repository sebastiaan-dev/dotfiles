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
It registers the local profiler formula before package installation and installs
the pinned `pprof` tool using a Go toolchain managed by mise after the Homebrew
packages.
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
| Ghostty | `~/.config/ghostty/config.ghostty` | Nord colors, bundled 14-point font, zero padding, TUI background extension |
| Atuin | `~/.config/atuin/config.toml` | Local history, fuzzy Ctrl-R search; normal Up-arrow behavior |
| Zsh | `~/.zshrc` | Compact Nord prompt, tool PATH, mise, fzf, Atuin, Zoxide-backed `cd`, and syntax highlighting |
| ccache | `~/.config/ccache/ccache.conf` | 50 GB maximum cache size |
| LazyVim | `~/.config/nvim/` | Managed Neovim configuration |

The managed `.zshrc` sources `~/.zshrc.local` for machine-specific additions.
Managed aliases cover navigation (`..`, `...`, `c`), file listings (`ll`, `la`,
`lt`), Git (`g`, `gs`, `gd`, `gds`, `gl`), tools (`lg`, `n`, `cz`), and DuckDB
worktree commands (`jb`, `jf`, `jt`) under `~/repos`. Define aliases in
`~/.zshrc.local` to override these defaults.
Use `tn <name>` to create a tmux session with that exact name or attach to it
if it already exists. Inside tmux, the shortcut switches to the named session.
Before the first apply on an existing Mac, review `chezmoi diff` and move any
existing shell customizations you want to retain into that local file. Avoid
adding a second Atuin initialization there.

The local Nord prompt uses one information row above the command input:

```text
[~/project] - [main *+] - [venv:.venv]
▶
```

The Git segment appears inside repositories and shows the branch plus markers
for unstaged (`*`), staged (`+`), untracked (`%`), stashed (`$`), and upstream
differences (`<`, `>`, `<>`, `=`). The environment segment appears for an active
virtualenv, Conda environment, or pyenv selection; a `system` pyenv selection is
hidden. Virtualenv takes precedence over Conda and pyenv. An active `MISE_ENV`
adds a mise environment label. SSH sessions prepend `[user@host]`.
The input arrow turns red after a failed command.
The branch appears immediately. Git status markers refresh asynchronously:
the prompt keeps the last result while a background scan runs, then updates
without interrupting typed input. Changing directories cancels the previous
scan, and stale results are discarded.

Ghostty's Cmd+K clears the screen and scrollback, then sends Ctrl+L to redraw
both prompt lines.
Window padding is disabled. Any space left over from fitting whole character
cells is balanced between the edges. Ghostty's `extend` mode fills edge gaps
with nearby background colors, but avoids vertical extension on rows containing
Powerline glyphs, preserving the shapes in the Nord tmux footer.
On macOS, manual window resizing snaps to whole cells. Tiled or fullscreen
windows can still leave a small gap below the footer.
If switching back to `window-padding-color = background`, open a new Ghostty
tab or window and reattach tmux. Ghostty 1.3.1 can retain the old extension
flags in existing terminals after a configuration reload.

The theme is managed at `~/.config/zsh/prompts/prompt_nord_setup`; edit its
source in this repository to customize the layout. Git's prompt helper at
`~/.config/zsh/git-prompt.sh` and the `zsh-async` library at
`~/.config/zsh/async.zsh` are installed from pinned, checksum-verified files
in `.chezmoiexternal.toml`. The first apply requires network access.

`zsh-syntax-highlighting` colors commands as you type. Its script is loaded last,
after local customizations, fzf, Atuin, and the other shell integrations.

Zsh command completion is initialized before fzf and the other completion
integrations. In a directory containing a Makefile, type `make ` and press Tab
to complete target names, or start typing a target (for example, `make deb`)
and press Tab. Bundled Zsh and Homebrew command completions are available too.

The Zsh configuration is generated from `dot_zshrc.tmpl`. On macOS with hostname
`c0c7db20dcdc` (this Amazon work Mac), chezmoi includes a conditional branch that
prepends `~/.toolbox/bin` to PATH. Update the hostname condition if this Mac is
renamed.

Open a new terminal after applying. Start tmux with `tn main`.
Within tmux, press Ctrl-Space, release it, then:

- `c`: open a window in the current directory.
- `%`: split into left/right panes; `"`: split into top/bottom panes.
- `n` / `p`: next / previous window; `1`–`9`: select a window.
- `x`: close the current pane (with confirmation).
- `d`: detach; `R` (Shift-R): reload the configuration.
- `[`: enter scroll/copy mode; `q`: leave it.
- `?`: list all key bindings.
- `F` (Shift-F): open tmux-fzf to manage sessions, windows, and panes.
- `Tab`: open extrakto to fuzzy-select text from terminal output; use Tab to
  insert a selection or Enter to copy it to the clipboard.

The macOS keyboard hook disables the input-source shortcut when it is assigned
to Ctrl-Space, letting that key reach tmux. A customized input-source shortcut
is preserved. Press Ctrl-Space twice to send it to the application.

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

`Brewfile` includes CMake, Ninja, ccache, OpenSSL 3, Python, D2 (d2lang), samply,
gperftools, Valgrind,
zx, AWS CLI, Colima, Docker CLI, eza, bat, aria2, ripgrep, lazygit, lnav,
hyperfine, nnn, Typst, Obsidian, Raycast, GitHub CLI, gita, jq, yq, just, LLVM,
clang-format, mise, git-delta, ShellCheck, Rust (including Cargo), Bun, and
AeroSpace, Worktrunk, Beans, HTTPie CLI, watchexec, typos-cli, act, Discord, and
Zen Browser, alongside the terminal tools.

The GitHub extension hook installs `dlvhdr/gh-dash` and `seachicken/gh-poi`
after the package setup. It checks on each apply, skipping extensions that are
already installed. If GitHub CLI is not authenticated yet, sign in with
`gh auth login` and apply again. Existing extensions are not automatically
upgraded.

- `gh dash`: open the GitHub dashboard for pull requests and issues.
- `gh poi --dry-run`: preview merged local branches eligible for cleanup.
- `gh poi`: clean up those branches.
- `act -l`: list GitHub Actions jobs available in the current repository.
- `act`: run workflows locally using Docker; start Colima first with `colima start`.

On Apple Silicon Macs, chezmoi manages `~/.actrc` to select native
`linux/arm64` containers. The Ubuntu runner labels `ubuntu-latest`,
`ubuntu-24.04`, and `ubuntu-22.04` use the ARM64 variants of
`ghcr.io/catthehacker/ubuntu:act-*` images. A project `.actrc` or command-line
flags can override these defaults; use `act --container-architecture=linux/amd64`
when a workflow needs x86 containers.

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

### Profiling

Valgrind is built from Louis Brunner's macOS-compatible fork at `HEAD`, using
the local `dotfiles/profilers` Homebrew tap. Its formula is managed in
`homebrew/Formula/valgrind-macos.rb` and registered before package installation.
The formula carries the linker fix from upstream PR #204 until it is merged.
The build prefers an installed SDK matching the running macOS version, allowing
this Mac to use SDK 26.5 even when Command Line Tools select SDK 27 by default.

```sh
valgrind --leak-check=full ./program
```

gperftools supplies `libprofiler` and `libtcmalloc`. Google's standalone `pprof`
is installed from a pinned Go module into `~/.local/bin`, using Go 1.27.1 through
mise. For CPU profiling, link the program with `libprofiler` from
`$(brew --prefix gperftools)/lib`,
then collect and inspect a profile:

```sh
CPUPROFILE=profile.pprof ./program
pprof --text profile.pprof
```

Build the program with debug information for useful function and line names.
The profile includes executable mappings; macOS system libraries in the shared
cache may have incomplete symbol names.

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
Choose versions with `mise use`. The package hook installs Go 1.27.1 through mise
to build `pprof`, without selecting it as a global or project default.

### LazyVim

[LazyVim](https://www.lazyvim.org/) is configured under `~/.config/nvim` and runs
with `nvim`. The first launch downloads lazy.nvim and installs LazyVim's plugins;
network access is required. Run `:LazyHealth` afterward to check the setup.
Neovim, fd, fzf, tree-sitter-cli, and ripgrep are installed for its standard tools.
Ghostty already provides a bundled font with the icons LazyVim uses.

The default colorscheme is Kanso Mist, using its dark palette
and an opaque background. Theme settings are in `lua/plugins/colorscheme.lua`;
`lua/config/options.lua` selects the dark palette.

Keep customizations in `lua/config/` and plugin specs in `lua/plugins/` in this
repository. Plugin updates are managed with `:Lazy update`; review and optionally
import `~/.config/nvim/lazy-lock.json` with chezmoi to track exact plugin versions.
Review the diff before applying over an existing Neovim configuration.

The package list lives in `Brewfile`. To reinstall missing packages manually:

```sh
brew bundle install --no-upgrade --file=~/Brewfile
```

The hook uses `--no-upgrade` to install missing packages while keeping existing
versions. Third-party taps for Bun, AeroSpace, and Beans are declared in the
Brewfile. The local profiler tap is registered by the setup hook.
Their individual package entries use `trusted: true`, so Homebrew Bundle grants
trust before installing them without trusting every package in either tap.
See [Homebrew's Brewfile trust documentation](https://docs.brew.sh/Brew-Bundle-and-Brewfile#advanced-brewfiles).

If an older checkout fails with `refusing to load formula ... from untrusted tap`,
trust the packages explicitly and rerun the bootstrap script:

```sh
brew trust --formula oven-sh/bun/bun
brew trust --cask nikitabobko/tap/aerospace
brew trust --cask hmans/beans/beans
brew trust --formula dotfiles/profilers/valgrind-macos
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
