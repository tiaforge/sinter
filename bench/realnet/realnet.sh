#!/bin/bash
# A shaped network path for page-load measurements: a network namespace joined to the root namespace by a veth pair,
# with the bandwidth towards the namespace limited by htb on the host side (and a delay by netem, where the kernel has
# it). The browser runs inside the namespace (`realnet.sh exec …`), the servers outside, listening on the host address.
# Nothing else is shaped (not `lo`). Needs root (CAP_NET_ADMIN) and iproute2 (`ip`, `tc`). See README.md.
#
#   realnet.sh check                  what this kernel offers: namespaces, htb, netem
#   realnet.sh up [rate] [delay]      e.g. `up 1600kbit` or, with netem, `up 1600kbit 75ms` (each way)
#   realnet.sh exec <command…>        runs a command inside the namespace
#   realnet.sh down                   removes the namespace, the veth pair and the qdiscs (safe to run any time)
#
# Environment: REALNET_NS (default sn-realnet), REALNET_NET (the /24 prefix, default 10.77.0): host side .1, namespace .2.
set -u
NS=${REALNET_NS:-sn-realnet}
NET=${REALNET_NET:-10.77.0}
HOST_IF=${NS:0:10}-h
NS_IF=${NS:0:10}-n

has_qdisc() {  # whether the kernel accepts a qdisc kind (tried on a throwaway veth pair)
  ip link add sn-probe-a type veth peer name sn-probe-b 2>/dev/null || return 1
  tc qdisc add dev sn-probe-a root "$@" >/dev/null 2>&1; local ok=$?
  ip link del sn-probe-a 2>/dev/null
  return $ok
}

down() {
  tc qdisc del dev "$HOST_IF" root 2>/dev/null
  ip link del "$HOST_IF" 2>/dev/null
  ip netns del "$NS" 2>/dev/null
  return 0
}

case ${1:-} in
  check)
    command -v ip >/dev/null && command -v tc >/dev/null || { echo "iproute2 missing: apt-get install -y iproute2"; exit 1; }
    ip netns add sn-probe-ns 2>/dev/null && { echo "network namespaces: yes"; ip netns del sn-probe-ns; } || echo "network namespaces: NO"
    for q in "htb" "netem delay 1ms" "tbf rate 1mbit burst 4kb latency 50ms" "fq"; do
      has_qdisc $q && echo "qdisc ${q%% *}: yes" || echo "qdisc ${q%% *}: no"
    done ;;
  up)
    RATE=${2:-1600kbit}; DELAY=${3:-}
    down
    set -e
    ip netns add "$NS"
    ip link add "$HOST_IF" type veth peer name "$NS_IF"
    ip link set "$NS_IF" netns "$NS"
    ip addr add "$NET.1/24" dev "$HOST_IF"
    ip link set "$HOST_IF" up
    ip netns exec "$NS" ip addr add "$NET.2/24" dev "$NS_IF"
    ip netns exec "$NS" ip link set "$NS_IF" up
    ip netns exec "$NS" ip link set lo up
    # towards the browser: the rate (and the delay, below it)
    tc qdisc add dev "$HOST_IF" root handle 1: htb default 10
    tc class add dev "$HOST_IF" parent 1: classid 1:10 htb rate "$RATE" ceil "$RATE"
    if [ -n "$DELAY" ]; then
      tc qdisc add dev "$HOST_IF" parent 1:10 handle 10: netem delay "$DELAY" limit 1000
      ip netns exec "$NS" tc qdisc add dev "$NS_IF" root netem delay "$DELAY"
    fi
    set +e
    echo "up: namespace $NS, host $NET.1 ($HOST_IF), namespace $NET.2; $RATE towards the namespace${DELAY:+, $DELAY each way}" ;;
  exec)
    shift; exec ip netns exec "$NS" "$@" ;;
  down)
    down; echo "down: $NS removed" ;;
  *)
    sed -n 6,12p "$0"; exit 1 ;;
esac
