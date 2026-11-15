package com.dancesync.users.infrastructure.observability;

import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** OBS-1: the correlation id of a request reaches the MDC and the response, and never leaks into the next one. */
class CorrelationIdFilterTest {

    private final CorrelationIdFilter filter = new CorrelationIdFilter();

    @Test
    void keepsAValidIncomingIdInTheMdcAndEchoesIt() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("PUT", "/api/matches/1");
        request.addHeader(CorrelationIdFilter.HEADER, "battle-trace_1.2");
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicReference<String> seenByTheHandler = new AtomicReference<>();

        filter.doFilter(request, response, (req, res) -> seenByTheHandler.set(MDC.get(CorrelationIdFilter.MDC_KEY)));

        assertThat(seenByTheHandler.get()).isEqualTo("battle-trace_1.2");
        assertThat(response.getHeader(CorrelationIdFilter.HEADER)).isEqualTo("battle-trace_1.2");
        assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).as("cleared after the request").isNull();
    }

    @Test
    void generatesOneWhenTheHeaderIsMissingOrNotAPlainId() throws Exception {
        for (String header : new String[] {null, "", "has spaces", "line\nbreak", "x".repeat(65)}) {
            MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/matches");
            if (header != null) request.addHeader(CorrelationIdFilter.HEADER, header);
            MockHttpServletResponse response = new MockHttpServletResponse();
            AtomicReference<String> seen = new AtomicReference<>();

            filter.doFilter(request, response, (req, res) -> seen.set(MDC.get(CorrelationIdFilter.MDC_KEY)));

            assertThat(seen.get()).as("header %s", header).matches("[0-9a-f-]{36}").isNotEqualTo(header);
            assertThat(response.getHeader(CorrelationIdFilter.HEADER)).isEqualTo(seen.get());
            assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isNull();
        }
    }

    @Test
    void clearsTheMdcEvenWhenTheHandlerFails() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/matches");
        try {
            filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> {
                throw new IllegalStateException("boom");
            });
        } catch (Exception expected) {
            // The servlet container answers 500; what matters is the MDC.
        }
        assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isNull();
    }
}
