# OpenWrt Setup Wizard — Design

Date: 2026-10-29
Status: draft, awaiting approval

## Intent and why

A fresh OpenWrt install greets a non-technical user with the full LuCI
dashboard: system log, status widgets, and dozens of menus. The user has to
know that they must set a root password, that WiFi is often disabled by
default, and that the WAN port may need PPPoE credentials or a VLAN before
anything works. Most people cannot do this.

The Setup Wizard is a first-run modal in LuCI that walks a non-advanced user
through the essential configuration in a few clicks: root password, WAN link
(protocol/VLAN handling included), timezone, WiFi, and LAN addressing — plus
an optional performance section (packet steering, IGMP snooping, custom DNS,
flow offloading).

Success looks like: a person who has never used OpenWrt plugs in a freshly
flashed router, opens its address in a browser, and has working internet and
WiFi in under five minutes — without opening the LuCI status page or knowing
what UCI is.

## Goals

- First-run modal over LuCI on a fresh install; skippable, with a "don't
  show again" choice.
- Re-runnable at any time from **System → Setup Wizard**; re-running
  re-configures the router with the new values (fields prefilled from
  current config).
- Steps:
  1. Root password
  2. WAN link (auto-detected, editable)
  3. Timezone (user selects; smart preselection)
  4. WiFi (SSID + password per radio)
  5. LAN addressing (default 192.168.1.1/24, changeable)
  6. Optional optimizations
- Single "Apply" at the end applies all steps at once, using LuCI's
  standard apply-with-rollback mechanism, with a clear message about
  reconnecting at the new LAN address when it changed.

## Non-goals (v1)

- Multi-WAN / load balancing.
- Guest networks.
- Auto-detection of required VLANs or ISP credentials (we detect the
  current WAN state and offer common presets, but we do not guess).
- GeoIP or any external service for timezone detection.
- Support for OpenWrt older than snapshot (client-side LuCI views assumed).

## Anti-goals

- Silently destroying existing configuration on a re-run: the wizard must
  only change what its own fields control, and must show what will change
  before applying.
- Requiring internet access to complete the wizard (all steps work
  offline, on the LAN side).
- Phoning home: no external services, no telemetry.

## Target platform and distribution

- OpenWrt **snapshot** (modern LuCI, client-side JavaScript views, ucode
  dispatcher).
- Form: an installable package (`luci-app-setup-wizard` ipk), not a
  firmware-only patch. Distribution paths:
  1. **v1 (in scope)**: the ipk plus a custom feed and image-build
     integration, so custom snapshot images can be produced with the
     wizard baked in (the parent `openwrt-builder` workspace is the
     build environment).
  2. **Later**: submit to the `luci` feed upstream, after which it
     becomes installable through firmware-selector.openwrt.org and
     opkg like any luci-app.
- When installed manually (opkg), it must also work: menu entry under
  **System → Setup Wizard** always exists.

## User flow

1. User browses to the router address on a fresh install. The wizard modal
   opens automatically (first-run condition: wizard not completed and not
   dismissed).
2. Modal header: "Welcome — let's set up your router". A "Skip" control is
   always visible; next to it a checkbox "Don't show this again". Skipping
   without the checkbox leaves the wizard available in the menu and shows
   it again on next login; with the checkbox it never auto-shows again.
3. Steps render inside the modal, one at a time, with Back/Next. A final
   summary screen lists every change that will be applied.
4. Apply → progress → success screen. If the LAN address changed, the
   success screen shows the new address prominently and tells the user to
   reconnect to it (the wizard restarts the network).
5. The wizard marks itself done in UCI and closes into the normal LuCI
   overview.

## Feature specifications

### 1. Root password

- Two fields (password + confirmation), plain-language hint about why it
  matters. Minimum length validation (8 chars).
- Skippable: user may continue without setting one (with a warning).
  LuCI's own no-password first-login prompt remains the safety net.

### 2. WAN link

- On entering the step, read current WAN state via
  `ubus network.interface.wan status` (and `wan6`): protocol (dhcp /
  static / pppoe / others), whether it has an address, uptime, gateway.
- Present the detected state in plain words ("Your router got an address
  automatically from your provider (DHCP). Internet works.") plus a
  "Change settings" expander offering:
  - Protocol: DHCP / Static / PPPoE.
  - PPPoE: username + password fields (PAP/CHAP credentials).
  - Static: address, netmask, gateway, DNS.
  - VLAN tagging on the WAN device: enable + VLAN ID field (for ISPs that
    require tagged WAN, e.g. some fiber deployments).
- v1 detects and displays; it does not guess VLAN requirements for the
  user. (My call: keep a small "common ISP presets" list out of v1; add
  later if users ask. Rejected for now to keep scope tight.)

### 2b. Repeater / mesh (conditional, only when WAN has no link)

- Trigger: the WAN port reports no cable / no carrier
  (`network.device` status on the WAN device). In that case the wizard
  replaces the WAN step with: "No cable detected in the WAN port — how
  should this router connect?" offering **Router mode** (I'll plug in a
  cable later — WAN step as specified above) or **Extend an existing
  network**.
- "Extend an existing network" offers repeater/mesh configuration:
  scan for visible networks, let the user pick one and enter its
  password, then set up the uplink accordingly.
- **Scope (user decision)**: v1 supports extending networks run by
  OpenWrt / this firmware only — no relayd-style join of arbitrary
  consumer routers (possible v2). Implementation (my call, easy to
  flip): **WDS (4addr) repeater** as the v1 mechanism — the router
  bridges onto the upstream AP and re-broadcasts the same network;
  the wizard's WiFi step (4) enables WDS support on the AP interfaces
  it configures, so every wizard-configured router can act as an
  upstream out of the box. True 802.11s mesh (multi-hop) is a possible
  follow-up, not v1.
- A plugged-in WAN cable always wins over this step (detection runs on
  step entry and on re-run).

### 3. Timezone

- Dropdown of all zones (from zoneinfo as exposed by LuCI's system
  config), defaulting to the router's current setting.
- Preselection: the browser knows the user's timezone via
  `Intl.DateTimeFormat().resolvedOptions().timeZone`; if it matches a
  known zone, preselect it, otherwise fall back to Europe/Warsaw when the
  browser locale is `pl`, else the current router setting.
  (User decision: no GeoIP, no external services. The browser-based
  preselection is my call — it costs nothing and replaces the "guess from
  language" heuristic with the user's actual device timezone.)
- Applied as `luci` system `zonename` + `timezone` strings; NTP client
  remains as configured (system default).

### 4. WiFi

- The step asks for a **network name** (SSID) and one **password**,
  shared across bands. Security stays at LuCI/hostapd defaults
  (WPA2/WPA3); no security options exposed.
- Checkbox **"One network name for all bands"** — checked by default.
  Checked: the same SSID is applied to every radio (2.4 / 5 / 6 GHz —
  whatever the device has). Unchecked: each band gets its own SSID by
  appending a suffix to the entered name — `_2G`, `_5G`, or `_6G`
  depending on the band (password still shared).
- Per-radio enable toggles remain visible, with a per-band hint
  (2.4 GHz / 5 GHz / 6 GHz).
- On targets where WiFi is disabled by default (most), this step is the
  main value; it must clearly say "WiFi is currently off" when it is.
- My call: AP interfaces configured here also get WDS support enabled
  (`option wds`), so this router can serve as the upstream for another
  wizard-configured router in repeater mode (see step 2b).

### 5. LAN addressing

- Router IP + netmask (presented as `192.168.1.1/24`-style input),
  default = current (fresh install: 192.168.1.1/24).
- Validate: not the same subnet as detected WAN (warn), sane private
  range hint.
- The LAN DHCP pool is recomputed for the new subnet automatically.
- On apply: network restart; success screen shows the new address.

### 6. Optimizations (optional, collapsed by default)

Presented as "Advanced (optional) — improve performance", all changes
explicitly listed in the summary before apply:

- **Hardware flow offloading** (`firewall.@defaults[0].flow_offloading`
  and `flow_offloading_hw`): checkbox, **default on** per the user's
  requirement. When the target does not support hardware offload, the
  wizard applies software offloading instead and says so.
- **Packet steering** (`network.@globals[0].packet_steering`): checkbox,
  default off; hint that on some hardware it conflicts with flow
  offloading, so enabling one is usually enough.
- **IGMP snooping** on the LAN bridge
  (`network.@device[0].igmp_snooping` on br-lan): checkbox, default off.
- **Custom DNS servers**: optional list of servers; when set, applied to
  WAN (peerdns=0 + dns list) and announced to LAN clients via DHCP.
  Empty = leave as is.

## Apply semantics (builder-review resolution)

- Apply uses LuCI's **uci apply-with-rollback** (`ubus uci apply` with the
  rollback timer), the same mechanism stock LuCI uses for network changes.
  Apply is atomic: on any failure, everything rolls back and the wizard
  shows an error report — no half-configured router (this is what the
  anti-goal demands, and it removes the "lock the user out with a typo"
  failure mode for LAN re-addressing too).
- When the LAN address changes, the wizard applies everything, then the
  rollback-confirmation flow shows at the new address; if the user does
  not confirm, the old configuration is restored automatically.

## Interaction with the stock no-password prompt (builder-review resolution)

Fresh installs without a root password trigger LuCI's own password-set
prompt. The wizard does not patch luci-base, so the stock prompt keeps
firing. Resolution: the stock prompt stays as the login-time gate; the
wizard's step 1 detects whether a password is already set and renders as
"set a password" (fresh) or "change password / leave as is" (re-run or
already set). Exact behavior confirmed against snapshot LuCI during
planning; if the stock prompt turns out to be a non-blocking banner, the
wizard simply owns the flow and no duplication is visible.

## First-run mechanism constraint (builder-review resolution)

Eventual inclusion in the official luci feed (required for the
firmware-selector path) means the auto-open hook must be upstream-clean:
no luci-base patches, no hacks that would be rejected in review. If
snapshot LuCI offers no acceptable auto-open hook, the feature degrades
gracefully to a prominent banner/link on the overview plus the System
menu entry — an unmergeable hack is never shipped.

## Flow offload capability handling (builder-review resolution)

There is no reliable runtime query for hardware-offload support. The
wizard always writes both `flow_offloading` and `flow_offloading_hw`
flags and labels the checkbox honestly ("hardware acceleration, where
supported"); targets that do not support HW offload ignore the flag. No
per-target allowlist, no probing heuristics.

## Validation (user decision)

- "Done" for v1 is defined against an **x86 VM** (primary early
  validation: password, WAN, timezone, LAN re-addressing) **and one real
  router — likely a GL.iNet B3000** — covering WiFi, hardware offload,
  and WAN VLAN tagging.

## Architecture

- A standard LuCI client-side application package:
  - `htdocs/luci-static/resources/view/system/setup-wizard.js` — the
    wizard view (modal-style full-page flow; see "First-run mechanism").
  - `usr/share/luci/menu.d/luci-app-setup-wizard.json` — menu entry
    **System → Setup Wizard** (`admin/system/setup-wizard`).
  - `root/usr/share/rpcd/acl.d/luci-app-setup-wizard.json` — minimal ACL:
    uci access to the sections it writes (system, network, wireless,
    firewall, dhcp), ubus network status calls, and the password-setting
    call.
  - Own UCI config `setupwizard` holding state: `done`, `dismissed`.
- **First-run mechanism**: the wizard must auto-open when LuCI is first
  entered. Preferred approach (to be confirmed against the snapshot
  dispatcher during planning): a low-order menu node / dispatcher hook
  that redirects to the wizard view when `setupwizard.done` and
  `dismissed` are unset, otherwise to the overview. The exact hook
  (menu.d order trick vs. dispatcher `firstlogin`-style action) is an
  implementation decision for the plan; whatever is chosen must survive
  luci-base updates without patching luci-base itself.
- All configuration writes go through the standard LuCI ubus/rpcd calls
  the ACL grants — no shell commands with user input except the
  documented password call, no custom daemons.
- i18n: English source strings with LuCI's standard `_()` translation
  mechanism; a Polish translation file can be added later.

## Decisions made by the user (in conversation)

- Modal popup in LuCI on the router's address; skippable; "don't show
  again" option.
- Audience: average, non-advanced user (GL.iNet-style simplicity).
- Installable package (ipk), not firmware-only; menu entry under System
  for manual re-run; re-run re-configures the router.
- Target: OpenWrt snapshot.
- Timezone: user selects manually — no GeoIP, no external services; a
  cheap local preselection is acceptable.
- LAN re-addressing step included (192.168.1.1/24 → other).
- Optimizations: packet steering, IGMP snooping, custom DNS, HW/SW
  flow offload with HW on by default.

## Left to the builder (my calls unless overridden)

- The browser-timezone preselection detail (described above).
- No ISP preset list in v1.
- WiFi security pinned to LuCI/hostapd defaults (WPA2/WPA3 mixed);
  no security options exposed.
- The concrete first-run dispatcher hook — decided during planning
  against the actual snapshot LuCI source.
- Package naming: `luci-app-setup-wizard` (follows luci feed
  conventions; final name confirmed at implementation).
