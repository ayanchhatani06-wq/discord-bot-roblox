-- The recruiter's cut: 20% of a recruit's FIRST payout, taken from that payout.
--
-- Not a share of the studio's pool like finder, leader, mod and owner. Those are
-- percentages of what is left after the artist is paid, and they must total
-- 100%. This one comes out of the artist's own money, once, on their first job,
-- so the pool is untouched and the studio never pays out more than came in.
--
-- The artist has to be told before they accept that first task. A figure agreed
-- as $35 that arrives as $28 is a broken promise even when the rule is fair.

ALTER TABLE staff ADD COLUMN recruited_by TEXT;
ALTER TABLE staff ADD COLUMN recruited_at INTEGER;
ALTER TABLE staff ADD COLUMN recruited_by_set_by TEXT;

-- Null until the one-time fee has been taken. This is what makes it one-time:
-- it is a fact about the person, not about a task, so it cannot be collected
-- twice by paying them on two tasks.
ALTER TABLE staff ADD COLUMN recruiter_fee_taken_at INTEGER;

-- Whose pay a payment was taken out of, when that is not the payee.
--
-- Without this the ledger would show the artist receiving $28 against $35 owed
-- and conclude they are still owed $7 — when in fact their debt is settled and
-- $7 of it went to their recruiter.
ALTER TABLE payments ADD COLUMN deducted_from_user_id TEXT;

CREATE INDEX idx_payments_deducted_from ON payments (deducted_from_user_id);
CREATE INDEX idx_staff_recruited_by ON staff (guild_id, recruited_by);

-- Configurable, because 20% is the studio's current choice rather than a law.
ALTER TABLE guild_config ADD COLUMN recruiter_fee_bp INTEGER NOT NULL DEFAULT 2000;
