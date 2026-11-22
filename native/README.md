# SquadChat Native Android

A separate native Android client built with Kotlin and Jetpack Compose.

## Safety boundary

- The existing AppDeploy-hosted SquadChat app is not modified by this project.
- The existing WebView APK and its source remain on the original branch.
- This native project has its own Android application ID: `com.squadchat.nativeapp`.
- It connects to the existing Supabase project using a public publishable key and the signed-in user's Auth session.
- Do not change the live Supabase schema or production Edge Functions as part of initial client setup.
- Never commit Supabase secret/service-role keys, Firebase Admin SDK credentials, or private signing keys.

## Current stage

Stage 1 adds native Supabase email/password authentication:
- Login and account creation
- Password show/hide
- Email confirmation redirect back into the app
- Supabase-managed session restoration and refresh
- Logout

This is still not a feature-complete messenger. The authenticated screen is a temporary checkpoint before profile and chat implementation.

## Compatibility note

The Supabase Kotlin 3.x SDK requires Android API 26 or newer. The native app therefore uses minSdk 26. This does not change the existing APK's Android compatibility.

## Authentication redirect setup

Add this exact redirect URL to Supabase Dashboard > Authentication > URL Configuration > Redirect URLs:

```
squadchat://auth-callback
```

The native app handles this deep link. Keep email confirmation enabled; do not disable it just to make signup appear successful.

## Planned implementation order

1. Native Supabase authentication and email confirmation.
2. Profile loading and editing.
3. Conversation list and realtime updates.
4. One-to-one messaging, read state, reactions, and deletion.
5. Group conversations and membership controls.
6. Image upload, multi-image sending, and image viewing.
7. FCM token registration and push notification handling.
8. Admin/suspension behavior and full regression testing.

Every feature will be tested in the native app without changing the live AppDeploy app.
