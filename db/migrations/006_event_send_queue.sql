ALTER TABLE invitation_events ADD COLUMN draft_template TEXT NULL;

CREATE TABLE event_send_queue (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  event_id INT UNSIGNED NOT NULL UNIQUE,
  binding VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CONSTRAINT event_send_queue_event_fk FOREIGN KEY (event_id) REFERENCES invitation_events (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Retain a batch that was running or paused at the time of the upgrade.
INSERT INTO event_send_queue (run_id, event_id, binding)
SELECT c.run_id, s.event_id, c.binding
FROM outbound_control c
JOIN outbound_jobs j ON j.run_id = c.run_id
JOIN staged_invitations s ON s.id = j.invitation_id
WHERE c.id = 1 AND c.binding IS NOT NULL
ORDER BY j.sequence LIMIT 1;
