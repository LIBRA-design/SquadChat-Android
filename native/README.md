# SquadChat Native Android

This is a separate native Android application project built with Kotlin and Jetpack Compose.

## Safety boundary

- The existing AppDeploy-hosted SquadChat app is not modified by this project.
- The existing WebView APK remains in the original Android project.
- This native project has its own Android application ID: `com.squadchat.nativeapp`.
- Do not change the live Supabase schema or production Edge Functions as part of initial client setup.
- Never commit Supabase service-role keys, Firebase Admin SDK credentials, or private signing keys.

## Current stage

The project currently contains a minimal native Compose shell using the existing dark-maroon and gold visual direction. It is a buildable foundation, not a feature-complete messenger yet.

## Planned implementation order

1. Supabase client configuration and authentication.
2. Profile loading and editing.
3. Conversation list and realtime updates.
4. One-to-one messaging, read state, reactions, and deletion.
5. Group conversations and membership controls.
6. Image upload, multi-image sending, and image viewing.
7. FCM token registration and push notification handling.
8. Admin/suspension behavior and full regression testing.

Every feature will be tested in the native app without changing the live AppDeploy app.
