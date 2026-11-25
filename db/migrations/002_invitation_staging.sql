CREATE TABLE invitation_draft (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  template TEXT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE staged_invitations (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  draft_id TINYINT UNSIGNED NOT NULL,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  ticket_no VARCHAR(255) NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  active_ticket_no VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status = 'removed' THEN NULL ELSE ticket_no END) STORED,
  name MEDIUMTEXT NOT NULL,
  phone VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  image_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message MEDIUMTEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY staged_invitations_active_ticket (draft_id, active_ticket_no),
  CONSTRAINT staged_invitations_draft_fk FOREIGN KEY (draft_id) REFERENCES invitation_draft (id),
  CONSTRAINT staged_invitations_image_fk FOREIGN KEY (image_id) REFERENCES ticket_images (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO invitation_draft (id) VALUES (1);
