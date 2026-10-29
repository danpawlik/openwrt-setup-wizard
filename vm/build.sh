#!/bin/sh
# Copy the package into the podman build container and build it there.
# Source of truth stays in this repo; the container copy is a build artifact.
# The tree's feeds and .config are left untouched (.config is restored).
set -eu

CONTAINER="${CONTAINER:-openwrt}"
CTREE="${CTREE:-/home/user/openwrt-builder/openwrt}"
PKG=luci-app-setup-wizard

cd "$(dirname "$0")/.."

# rm first: podman cp of a dir onto an existing dir nests it (dir/dir)
podman exec "$CONTAINER" rm -rf "$CTREE/package/$PKG"
podman cp "$PKG" "$CONTAINER:$CTREE/package/$PKG"

podman exec "$CONTAINER" bash -ec "
cd $CTREE
cp .config .config.setupwizard-bak
trap 'mv .config.setupwizard-bak .config' EXIT
echo 'CONFIG_PACKAGE_$PKG=y' >> .config
make defconfig >/dev/null
make -j\$(nproc) package/$PKG/compile
find bin/packages -name '$PKG-*' -newer .config.setupwizard-bak
"
