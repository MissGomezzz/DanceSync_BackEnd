package com.dancesync.users.infrastructure.adapter.out.geoip;

import com.dancesync.users.domain.model.audit.AuditEvent;
import com.dancesync.users.domain.port.out.RegionResolverPort;
import com.maxmind.db.CHMCache;
import com.maxmind.geoip2.DatabaseReader;
import com.maxmind.geoip2.model.CityResponse;
import com.maxmind.geoip2.model.CountryResponse;
import com.maxmind.geoip2.record.Country;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Region of a client address from a local GeoIP database in MaxMind format (SEG-2): the free
 * DB-IP "IP to City Lite" or "IP to Country Lite" databases (CC BY 4.0, see
 * {@code scripts/download-geoip.sh}), or a MaxMind GeoLite2 database. The lookup never leaves the
 * machine: no address is sent to a third party.
 *
 * <p>Private, loopback and link-local addresses (local development, the containers' network) are
 * reported as such without a lookup. Without a database every other address is "unknown": the
 * record is still stored with its address, from which the region can be resolved later.
 */
public class GeoIpRegionResolver implements RegionResolverPort, Closeable {

    public static final String PRIVATE_NETWORK = "Private network";

    private static final Logger log = LoggerFactory.getLogger(GeoIpRegionResolver.class);
    private static final Pattern IPV4 = Pattern.compile("\\d{1,3}(\\.\\d{1,3}){3}");
    private static final Pattern IPV6 = Pattern.compile("[0-9A-Fa-f:.]{2,45}");

    private final DatabaseReader reader;
    private final boolean cityLevel;

    private GeoIpRegionResolver(DatabaseReader reader) {
        this.reader = reader;
        this.cityLevel = reader != null && reader.getMetadata().getDatabaseType().contains("City");
    }

    /** Opens the database at {@code path}; without a readable file, only private addresses are resolved. */
    public static GeoIpRegionResolver open(String path) {
        if (path == null || path.isBlank()) {
            log.warn("GEOIP_DB_PATH is not set: the region of public addresses will be recorded as unknown");
            return new GeoIpRegionResolver(null);
        }
        File file = new File(path.trim());
        try {
            DatabaseReader reader = new DatabaseReader.Builder(file).withCache(new CHMCache()).build();
            log.atInfo().addKeyValue("database", reader.getMetadata().getDatabaseType())
                    .addKeyValue("built", reader.getMetadata().getBuildDate()).log("GeoIP database loaded");
            return new GeoIpRegionResolver(reader);
        } catch (IOException e) {
            log.atWarn().addKeyValue("path", file.getPath()).addKeyValue("error", e.getMessage())
                    .log("Could not open the GeoIP database: the region of public addresses will be recorded as unknown");
            return new GeoIpRegionResolver(null);
        }
    }

    /** For tests: a resolver over an already open reader (or none). */
    static GeoIpRegionResolver of(DatabaseReader reader) {
        return new GeoIpRegionResolver(reader);
    }

    public boolean databaseLoaded() {
        return reader != null;
    }

    @Override
    public String regionOf(String ip) {
        Optional<InetAddress> address = parse(ip);
        if (address.isEmpty()) return AuditEvent.UNKNOWN;
        if (isPrivate(address.get())) return PRIVATE_NETWORK;
        if (reader == null) return AuditEvent.UNKNOWN;
        try {
            return cityLevel
                    ? reader.tryCity(address.get()).map(GeoIpRegionResolver::describe).orElse(AuditEvent.UNKNOWN)
                    : reader.tryCountry(address.get()).map(GeoIpRegionResolver::describe).orElse(AuditEvent.UNKNOWN);
        } catch (Exception e) {
            // A corrupt entry must not stop the batch: the address itself is still recorded.
            log.atDebug().addKeyValue("error", e.getClass().getSimpleName()).log("GeoIP lookup failed");
            return AuditEvent.UNKNOWN;
        }
    }

    private static String describe(CityResponse response) {
        List<String> parts = new ArrayList<>(3);
        if (response.getCity() != null && response.getCity().getName() != null) parts.add(response.getCity().getName());
        if (response.getMostSpecificSubdivision() != null && response.getMostSpecificSubdivision().getName() != null) {
            parts.add(response.getMostSpecificSubdivision().getName());
        }
        String country = country(response.getCountry());
        if (country != null) parts.add(country);
        return parts.isEmpty() ? AuditEvent.UNKNOWN : String.join(", ", parts);
    }

    private static String describe(CountryResponse response) {
        String country = country(response.getCountry());
        return country == null ? AuditEvent.UNKNOWN : country;
    }

    private static String country(Country country) {
        if (country == null) return null;
        if (country.getName() != null && country.getIsoCode() != null) {
            return country.getName() + " (" + country.getIsoCode() + ")";
        }
        return country.getName() != null ? country.getName() : country.getIsoCode();
    }

    /**
     * Only IP literals are parsed: {@link InetAddress#getByName} would resolve a host name
     * through DNS, and the address field must never trigger a network call.
     */
    static Optional<InetAddress> parse(String ip) {
        if (ip == null) return Optional.empty();
        String value = ip.trim();
        if (!IPV4.matcher(value).matches() && !(value.contains(":") && IPV6.matcher(value).matches())) {
            return Optional.empty();
        }
        try {
            return Optional.of(InetAddress.getByName(value));
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    static boolean isPrivate(InetAddress address) {
        if (address.isLoopbackAddress() || address.isSiteLocalAddress() || address.isLinkLocalAddress()
                || address.isAnyLocalAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        // IPv6 unique local addresses (fc00::/7) and the carrier-grade NAT range 100.64.0.0/10.
        if (address instanceof Inet6Address) return (bytes[0] & 0xFE) == 0xFC;
        return (bytes[0] & 0xFF) == 100 && (bytes[1] & 0xC0) == 64;
    }

    @Override
    public void close() throws IOException {
        if (reader != null) reader.close();
    }
}
