package com.dancesync.users.infrastructure.adapter.in.rest;

import com.dancesync.users.domain.exception.UserAlreadyExistsException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class RestExceptionHandlerTest {

    private final RestExceptionHandler handler = new RestExceptionHandler();

    @Test
    void dataIntegrityViolationIsAConflictWithTheSameShapeAsADuplicateUser() {
        ProblemDetail duplicate = handler.handleConflict(new UserAlreadyExistsException("azure-oid-1"));
        ProblemDetail violation = handler.handleDataIntegrityViolation(new DataIntegrityViolationException(
                "duplicate key value violates unique constraint \"users_external_id_key\""));

        assertEquals(HttpStatus.CONFLICT.value(), violation.getStatus());
        assertEquals(duplicate.getStatus(), violation.getStatus());
        assertEquals(duplicate.getTitle(), violation.getTitle());
        assertEquals(RestExceptionHandler.DATA_CONFLICT_DETAIL, violation.getDetail());
    }

    @Test
    void dataIntegrityViolationDoesNotLeakTheDatabaseMessage() {
        ProblemDetail violation = handler.handleDataIntegrityViolation(
                new DataIntegrityViolationException("constraint users_external_id_key on table users"));

        assertFalse(violation.getDetail().contains("users_external_id_key"));
    }
}
