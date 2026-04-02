ALTER TABLE recurrence_rules ADD COLUMN day_of_month INTEGER;

ALTER TABLE recurrence_rules ADD COLUMN generation_policy TEXT NOT NULL DEFAULT 'calendar';
