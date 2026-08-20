#!/bin/sh
# shellcheck shell=dash
# Install the deckops Go CLI from GitHub Releases.
#
# Usage (macOS / Linux):
#   curl --proto '=https' --tlsv1.2 -LsSf \
#     https://github.com/deckflow/deckops/releases/latest/download/deckops-installer.sh | sh
#
# Optional environment variables:
#   DECKOPS_VERSION       Pin a version (e.g. 0.7.3). Default: latest go-cli release.
#   DECKOPS_INSTALL_DIR   Install directory for the binary. Default: $HOME/.local/bin
#   DECKOPS_NO_MODIFY_PATH  Set to 1 to skip PATH hints / shell profile updates.
#   DECKOPS_PRINT_VERBOSE Set to 1 for verbose logs.
#   DECKOPS_GITHUB_TOKEN  Optional token for higher GitHub API rate limits / private fetches.
#
# Inspired by the deckprobe cargo-dist installer UX:
#   https://github.com/deckflow/deckprobe

set -u

APP_NAME="deckops"
REPO="deckflow/deckops"
TAG_PREFIX="go-cli/v"

PRINT_VERBOSE="${DECKOPS_PRINT_VERBOSE:-0}"
NO_MODIFY_PATH="${DECKOPS_NO_MODIFY_PATH:-0}"
AUTH_TOKEN="${DECKOPS_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"

GITHUB_BASE="${DECKOPS_INSTALLER_GITHUB_BASE_URL:-https://github.com}"
API_BASE="${DECKOPS_INSTALLER_GITHUB_API_BASE_URL:-https://api.github.com}"

say() {
    printf '%s\n' "$1"
}

say_verbose() {
    if [ "$PRINT_VERBOSE" = "1" ]; then
        printf '%s\n' "$1" >&2
    fi
}

err() {
    say "$1" >&2
    exit 1
}

need_cmd() {
    if ! check_cmd "$1"; then
        err "need '$1' (command not found)"
    fi
}

check_cmd() {
    command -v "$1" >/dev/null 2>&1
}

ensure() {
    if ! "$@"; then
        err "command failed: $*"
    fi
}

downloader() {
    local _url="$1"
    local _out="$2"
    local _auth_header=""

    if [ -n "$AUTH_TOKEN" ]; then
        _auth_header="Authorization: Bearer ${AUTH_TOKEN}"
    fi

    if check_cmd curl; then
        if [ -n "$_auth_header" ]; then
            curl --proto '=https' --tlsv1.2 --retry 3 -fsSL \
                -H "$_auth_header" \
                -H "Accept: application/octet-stream" \
                "$_url" -o "$_out"
        else
            curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "$_url" -o "$_out"
        fi
    elif check_cmd wget; then
        if [ -n "$_auth_header" ]; then
            wget --secure-protocol=TLSv1_2 --tries=3 -q \
                --header="$_auth_header" \
                --header="Accept: application/octet-stream" \
                -O "$_out" "$_url"
        else
            wget --secure-protocol=TLSv1_2 --tries=3 -q -O "$_out" "$_url"
        fi
    else
        err "need 'curl' or 'wget' to download"
    fi
}

get_home() {
    if [ -n "${HOME:-}" ]; then
        printf '%s\n' "$HOME"
    elif [ -n "${USER:-}" ] && check_cmd getent; then
        getent passwd "$USER" | cut -d: -f6
    elif check_cmd getent; then
        getent passwd "$(id -un)" | cut -d: -f6
    else
        err "could not determine HOME"
    fi
}

detect_target() {
    local _os
    local _arch
    local _uname_s
    local _uname_m

    _uname_s="$(uname -s)"
    _uname_m="$(uname -m)"

    case "$_uname_s" in
        Linux) _os="linux" ;;
        Darwin) _os="darwin" ;;
        MINGW* | MSYS* | CYGWIN*)
            err "Windows detected. Use the .zip assets from GitHub Releases, or run this installer from WSL."
            ;;
        *)
            err "unsupported OS: $_uname_s"
            ;;
    esac

    case "$_uname_m" in
        x86_64 | amd64) _arch="amd64" ;;
        arm64 | aarch64) _arch="arm64" ;;
        *)
            err "unsupported architecture: $_uname_m"
            ;;
    esac

    RETVAL="${_os}_${_arch}"
}

resolve_version() {
    local _version="${DECKOPS_VERSION:-}"
    local _json
    local _tmp

    if [ -n "$_version" ]; then
        # Allow go-cli/vX.Y.Z or vX.Y.Z or X.Y.Z
        _version="${_version#go-cli/}"
        _version="${_version#v}"
        RETVAL="$_version"
        return 0
    fi

    need_cmd curl
    say_verbose "resolving latest ${TAG_PREFIX}* release"
    _tmp="$(mktemp)"
    if [ -n "$AUTH_TOKEN" ]; then
        ensure curl --proto '=https' --tlsv1.2 -fsSL \
            -H "Authorization: Bearer ${AUTH_TOKEN}" \
            -H "Accept: application/vnd.github+json" \
            "${API_BASE}/repos/${REPO}/releases?per_page=30" -o "$_tmp"
    else
        ensure curl --proto '=https' --tlsv1.2 -fsSL \
            -H "Accept: application/vnd.github+json" \
            "${API_BASE}/repos/${REPO}/releases?per_page=30" -o "$_tmp"
    fi

    # Prefer releases/latest when it is a go-cli tag; otherwise scan the list.
    _json="$(cat "$_tmp")"
    rm -f "$_tmp"

    _version="$(
        printf '%s' "$_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(go-cli\/v[^"]*\)".*/\1/p' | head -n 1
    )"

    if [ -z "$_version" ]; then
        err "could not find a ${TAG_PREFIX}* release on GitHub"
    fi

    _version="${_version#go-cli/v}"
    RETVAL="$_version"
}

verify_checksum() {
    local _file="$1"
    local _checksums_file="$2"
    local _artifact="$3"
    local _expected
    local _actual

    _expected="$(
        awk -v artifact="$_artifact" '
            $2 == artifact || $2 == ("*" artifact) { print $1; exit }
        ' "$_checksums_file"
    )"

    if [ -z "$_expected" ]; then
        say "warning: no checksum entry for ${_artifact}; skipping verification"
        return 0
    fi

    if check_cmd sha256sum; then
        _actual="$(sha256sum "$_file" | awk '{print $1}')"
    elif check_cmd shasum; then
        _actual="$(shasum -a 256 "$_file" | awk '{print $1}')"
    else
        say "warning: neither sha256sum nor shasum found; skipping checksum verification"
        return 0
    fi

    if [ "$_actual" != "$_expected" ]; then
        err "checksum mismatch for ${_artifact}
  expected: ${_expected}
  actual:   ${_actual}"
    fi

    say_verbose "checksum ok (${_actual})"
}

maybe_clear_quarantine() {
    local _bin="$1"
    if [ "$(uname -s)" = "Darwin" ] && check_cmd xattr; then
        xattr -d com.apple.quarantine "$_bin" >/dev/null 2>&1 || true
    fi
}

ensure_path_hint() {
    local _install_dir="$1"
    local _home
    local _profile=""
    local _line
    local _shell_name

    case ":${PATH}:" in
        *":${_install_dir}:"*)
            return 0
            ;;
    esac

    say ""
    say "${_install_dir} is not on your PATH."

    if [ "$NO_MODIFY_PATH" = "1" ]; then
        say "Add it manually, for example:"
        say "  export PATH=\"${_install_dir}:\$PATH\""
        return 0
    fi

    _home="$(get_home)"
    _shell_name="$(basename "${SHELL:-/bin/sh}")"
    _line="export PATH=\"${_install_dir}:\$PATH\""

    case "$_shell_name" in
        zsh) _profile="${_home}/.zshrc" ;;
        bash)
            if [ -f "${_home}/.bashrc" ]; then
                _profile="${_home}/.bashrc"
            else
                _profile="${_home}/.bash_profile"
            fi
            ;;
        fish)
            say "Add the following to your fish config:"
            say "  fish_add_path ${_install_dir}"
            return 0
            ;;
        *)
            _profile="${_home}/.profile"
            ;;
    esac

    if [ -f "$_profile" ] && grep -F "$_install_dir" "$_profile" >/dev/null 2>&1; then
        say "PATH entry already present in ${_profile}; open a new shell and run: ${APP_NAME} --version"
        return 0
    fi

    say "Appending PATH update to ${_profile}"
    {
        printf '\n# %s\n' "$APP_NAME"
        printf '%s\n' "$_line"
    } >>"$_profile"
    say "Restart your shell, or run: . ${_profile}"
}

main() {
    local _home
    local _target
    local _version
    local _artifact
    local _url
    local _checksums_url
    local _install_dir
    local _archive
    local _checksums
    local _bin_src
    local _bin_dst

    need_cmd uname
    need_cmd mktemp
    need_cmd mkdir
    need_cmd tar
    need_cmd mv
    need_cmd chmod

    if ! check_cmd curl && ! check_cmd wget; then
        err "need 'curl' or 'wget' to download"
    fi

    _home="$(get_home)"
    detect_target
    _target="$RETVAL"

    resolve_version
    _version="$RETVAL"

    _install_dir="${DECKOPS_INSTALL_DIR:-${_home}/.local/bin}"
    _artifact="${APP_NAME}_${_version}_${_target}.tar.gz"
    _url="${GITHUB_BASE}/${REPO}/releases/download/${TAG_PREFIX}${_version}/${_artifact}"
    _checksums_url="${GITHUB_BASE}/${REPO}/releases/download/${TAG_PREFIX}${_version}/checksums.txt"

    say "installing ${APP_NAME} ${_version} (${_target})"
    say_verbose "  from ${_url}"
    say_verbose "  into ${_install_dir}"

    INSTALL_TMPDIR="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap 'rm -rf "${INSTALL_TMPDIR}"' EXIT INT HUP

    _archive="${INSTALL_TMPDIR}/${_artifact}"
    _checksums="${INSTALL_TMPDIR}/checksums.txt"

    if ! downloader "$_url" "$_archive"; then
        err "failed to download ${_url}"
    fi

    if downloader "$_checksums_url" "$_checksums"; then
        verify_checksum "$_archive" "$_checksums" "$_artifact"
    else
        say "warning: could not download checksums.txt; skipping verification"
    fi

    ensure tar -xzf "$_archive" -C "$INSTALL_TMPDIR"

    if [ -f "${INSTALL_TMPDIR}/${APP_NAME}" ]; then
        _bin_src="${INSTALL_TMPDIR}/${APP_NAME}"
    elif [ -f "${INSTALL_TMPDIR}/${APP_NAME}/${APP_NAME}" ]; then
        _bin_src="${INSTALL_TMPDIR}/${APP_NAME}/${APP_NAME}"
    else
        err "archive did not contain ${APP_NAME} binary"
    fi

    ensure mkdir -p "$_install_dir"
    _bin_dst="${_install_dir}/${APP_NAME}"
    ensure mv "$_bin_src" "$_bin_dst"
    ensure chmod +x "$_bin_dst"
    maybe_clear_quarantine "$_bin_dst"

    say "installed ${_bin_dst}"
    if "$_bin_dst" --version >/dev/null 2>&1; then
        say "  $("$_bin_dst" --version)"
    fi

    ensure_path_hint "$_install_dir"
    say "done."
}

main "$@"
