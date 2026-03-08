#!/bin/bash
# Re-apply Apple Container networking after sleep/wake
# Restores IP forwarding and NAT rules that may be lost after macOS sleep.
#
# Run manually:  sudo ./scripts/fix-container-network.sh
# Or install as a wake hook (see com.nanoclaw.network-fix.plist)

set -e

# Enable IP forwarding
sysctl -w net.inet.ip.forwarding=1 >/dev/null 2>&1

# Detect the active internet-facing interface.
# If default route goes through a VPN tunnel (utun*), fall back to the
# physical Wi-Fi or Ethernet interface — pfctl NAT doesn't work on utun.
IFACE=$(route get 8.8.8.8 2>/dev/null | grep 'interface:' | awk '{print $2}')

if echo "$IFACE" | grep -q '^utun'; then
  echo "Default route is VPN ($IFACE), looking for physical interface..."
  PHYS=$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}')
  if [ -n "$PHYS" ] && ifconfig "$PHYS" 2>/dev/null | grep -q 'inet '; then
    IFACE="$PHYS"
  else
    PHYS=$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Ethernet/{getline; print $2}')
    if [ -n "$PHYS" ] && ifconfig "$PHYS" 2>/dev/null | grep -q 'inet '; then
      IFACE="$PHYS"
    fi
  fi
fi

if [ -z "$IFACE" ]; then
  echo "No active network interface found, skipping NAT setup"
  exit 0
fi

# Apply NAT for the container subnet without flushing other rules (e.g. VPN).
# -F nat only flushes NAT rules, then -f - loads our new rule, -e enables pf.
(pfctl -F nat 2>/dev/null; echo "nat on $IFACE from 192.168.64.0/24 to any -> ($IFACE)" | pfctl -f - -e) 2>&1

echo "Container networking restored (interface: $IFACE)"
