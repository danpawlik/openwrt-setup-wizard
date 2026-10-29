# VM test environment

Build and boot harness for testing `luci-app-setup-wizard` against a real
OpenWrt snapshot system.

## Layout

- `build.sh` — sync the package into the podman build container and build it.
- `boot.sh` — boot the x86_64 test image in qemu (fresh state every run).

## Build (podman container)

Builds run inside the `openwrt` podman container (image
`quay.io/dpawlik/openwrt:f44`), build tree at
`/home/user/openwrt-builder/openwrt`. The host repo is NOT mounted there, so
`build.sh` copies the package in via `podman cp` (source of truth stays in
this repo) and registers it as a `src-link` feed:

```
src-link setupwizard /home/user/openwrt-builder/openwrt-setup-wizard
```

What `build.sh` does:

1. `podman cp` the package (removing the previous copy first — podman cp
   nests directories otherwise).
2. Ensure `feeds.conf` exists (mirroring the feeds actually present in
   `feeds/`; note: `feeds.conf.default` lists feeds that were never
   installed and breaks `make defconfig` with kconfig recursive-dependency
   errors).
3. `./scripts/feeds update setupwizard luci && ./scripts/feeds install luci-app-setup-wizard`.
4. Temporarily add `CONFIG_PACKAGE_luci-app-setup-wizard=y` to `.config`
   (backed up and restored — the tree's own config is left untouched).
5. `make -j$(nproc) package/feeds/setupwizard/luci-app-setup-wizard/compile`.

Result: `bin/packages/<arch>/setupwizard/luci-app-setup-wizard-*.apk`
(snapshot OpenWrt packages as `.apk`, not `.ipk`).

Run: `vm/build.sh` (override container with `CONTAINER=name vm/build.sh`).

## Boot (qemu, x86_64) — pending until an x86_64 image is built

`boot.sh` boots the combined-ext4 image from
`../openwrt/bin/targets/x86/64/` in snapshot mode (every boot is a fresh
install), web on http://localhost:10080, ssh on localhost:10022.

To produce the image (in the container, tree switched to x86_64 target):

```
cd /home/user/openwrt-builder/openwrt
# select x86/64 target and CONFIG_PACKAGE_luci-app-setup-wizard=y
make menuconfig
make -j$(nproc)
```

## Deferred verification (once the VM exists)

- Menu shows System → Setup Wizard; the page renders.
- `ssh -p 10022 root@localhost 'uci show setupwizard'` → `done='0'`,
  `dismissed='0'`.
- `curl -s -o /dev/null -w '%{http_code}' http://localhost:10080/` → 200/302
  through LuCI.

## Host-side note

The host tree `../openwrt` (RH/upstream) is a reference checkout, not the
build tree. It has `feeds.conf` (created from default + the setupwizard
src-link) and a shallow `feeds/luci` clone for metadata checks — nothing is
built there.
