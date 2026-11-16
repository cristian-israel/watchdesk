SET @chat_device = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'device_id') = 0,
    'ALTER TABLE chat_messages ADD COLUMN device_id CHAR(64) NULL, ADD KEY idx_chat_device (device_id)',
    'SELECT 1'
  )
);
PREPARE chat_device_stmt FROM @chat_device;
EXECUTE chat_device_stmt;
DEALLOCATE PREPARE chat_device_stmt;
