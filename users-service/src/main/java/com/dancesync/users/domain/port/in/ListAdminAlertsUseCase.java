package com.dancesync.users.domain.port.in;

import com.dancesync.users.domain.model.audit.AdminAlert;

import java.util.List;

/** Alerts shown to the admin: the Prometheus rules of OBS-1 and the security alerts of the audit log. */
public interface ListAdminAlertsUseCase {

    AlertsView list();

    /**
     * @param operational      alerts of the Prometheus rules
     * @param security         alerts derived from the audit log
     * @param prometheusStatus "ok", "unavailable" (could not be reached) or "not_configured"
     */
    record AlertsView(List<AdminAlert> operational, List<AdminAlert> security, String prometheusStatus) {
    }
}
