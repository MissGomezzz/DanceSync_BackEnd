package com.dancesync.users.domain.port.out;

/** Region of a client address, from a local GeoIP database (SEG-2). */
public interface RegionResolverPort {

    /** "City, Region, CC" with whatever the database knows; never null. */
    String regionOf(String ip);
}
