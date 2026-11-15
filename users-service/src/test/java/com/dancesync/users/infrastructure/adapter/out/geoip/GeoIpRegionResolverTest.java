package com.dancesync.users.infrastructure.adapter.out.geoip;

import com.dancesync.users.domain.model.audit.AuditEvent;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class GeoIpRegionResolverTest {

    private final GeoIpRegionResolver withoutDatabase = GeoIpRegionResolver.open("");

    @Test
    void privateAndLoopbackAddressesNeedNoDatabase() {
        assertThat(withoutDatabase.regionOf("127.0.0.1")).isEqualTo(GeoIpRegionResolver.PRIVATE_NETWORK);
        assertThat(withoutDatabase.regionOf("10.0.0.7")).isEqualTo(GeoIpRegionResolver.PRIVATE_NETWORK);
        assertThat(withoutDatabase.regionOf("172.18.0.5")).isEqualTo(GeoIpRegionResolver.PRIVATE_NETWORK);
        assertThat(withoutDatabase.regionOf("192.168.1.20")).isEqualTo(GeoIpRegionResolver.PRIVATE_NETWORK);
        assertThat(withoutDatabase.regionOf("100.64.3.1")).isEqualTo(GeoIpRegionResolver.PRIVATE_NETWORK);
        assertThat(withoutDatabase.regionOf("::1")).isEqualTo(GeoIpRegionResolver.PRIVATE_NETWORK);
        assertThat(withoutDatabase.regionOf("fd12:3456::1")).isEqualTo(GeoIpRegionResolver.PRIVATE_NETWORK);
    }

    @Test
    void publicAddressesAreUnknownWithoutADatabase() {
        assertThat(withoutDatabase.databaseLoaded()).isFalse();
        assertThat(withoutDatabase.regionOf("203.0.113.7")).isEqualTo(AuditEvent.UNKNOWN);
        assertThat(withoutDatabase.regionOf("2001:db8::1")).isEqualTo(AuditEvent.UNKNOWN);
    }

    @Test
    void aMissingFileIsNotFatal() {
        GeoIpRegionResolver resolver = GeoIpRegionResolver.open("/does/not/exist.mmdb");

        assertThat(resolver.databaseLoaded()).isFalse();
        assertThat(resolver.regionOf("8.8.8.8")).isEqualTo(AuditEvent.UNKNOWN);
    }

    @Test
    void hostNamesAreNeverResolved() {
        // Parsing "example.com" with InetAddress would query DNS; only IP literals are accepted.
        assertThat(GeoIpRegionResolver.parse("example.com")).isEmpty();
        assertThat(GeoIpRegionResolver.parse("unknown")).isEmpty();
        assertThat(withoutDatabase.regionOf("localhost")).isEqualTo(AuditEvent.UNKNOWN);
        assertThat(withoutDatabase.regionOf(null)).isEqualTo(AuditEvent.UNKNOWN);
    }
}
