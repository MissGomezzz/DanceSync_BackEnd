# GeoIP database (SEG-2)

users-service resolves the region of every audited address from a local database in MaxMind
format (`GEOIP_DB_PATH`). No address is sent to a third party. The database is not committed:

```sh
sh scripts/download-geoip.sh          # DB-IP "IP to City Lite" (CC BY 4.0), ~130 MB
sh scripts/download-geoip.sh country  # DB-IP "IP to Country Lite", ~8 MB
```

Without it, private addresses are still reported as "Private network" and public ones as
"unknown" (the address itself is always stored).

IP geolocation by DB-IP.com, licensed under CC BY 4.0.
