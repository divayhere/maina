-- Android's UTF-8 text upload includes the charset in Content-Type. Supabase
-- Storage compares the full value against the bucket allow-list.
update storage.buckets
set allowed_mime_types = array[
  'audio/ogg',
  'audio/mp4',
  'text/plain',
  'text/plain; charset=utf-8'
]::text[]
where id = 'maina-diagnostics';
