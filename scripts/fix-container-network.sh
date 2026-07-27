#!/bin/bash
# Re-apply Apple Container networking after sleep/wake
# Restores IP forwarding and NAT rules that may be lost after macOS sleep.
#
# Run manually:  sudo ./scripts/fix-container-network.sh
# Or install as a wake hook (see com.nanoclaw.network-fix.plist)

set -e

LOG_PREFIX="$(date '+%Y-%m-%dT%H:%M:%S%z') [network-fix]"

# pfctl 会固定输出 4-6 行例行警告 (ALTQ/See pf.conf/already enabled 等)，
# 这些不是错误，但 WatchPaths 触发频繁会把日志涨成 MB 级。此处过滤掉
# 这些例行噪音，只保留真正有价值的信息。
PFCTL_NOISE='pfctl: Use of -f option|pfctl: pf already enabled|present in the main ruleset|See /etc/pf\.conf|No ALTQ support in kernel|ALTQ related functions disabled|^$'
filter_pfctl_noise() {
  grep -Ev "$PFCTL_NOISE" || true
}

sysctl -w net.inet.ip.forwarding=1 >/dev/null 2>&1

# Detect the active internet-facing interface.
# If default route goes through a VPN tunnel (utun*), fall back to the
# physical Wi-Fi or Ethernet interface — pfctl NAT doesn't work on utun.
IFACE=$(route get 8.8.8.8 2>/dev/null | grep 'interface:' | awk '{print $2}')

if echo "$IFACE" | grep -q '^utun'; then
  PHYS=$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}')
  if [ -n "$PHYS" ] && ifconfig "$PHYS" 2>/dev/null | grep -q 'inet '; then
    echo "$LOG_PREFIX default route is VPN ($IFACE) -> using Wi-Fi ($PHYS)"
    IFACE="$PHYS"
  else
    PHYS=$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Ethernet/{getline; print $2}')
    if [ -n "$PHYS" ] && ifconfig "$PHYS" 2>/dev/null | grep -q 'inet '; then
      echo "$LOG_PREFIX default route is VPN ($IFACE) -> using Ethernet ($PHYS)"
      IFACE="$PHYS"
    fi
  fi
fi

if [ -z "$IFACE" ]; then
  echo "$LOG_PREFIX no active network interface found, skipping NAT setup"
  exit 0
fi

# Apply NAT for the container subnet without flushing other rules (e.g. VPN).
# -F nat only flushes NAT rules, then -f - loads our new rule, -e enables pf.
{
  pfctl -F nat 2>&1
  echo "nat on $IFACE from 192.168.64.0/24 to any -> ($IFACE)" | pfctl -f - -e 2>&1
} | filter_pfctl_noise | sed "s|^|$LOG_PREFIX pfctl: |"

echo "$LOG_PREFIX container networking restored (interface: $IFACE)"
