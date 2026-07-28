# Create user profile API endpoints

> difficulty:low, mode:hitl

## What to build

Build REST API endpoints for user profile management. Users should be able to retrieve their own profile, update their information, and delete their account. All endpoints require authentication and should validate input data.

Endpoints:
- GET /api/profile - retrieve authenticated user's profile
- PUT /api/profile - update profile fields (email, display name, bio)
- DELETE /api/profile - soft-delete user account

Input validation should reject malformed emails, overly long fields, and missing required data. Responses should follow consistent JSON structure with appropriate status codes.

## Acceptance criteria

- [ ] GET /api/profile returns authenticated user's data (200) or 401 if unauthenticated
- [ ] PUT /api/profile validates input and updates allowed fields, returns updated profile
- [ ] PUT rejects invalid emails, display names >100 chars, bios >500 chars with 400 errors
- [ ] DELETE /api/profile marks account as deleted and returns 204
- [ ] All endpoints require valid authentication (use the middleware)
- [ ] Integration tests cover all three endpoints with valid and invalid inputs

## Blocked by

- `{8094f485-be78-4d0d-8503-79f983d45292/0}`
