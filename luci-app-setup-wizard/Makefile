# Copyright (C) 2026 Daniel Pawlik
# This is free software, licensed under the Apache License 2.0.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-setup-wizard
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Daniel Pawlik <dpawlik@redhat.com>
LUCI_MAINTAINER:=$(PKG_MAINTAINER)

LUCI_TITLE:=LuCI Setup Wizard
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
