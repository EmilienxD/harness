-- Existing deployments keep the same private bucket, credentials and asset lifecycle.
update storage.buckets
set file_size_limit = 20971520,
    allowed_mime_types = array[
      'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml',
      'video/mp4', 'video/webm'
    ]
where id = 'grill-assets';
