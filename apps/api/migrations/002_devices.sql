CREATE TABLE IF NOT EXISTS devices (
  id CHAR(64) NOT NULL PRIMARY KEY,
  display_name VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @rooms_device = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND COLUMN_NAME = 'device_id') = 0,
    'ALTER TABLE rooms ADD COLUMN device_id CHAR(64) NULL, ADD UNIQUE KEY uq_rooms_device (device_id), ADD CONSTRAINT fk_rooms_device FOREIGN KEY (device_id) REFERENCES devices (id)',
    'SELECT 1'
  )
);
PREPARE rooms_device_stmt FROM @rooms_device;
EXECUTE rooms_device_stmt;
DEALLOCATE PREPARE rooms_device_stmt;

SET @sessions_device = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'device_id') = 0,
    'ALTER TABLE sessions ADD COLUMN device_id CHAR(64) NULL, ADD KEY idx_sessions_device (device_id), ADD CONSTRAINT fk_sessions_device FOREIGN KEY (device_id) REFERENCES devices (id)',
    'SELECT 1'
  )
);
PREPARE sessions_device_stmt FROM @sessions_device;
EXECUTE sessions_device_stmt;
DEALLOCATE PREPARE sessions_device_stmt;
