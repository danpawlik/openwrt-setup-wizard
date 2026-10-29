#!/bin/sh
# Sync the package into the podman build container and build the ipk there.
# Source of truth stays in this repo; the container copy is a build artifact.
# The container tree's .config is backed up and restored untouched.
set -eu

CONTAINER="${CONTAINER:-openwrt}"
CTREE="/home/user/openwrt-builder/openwrt"
CREPO="/home/user/openwrt-builder/openwrt-setup-wizard"

# rm first: podman cp of a dir onto an existing dir nests it (dir/dir)
podman exec "$CONTAINER" mkdir -p "$CREPO"
podman exec "$CONTAINER" rm -rf "$CREPO/luci-app-setup-wizard"
podman cp luci-app-setup-wizard "$CONTAINER:$CREPO/luci-app-setup-wizard"

podman exec "$CONTAINER" bash -ec "
cd $CTREE
if [ ! -f feeds.conf ]; then
	# mirror only the feeds actually present in feeds/ — feeds.conf.default
	# lists feeds (video, telephony) that were never installed here and
	# break make defconfig with kconfig recursive-dependency errors
	for f in \$(ls feeds/ | grep -v index | grep -v tmp | grep -v base); do
		grep \"^src-git \$f \" feeds.conf.default >> feeds.conf || true
	done
fi
grep -q 'src-link setupwizard' feeds.conf || echo 'src-link setupwizard $CREPO' >> feeds.conf
./scripts/feeds update setupwizard luci
./scripts/feeds install luci-app-setup-wizard

# temporarily select the package, restore .config afterwards
cp .config .config.setupwizard-bak
grep -q '^CONFIG_PACKAGE_luci-app-setup-wizard=y' .config || echo 'CONFIG_PACKAGE_luci-app-setup-wizard=y' >> .config
make defconfig >/dev/null
restore() { mv .config.setupwizard-bak .config; }
trap restore EXIT
make -j\$(nproc) package/feeds/setupwizard/luci-app-setup-wizard/compile
restore
trap - EXIT
"

podman exec "$CONTAINER" find "$CTREE/bin/packages" -name 'luci-app-setup-wizard*.ipk' -newer "$CTREE/feeds.conf" -ls
