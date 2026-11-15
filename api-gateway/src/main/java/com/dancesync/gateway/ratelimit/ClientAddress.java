package com.dancesync.gateway.ratelimit;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The address of the client behind {@code trustedProxyHops} trusted proxies
 * (SEG-3), with the same rule as battle-service: each proxy appends to
 * {@code X-Forwarded-For} the address it received the request from, a client
 * can write anything there, so only the entries added by trusted proxies are
 * believed. The client is the entry {@code trustedProxyHops} places from the
 * right of {@code X-Forwarded-For, <connection address>}; with 0 the header is
 * ignored.
 */
public final class ClientAddress {

    /** IPv4, or something made of IPv6 characters; anything else is not taken from the header. */
    private static final Pattern IPV4 = Pattern.compile("\\d{1,3}(\\.\\d{1,3}){3}");
    private static final Pattern IPV6 = Pattern.compile("[0-9A-Fa-f:.]{2,45}");

    private ClientAddress() {
    }

    public static String resolve(InetSocketAddress remote, List<String> forwardedFor, int trustedProxyHops) {
        String connection = connectionAddress(remote);
        if (trustedProxyHops <= 0) return connection;
        List<String> chain = new ArrayList<>();
        if (forwardedFor != null) {
            for (String header : forwardedFor) {
                for (String part : header.split(",")) {
                    String entry = part.trim();
                    if (!entry.isEmpty()) chain.add(entry);
                }
            }
        }
        chain.add(connection);
        String candidate = chain.get(Math.max(0, chain.size() - 1 - trustedProxyHops));
        return isAddress(candidate) ? normalize(candidate) : connection;
    }

    private static String connectionAddress(InetSocketAddress remote) {
        if (remote == null) return "unknown";
        InetAddress address = remote.getAddress();
        return normalize(address != null ? address.getHostAddress() : remote.getHostString());
    }

    private static boolean isAddress(String value) {
        if (IPV4.matcher(value).matches()) return true;
        return value.contains(":") && IPV6.matcher(value).matches();
    }

    /** "::ffff:10.0.0.7" -> "10.0.0.7"; brackets and zone ids of IPv6 are dropped. */
    private static String normalize(String address) {
        String value = address;
        if (value.startsWith("[") && value.endsWith("]")) value = value.substring(1, value.length() - 1);
        int zone = value.indexOf('%');
        if (zone >= 0) value = value.substring(0, zone);
        if (value.startsWith("::ffff:") && IPV4.matcher(value.substring(7)).matches()) value = value.substring(7);
        return value;
    }
}
