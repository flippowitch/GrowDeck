#!/bin/sh
set -e
if [ -z "$NAS_IP" ]; then
  echo "NAS_IP ist nicht gesetzt. Trage die IP-Adresse der NAS in der .env-Datei ein." >&2
  exit 1
fi
UP1="${DNS_UPSTREAM_1:-1.1.1.1}"
UP2="${DNS_UPSTREAM_2:-9.9.9.9}"
echo "sf.mqtt.spider-farmer.com -> $NAS_IP, alle anderen Anfragen -> $UP1 / $UP2"
exec dnsmasq --keep-in-foreground --log-facility=- --no-resolv --no-hosts \
  --server="$UP1" --server="$UP2" \
  --address=/sf.mqtt.spider-farmer.com/"$NAS_IP" \
  --domain-needed --bogus-priv --cache-size=1000
