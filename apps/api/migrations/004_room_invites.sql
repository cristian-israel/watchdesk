SET @viewer_invite = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND COLUMN_NAME = 'viewer_invite') = 0,
    'ALTER TABLE rooms ADD COLUMN viewer_invite VARCHAR(128) NOT NULL DEFAULT \'\'',
    'SELECT 1'
  )
);
PREPARE viewer_invite_stmt FROM @viewer_invite;
EXECUTE viewer_invite_stmt;
DEALLOCATE PREPARE viewer_invite_stmt;

SET @host_invite = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND COLUMN_NAME = 'host_invite') = 0,
    'ALTER TABLE rooms ADD COLUMN host_invite VARCHAR(128) NOT NULL DEFAULT \'\'',
    'SELECT 1'
  )
);
PREPARE host_invite_stmt FROM @host_invite;
EXECUTE host_invite_stmt;
DEALLOCATE PREPARE host_invite_stmt;
