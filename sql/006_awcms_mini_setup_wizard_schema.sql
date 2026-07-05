CREATE TABLE IF NOT EXISTS awcms_mini_setup_state (
  id boolean PRIMARY KEY DEFAULT true,
  tenant_id uuid REFERENCES awcms_mini_tenants (id),
  locked_at timestamptz,
  CONSTRAINT awcms_mini_setup_state_singleton CHECK (id)
);
