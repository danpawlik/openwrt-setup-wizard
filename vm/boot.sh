#!/bin/sh
# Boot an x86_64 OpenWrt image in qemu. Snapshot mode: every run starts from
# a pristine (fresh-install) router; the image file is never modified.
#
# eth0 = LAN (router at 192.168.1.1), eth1 = WAN (qemu user-net DHCP, so the
# wizard sees a DHCP uplink). Host ports, bound to localhost only:
#   web  http://localhost:10080   ssh  ssh -p 10022 root@localhost
#
# Usage: vm/boot.sh [image]   (default: vm/openwrt.img, see vm/README.md)
set -eu

IMAGE="${1:-$(dirname "$0")/openwrt.img}"
if [ ! -f "$IMAGE" ]; then
	echo "Image not found: $IMAGE (see vm/README.md)" >&2
	exit 1
fi

exec qemu-system-x86_64 \
	-m 512M \
	-snapshot \
	-drive "file=${IMAGE},format=raw,if=virtio" \
	-netdev user,id=lan,net=192.168.1.0/24,host=192.168.1.2,hostfwd=tcp:127.0.0.1:10080-192.168.1.1:80,hostfwd=tcp:127.0.0.1:10022-192.168.1.1:22 \
	-device virtio-net-pci,netdev=lan \
	-netdev user,id=wan \
	-device virtio-net-pci,netdev=wan \
	-display none \
	-serial mon:stdio
