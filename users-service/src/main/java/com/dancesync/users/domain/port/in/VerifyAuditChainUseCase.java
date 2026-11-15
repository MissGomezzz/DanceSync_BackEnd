package com.dancesync.users.domain.port.in;

import com.dancesync.users.domain.model.audit.ChainVerification;

import java.util.Optional;

/** Walks the whole audit chain and reports the first record that was deleted, inserted or altered (SEG-2). */
public interface VerifyAuditChainUseCase {

    ChainVerification verify();

    /** The result of the last walk made by this instance, if any. */
    Optional<ChainVerification> lastVerification();
}
