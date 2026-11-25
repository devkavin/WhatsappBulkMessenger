ALTER TABLE outbound_attempts
  ADD COLUMN provider_status ENUM('accepted','queued','sent','failed','delivered') NULL,
  ADD COLUMN provider_status_source ENUM('submission','lookup','webhook') NULL,
  ADD COLUMN provider_webhook_event ENUM('message:out:ack','message:out:new','message:out:failed') NULL,
  ADD COLUMN provider_webhook_at DATETIME(3) NULL;
