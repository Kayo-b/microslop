#!/usr/bin/env bash
# Builds Bolt 0.24 (Jagex Launcher replacement) from source into ~/.local/opt/bolt-0.24,
# following the AUR bolt-launcher PKGBUILD, without root. Needs gcc, make, git and the
# runtime libraries listed in the PKGBUILD (gtk3, nss, luajit, libarchive, fmt, ...);
# cmake comes from mise.
#
# Why not the GitHub release: development moved to Codeberg; the last GitHub build (0.20.6)
# cannot complete the current Jagex login (its login popup closes without saving an account).
set -euo pipefail
VERSION="${BOLT_VERSION:-0.24.0}"
PREFIX="${BOLT_PREFIX:-$HOME/.local/opt/bolt-0.24}"
SRC="${BOLT_SRC:-$HOME/.local/src/bolt-build}"
CEF="cef-139.0.7258.139-linux-x86_64-minimal-ungoogled.tar.xz"
CEF_SHA256="aeb98ff1f621c8f7c5f0be6c34acefaf4fe4be763004a9d2a9e933d1cd914650"

mise install cmake@latest >/dev/null
CMAKE="$(find "$(mise where cmake@latest)" -path '*/bin/cmake' -type f | head -1)"

mkdir -p "$SRC" && cd "$SRC"
[[ -d Bolt ]] || git clone --depth 1 --branch "$VERSION" https://codeberg.org/Adamcake/Bolt.git
git -C Bolt submodule update --init --recursive
for f in fmt.patch cef-no-fortify.patch; do
  curl -sf -o "$f" "https://aur.archlinux.org/cgit/aur.git/plain/$f?h=bolt-launcher"
done
if [[ ! -d dist ]]; then
  curl -sf -o "$CEF" "https://adamcake.com/cef/$CEF"
  echo "$CEF_SHA256  $CEF" | sha256sum -c
  tar -xf "$CEF"
  patch -s -p1 -d dist < cef-no-fortify.patch
  git -C Bolt apply ../fmt.patch
fi
"$CMAKE" -S Bolt -B build -G "Unix Makefiles" -D CMAKE_BUILD_TYPE=Release -D CEF_ROOT="$PWD/dist" \
  -D CMAKE_INSTALL_PREFIX="$PREFIX" -D BOLT_BINDIR=bin -D BOLT_LIBDIR=lib -D BOLT_SHAREDIR=share \
  -D BOLT_META_NAME=bolt-launcher
"$CMAKE" --build build -j"$(nproc)"
"$CMAKE" --install build
echo "Installed Bolt $VERSION to $PREFIX"
