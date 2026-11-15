package com.dancesync.gateway.security;

import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

import java.security.Principal;

/**
 * {@code GET /api/me}: who the validated token belongs to and whether it is the admin account
 * (SEG-2). The frontend asks here to decide whether to show the admin console, so a regular user
 * gets a plain 200 with {@code admin: false} instead of a 403 from {@code /api/admin/**}: signing in
 * never looks like an attempt to open the admin screen in the audit log, nor feeds its alerts.
 * Answered by the gateway itself, from the roles SecurityConfig gave the token.
 */
@RestController
public class SessionController {

    @GetMapping("/api/me")
    public Mono<Me> me(Principal principal) {
        if (!(principal instanceof JwtAuthenticationToken token)) return Mono.empty();
        boolean guest = token.getAuthorities().contains(SecurityConfig.GUEST);
        boolean admin = token.getAuthorities().contains(SecurityConfig.ADMIN);
        Jwt jwt = token.getToken();
        return Mono.just(new Me(token.getName(), guest ? "guest" : "user", jwt.getClaimAsString("name"), admin));
    }

    /** @param admin true only for the single account named by ADMIN_USER_OID */
    public record Me(String userId, String kind, String name, boolean admin) {
    }
}
