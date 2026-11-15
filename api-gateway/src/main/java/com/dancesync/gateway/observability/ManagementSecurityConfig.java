package com.dancesync.gateway.observability;

import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.boot.web.server.context.WebServerInitializedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.security.web.server.util.matcher.ServerWebExchangeMatcher;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * OBS-1: the management port (MANAGEMENT_PORT, health and prometheus only) is scraped by
 * Prometheus from inside the network, without a token. This chain applies only to requests
 * received on that port, ahead of the SEG-1 chain, so the rules of the public port
 * (including {@code /actuator/**} for signed-in users only) do not change.
 */
@Configuration
public class ManagementSecurityConfig {

    @Bean
    ManagementPortMatcher managementPortMatcher() {
        return new ManagementPortMatcher();
    }

    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE)
    SecurityWebFilterChain managementSecurityWebFilterChain(ServerHttpSecurity http, ManagementPortMatcher managementPort) {
        return http
                .securityMatcher(managementPort)
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .httpBasic(ServerHttpSecurity.HttpBasicSpec::disable)
                .formLogin(ServerHttpSecurity.FormLoginSpec::disable)
                .logout(ServerHttpSecurity.LogoutSpec::disable)
                .authorizeExchange(exchanges -> exchanges.anyExchange().permitAll())
                .build();
    }

    /**
     * Matches the requests received on the management server's port, learned when that
     * server starts (it may be random, as in the tests). Before that, nothing matches.
     */
    static class ManagementPortMatcher implements ServerWebExchangeMatcher, ApplicationListener<WebServerInitializedEvent> {

        private static final String MANAGEMENT_NAMESPACE = "management";

        private final AtomicInteger port = new AtomicInteger(-1);

        @Override
        public void onApplicationEvent(WebServerInitializedEvent event) {
            WebServerApplicationContext context = event.getApplicationContext();
            if (MANAGEMENT_NAMESPACE.equals(context.getServerNamespace())) port.set(event.getWebServer().getPort());
        }

        @Override
        public Mono<MatchResult> matches(ServerWebExchange exchange) {
            InetSocketAddress local = exchange.getRequest().getLocalAddress();
            int managementPort = port.get();
            return managementPort > 0 && local != null && local.getPort() == managementPort
                    ? MatchResult.match()
                    : MatchResult.notMatch();
        }
    }
}
