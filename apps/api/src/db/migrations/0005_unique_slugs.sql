-- Rename duplicate slug before adding global unique constraint
UPDATE endpoints SET slug = 'nano-2' WHERE id = '88957183aeb4446b94de47f79a92287b';
-- Slugs must be globally unique for wildcard subdomain routing
CREATE UNIQUE INDEX idx_endpoints_slug_unique ON endpoints(slug);
