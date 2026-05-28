# Emergent Auth Testing Playbook (saved per integration playbook)

This document outlines how to test the Emergent-managed Google Auth integration for the Travel Itinerary Builder app.

## Test User Setup
mongosh --eval "
use('test_database');
var userId = 'test-user-' + Date.now();
var sessionToken = 'test_session_' + Date.now();
db.users.insertOne({
  user_id: userId,
  email: 'test.user.' + Date.now() + '@example.com',
  name: 'Test User',
  picture: 'https://via.placeholder.com/150',
  role: 'admin',
  created_at: new Date()
});
db.user_sessions.insertOne({
  user_id: userId,
  session_token: sessionToken,
  expires_at: new Date(Date.now() + 7*24*60*60*1000),
  created_at: new Date()
});
print('Session token: ' + sessionToken);
print('User ID: ' + userId);
"

## Backend Tests
- GET /api/auth/me with Authorization: Bearer <token>
- GET /api/experiences with cookie session_token
- GET /api/providers with cookie session_token

## Browser tests
- Login button redirects to https://auth.emergentagent.com/?redirect=...
- After auth, app receives session_id in URL fragment and exchanges it via POST /api/auth/session
- /dashboard renders after cookie set
