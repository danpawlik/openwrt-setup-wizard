#!/bin/sh
# Boot the x86_64 test image from the OpenWrt buildroot in qemu.
# Snapshot mode: every run starts from a pristine (fresh-install) router.
# Web UI: http://localhost:10080  SSH: localhost:10022
set -eu

IMAGE="$(ls ../openwrt/bin/targets/x86/64/*combined-ext4.img 2>/dev/null | head -n1)"
if [ -z "$IMAGE" ]; then
	echo "No x86_64 combined-ext4 image in ../openwrt/bin/targets/x86/64/." >&2
	echo "Build it first: see vm/README.md" >&2
	exit 1
fi

exec qemu-system-x86_64 \
	-m 512M \
	-snapshot \
	-drive "file=${IMAGE},format=raw,if=virtio" \
	-netdev user,id=net0,hostfwd=tcp::10080-:80,hostfwd=tcp::10022-:22 \
	-device virtio-net-pci,netdev=net0 \
	-display none \
	-serial mon:stdio
