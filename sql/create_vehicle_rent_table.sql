-- Create vehicle_rent table
CREATE TABLE IF NOT EXISTS `vehicle_rent` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `trip_id` INT(11) NOT NULL,
  `vehicle_id` INT(11) NOT NULL,
  `distance_km` DECIMAL(10, 2) NOT NULL,
  `rent_per_km` DECIMAL(10, 2) NOT NULL DEFAULT 120.00,
  `total_rent` DECIMAL(12, 2) NOT NULL,
  `payment_source` VARCHAR(50) DEFAULT NULL COMMENT 'cash, bank, keep_payable',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_trip_id` (`trip_id`),
  KEY `idx_vehicle_id` (`vehicle_id`),
  CONSTRAINT `fk_vehicle_rent_trip` FOREIGN KEY (`trip_id`) REFERENCES `trips` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_vehicle_rent_vehicle` FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

