// RFC 4122 v1-5 with the RFC variant. Postgres gen_random_uuid() and
// uuid_generate_v4() emit v4, so every row id passes; anything else is
// rejected before it reaches a query (where it would be a 22P02 → 500).
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
