# openwrt-setup-wizard

A first-run setup wizard for OpenWrt's LuCI web interface. A non-technical
user opens the router's address in a browser and gets a router with working
internet and WiFi in a few clicks, without touching the full LuCI menus.

Package: `luci-app-setup-wizard`. Target: OpenWrt snapshot.

<!-- Screenshots: TODO -->

## What it configures

1. **Administrator password**: leave empty to keep the current one.
2. **Internet connection**: shows the detected WAN state in plain words.
   Optional changes: DHCP, static address, or PPPoE, plus a VLAN ID for
   providers that require tagged WAN.
3. **Repeater mode**: offered when no cable is plugged into the WAN port.
   Scans for networks and joins the main router as a WDS client, bridged
   into the LAN. The main router must run OpenWrt with WDS enabled on its
   WiFi; routers set up with this wizard have it enabled.
4. **Time zone**: preselected from the browser's time zone (Europe/Warsaw
   for Polish), changeable from the full list.
5. **WiFi**: one network name and password. "One network name for all
   bands" is on by default; turn it off to get per-band names with a
   `_2G`, `_5G` or `_6G` suffix. Each band can be turned on or off.
   Security is WPA2/WPA3 mixed, and WPA3 only on 6 GHz.
6. **Router address**: change the LAN from `192.168.1.1/24` to another
   network. The DHCP pool is adjusted to fit, and addresses that overlap
   the WAN are rejected.
7. **Optimizations** (optional): software and hardware flow offloading (both
   on by default), packet steering, IGMP snooping, custom DNS servers.
8. **Summary**: lists every change before anything is applied.

## Behaviour

- **First run**: the wizard opens automatically after login until it is
  completed, or skipped with "Don't show this again". Skipping without that
  checkbox hides it until the browser tab is closed.
- **Re-run**: open it anytime from **System → Setup Wizard**. Fields are
  prefilled from the current configuration, and only values you change are
  written, so untouched services are not restarted.
- **Safe apply**: changes go through LuCI's apply with automatic rollback.
  If the router becomes unreachable, the previous configuration is restored.
  Changing the LAN address shows LuCI's usual "connect to the new IP"
  prompt.
- **Not covered by rollback**: the password is changed immediately.
- **Offline**: no external services, no telemetry; works without internet.

## Installation

On a router running snapshot:

```sh
apk add luci-app-setup-wizard     # once available in a feed
apk add --allow-untrusted ./luci-app-setup-wizard-*.apk   # local build
```

To include it in your own image, add this repository as a feed in the
buildroot's `feeds.conf`:

```
src-git setupwizard https://github.com/danpawlik/openwrt-setup-wizard.git
```

```sh
./scripts/feeds update setupwizard
./scripts/feeds install luci-app-setup-wizard
# select LuCI → Applications → luci-app-setup-wizard in make menuconfig
```

The package is architecture-independent (`all`).

## Building

The package is a standard LuCI app and builds in any OpenWrt buildroot that
has the luci feed installed:

```sh
make package/luci-app-setup-wizard/compile
```

`vm/build.sh` builds it inside the `openwrt` podman container, and
`vm/boot.sh` boots an x86_64 image in qemu for testing. See
[vm/README.md](vm/README.md).

## Repository layout

```
luci-app-setup-wizard/
  Makefile
  htdocs/luci-static/resources/view/system/setup-wizard.js         wizard
  htdocs/luci-static/resources/view/status/include/05_setupwizard.js  first-run redirect
  root/etc/uci-defaults/90_setupwizard-state                       state config
  root/usr/share/luci/menu.d/luci-app-setup-wizard.json            System menu entry
  root/usr/share/rpcd/acl.d/luci-app-setup-wizard.json             permissions
docs/superpowers/   design and implementation plan
vm/                 build and test helpers
```

Wizard state is kept in `/etc/config/setupwizard`:

```
config state 'state'
	option done '0'       # 1 after the wizard was applied
	option dismissed '0'  # 1 after "Don't show this again"
```

To show the wizard again on next login:

```sh
uci set setupwizard.state.done=0
uci set setupwizard.state.dismissed=0
uci commit setupwizard
```

## License

Apache-2.0, see [LICENSE](LICENSE).
