CREATE TABLE IF NOT EXISTS recent_rooms (
  device_id CHAR(64) NOT NULL,
  room_slug VARCHAR(40) NOT NULL,
  room_label VARCHAR(80) NOT NULL DEFAULT '',
  viewer_invite VARCHAR(128) NOT NULL DEFAULT '',
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (device_id, room_slug),
  KEY idx_recent_device_seen (device_id, last_seen_at),
  CONSTRAINT fk_recent_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id BIGINT UNSIGNED NOT NULL,
  host_device_id CHAR(64) NULL,
  target_peer_id VARCHAR(32) NOT NULL,
  target_display_name VARCHAR(80) NOT NULL DEFAULT '',
  mode ENUM('view', 'interact') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_control_audit_room_created (room_id, created_at),
  CONSTRAINT fk_control_audit_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
