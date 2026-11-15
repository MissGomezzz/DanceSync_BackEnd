package com.dancesync.gateway.audit;

/**
 * Who made a request, as proven by the token the security chain validated (SEG-2): the
 * Entra ID object id of a registered user, or the server-generated id of a guest.
 */
public record AuditIdentity(String userId, String kind, String displayName) {

    /** Exchange attribute where the security chain leaves the identity for the audit filter. */
    public static final String ATTRIBUTE = AuditIdentity.class.getName();
}
