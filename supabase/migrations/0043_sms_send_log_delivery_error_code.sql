-- 0043 — keep the carrier's REASON, not just its verdict.
--
-- STATUS: DRAFT. Not applied by the agent that wrote it; the Operator applies migrations.
-- lib/sms/delivery-status.ts writes this column, so this migration must land BEFORE that code.
--
-- WHAT WAS BEING THROWN AWAY. Twilio's status callback carries `ErrorCode` alongside a `failed` or
-- `undelivered` `MessageStatus`, and lib/sms/delivery-status.ts has parsed it since it was written
-- (`DeliveryStatusReport.errorCode`) — then dropped it on the floor, because the UPDATE only ever
-- wrote `delivery_status`. So `sms_send_log` could say a message did not arrive and could not say
-- why, for any message, ever. The two questions that answer differ completely in what they ask of
-- us and are indistinguishable without this column:
--
--   30003  unreachable handset — phone off, out of coverage. Nothing to do; it may work tomorrow.
--   30006  landline or unreachable carrier — the number will NEVER receive an SMS. A signup that
--          collects it is collecting a number we can never text.
--   30007  carrier filtered — the carrier judged the message spam. That is about OUR sender
--          reputation and OUR message content, and it is the one that gets a shortcode shut down.
--   21610  the recipient has opted out at the carrier (PRD §2.2 step 6 already treats this code
--          specially at SEND time; until now the callback path could not see it at all).
--
-- WHY A COLUMN AND NOT A LOG LINE. Application logs are retained for days; this table is the CASL
-- audit trail and is retained indefinitely (0035). "Why did this number stop receiving our texts"
-- is asked months later, by which time the log line that knew the answer is gone.
--
-- integer, NULLABLE, NO DEFAULT. Twilio's codes are 5-digit integers, and the column is absent —
-- not zero — on every successful delivery, which is most rows. A `0` default would be a real
-- Twilio-shaped value standing in for "no error", and `parseDeliveryStatus` already maps an
-- `ErrorCode` of `0` to null for exactly that reason.
--
-- NOT INDEXED, deliberately. The query this serves is "group the failures of the last N days by
-- code" — an aggregate over a table that holds one row per text sent, scanned in full either way.
-- An index here would be added on a guess; add it if a real plan asks for it.
--
-- APPEND-ONLY, WITH THE SAME ONE EXCEPTION AS `delivery_status`. This column is written by the
-- same statement, under the same monotonic guard: it is set only when the status it arrived with
-- actually advances the row, so the code on a row always describes the status on that row rather
-- than some earlier verdict the code never belonged to.

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE sms_send_log
  ADD COLUMN IF NOT EXISTS delivery_error_code integer;

COMMENT ON COLUMN sms_send_log.delivery_error_code IS
  'Twilio''s numeric ErrorCode from the delivery-status callback, e.g. 30003 (unreachable), '
  '30006 (landline — will never receive SMS), 30007 (carrier filtered), 21610 (opted out at the '
  'carrier). NULL on every successful delivery and on any row whose callback carried no code. '
  'Written only by the statement that advances delivery_status, so the two always describe the '
  'same carrier verdict.';

-- ── rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE sms_send_log DROP COLUMN IF EXISTS delivery_error_code;
