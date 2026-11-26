ALTER TABLE outbound_jobs
  ADD COLUMN recovery_ref CHAR(39) CHARACTER SET ascii COLLATE ascii_bin NULL;
