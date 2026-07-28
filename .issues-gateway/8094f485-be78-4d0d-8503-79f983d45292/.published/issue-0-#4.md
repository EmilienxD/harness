# Add user authentication middleware

> difficulty:medium, mode:afk

## What to build

Implement JWT-based authentication middleware that protects API routes. The middleware validates incoming tokens, handles authentication errors gracefully, and enriches request context with authenticated user information for downstream handlers.

The middleware should:
- Extract and validate JWT tokens from Authorization headers
- Verify token signatures and expiration
- Return appropriate HTTP status codes for auth failures (401 for missing/invalid tokens, 403 for expired tokens)
- Attach decoded user data to the request context for authenticated requests

## Acceptance criteria

- [ ] Middleware validates JWT tokens from Authorization header (Bearer scheme)
- [ ] Invalid or missing tokens return 401 with clear error messages
- [ ] Expired tokens return 403 with expiration details
- [ ] Valid tokens enrich request context with user ID and claims
- [ ] Middleware can be composed with route handlers in the API layer
- [ ] Unit tests cover happy path and all error cases

## Blocked by

None - can start immediately
