-- Work in progress: not records, not chained, never read as a page. See docs/adr/0009.
CREATE TABLE page_drafts (
  address text PRIMARY KEY CHECK (address ~ '^/\S*$'),
  session text NOT NULL,
  base_version_id uuid REFERENCES page_versions(id),
  content jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_drafts_session ON page_drafts (session);

CREATE FUNCTION announce_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d page_drafts;
BEGIN
  IF TG_OP = 'DELETE' THEN d := OLD; ELSE d := NEW; END IF;
  PERFORM pg_notify('ganjine_events', json_build_object(
    'id', d.address, 'kind', 'page_draft', 'address', d.address,
    'tags', json_build_array('session:' || left(d.session, 190)))::text);
  RETURN NULL;
END $$;

CREATE TRIGGER page_drafts_announce AFTER INSERT OR UPDATE OR DELETE ON page_drafts
  FOR EACH ROW EXECUTE FUNCTION announce_draft();
