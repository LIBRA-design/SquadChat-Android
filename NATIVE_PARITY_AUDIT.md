# Native Android parity audit

Baseline:
- Production web source snapshot: AppDeploy app `squadchat-ew2b04`, snapshot `1795353881521`
- Reference source: `reference-web-app/` on `appdeploy-source-reference`
- Native baseline: `native-android`, commit `4156946215c0d4c36bf537b92a1fb953762c65d8`
- This review branch is isolated from production and the native baseline.

## Production app behavior confirmed in source

### Session and account access
- Login/signup and password reset flows.
- Fresh login opens the conversation list rather than restoring a previously selected chat.
- Account-status check calls the `admin-api` Edge Function. Explicitly suspended accounts see a lock screen where only logout is available.
- Peer status is checked before enabling a private chat. Suspended/unavailable peers cannot send messages or attachments.
- Presence and last-seen information are displayed.

### Conversation list and navigation
- Conversation list supports search, active selection, unread count, latest activity, online presence, avatar/cover, and private/group distinctions.
- Search friends by username and create private conversations.
- Create group conversations and avoid duplicate membership combinations.
- Long press/context menu supports conversation actions (including delete).
- The app's primary signed-in destination is the conversation list.

### Chat
- Private and group conversations.
- Text messages, photo attachments, multi-photo albums, offline queue/cache and retry/sync behavior.
- Message replies, reaction previews, emoji reactions (👍 ❤️ 😂 😮 😢), own-message deletion, read receipts and unread counts.
- Message links open externally through a safe/native bridge when present.
- Shared conversation appearance/background.
- Shared photos gallery and image viewer with previous/next navigation and download.
- Group settings: view members, change member roles, add members, change group cover, leave group.

### Profile and administration
- View another member's profile, including display name, username, bio, photo/avatar and admin badge.
- Admin dashboard is gated by the server-provided admin role and uses the `admin-api` Edge Function.
- Admin dashboard includes account statistics, user search, status/role filters, user details, suspend/unsuspend actions, permanent account deletion and admin activity history.
- Admin identity and suspension status must never be inferred from local UI state alone.

## Native baseline observed

- `SquadChatApp.kt` currently switches between authentication, conversation list and chat based on session and active conversation ID.
- `ConversationListScreen.kt` loads memberships, conversations, profiles, latest messages, read timestamps and unread messages; supports search and conversation opening.
- `ChatScreen.kt` supports text messages, reactions, read receipts and deleting the current user's messages; it polls while open.
- Native manifest currently includes the auth deep link. The current top-level navigation does not yet expose the complete production feature set.

## Gap list before release

| Area | Production web behavior | Native baseline status |
|---|---|---|
| Auth/session | Login/signup/reset, deep link, list-first login | Partial; auth/session and deep link present |
| Conversation list | Search, unread, presence, latest activity | Partial; list/search/unread; presence parity needs verification |
| Private chat | Text, photos/albums, replies, reactions, read receipts, deletion | Partial; text/reactions/read/deletion present; photos/replies missing |
| Group chat | Create, members, roles, cover, leave, settings | Not yet verified / incomplete |
| Profile | Own profile editing and peer profile view | Missing in reviewed native navigation |
| Shared media | Gallery, viewer, downloads | Missing |
| Shared appearance | Shared background picker | Missing |
| Admin | Server-gated dashboard, suspend/unsuspend/delete, activity | Missing |
| Suspension | Own-account lock and peer chat restrictions | Missing |
| Push/deep links | FCM registration, open target conversation, notification clearing | Must inspect native service and verify end-to-end |

## Implementation guardrails

1. Keep changes on this review branch until the user reviews the APK.
2. Preserve existing authentication, session persistence, list loading, text sending, reactions, read receipts and own-message deletion.
3. Follow the production source's actual behavior; do not invent alternate features.
4. Use only the Supabase anon/public client key in the APK. Keep privileged admin actions behind the existing Edge Function and server authorization.
5. Do not change RLS policies or production AppDeploy.
6. Implement in coherent stages: navigation/design shell; profile and groups; media and appearance; server-gated admin/suspension; notification and regression testing.
7. Build and test after each stage. Do not call a feature complete until it is implemented and verified.
