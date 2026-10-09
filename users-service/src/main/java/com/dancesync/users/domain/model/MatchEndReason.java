package com.dancesync.users.domain.model;

import java.util.Arrays;

/** Why a battle finished. The wire value is what battle-service sends and what is stored. */
public enum MatchEndReason {

    SONG_END("song-end"),
    NOT_ENOUGH_DANCERS("not-enough-dancers");

    private final String wireValue;

    MatchEndReason(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }

    public static MatchEndReason fromWireValue(String value) {
        return Arrays.stream(values())
                .filter(reason -> reason.wireValue.equals(value))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown match end reason '" + value + "'"));
    }
}
