-- H2a: normal, audited synthetic PAPER release on an owner-approved session
-- Pause/End or on the explicitly approved finite Start deadline.
-- Keep expiry and kill-switch reasons unchanged, preserving historical digests.
ALTER TABLE "trading_paper_release_audits"
    DROP CONSTRAINT "trading_paper_release_audits_reason_check";
ALTER TABLE "trading_paper_release_audits"
    ADD CONSTRAINT "trading_paper_release_audits_reason_check"
    CHECK ("reason" IN ('expired', 'kill_switch', 'session_end'));
