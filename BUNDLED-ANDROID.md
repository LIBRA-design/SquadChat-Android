# Bundled SquadChat Android build

This branch packages the original SquadChat Vite application inside the Android APK.

## Runtime architecture

- Android opens `https://appassets.androidplatform.net/assets/index.html` through AndroidX WebViewAssetLoader.
- The `web/` directory contains the original SquadChat Vite/TypeScript/CSS application source copied from the AppDeploy source snapshot.
- Gradle installs the web dependencies, runs the Vite production build, and copies `web/dist/` into `app/src/main/assets/` before Android packaging.
- Supabase remains the online backend for Auth, Postgres, Realtime, Storage, and the existing `admin-api` Edge Function.
- The existing Android photo gallery, JavaScript bridge, and Firebase Messaging integration are retained.
- The APK does not load its interface from the AppDeploy website. AppDeploy is not needed at runtime.

## Build

Requirements: JDK 17, Android SDK, Gradle 8.9, and Node.js 22 with npm.

From the repository root:

```bash
gradle --no-daemon -PsquadChatVersionCode=1 assembleDebug
```

Gradle runs `npm install` and `npm run build` in `web/`, then packages the output into the APK.

GitHub Actions runs the same build on pushes to `main` and `feature/bundled-squadchat-source`.

## Important scope

This is the fast source-reuse route: the existing web UI runs locally inside the Android application shell. It is independent of the AppDeploy-hosted website, but it is not a full Kotlin rewrite of every screen. Supabase still requires an internet connection for live accounts, messaging, and synchronization.
