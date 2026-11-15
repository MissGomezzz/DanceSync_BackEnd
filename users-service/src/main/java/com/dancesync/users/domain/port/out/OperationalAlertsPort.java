package com.dancesync.users.domain.port.out;

import com.dancesync.users.domain.model.audit.AdminAlert;

import java.util.List;

/** Active alerts of the monitoring system (Prometheus rules of OBS-1). */
public interface OperationalAlertsPort {

    /** False when no monitoring system is configured. */
    boolean configured();

    /** Firing and pending alerts. Throws when the monitoring system cannot be reached. */
    List<AdminAlert> activeAlerts();
}
