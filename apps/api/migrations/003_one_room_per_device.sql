-- Uma sala por aparelho: remove duplicatas (mantém a mais recente) e cria UNIQUE.
DELETE r
FROM rooms r
INNER JOIN rooms newer
  ON newer.device_id = r.device_id
 AND (
   newer.updated_at > r.updated_at
   OR (newer.updated_at = r.updated_at AND newer.id > r.id)
 );

ALTER TABLE rooms
  DROP INDEX idx_rooms_device,
  ADD UNIQUE KEY uq_rooms_device (device_id);
