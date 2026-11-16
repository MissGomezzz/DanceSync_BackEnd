#!/bin/sh
# SEG-2: downloads the free DB-IP Lite database (CC BY 4.0, https://db-ip.com/db/lite.php) that
# users-service uses to resolve the region of each audited address. Usage:
#   sh scripts/download-geoip.sh [city|country]
# Writes geoip/dbip-lite.mmdb (the default GEOIP_DB_PATH of docker-compose.observability.yml).
set -eu
kind="${1:-city}"
case "$kind" in
  city|country) ;;
  *) echo "usage: $0 [city|country]" >&2; exit 1 ;;
esac
dir="$(cd "$(dirname "$0")/.." && pwd)/geoip"
mkdir -p "$dir"
month="$(date -u +%Y-%m)"
url="https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz"
echo "Downloading $url"
if ! curl --proto =https --tlsv1.2 -fsSL "$url" -o "$dir/download.mmdb.gz"; then
  # The new month's file appears a few days in: fall back to the previous one.
  previous="$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)"
  url="https://download.db-ip.com/free/dbip-${kind}-lite-${previous}.mmdb.gz"
  echo "Not published yet; downloading $url"
  curl --proto =https --tlsv1.2 -fsSL "$url" -o "$dir/download.mmdb.gz"
fi
gunzip -c "$dir/download.mmdb.gz" > "$dir/dbip-lite.mmdb"
rm "$dir/download.mmdb.gz"
echo "Saved $dir/dbip-lite.mmdb (set GEOIP_DB_PATH to it). IP geolocation by DB-IP.com, CC BY 4.0."
