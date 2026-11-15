package com.dancesync.users.infrastructure.adapter.in.rest;

import com.dancesync.users.domain.port.in.GetMatchUseCase;
import com.dancesync.users.domain.port.in.RecordMatchUseCase;
import com.dancesync.users.infrastructure.adapter.in.rest.dto.MatchResponse;
import com.dancesync.users.infrastructure.adapter.in.rest.dto.RecordMatchRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * Final match results (HU 21). The gateway exposes only the GET endpoints; the PUT is
 * called by battle-service directly when a battle finishes.
 */
@RestController
@RequestMapping("/api/matches")
public class MatchController {

    private static final Logger log = LoggerFactory.getLogger(MatchController.class);

    private final RecordMatchUseCase recordMatch;
    private final GetMatchUseCase getMatch;

    public MatchController(RecordMatchUseCase recordMatch, GetMatchUseCase getMatch) {
        this.recordMatch = recordMatch;
        this.getMatch = getMatch;
    }

    /**
     * Idempotent upsert: storing the same battle again replaces the stored match. The line
     * logged here ends the trace of a battle (OBS-1): it carries the battle's correlation id,
     * sent by battle-service as X-Correlation-Id.
     */
    @PutMapping("/{id}")
    public MatchResponse record(@PathVariable UUID id, @Valid @RequestBody RecordMatchRequest request) {
        MatchResponse stored = MatchResponse.from(recordMatch.record(request.toDomain(id)));
        log.atInfo()
                .addKeyValue("battleId", id)
                .addKeyValue("roomCode", request.roomCode())
                .addKeyValue("participants", request.participants() == null ? 0 : request.participants().size())
                .log("Match stored");
        return stored;
    }

    @GetMapping("/{id}")
    public MatchResponse getById(@PathVariable UUID id) {
        return MatchResponse.from(getMatch.getById(id));
    }

    @GetMapping
    public List<MatchResponse> listByRoomCode(@RequestParam @NotBlank @Size(max = 16) String roomCode) {
        return getMatch.listByRoomCode(roomCode).stream().map(MatchResponse::from).toList();
    }
}
