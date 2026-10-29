# VM test environment

- `build.sh` — build the package inside the podman build container.
- `boot.sh` — boot an x86_64 OpenWrt image in qemu (fresh state every run).

## Build

Builds run in the `openwrt` podman container (`quay.io/dpawlik/openwrt:f44`),
tree at `/home/user/openwrt-builder/openwrt`. The host repo is not mounted
there, so `build.sh`:

1. copies `luci-app-setup-wizard/` into the tree's `package/` directory
   (`podman cp`, previous copy removed first — podman cp nests directories
   otherwise);
2. temporarily selects the package in `.config` (restored on exit);
3. runs `make package/luci-app-setup-wizard/compile`.

Feeds and `feeds.conf` are not touched. The package Makefile includes
`$(TOPDIR)/feeds/luci/luci.mk`, so the tree must have the luci feed installed.

Result: `bin/packages/<arch>/base/luci-app-setup-wizard-*.apk` (snapshot
packages are `.apk`). Override with `CONTAINER=... CTREE=... vm/build.sh`.

## Boot

`boot.sh` needs an x86_64 combined image. The current container tree targets
aarch64, so build x86_64 in a separate tree (or switch the target), with
`CONFIG_PACKAGE_luci-app-setup-wizard=y`, then copy the image out:

```
podman cp openwrt:<tree>/bin/targets/x86/64/openwrt-x86-64-generic-ext4-combined.img.gz vm/
gunzip vm/openwrt-x86-64-generic-ext4-combined.img.gz
mv vm/openwrt-x86-64-generic-ext4-combined.img vm/openwrt.img
vm/boot.sh
```

Or pass any image: `vm/boot.sh path/to/image.img`.

Network: eth0 = LAN (192.168.1.1, forwarded to localhost:10080 web and
localhost:10022 ssh), eth1 = WAN (DHCP from qemu). When the wizard changes the
LAN address, the port forwards stop working — restart with the forward target
edited in `boot.sh`.

## Pending checks (Task 1, need the VM)

- System → Setup Wizard is in the menu and the page renders.
- `ssh -p 10022 root@localhost uci show setupwizard` → `done='0'`, `dismissed='0'`.
