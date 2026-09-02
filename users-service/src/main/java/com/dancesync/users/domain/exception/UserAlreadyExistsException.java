package com.dancesync.users.domain.exception;

public class UserAlreadyExistsException extends RuntimeException {

    public UserAlreadyExistsException(String externalId) {
        super("A user with external id '" + externalId + "' already exists");
    }
}
