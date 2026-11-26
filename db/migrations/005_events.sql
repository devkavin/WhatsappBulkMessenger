CREATE TABLE invitation_events (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  archived_at DATETIME(3) NULL,
  archived_mode ENUM('simulate','live') NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO invitation_events (id, name, created_at) VALUES (1, 'Dinner Dance', UTC_TIMESTAMP(3));

ALTER TABLE invitation_draft
  ADD COLUMN event_id INT UNSIGNED NOT NULL DEFAULT 1,
  ADD CONSTRAINT invitation_draft_event_fk FOREIGN KEY (event_id) REFERENCES invitation_events (id);

ALTER TABLE draft_csv
  ADD COLUMN event_id INT UNSIGNED NOT NULL DEFAULT 1,
  DROP PRIMARY KEY,
  DROP COLUMN id,
  ADD PRIMARY KEY (event_id),
  ADD CONSTRAINT draft_csv_event_fk FOREIGN KEY (event_id) REFERENCES invitation_events (id);

ALTER TABLE draft_images
  ADD COLUMN event_id INT UNSIGNED NOT NULL DEFAULT 1,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (event_id, filename),
  ADD CONSTRAINT draft_images_event_fk FOREIGN KEY (event_id) REFERENCES invitation_events (id);

ALTER TABLE staged_invitations DROP FOREIGN KEY staged_invitations_draft_fk;

ALTER TABLE staged_invitations
  ADD COLUMN event_id INT UNSIGNED NOT NULL DEFAULT 1,
  DROP INDEX staged_invitations_active_ticket,
  DROP COLUMN draft_id,
  ADD UNIQUE KEY staged_invitations_event_ticket (event_id, active_ticket_no),
  ADD CONSTRAINT staged_invitations_event_fk FOREIGN KEY (event_id) REFERENCES invitation_events (id);

-- The default above backfills existing rows. New writes supply an event ID.
ALTER TABLE draft_csv MODIFY COLUMN event_id INT UNSIGNED NOT NULL;
ALTER TABLE draft_images MODIFY COLUMN event_id INT UNSIGNED NOT NULL;
ALTER TABLE staged_invitations MODIFY COLUMN event_id INT UNSIGNED NOT NULL;
