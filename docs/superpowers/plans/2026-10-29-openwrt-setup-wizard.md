# OpenWrt Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `luci-app-setup-wizard` — a first-run LuCI wizard (password, WAN, timezone, WiFi, LAN, optimizations, WDS repeater) for OpenWrt snapshot, plus custom-feed and image-build integration.

**Architecture:** A standard LuCI client-side JS application package (menu.d + ACL + uci-defaults + one view module + one pure-logic module). First-run auto-open is a status-overview include (`view/status/include/`) that redirects to the wizard based on UCI state flags. All configuration is applied atomically through LuCI's built-in uci apply/rollback flow. Pure logic lives in a node-testable module; integration is validated in a qemu x86 VM.

**Tech Stack:** OpenWrt snapshot buildroot (`../openwrt`), LuCI JS (client-side views), rpcd ACLs, UCI, node ≥18 for unit tests, qemu + chrome-devtools MCP for e2e.

**Spec:** `docs/superpowers/specs/2026-10-29-openwrt-setup-wizard-design.md` — the plan argues from it; executors read both.

## Global Constraints

- All user-visible strings in English, wrapped in LuCI's `_()` for future i18n. All docs in English.
- **Never patch luci-base or any feed file** — upstream-clean mechanisms only.
- Snapshot LuCI is ucode + client-side JS: no Lua code (no luci-compat dependency). Views use `'require view'`, not the legacy `L.view`.
- Snapshot packages are `.apk`. Reference LuCI source: the host checkout `../luci`.
- Builds run in the podman container `openwrt` via `vm/build.sh` (package copied into the tree's `package/`); never build on the host, never modify the container tree's feeds or `.config`.
- Target: OpenWrt snapshot, DSA devices (x86_64, mediatek/filogic).
- Apply is atomic via uci apply-with-rollback; the wizard only writes fields its own forms expose (re-run must not reset untouched config).
- No external services, no telemetry.
- Wizard state in `/etc/config/setupwizard`, flags `done` and `dismissed` (both `0`/`1`).
- Optimizations defaults: `flow_offloading=1` + `flow_offloading_hw=1` ON; `packet_steering` OFF; `igmp_snooping` OFF; DNS empty = leave as-is.
- WiFi: single name + password; "one name for all bands" checkbox default ON; when off, suffix `_2G`/`_5G`/`_6G` per band; APs also get `option wds '1'`.
- Repeater (v1): WDS/4addr to OpenWrt upstreams only.
- Repo layout: package at `luci-app-setup-wizard/` (repo root is the feed root), tests in `test/`, VM tooling in `vm/`.

## Review Focus

Failure modes the spec implies but task tests don't fully exercise; each is pinned to a test below:

1. **Re-run on a configured router resets nothing untouched** — e2e re-run pass in Task 14 completes with only edited fields changed (diff of `uci export` before/after).
2. **LAN address change must never lock the user out** — rollback-confirm flow verified in Task 12 VM check.
3. **Zero-radio devices (x86)** — WiFi step renders "no wireless hardware" and stays valid (Task 9 unit test on step logic + Task 14 e2e on x86).
4. **SSID length with suffixes** — UTF-8 byte length ≤ 32 enforced including the suffix (Task 2 unit tests).
5. **Failed WAN apply (bad PPPoE credentials)** — rollback restores a reachable router (Task 12 VM check).

---

### Task 1: Package skeleton + VM harness

**Files:**
- Create: `luci-app-setup-wizard/Makefile`, `luci-app-setup-wizard/root/usr/share/luci/menu.d/luci-app-setup-wizard.json`, `luci-app-setup-wizard/root/usr/share/rpcd/acl.d/luci-app-setup-wizard.json`, `luci-app-setup-wizard/root/etc/uci-defaults/90_setupwizard-state`, `luci-app-setup-wizard/htdocs/luci-static/resources/view/system/setup-wizard.js`, `vm/README.md`
- Test: `vm/boot.sh`

**Interfaces:**
- Produces: package `luci-app-setup-wizard` built by `vm/build.sh` in the podman container; menu node `admin/system/setup-wizard` (title "Setup Wizard", action view `system/setup-wizard`); UCI file `setupwizard` with `config state 'state'; option done '0'; option dismissed '0'`; `vm/boot.sh` starting the image with web on `localhost:10080`, ssh on `localhost:10022`, snapshot mode.

- [ ] **Step 1: Write the check first**

`vm/boot.sh` (qemu wrapper, x86_64 combined-ext4 image from `../openwrt/bin/targets/x86/64/`, `-snapshot`, `-netdev user,hostfwd=tcp::10080-:80,hostfwd=tcp::10022-:22`, 512M). Check it fails now: run `vm/boot.sh` → no image / no menu entry. Also define the pass condition: `curl -s -o /dev/null -w '%{http_code}' http://localhost:10080/` → 200 or 302 through LuCI.

- [ ] **Step 2: Create the package files**

Makefile: `include $(TOPDIR)/rules.mk`, `PKG_NAME:=luci-app-setup-wizard`, `PKG_VERSION:=1.0.0`, `PKG_RELEASE:=1`, `LUCI_TITLE:=LuCI Setup Wizard`, `LUCI_DEPENDS:=+luci-base`, `LUCI_PKGARCH:=all`, `include $(TOPDIR)/feeds/luci/luci.mk`. menu.d JSON defines only `admin/system/setup-wizard` for now. ACL file with the uci read/write grants from the spec's architecture section (`setupwizard`, `network`, `wireless`, `system`, `firewall`, `dhcp`). uci-defaults script creates `/etc/config/setupwizard` idempotently (`[ -f ] ||` guard). View file: minimal `return L.view.extend({ render: () => E('h2', {}, _('Setup Wizard')) })`.

- [ ] **Step 3: Build in the container**

`vm/build.sh`: `podman cp` the package into `<tree>/package/` of the `openwrt` container, temporarily select it in `.config` (restored on exit), `make package/luci-app-setup-wizard/compile`. Document in `vm/README.md`, including how to get an x86_64 image for `vm/boot.sh`.

- [ ] **Step 4: Verify in VM**

Run `vm/boot.sh`; browser (chrome-devtools MCP) or curl through login: menu shows **System → Setup Wizard**; page renders the heading; ssh `uci show setupwizard` shows both flags `0`.

- [ ] **Step 5: Commit**

`git add luci-app-setup-wizard vm/ && git commit -m "feat: package skeleton with menu entry and VM harness"`

### Task 2: Pure logic module + node test harness

**Files:**
- Create: `luci-app-setup-wizard/htdocs/luci-static/resources/setup-wizard/logic.js`, `test/run-tests.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Produces (all pure functions, module `return {...}` object, loadable both by LuCI and by the node harness):
  - `ssidForBand(base, band, perBand) -> string` — `band` is `'2G'|'5G'|'6G'`; `perBand` true → `base + '_' + band`, else `base`.
  - `ssidFitsLimit(ssid) -> bool` — UTF-8 byte length ≤ 32.
  - `validateLan(ip, maskBits) -> null|string` — valid IPv4, maskBits 16–30 (allow smaller? no: 16–30), error string otherwise.
  - `poolFits(start, limit, maskBits) -> bool` — DHCP offsets `start`, `start+limit` within a `/maskBits`.
  - `parseDnsList(text) -> string[]|null` — comma/space separated IPv4+IPv6, trimmed, empty → `[]`, invalid token → `null`.
  - `guessTimezone(intlZone, lang, current) -> string` — truthy `intlZone` → it; `lang` starts with `pl` → `Europe/Warsaw`; else `current`.
  - `classifyWan(status) -> {proto, up, hasAddr}` — `proto` normalized to `'dhcp'|'static'|'pppoe'|'other'`, derived from a `network.interface.wan` status object (`proto`, `up`, `ipv4-address`/`ipv6-address` arrays).

- [ ] **Step 1: Write the failing tests**

`test/run-tests.js`: plain `assert` module, no framework; loads `logic.js` by reading the file and evaluating it as a function body with an `L` stub (`{Class:{extend:o=>o}}`) — write `loadLogic()` once and use it for all later tasks. Tests must include: `ssidForBand('Net','5G',true)==='Net_5G'`, `ssidForBand('Net','5G',false)==='Net'`, `ssidFitsLimit('ą'.repeat(32))===false` (multi-byte), `parseDnsList('1.1.1.1, 2606:4700::1111')` both entries, `parseDnsList('foo')===null`, `guessTimezone('','pl-PL','UTC')==='Europe/Warsaw'`, `guessTimezone('Europe/Berlin','pl-PL','UTC')==='Europe/Berlin'`, `classifyWan` on a DHCP-up sample (proto dhcp, up true, hasAddr true) and a down sample.

- [ ] **Step 2: Run to verify failure**

Run: `node test/run-tests.js` — Expected: exit 1, module not found / functions undefined.

- [ ] **Step 3: Implement `logic.js`**

One function per test group; no LuCI imports (that's why the `L` stub suffices — keep the file free of `L.` usage entirely).

- [ ] **Step 4: Run to verify pass**

Run: `node test/run-tests.js` — Expected: all assertions pass, exit 0.

- [ ] **Step 5: Commit**

`git commit -am "feat: pure logic module with unit tests"`

### Task 3: First-run auto-open + skip semantics

**Files:**
- Create: `luci-app-setup-wizard/htdocs/luci-static/resources/view/status/include/05_setupwizard.js`
- Modify: view `system/setup-wizard.js`
- Test: manual/browser checks in VM (below)

**Interfaces:**
- Consumes: UCI flags from Task 1.
- Produces: status-overview include `05_setupwizard.js`. After login LuCI lands on `admin/status/overview` (`admin` is `firstchild`), and the overview (`../luci/modules/luci-mod-status/htdocs/luci-static/resources/view/status/index.js`) loads every `view/status/include/*.js`. The include's `load()` reads `setupwizard.state` and, when `done==0 && dismissed==0` and the browser session has not skipped (`sessionStorage` key `setupwizard-skipped`), redirects to `L.url('admin/system/setup-wizard')`; `render()` returns nothing visible. Wizard view gains `handleSkip(dontShowAgain)` (no checkbox → set the sessionStorage key only; checkbox → also write `dismissed='1'`) and `handleDone()` writing `done='1'` (via `uci.set` on `setupwizard.state`).

- [ ] **Step 1: Define the pass checks**

1. Fresh boot (qemu snapshot = always fresh): log in via browser → landing URL is `admin/system/setup-wizard` (wizard view). 2. Click "Skip" without checkbox, log out/in → wizard again. 3. Skip with "Don't show again" → log out/in → `admin/status/overview`. 4. Menu always shows **System → Setup Wizard** regardless of flags.

- [ ] **Step 2: Run them — they fail**

No include exists; landing stays on overview.

- [ ] **Step 3: Implement**

Write the include per the Interfaces block (`'require view'`, `'require uci'`; a failed uci load must not break the overview — catch and do nothing). Add the Skip control + "Don't show this again" checkbox and `handleSkip` to the wizard view. Snapshot LuCI is ucode + JS: no Lua templates, no menu or dispatcher tricks, nothing in luci-base touched.

- [ ] **Step 4: Run the four checks in the VM — all pass**

- [ ] **Step 5: Commit**

`git commit -am "feat: first-run auto-open with skip and dont-show-again"`

### Task 4: Step framework

**Files:**
- Modify: `luci-app-setup-wizard/htdocs/luci-static/resources/view/system/setup-wizard.js`
- Test: `test/run-tests.js` (add framework unit tests)

**Interfaces:**
- Produces (used by every later step task):
  - `model` object, initialized empty by `initModel()` with the spec's shape: `password{set,value}`, `wan{mode,proto,static{ip,gw,mask},pppoe{user,pass},vlan{enabled,id}}`, `repeater{ssid,bssid,encryption,key}`, `timezone`, `wifi{sharedSsid,ssid,key,radios{}}`, `lan{ip,maskBits}`, `opt{hwOffload=true,steering=false,igmp=false,dns:[]}`.
  - Step contract: each step is `{id, title(), render(model, nodes), validate(model) -> null|errorMsg}` registered in a `steps` array.
  - `collectChanges(model) -> [{label, value}]` — plain-word summary rows for the summary screen (pure; unit-testable).
  - Framework renders current step, Back/Next (Next disabled while `validate` returns a string), and a Finish button that later tasks wire to apply.

- [ ] **Step 1: Write failing tests**

Unit tests for `initModel` defaults (hwOffload true, others false, dns `[]`) and `collectChanges` given a fully-set model → contains rows for password set, WAN proto, WiFi SSID, LAN IP, each enabled optimization; given default model → empty/`[]` (skipped steps produce no rows).

- [ ] **Step 2: Run — fail** (`node test/run-tests.js`).

- [ ] **Step 3: Implement**

Move `initModel`/`collectChanges` into `logic.js` (stay pure); view gets the step array with one placeholder step.

- [ ] **Step 4: Run — pass.** Also boot VM: wizard shows step navigation with the placeholder step.

- [ ] **Step 5: Commit** `git commit -am "feat: wizard step framework with model and change summary"`

### Task 5: Password step

**Files:**
- Modify: view `system/setup-wizard.js`, ACL file
- Test: VM walkthrough

**Interfaces:**
- Consumes: step contract, `model.password`.
- Produces: step `password` (id `'password'`, first in `steps`).

- [ ] **Step 1: Define pass checks**

Two fields (password + confirmation); mismatch or <8 chars while non-empty → Next blocked with message; leaving both empty allowed with a visible warning; on apply the root password changes (verify: log out, log in with the new password).

- [ ] **Step 2: Run — fail** (step doesn't exist).

- [ ] **Step 3: Implement**

Render per checks; store into `model.password`. For the actual password set, use the same rpc call as `../luci/modules/luci-mod-system/htdocs/luci-static/resources/view/system/password.js` (`rpc.declare({object: 'luci', method: 'setPassword', params: ['username', 'password']})`) and add the matching ACL write grant `"ubus": {"luci": ["setPassword"]}` (as in `../luci/modules/luci-mod-system/root/usr/share/rpcd/acl.d/luci-mod-system.json`). Execute it as the first action of apply.

- [ ] **Step 4: Run checks in VM — pass** (including logout/login with new password).

- [ ] **Step 5: Commit** `git commit -am "feat: root password step"`

### Task 6: WAN step

**Files:**
- Modify: view `system/setup-wizard.js`, ACL file
- Test: `test/run-tests.js` (add), VM walkthrough

**Interfaces:**
- Consumes: `classifyWan` (Task 2), step contract, `model.wan`, luci-base's `network` JS module (`L.require('network')`) for interface status.
- Produces: step `wan`; apply section writing `model.wan` to UCI (`network.wan` proto/peerdns, static fields, PPPoE username/password; VLAN → DSA 8021q device `wan.<id>` with `network.wan.device` pointing at it).

- [ ] **Step 1: Write failing tests**

Unit: `classifyWan` variants already exist — add none here if covered. The new pure piece: `vlanDeviceName(id)` — `'wan.' + id` with numeric validation → put in `logic.js` and test it.

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement step UI + model writes**

On entry: `network.getWanNetwork()` → status via `classifyWan` → plain-words display ("connected via DHCP", "no cable / not connected"). "Change settings" expander: protocol select dhcp/static/pppoe with the spec's conditional fields; VLAN checkbox + ID (numeric 1–4094). Radio for the Task 7 question appears here when WAN is down (mode router/extend) — add the field now, Task 7 renders the extend branch.

- [ ] **Step 4: VM checks**

With qemu user-net the WAN port gets DHCP: wizard shows "connected via DHCP"; switch to static with a bogus address, apply, confirm rollback countdown restores connectivity; VLAN field writes `wan.<id>` device (verify via `uci show network` after apply).

- [ ] **Step 5: Commit** `git commit -am "feat: WAN step with detection, protocols and VLAN"`

### Task 7: Repeater step (conditional)

**Files:**
- Modify: view `system/setup-wizard.js`, ACL file
- Test: VM walkthrough (x86 has no WiFi — see Review Focus 3; scan list needs the B3000 or a wifi-bearing test target)

**Interfaces:**
- Consumes: `model.wan.mode`, `model.repeater`, ubus `iwinfo` (`devices`, `scan`) — grant in ACL; scan call mirrors `../luci/modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js` "Join Network" scan.
- Produces: step `repeater`, shown only when `model.wan.mode === 'extend'`; apply section writing the WDS STA interface.

- [ ] **Step 1: Define pass checks**

WAN up → step skipped entirely (steps array filtered). WAN down + "extend" chosen: network list from scan, password field, Next blocked until both filled.

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement**

Scan on entry (per radio device), SSID dropdown + password; store `model.repeater`. Apply: `wifi-iface` with `mode 'sta'`, `wds '1'`, ssid/encryption/key, `network 'lan'` (bridged repeater per spec), radio enabled.

- [ ] **Step 4: VM checks**

x86: step skipped when WAN up (the scan path needs real radios — exercise it during Task 13 on the B3000 and record results in `vm/README.md`).

- [ ] **Step 5: Commit** `git commit -am "feat: conditional WDS repeater step"`

### Task 8: Timezone step

**Files:**
- Modify: view `system/setup-wizard.js`
- Test: `test/run-tests.js` (guessTimezone already tested), VM walkthrough

**Interfaces:**
- Consumes: `guessTimezone` (Task 2), the zone list exactly as the system settings page sources it (`../luci/modules/luci-mod-system/htdocs/luci-static/resources/view/system/system.js`: `rpc.declare({object: 'luci', method: 'getTimezones'})`, ACL read grant `"ubus": {"luci": ["getTimezones"]}`); do not embed a second copy of the zone list.
- Produces: step `timezone`; apply writes `system.@system[0].zonename`/`timezone` (same key pairs luci-base writes).

- [ ] **Step 1: Pass checks**

Dropdown preselected from `Intl.DateTimeFormat().resolvedOptions().timeZone` when it appears in the list (fake via test override), `Europe/Warsaw` fallback for `pl` locale, else current; changing zone then applying updates `uci show system`.

- [ ] **Step 2: Run — fail. Step 3: Implement per checks. Step 4: VM checks — pass.**

- [ ] **Step 5: Commit** `git commit -am "feat: timezone step with browser preselection"`

### Task 9: WiFi step

**Files:**
- Modify: view `system/setup-wizard.js`
- Test: `test/run-tests.js` (add), VM walkthrough

**Interfaces:**
- Consumes: `ssidForBand`, `ssidFitsLimit` (Task 2), luci-base `wireless` JS module for radios; step contract.
- Produces: step `wifi`; apply writes per-radio `wifi-iface` AP configs.

- [ ] **Step 1: Write failing tests**

Unit: `ssidForBand` covered; add `wifiPlan(radios, model) -> [{device, ssid, enabled}]` — one entry per radio, SSID from `ssidForBand(model.wifi.ssid, bandFor(radio), !model.wifi.sharedSsid)`, `bandFor(radio)` mapping band strings (`2.4G`→`'2G'`, `5G`, `6G`); `radios=[]` → `[]` (zero-radio case, Review Focus 3). Test the zero-radio case explicitly.

- [ ] **Step 2: Run — fail. Step 3: Implement**

`wifiPlan` + `bandFor` in `logic.js`; step UI: network name + password (min 8), "One network name for all bands" checkbox default ON, per-radio enable toggles with band hints, explicit "WiFi is currently off" notice when radios are disabled. Apply: per `wifiPlan`, write SSID/encryption (luci/hostapd WPA2/WPA3 defaults as luci-mod-network writes them)/key, `option wds '1'`, radio `disabled '0'`. Zero radios: render the "no wireless hardware" message, step stays valid (Next works).

- [ ] **Step 4: Run unit tests — pass; VM: x86 shows the no-hardware message and stays navigable.**

- [ ] **Step 5: Commit** `git commit -am "feat: WiFi step with band suffixes and WDS-enabled APs"`

### Task 10: LAN step

**Files:**
- Modify: view `system/setup-wizard.js`
- Test: `test/run-tests.js` (add), VM walkthrough

**Interfaces:**
- Consumes: `validateLan`, `poolFits` (Task 2), step contract.
- Produces: step `lan`; apply writes `network.lan.ipaddr`/`netmask` (or CIDR as luci-mod-network writes it) and clamps `dhcp.lan` start/limit if needed.

- [ ] **Step 1: Write failing tests**

`validateLan('192.168.1.1', 24)` → null; `('10.0.0.1', 8)` → error; `('300.1.1.1', 24)` → error. `poolFits(100, 150, 24)` → true; `(100, 150, 25)` → false.

- [ ] **Step 2: Run — fail. Step 3: Implement**

Input as `ip/maskBits`; validate on Next; prefill from current `network.lan`; warn when the LAN subnet equals the detected WAN subnet (`classifyWan` address family info). Apply: write LAN addr, and when `poolFits` is false, clamp `dhcp.lan.limit` so it fits.

- [ ] **Step 4: Unit tests pass; VM: change LAN to 192.168.7.1/24, apply, page reconnects at the new address (rollback confirm flow), `uci show network.lan` correct.**

- [ ] **Step 5: Commit** `git commit -am "feat: LAN re-addressing step"`

### Task 11: Optimizations step

**Files:**
- Modify: view `system/setup-wizard.js`
- Test: `test/run-tests.js` (add), VM walkthrough

**Interfaces:**
- Consumes: `parseDnsList` (Task 2), step contract, `model.opt`.
- Produces: step `opt` (collapsed "Advanced (optional)" by default); apply writes: `firewall.@defaults[0].flow_offloading(+hw)`, `network.@globals[0].packet_steering`, br-lan device `igmp_snooping`, WAN DNS (`peerdns '0'` + `dns` list) + `dhcp.lan` option 6 announce.

- [ ] **Step 1: Write failing tests**

`parseDnsList` covered in Task 2; add `optPlan(model) -> {uciPath, value}[]` — the exact UCI writes derived from `model.opt`, including DNS skipped when `dns` is `[]`. Unit test both branches.

- [ ] **Step 2: Run — fail. Step 3: Implement per `optPlan` + spec defaults (HW offload ON).**

- [ ] **Step 4: Unit tests pass; VM: defaults show correctly, toggling everything on and applying leaves valid `uci show firewall/network/dhcp`.**

- [ ] **Step 5: Commit** `git commit -am "feat: optimizations step"`

### Task 12: Apply pipeline

**Files:**
- Modify: view `system/setup-wizard.js`
- Test: VM walkthrough (three scenarios)

**Interfaces:**
- Consumes: `collectChanges` (Task 4), every step's apply section, `handleDone` (Task 3).
- Produces: summary screen (step after `opt`) and `applyAll(model)`: 1) password (Task 5 mechanism), 2) all UCI writes staged via `L.uci.set`, 3) apply through luci-base's built-in apply/rollback flow — the same code path the config pages use (`ui.changes.apply` / `L.uci.apply` — mirror `../luci/modules/luci-base/htdocs/luci-static/resources/ui.js`), 4) `setupwizard.state.done='1'` staged in the same apply, 5) success screen; when `model.lan` changed, success screen names the new address and the built-in reconnect logic handles the switch.

- [ ] **Step 1: Define the three VM scenarios (pass checks)**

A) Happy path: complete all steps, summary lists every change before Apply, apply succeeds, wizard closes into overview, `done=1`, re-login goes to overview. B) LAN change: applies, reconnect prompt at new address, rollback countdown visible (Review Focus 2). C) Broken WAN config (bogus static + unreachable gateway): apply fails or times out → rollback restores the working DHCP config, router reachable (Review Focus 5).

- [ ] **Step 2: Run — fail (no summary/apply yet; Next on the last step does nothing).**

- [ ] **Step 3: Implement per interface above.** No custom rollback code — use luci-base's flow wholesale.

- [ ] **Step 4: Run scenarios A–C in VM — pass.**

- [ ] **Step 5: Commit** `git commit -am "feat: atomic apply pipeline with summary and rollback"`

### Task 13: Feed + image integration (x86 + B3000)

**Files:**
- Create: `vm/build-x86.sh`, `vm/build-b3000.sh` (or extend the existing build scripts' conventions — see `../build-mediatek-version.sh`, `../configs/`)
- Modify: `vm/README.md`
- Test: built images

**Interfaces:**
- Consumes: `vm/build.sh` container conventions (Task 1); `configs/mediatek` conventions for the B3000 (GL.iNet B3000 = mediatek/filogic target — confirm the exact device profile in menuconfig before building).
- Produces: reproducible build scripts producing (a) an x86_64 image with the wizard built in, (b) a B3000 sysupgrade image with the wizard built in.

- [ ] **Step 1: Pass checks**

Both scripts run end-to-end in the podman build container per `../README.md` conventions and produce images in `../openwrt/bin/targets/...` containing the wizard (`gzip -dc image | strings | grep -i setup-wizard` or verify via `opkg` listing in VM / first boot).

- [ ] **Step 2: Run — fail (scripts don't exist).**

- [ ] **Step 3: Implement**

Wrap the existing configure/build flow; add `CONFIG_PACKAGE_luci-app-setup-wizard=y` (and luci defaults) to the x86 and mediatek configs; register this repo as a feed in the image build tree (`src-git setupwizard <repo-url>` or `src-link` to a copy inside the container — the repo root is the feed root) so images pull the package the same way any feed package is pulled. Record the B3000 device profile name and build results in `vm/README.md`.

- [ ] **Step 4: Run both scripts — images produced; x86 image boots in `vm/boot.sh` with wizard auto-open working.**

- [ ] **Step 5: Commit** `git commit -am "feat: reproducible image builds for x86 and B3000"`

### Task 14: End-to-end acceptance

**Files:**
- Create: `vm/e2e-checklist.md` (filled in with results), `test/snap-uci.sh` (dumps `uci export` via ssh for the re-run diff)
- Test: the checklist itself

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Fresh-boot flow (x86 VM, snapshot mode)**

Boot, browser to `localhost:10080`: wizard auto-opens (after the stock login/password gate), complete every step with known values (password `w1zardtest`, DHCP WAN, `Europe/Warsaw`, LAN `192.168.10.1/24`, optimizations on with DNS `1.1.1.1`), apply, verify: reachable at `.10.1` (re-point `vm/boot.sh` hostfwd or reconnect), `uci export` matches expectations (spot-check `network`, `wireless` absent on x86, `firewall` offload flags, `dhcp` option 6), `done=1`.

- [ ] **Step 2: Re-run flow (Review Focus 1)**

`test/snap-uci.sh` before and after: open **System → Setup Wizard**, change only the WiFi password field (or LAN IP if no radios), apply → `diff` of the two snapshots shows only the intended lines changed.

- [ ] **Step 3: Skip flow**

Fresh boot, skip with "don't show again", reboot the VM (without `-snapshot` on a scratch copy) → landing is overview, menu entry present.

- [ ] **Step 4: Record results in `vm/e2e-checklist.md`; note any deviations from the spec as GitHub-style issues in the repo (`docs/superpowers/issues/` if any).**

- [ ] **Step 5: Commit** `git commit -am "test: e2e acceptance results"`
