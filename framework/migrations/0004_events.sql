CREATE FUNCTION announce_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('ganjine_events', json_build_object(
    'id', NEW.id, 'kind', NEW.kind, 'address', NEW.payload->>'address',
    'tags', (SELECT coalesce(json_agg(t), '[]'::json) FROM unnest(NEW.tags) AS t WHERE length(t) < 200))::text);
  RETURN NULL;
END $$;

CREATE TRIGGER records_announce AFTER INSERT ON records
  FOR EACH ROW EXECUTE FUNCTION announce_record();
