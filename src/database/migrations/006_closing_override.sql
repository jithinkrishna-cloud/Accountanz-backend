-- Month-end readiness is strict: a period is marked ready only when its checklist is complete, unless an
-- authorised reviewer records why it is ready anyway. The reason stays while the period is ready or closed.
ALTER TABLE period_closings
  ADD COLUMN ready_override VARCHAR(500) NULL AFTER status;
