# SquadChat-Android

## Production reference and native parity

The current native Android APK UI was reported as messy. The production web source snapshot has now been imported under `reference-web-app/` on this branch. Do not continue isolated UI patches without first inspecting it.

- **Production app:** https://squadchat-ew2b04.v2.appdeploy.ai/
- **AppDeploy app ID:** `squadchat-ew2b04`
- **Inspected source snapshot:** `1795353881521` (2026-11-23)
- **Imported source folder:** `reference-web-app/` (14 text/source/config/test files)
- **Main application:** `reference-web-app/src/main.ts` (4,850 lines)
- **Design system/styles:** `reference-web-app/src/styles.css` (2,226 lines)
- **Offline queue/cache:** `reference-web-app/src/offline.ts`
- **Backend realtime:** `reference-web-app/backend/realtime.ts`, `reference-web-app/backend/realtime-subscribers.ts`
- **Other imported files:** `reference-web-app/index.html`, `package.json`, `tests/tests.json`, Vite/TypeScript/Tailwind configuration, service worker.
- **Not imported:** `public/resources/squadchat-icon.png` and `squadchat-logo.png` (binary assets were not available through the source export).

Read the complete current AppDeploy source for the app ID above before rebuilding native screens. The AppDeploy deployment is the source of truth; re-read it if the deployed version has changed.

### Required implementation rules

1. Inventory real screens, navigation, visual components, dialogs, feature flows, roles, and error/empty states.
2. Compare the current Compose UI against the production app before coding.
3. Rebuild navigation and UI coherently, retaining the existing dark maroon/gold SquadChat identity.
4. Match actual production behavior for auth, conversations, groups, profiles, photos/albums, reactions, read receipts, deletion, admin controls, suspension, and notifications wherever present in the source.
5. Preserve working native authentication, session persistence, and text chat.
6. Keep Android work on `native-android` or a review branch. Never modify the default branch or production AppDeploy app without explicit approval.
7. Never put a Supabase service-role key in the Android app or broaden Supabase RLS.
8. Test admin and normal-user access, two-device behavior, photo flows, and narrow-screen navigation.
9. Build and verify the APK before delivery; the user must review the UI before release.

Detailed work request: [GitHub issue #2](https://github.com/LIBRA-design/SquadChat-Android/issues/2).
