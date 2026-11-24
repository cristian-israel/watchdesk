-- Instalação limpa do schema Watchdesk (salas por link, sem chaves).
-- Recrie o banco se veio de migrations anteriores.

CREATE TABLE IF NOT EXISTS devices (
  id CHAR(64) NOT NULL PRIMARY KEY,
  display_name VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rooms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(40) NOT NULL,
  device_id CHAR(64) NOT NULL,
  creator_name VARCHAR(80) NOT NULL,
  join_mode ENUM('open', 'ask') NOT NULL DEFAULT 'ask',
  max_viewers TINYINT UNSIGNED NOT NULL DEFAULT 8,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_rooms_slug (slug),
  KEY idx_rooms_device (device_id),
  CONSTRAINT fk_rooms_device FOREIGN KEY (device_id) REFERENCES devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(64) NOT NULL PRIMARY KEY,
  room_id BIGINT UNSIGNED NOT NULL,
  role ENUM('host', 'viewer') NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  device_id CHAR(64) NULL,
  KEY idx_sessions_room_role (room_id, role),
  KEY idx_sessions_expires (expires_at),
  KEY idx_sessions_device (device_id),
  CONSTRAINT fk_sessions_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_device FOREIGN KEY (device_id) REFERENCES devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id BIGINT UNSIGNED NOT NULL,
  author_name VARCHAR(80) NOT NULL,
  role ENUM('host', 'viewer') NOT NULL,
  body VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  device_id CHAR(64) NULL,
  KEY idx_chat_room_created (room_id, created_at),
  KEY idx_chat_device (device_id),
  CONSTRAINT fk_chat_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recent_rooms (
  device_id CHAR(64) NOT NULL,
  room_slug VARCHAR(40) NOT NULL,
  room_label VARCHAR(80) NOT NULL DEFAULT '',
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (device_id, room_slug),
  KEY idx_recent_device_seen (device_id, last_seen_at),
  CONSTRAINT fk_recent_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
