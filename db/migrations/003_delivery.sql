CREATE TABLE outbound_control (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  binding VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  paused TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_send_at DATETIME(3) NULL,
  next_check_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE test_recipients (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE outbound_jobs (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  invitation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  test_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  mode ENUM('simulate', 'live') NOT NULL,
  binding VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ticket_no VARCHAR(255) NOT NULL,
  name MEDIUMTEXT NOT NULL,
  phone VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  image_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message MEDIUMTEXT NOT NULL,
  status ENUM('queued','submitting','submitted','delivered','failed','review','cancelled') NOT NULL,
  active_invitation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (CASE WHEN status = 'cancelled' THEN NULL ELSE invitation_id END) STORED,
  current_ref CHAR(39) CHARACTER SET ascii COLLATE ascii_bin NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  retryable TINYINT UNSIGNED NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  lease_until DATETIME(3) NULL,
  dispatch_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  last_checked_at DATETIME(3) NULL,
  UNIQUE KEY outbound_invitation_mode (active_invitation_id, mode),
  KEY outbound_invitation_id (invitation_id),
  UNIQUE KEY outbound_test_recipient (test_key, phone),
  KEY outbound_ready (binding, status, sequence),
  KEY outbound_run (run_id, status),
  CONSTRAINT outbound_invitation_fk FOREIGN KEY (invitation_id) REFERENCES staged_invitations (id),
  CONSTRAINT outbound_image_fk FOREIGN KEY (image_id) REFERENCES ticket_images (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE outbound_attempts (
  reference CHAR(39) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  provider_alias VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  KEY outbound_provider_id (provider_id),
  KEY outbound_provider_alias (provider_alias),
  CONSTRAINT outbound_attempt_job_fk FOREIGN KEY (job_id) REFERENCES outbound_jobs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO outbound_control (id) VALUES (1);
