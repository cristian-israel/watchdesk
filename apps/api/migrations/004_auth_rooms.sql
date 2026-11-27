-- Contas, ownership por usuário, TTL, slots e designação de controlador.

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  login VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_login (login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(64) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_auth_sessions_user (user_id),
  KEY idx_auth_sessions_expires (expires_at),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Salas antigas sem dono: encerra e libera o UNIQUE por device.
UPDATE rooms SET active = 0 WHERE 1=1;

ALTER TABLE rooms
  DROP INDEX uq_rooms_device,
  ADD KEY idx_rooms_device (device_id);

ALTER TABLE rooms
  ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER device_id,
  ADD COLUMN status ENUM('active', 'expired', 'ended') NOT NULL DEFAULT 'ended' AFTER active,
  ADD COLUMN expires_at DATETIME(3) NULL AFTER status,
  ADD COLUMN controller_password_hash CHAR(64) NULL AFTER expires_at,
  ADD COLUMN designated_device_id CHAR(64) NULL AFTER controller_password_hash,
  ADD COLUMN designated_display_name VARCHAR(80) NULL AFTER designated_device_id,
  ADD KEY idx_rooms_user_status (user_id, status),
  ADD KEY idx_rooms_expires (expires_at),
  ADD CONSTRAINT fk_rooms_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;

UPDATE rooms SET status = IF(active = 1, 'ended', 'ended'), expires_at = UTC_TIMESTAMP(3);

ALTER TABLE rooms
  MODIFY COLUMN join_mode ENUM('open', 'ask') NOT NULL DEFAULT 'open',
  MODIFY COLUMN voice_enabled TINYINT(1) NOT NULL DEFAULT 1,
  MODIFY COLUMN max_viewers TINYINT UNSIGNED NOT NULL DEFAULT 9;
