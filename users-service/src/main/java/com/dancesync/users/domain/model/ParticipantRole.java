package com.dancesync.users.domain.model;

import java.util.Arrays;

/** Seat a player held in a match. The wire value is what battle-service sends and what is stored. */
public enum ParticipantRole {

    DANCER("dancer"),
    SPECTATOR("spectator");

    private final String wireValue;

    ParticipantRole(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }

    public static ParticipantRole fromWireValue(String value) {
        return Arrays.stream(values())
                .filter(role -> role.wireValue.equals(value))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown participant role '" + value + "'"));
    }
}
