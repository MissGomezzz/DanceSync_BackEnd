package com.dancesync.gateway.audit;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.support.ServerWebExchangeUtils;
import org.springframework.core.Ordered;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * The internal secret of users-service (SEG-2) on forwarded requests: removed from every request
 * (a client must never be able to send it), and added only to the admin route, which the security
 * chain has already restricted to ROLE_ADMIN.
 */
@Component
public class InternalTokenRelay implements GlobalFilter, Ordered {

    static final String ADMIN_ROUTE = "users-service-admin";

    private final AuditProperties properties;

    public InternalTokenRelay(AuditProperties properties) {
        this.properties = properties;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        Route route = exchange.getAttribute(ServerWebExchangeUtils.GATEWAY_ROUTE_ATTR);
        boolean admin = route != null && ADMIN_ROUTE.equals(route.getId()) && properties.shippingConfigured();
        ServerHttpRequest request = exchange.getRequest().mutate().headers(headers -> {
            headers.remove(AuditShipper.HEADER);
            if (admin) headers.set(AuditShipper.HEADER, properties.internalToken());
        }).build();
        return chain.filter(exchange.mutate().request(request).build());
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }
}
