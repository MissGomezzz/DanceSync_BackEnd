package com.dancesync.gateway.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.authentication.ReactiveAuthenticationManager;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.authorization.AuthorizationResult;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusReactiveJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.security.oauth2.server.resource.authentication.JwtIssuerReactiveAuthenticationManagerResolver;
import org.springframework.security.oauth2.server.resource.authentication.JwtReactiveAuthenticationManager;
import org.springframework.security.oauth2.server.resource.authentication.ReactiveJwtAuthenticationConverterAdapter;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.security.web.server.authorization.AuthorizationContext;
import org.springframework.security.web.server.context.NoOpServerSecurityContextRepository;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.reactive.CorsConfigurationSource;
import org.springframework.web.cors.reactive.UrlBasedCorsConfigurationSource;
import reactor.core.publisher.Mono;

import javax.crypto.spec.SecretKeySpec;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * SEG-1: the gateway is an OAuth2 resource server. Every HTTP request must
 * carry a valid JWT (signature, expiry, issuer and audience are checked)
 * before it is routed; otherwise it is answered 401 and recorded.
 *
 * <p>Two issuers are trusted, each with its own keys and algorithm:
 * <ul>
 *   <li>Microsoft Entra ID (RS256, keys from the tenant's JWKS): registered
 *       users, role USER. Only they may create rooms and read the match history.</li>
 *   <li>battle-service (HS256, shared secret): guests, role GUEST. Their token
 *       is valid for one room only, the one in its {@code room} claim.</li>
 * </ul>
 *
 * <p>Routes that stay open, and why:
 * <ul>
 *   <li>health checks;</li>
 *   <li>{@code POST /api/rooms/{code}/guest-token}: how a guest gets a token;</li>
 *   <li>{@code /socket.io/**}: the token travels inside the Socket.IO handshake,
 *       which the gateway only proxies, so battle-service validates it before
 *       accepting the connection;</li>
 *   <li>{@code POST /api/rooms/{code}/leave}: sent by {@code navigator.sendBeacon},
 *       which cannot set headers, so the token travels in the body and
 *       battle-service validates it.</li>
 * </ul>
 */
@Configuration
@EnableWebFluxSecurity
@EnableConfigurationProperties(AuthProperties.class)
public class SecurityConfig {

    private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);

    static final GrantedAuthority USER = new SimpleGrantedAuthority("ROLE_USER");
    static final GrantedAuthority GUEST = new SimpleGrantedAuthority("ROLE_GUEST");
    /** Claim of the guest token naming the only room it is valid for. */
    static final String ROOM_CLAIM = "room";

    @Bean
    SecurityWebFilterChain securityWebFilterChain(ServerHttpSecurity http, AuthProperties properties,
                                                  AuthRejectionHandler rejections) {
        JwtIssuerReactiveAuthenticationManagerResolver tokens = authenticationManagers(properties);
        return http
                // Stateless API authenticated by bearer tokens: no session, no cookies, so no CSRF surface.
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .httpBasic(ServerHttpSecurity.HttpBasicSpec::disable)
                .formLogin(ServerHttpSecurity.FormLoginSpec::disable)
                .logout(ServerHttpSecurity.LogoutSpec::disable)
                .securityContextRepository(NoOpServerSecurityContextRepository.getInstance())
                .cors(cors -> cors.configurationSource(corsConfigurationSource(properties)))
                .authorizeExchange(exchanges -> exchanges
                        .pathMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        .pathMatchers(HttpMethod.GET, "/actuator/health", "/actuator/health/**",
                                "/api/battles/health").permitAll()
                        .pathMatchers("/socket.io/**").permitAll()
                        .pathMatchers(HttpMethod.POST, "/api/rooms/{code}/guest-token", "/api/rooms/{code}/leave")
                        .permitAll()
                        .pathMatchers("/api/rooms/{code}", "/api/rooms/{code}/**").access(SecurityConfig::roomAccess)
                        // Everything else (creating rooms, match history, users, actuator) is for registered users.
                        .anyExchange().hasRole("USER"))
                .oauth2ResourceServer(server -> server
                        .authenticationManagerResolver(tokens)
                        .authenticationEntryPoint(rejections)
                        .accessDeniedHandler(rejections))
                .exceptionHandling(handling -> handling
                        .authenticationEntryPoint(rejections)
                        .accessDeniedHandler(rejections))
                .build();
    }

    /** A room is open to registered users and to the guests whose token names that very room. */
    private static Mono<AuthorizationResult> roomAccess(Mono<Authentication> authentication,
                                                        AuthorizationContext context) {
        String code = String.valueOf(context.getVariables().get("code"));
        return authentication
                .filter(Authentication::isAuthenticated)
                .<AuthorizationResult>map(token -> new AuthorizationDecision(
                        token.getAuthorities().contains(USER) || isGuestOf(token, code)))
                .defaultIfEmpty(new AuthorizationDecision(false));
    }

    private static boolean isGuestOf(Authentication authentication, String roomCode) {
        return authentication instanceof JwtAuthenticationToken jwt
                && jwt.getAuthorities().contains(GUEST)
                && roomCode.equalsIgnoreCase(jwt.getToken().getClaimAsString(ROOM_CLAIM));
    }

    /** Picks the keys that must validate a token from its issuer; an unknown issuer is refused. */
    private static JwtIssuerReactiveAuthenticationManagerResolver authenticationManagers(AuthProperties properties) {
        Map<String, ReactiveAuthenticationManager> byIssuer = new HashMap<>();
        if (properties.entra().configured()) {
            byIssuer.put(properties.entra().resolvedIssuer(), entraManager(properties.entra()));
        } else {
            log.warn("AZURE_TENANT_ID / AZURE_CLIENT_ID are not set: every registered-user token will be refused");
        }
        if (properties.guest().configured()) {
            byIssuer.put(properties.guest().issuer(), guestManager(properties.guest()));
        } else {
            log.warn("GUEST_TOKEN_SECRET is not set: every guest token will be refused");
        }
        return new JwtIssuerReactiveAuthenticationManagerResolver(issuer -> Mono.justOrEmpty(byIssuer.get(issuer)));
    }

    private static ReactiveAuthenticationManager entraManager(AuthProperties.Entra entra) {
        // Keys are fetched from the tenant's JWKS on first use and cached; only RS256 is accepted,
        // so an unsigned token or one "signed" with the public key as an HMAC secret is refused.
        NimbusReactiveJwtDecoder decoder = NimbusReactiveJwtDecoder.withJwkSetUri(entra.resolvedJwkSetUri())
                .jwsAlgorithm(SignatureAlgorithm.RS256)
                .build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                JwtValidators.createDefaultWithIssuer(entra.resolvedIssuer()),
                audienceValidator(entra.resolvedAudiences())));
        // "oid" identifies the user in the tenant; it is the player id battle-service uses too.
        return manager(decoder, USER, jwt -> jwt.hasClaim("oid") ? jwt.getClaimAsString("oid") : jwt.getSubject());
    }

    private static ReactiveAuthenticationManager guestManager(AuthProperties.Guest guest) {
        NimbusReactiveJwtDecoder decoder = NimbusReactiveJwtDecoder
                .withSecretKey(new SecretKeySpec(guest.secretBytes(), "HmacSHA256"))
                .macAlgorithm(MacAlgorithm.HS256)
                .build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                JwtValidators.createDefaultWithIssuer(guest.issuer()),
                audienceValidator(List.of(guest.audience())),
                new JwtClaimValidator<String>(ROOM_CLAIM, room -> room != null && !room.isBlank())));
        return manager(decoder, GUEST, Jwt::getSubject);
    }

    private static ReactiveAuthenticationManager manager(NimbusReactiveJwtDecoder decoder, GrantedAuthority role,
                                                         java.util.function.Function<Jwt, String> principal) {
        JwtReactiveAuthenticationManager manager = new JwtReactiveAuthenticationManager(decoder);
        manager.setJwtAuthenticationConverter(new ReactiveJwtAuthenticationConverterAdapter(
                jwt -> new JwtAuthenticationToken(jwt, List.of(role), principal.apply(jwt))));
        return manager;
    }

    private static OAuth2TokenValidator<Jwt> audienceValidator(List<String> accepted) {
        return new JwtClaimValidator<List<String>>("aud",
                audiences -> audiences != null && audiences.stream().anyMatch(accepted::contains));
    }

    /**
     * Same origin as the gateway routes' global CORS. Declared here as well so
     * the answers produced by the security filter itself (401, 403, preflight)
     * carry the CORS headers: without them the browser would hide the 401 from
     * the frontend behind a generic network error.
     */
    private static CorsConfigurationSource corsConfigurationSource(AuthProperties properties) {
        CorsConfiguration cors = new CorsConfiguration();
        cors.setAllowedOrigins(List.of(properties.cors().allowedOrigin()));
        cors.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        cors.setAllowedHeaders(List.of("*"));
        cors.setExposedHeaders(List.of(CorrelationIdFilter.HEADER));
        cors.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cors);
        return source;
    }
}
