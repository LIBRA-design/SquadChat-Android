# SquadChat-Android

## Production reference and native parity

The current native Android APK UI was reported as messy. Do not continue isolated UI patches without first inspecting the real production web app.

- **Production app:** https://squadchat-ew2b04.v2.appdeploy.ai/
- **AppDeploy app ID:** `squadchat-ew2b04`
- **Inspected source snapshot:** `1795353881521` (2026-11-23)
- **Main application:** `src/main.ts` (4,850 lines)
- **Design system/styles:** `src/styles.css` (2,226 lines)
- **Offline queue/cache:** `src/offline.ts`
- **Backend realtime:** `backend/realtime.ts`, `backend/realtime-subscribers.ts`
- **Other project files:** `index.html`, `package.json`, `tests/tests.json`, Vite/TypeScript/Tailwind configuration.

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
