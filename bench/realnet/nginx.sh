#!/bin/bash
# nginx in front of a build for realnet measurements (nginx.conf.tmpl). Needs nginx (`apt-get install -y nginx`) and openssl.
#
#   nginx.sh start <static dir> [backend host:port] [tuned]   serves the build; proxies everything else to the backend
#   nginx.sh stop                                             (safe to run any time)
#
# Listens on the host side of realnet.sh's veth pair: https://$REALNET_NET.1:$REALNET_H2 (HTTP/2) and :$REALNET_H1
# (HTTP/1.1 only). `tuned`: `sndbuf=16k` on the listeners and `http2_chunk_size 4k`, so nginx cannot write far ahead
# into the connection and its HTTP/2 priorities can show (README.md). A self-signed certificate is made once.
# Environment: REALNET_NET (10.77.0), REALNET_H2 (8443), REALNET_H1 (8444), REALNET_STATE (state directory).
set -u
D=$(dirname "$(realpath "$0")")
STATE=${REALNET_STATE:-${TMPDIR:-/tmp}/sinter-realnet}
ADDR=${REALNET_NET:-10.77.0}.1
H2=${REALNET_H2:-8443}; H1=${REALNET_H1:-8444}

stop() {
  [ -f "$STATE/nginx.pid" ] && kill "$(cat "$STATE/nginx.pid")" 2>/dev/null
  for _ in $(seq 25); do [ -f "$STATE/nginx.pid" ] || break; sleep 0.2; done
  rm -f "$STATE/nginx.pid"
  return 0
}

case ${1:-} in
  start)
    [ -d "${2:-}" ] || { echo "nginx.sh start <static dir> [backend host:port] [tuned]"; exit 1; }
    command -v nginx >/dev/null || { echo "nginx missing: apt-get install -y nginx"; exit 1; }
    stop
    STATIC=$(realpath "$2"); BACKEND=${3:-}; TUNED=${4:-}
    [ "$BACKEND" = tuned ] && { BACKEND=''; TUNED=tuned; }
    mkdir -p "$STATE/tmp"
    [ -f "$STATE/cert.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=localhost -keyout "$STATE/key.pem" -out "$STATE/cert.pem" 2>/dev/null
    SNDBUF=''; CHUNK=''
    [ "$TUNED" = tuned ] && { SNDBUF='sndbuf=16k'; CHUNK='http2_chunk_size 4k;'; }
    UPSTREAM=''; FALLBACK='return 404;'
    if [ -n "$BACKEND" ]; then
      UPSTREAM="upstream backend { server $BACKEND; keepalive 16; }"
      # the backend's own Host header and redirects; no buffering (event streams)
      FALLBACK="proxy_pass http://backend; proxy_http_version 1.1; proxy_set_header Connection \"\"; proxy_set_header Host \$proxy_host; proxy_redirect http://\$proxy_host/ /; proxy_buffering off; add_header Timing-Allow-Origin \"*\";"
    fi
    SITE="root $STATE/static; location / { try_files \$uri \$uri.html \$uri/index.html @backend; add_header Timing-Allow-Origin \"*\"; } location @backend { $FALLBACK }"
    ln -sfn "$STATIC" "$STATE/static"
    sed -e "s#@STATE@#$STATE#g; s#@ADDR@#$ADDR#g; s#@H2_PORT@#$H2#g; s#@H1_PORT@#$H1#g; s#@SNDBUF@#$SNDBUF#g; s#@CHUNK@#$CHUNK#g" \
        -e "s#@MIME@#/etc/nginx/mime.types#g" -e "s|@UPSTREAM@|$UPSTREAM|g" -e "s|@SITE@|$SITE|g" "$D/nginx.conf.tmpl" > "$STATE/nginx.conf"
    nginx -c "$STATE/nginx.conf" -p "$STATE" -e "$STATE/error.log" || { cat "$STATE/error.log"; exit 1; }
    echo "nginx $(nginx -v 2>&1 | sed 's/.*\///'): https://$ADDR:$H2 (HTTP/2), https://$ADDR:$H1 (HTTP/1.1); $STATIC${BACKEND:+, else $BACKEND}${TUNED:+, tuned}" ;;
  stop) stop ;;
  *) sed -n 4,6p "$0"; exit 1 ;;
esac
