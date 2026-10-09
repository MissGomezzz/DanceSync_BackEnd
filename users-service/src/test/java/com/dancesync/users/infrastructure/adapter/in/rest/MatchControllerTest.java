package com.dancesync.users.infrastructure.adapter.in.rest;

import com.dancesync.users.application.service.MatchService;
import com.dancesync.users.support.InMemoryMatchRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

import java.util.UUID;

import static org.hamcrest.Matchers.contains;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Web slice with the real service over an in-memory repository: no database needed. */
@WebMvcTest(MatchController.class)
@Import(MatchControllerTest.InMemoryMatchConfig.class)
class MatchControllerTest {

    private static final String VALID_BODY = """
            {
              "roomCode": "abc123",
              "songId": "song-1",
              "songTitle": "Some Song",
              "startedAt": "2026-10-09T12:00:00.000Z",
              "finishedAt": "2026-10-09T12:01:30.000Z",
              "winnerPlayerId": "guest-a",
              "endReason": "song-end",
              "someFutureField": true,
              "participants": [
                { "playerId": "guest-c", "displayName": "Cam", "role": "spectator",
                  "votes": null, "wordsWon": null, "score": null, "rank": null, "leftEarly": true },
                { "playerId": "guest-b", "displayName": "Bob", "role": "dancer",
                  "votes": 0, "wordsWon": 1, "score": 1, "rank": 2 },
                { "playerId": "guest-a", "displayName": "Ana", "role": "dancer",
                  "votes": 2, "wordsWon": 1, "score": 5, "rank": 1, "leftEarly": false }
              ]
            }
            """;

    @Autowired
    private MockMvc mockMvc;

    @TestConfiguration
    static class InMemoryMatchConfig {

        @Bean
        MatchService matchService() {
            return new MatchService(new InMemoryMatchRepository());
        }
    }

    @Test
    void putStoresTheMatchAndReturnsItInResultsOrder() throws Exception {
        UUID id = UUID.randomUUID();

        putMatch(id, VALID_BODY)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(id.toString()))
                .andExpect(jsonPath("$.roomCode").value("ABC123"))
                .andExpect(jsonPath("$.endReason").value("song-end"))
                .andExpect(jsonPath("$.winnerPlayerId").value("guest-a"))
                .andExpect(jsonPath("$.participants[*].playerId").value(contains("guest-a", "guest-b", "guest-c")))
                .andExpect(jsonPath("$.participants[1].leftEarly").value(false))
                .andExpect(jsonPath("$.participants[2].role").value("spectator"))
                .andExpect(jsonPath("$.participants[2].rank").value(nullValue()))
                .andExpect(jsonPath("$.participants[2].leftEarly").value(true));
    }

    @Test
    void putIsIdempotentAndTheLastVersionWins() throws Exception {
        UUID id = UUID.randomUUID();
        putMatch(id, VALID_BODY).andExpect(status().isOk());
        putMatch(id, VALID_BODY.replace("\"score\": 5", "\"score\": 9")).andExpect(status().isOk());

        mockMvc.perform(get("/api/matches/{id}", id))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.participants", hasSize(3)))
                .andExpect(jsonPath("$.participants[0].score").value(9));
    }

    @Test
    void putRejectsAnIdThatIsNotAUuid() throws Exception {
        putMatch("not-a-uuid", VALID_BODY).andExpect(status().isBadRequest());
    }

    @Test
    void putRejectsAnUnknownEndReason() throws Exception {
        putMatch(UUID.randomUUID(), VALID_BODY.replace("\"song-end\"", "\"timeout\""))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putRejectsAnUnknownRole() throws Exception {
        putMatch(UUID.randomUUID(), VALID_BODY.replace("\"spectator\"", "\"judge\""))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putRejectsABlankPlayerId() throws Exception {
        putMatch(UUID.randomUUID(), VALID_BODY.replace("\"guest-b\"", "\"  \""))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putRejectsARepeatedPlayerId() throws Exception {
        putMatch(UUID.randomUUID(), VALID_BODY.replace("\"guest-b\"", "\"guest-a\""))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putRejectsANegativeScore() throws Exception {
        putMatch(UUID.randomUUID(), VALID_BODY.replace("\"score\": 5", "\"score\": -1"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putRejectsAMissingFinishTime() throws Exception {
        putMatch(UUID.randomUUID(), VALID_BODY.replace("\"finishedAt\": \"2026-10-09T12:01:30.000Z\",", ""))
                .andExpect(status().isBadRequest());
    }

    @Test
    void getReturnsNotFoundForAnUnknownMatch() throws Exception {
        UUID id = UUID.randomUUID();
        mockMvc.perform(get("/api/matches/{id}", id))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.status").value(404))
                .andExpect(jsonPath("$.detail").value("Match '" + id + "' was not found"));
    }

    @Test
    void listByRoomCodeIsCaseInsensitive() throws Exception {
        UUID id = UUID.randomUUID();
        putMatch(id, VALID_BODY.replace("abc123", "LST123")).andExpect(status().isOk());

        mockMvc.perform(get("/api/matches").param("roomCode", "lst123"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(1)))
                .andExpect(jsonPath("$[0].id").value(id.toString()));
    }

    @Test
    void listByRoomCodeReturnsAnEmptyArrayForAnUnknownRoom() throws Exception {
        mockMvc.perform(get("/api/matches").param("roomCode", "NOPE00"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(0)));
    }

    @Test
    void listRequiresARoomCode() throws Exception {
        mockMvc.perform(get("/api/matches")).andExpect(status().isBadRequest());
        mockMvc.perform(get("/api/matches").param("roomCode", " ")).andExpect(status().isBadRequest());
    }

    private ResultActions putMatch(Object id, String body) throws Exception {
        return mockMvc.perform(put("/api/matches/{id}", id).contentType(MediaType.APPLICATION_JSON).content(body));
    }
}
