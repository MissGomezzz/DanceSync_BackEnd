package com.dancesync.gateway.ratelimit;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ClientAddressTests {

    private static InetSocketAddress remote(String ip) {
        return new InetSocketAddress(ip, 40000);
    }

    @Test
    @DisplayName("With no trusted proxy the connection address is used, whatever X-Forwarded-For says")
    void ignoresTheHeaderWithoutTrustedProxies() {
        assertEquals("203.0.113.9", ClientAddress.resolve(remote("203.0.113.9"), List.of("1.2.3.4"), 0));
    }

    @Test
    @DisplayName("The address the trusted proxy saw is used, not what the client wrote")
    void takesTheAddressAddedByTheTrustedProxy() {
        assertEquals("198.51.100.7", ClientAddress.resolve(remote("10.0.0.2"), List.of("198.51.100.7"), 1));
        assertEquals("198.51.100.7", ClientAddress.resolve(remote("10.0.0.2"), List.of("1.2.3.4, 198.51.100.7"), 1));
    }

    @Test
    @DisplayName("One entry is walked back per trusted proxy, across several header values")
    void walksBackOneEntryPerProxy() {
        assertEquals("198.51.100.7",
                ClientAddress.resolve(remote("10.0.0.3"), List.of("198.51.100.7", "10.0.0.2"), 2));
        assertEquals("198.51.100.7", ClientAddress.resolve(remote("10.0.0.2"), List.of("198.51.100.7"), 5));
        assertEquals("10.0.0.2", ClientAddress.resolve(remote("10.0.0.2"), null, 3));
    }

    @Test
    @DisplayName("An entry that is not an address falls back to the connection address; IPv4-mapped is normalized")
    void fallsBackAndNormalizes() {
        assertEquals("10.0.0.2", ClientAddress.resolve(remote("10.0.0.2"), List.of("not-an-ip"), 1));
        assertEquals("198.51.100.7", ClientAddress.resolve(remote("10.0.0.2"), List.of("::ffff:198.51.100.7"), 1));
        assertEquals("2001:db8::1", ClientAddress.resolve(remote("10.0.0.2"), List.of("2001:db8::1"), 1));
        assertEquals("unknown", ClientAddress.resolve(null, null, 0));
    }
}
