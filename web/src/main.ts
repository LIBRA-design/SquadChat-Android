import './styles.css';

// Keep signup confirmation links from creating a browser login session.
const isSignupConfirmationCallback = new URLSearchParams(window.location.hash.slice(1)).get('type') === 'signup';
import {
  createClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { addOfflineQueueItem, getOfflineChatList, getOfflineMessages, getOfflinePhoto, getOfflineQueue, hasPendingPhotoAlbum, rememberPhotoAlbum, removeDuplicateQueuedPhotoAlbums, removeOfflineQueueItem, saveOfflineChatList, saveOfflineMessages, saveOfflinePhoto, upsertOfflineMessage } from './offline';

const SQL_SETUP = `-- SquadChat database setup. Run once in Supabase SQL Editor.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  display_name text check (char_length(coalesce(display_name, '')) <= 40),
  bio text check (char_length(coalesce(bio, '')) <= 160),
  avatar_seed text,
  profile_photo_url text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists avatar_seed text;
alter table public.profiles add column if not exists profile_photo_url text;
alter table public.profiles add column if not exists last_seen_at timestamptz;
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  is_group boolean not null default false,
  group_cover_url text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.conversations add column if not exists group_cover_url text;

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  role text not null default 'member' check (role in ('admin','member')),
  primary key (conversation_id, user_id)
);
alter table public.conversation_members add column if not exists role text not null default 'member' check (role in ('admin','member'));
update public.conversation_members cm set role = 'admin' from public.conversations c where c.id = cm.conversation_id and c.created_by = cm.user_id and cm.role <> 'admin';
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id),
  content text not null check (char_length(trim(content)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_chat_time_idx on public.messages (conversation_id, created_at);

-- Group tables must be created after messages because group_pins references messages(id).
create table if not exists public.group_pins (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  pinned_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(conversation_id, message_id)
);
create table if not exists public.group_preferences (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  muted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- The latest time each member read a conversation. Used for unread counts and read receipts.
create table if not exists public.conversation_reads (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_reads_user_idx on public.conversation_reads (user_id, conversation_id);

-- Emoji reactions on messages.
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (emoji in ('👍','❤️','😂','😮','😢')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists message_reactions_chat_idx on public.message_reactions (conversation_id, message_id);

-- Per-user alerts created automatically when another member sends a message.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  title text not null,
  body text not null default '',
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_created_idx on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_recipient_unread_idx on public.notifications (recipient_id, is_read, created_at desc);

-- Photo attachments. The bucket is public so recipients can load image URLs on any device;
-- uploads are restricted to signed-in members of the conversation.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('squadchat-images', 'squadchat-images', true, 5242880, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;


create or replace function public.is_chat_member(chat_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = chat_id and cm.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_chat_member(uuid) from public;
grant execute on function public.is_chat_member(uuid) to authenticated;

create or replace function public.is_group_admin(chat_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $ select exists (select 1 from public.conversation_members cm where cm.conversation_id = chat_id and cm.user_id = (select auth.uid()) and cm.role = 'admin'); $;
revoke all on function public.is_group_admin(uuid) from public;
grant execute on function public.is_group_admin(uuid) to authenticated;

create or replace function public.is_chat_creator(chat_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = chat_id and c.created_by = (select auth.uid())
  );
$$;
revoke all on function public.is_chat_creator(uuid) from public;
grant execute on function public.is_chat_creator(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_reads enable row level security;
alter table public.message_reactions enable row level security;
alter table public.notifications enable row level security;
alter table public.group_pins enable row level security;
alter table public.group_preferences enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.conversations from anon, authenticated;
revoke all on table public.conversation_members from anon, authenticated;
revoke all on table public.messages from anon, authenticated;
revoke all on table public.conversation_reads from anon, authenticated;
revoke all on table public.message_reactions from anon, authenticated;
revoke all on table public.notifications from anon, authenticated;
revoke all on table public.group_pins from anon, authenticated;
revoke all on table public.group_preferences from anon, authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.conversations to authenticated;
grant select, insert, delete on public.conversation_members to authenticated;
grant select, insert, delete on public.messages to authenticated;
grant select, insert, update on public.conversation_reads to authenticated;
grant select, insert, delete on public.message_reactions to authenticated;
grant select, update on public.notifications to authenticated;
grant select, insert, delete on public.group_pins to authenticated;
grant select, insert, update on public.group_preferences to authenticated;

drop policy if exists "Signed-in users can view profiles" on public.profiles;
create policy "Signed-in users can view profiles" on public.profiles for select to authenticated using ((select auth.uid()) is not null);
drop policy if exists "Users create own profile" on public.profiles;
create policy "Users create own profile" on public.profiles for insert to authenticated with check (id = (select auth.uid()));
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "Members read conversations" on public.conversations;
create policy "Members read conversations" on public.conversations for select to authenticated using (public.is_chat_member(id));
drop policy if exists "Users create conversations" on public.conversations;
create policy "Users create conversations" on public.conversations for insert to authenticated with check (created_by = (select auth.uid()));
drop policy if exists "Members update group cover" on public.conversations;
drop policy if exists "Group admins update group details" on public.conversations;
create policy "Group admins update group details" on public.conversations for update to authenticated using (is_group and public.is_group_admin(id)) with check (is_group and public.is_group_admin(id));

drop policy if exists "Members read membership" on public.conversation_members;
create policy "Members read membership" on public.conversation_members for select to authenticated using (public.is_chat_member(conversation_id));
drop policy if exists "Creator adds initial members" on public.conversation_members;
drop policy if exists "Members add group members" on public.conversation_members;
create policy "Group admins add members" on public.conversation_members for insert to authenticated with check (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.is_group)
  and (
    public.is_group_admin(conversation_id)
    or (public.is_chat_member(conversation_id) and exists (select 1 from public.conversations c where c.id = conversation_id and c.created_by = (select auth.uid())))
  )
);
drop policy if exists "Members leave or remove group members" on public.conversation_members;
create policy "Members leave or admins remove members" on public.conversation_members for delete to authenticated using (public.is_chat_member(conversation_id) and (user_id = (select auth.uid()) or public.is_group_admin(conversation_id)));
drop policy if exists "Members update own group role" on public.conversation_members;
create policy "Group admins manage group roles" on public.conversation_members for update to authenticated using (public.is_group_admin(conversation_id)) with check (public.is_group_admin(conversation_id));

drop policy if exists "Members read messages" on public.messages;
create policy "Members read messages" on public.messages for select to authenticated using (public.is_chat_member(conversation_id));
drop policy if exists "Members send own messages" on public.messages;
create policy "Members send own messages" on public.messages for insert to authenticated with check (sender_id = (select auth.uid()) and public.is_chat_member(conversation_id));
drop policy if exists "Users delete own messages" on public.messages;
create policy "Users delete own messages" on public.messages for delete to authenticated using (sender_id = (select auth.uid()) and public.is_chat_member(conversation_id));
alter table public.messages replica identity full;

drop policy if exists "Members read conversation receipts" on public.conversation_reads;
create policy "Members read conversation receipts" on public.conversation_reads for select to authenticated using (public.is_chat_member(conversation_id));
drop policy if exists "Users create own conversation receipt" on public.conversation_reads;
create policy "Users create own conversation receipt" on public.conversation_reads for insert to authenticated with check (user_id = (select auth.uid()) and public.is_chat_member(conversation_id));
drop policy if exists "Users update own conversation receipt" on public.conversation_reads;
create policy "Users update own conversation receipt" on public.conversation_reads for update to authenticated using (user_id = (select auth.uid()) and public.is_chat_member(conversation_id)) with check (user_id = (select auth.uid()) and public.is_chat_member(conversation_id));

drop policy if exists "Members read message reactions" on public.message_reactions;
create policy "Members read message reactions" on public.message_reactions for select to authenticated using (public.is_chat_member(conversation_id));
drop policy if exists "Members add own message reactions" on public.message_reactions;
create policy "Members add own message reactions" on public.message_reactions for insert to authenticated with check (user_id = (select auth.uid()) and public.is_chat_member(conversation_id) and exists (select 1 from public.messages m where m.id = public.message_reactions.message_id and m.conversation_id = public.message_reactions.conversation_id));
drop policy if exists "Users remove own message reactions" on public.message_reactions;
create policy "Users remove own message reactions" on public.message_reactions for delete to authenticated using (user_id = (select auth.uid()) and public.is_chat_member(conversation_id));

drop policy if exists "Members read group pins" on public.group_pins;
create policy "Members read group pins" on public.group_pins for select to authenticated using (public.is_chat_member(conversation_id));
drop policy if exists "Admins pin group messages" on public.group_pins;
create policy "Admins pin group messages" on public.group_pins for insert to authenticated with check (public.is_group_admin(conversation_id) and exists (select 1 from public.messages m where m.id = message_id and m.conversation_id = group_pins.conversation_id));
drop policy if exists "Admins unpin group messages" on public.group_pins;
create policy "Admins unpin group messages" on public.group_pins for delete to authenticated using (public.is_group_admin(conversation_id));
drop policy if exists "Members read own group preferences" on public.group_preferences;
create policy "Members read own group preferences" on public.group_preferences for select to authenticated using (user_id = (select auth.uid()) and public.is_chat_member(conversation_id));
drop policy if exists "Members manage own group preferences" on public.group_preferences;
create policy "Members manage own group preferences" on public.group_preferences for all to authenticated using (user_id = (select auth.uid()) and public.is_chat_member(conversation_id)) with check (user_id = (select auth.uid()) and public.is_chat_member(conversation_id));

drop policy if exists "Users read their own notifications" on public.notifications;
create policy "Users read their own notifications" on public.notifications for select to authenticated using (recipient_id = (select auth.uid()));
drop policy if exists "Users update their own notifications" on public.notifications;
create policy "Users update their own notifications" on public.notifications for update to authenticated using (recipient_id = (select auth.uid())) with check (recipient_id = (select auth.uid()));

grant insert, select on storage.objects to authenticated;
drop policy if exists "Chat members upload SquadChat photos" on storage.objects;
create policy "Chat members upload SquadChat photos" on storage.objects for insert to authenticated with check (bucket_id = 'squadchat-images' and public.is_chat_member((storage.foldername(name))[1]::uuid));
drop policy if exists "Chat members view SquadChat photos" on storage.objects;
create policy "Chat members view SquadChat photos" on storage.objects for select to authenticated using (bucket_id = 'squadchat-images' and public.is_chat_member((storage.foldername(name))[1]::uuid));
drop policy if exists "Users upload own profile photos" on storage.objects;
create policy "Users upload own profile photos" on storage.objects for insert to authenticated with check (bucket_id = 'squadchat-images' and (storage.foldername(name))[1] = (select auth.uid())::text and (storage.foldername(name))[2] = 'profile');

create or replace function public.create_message_notifications()
returns trigger language plpgsql security definer set search_path = ''
as $squad$
begin
  insert into public.notifications
    (recipient_id, actor_id, conversation_id, message_id, title, body)
  select
    cm.user_id,
    new.sender_id,
    new.conversation_id,
    new.id,
    'New message from ' || coalesce(nullif(p.display_name, ''), p.username, 'Someone'),
    case when new.content like 'IMGSET:%' then 'Sent multiple photos' when new.content like 'IMG:%' then 'Sent a photo' else left(new.content, 160) end
  from public.conversation_members cm
  left join public.profiles p on p.id = new.sender_id
  left join public.profiles recipient on recipient.id = cm.user_id
  where cm.conversation_id = new.conversation_id
    and cm.user_id <> new.sender_id
    and (not exists (select 1 from public.group_preferences gp where gp.conversation_id = new.conversation_id and gp.user_id = cm.user_id and gp.muted)
      or position('@' || lower(recipient.username) in lower(new.content)) > 0);
  return new;
end;
$squad$;
revoke all on function public.create_message_notifications() from public, anon, authenticated;
drop trigger if exists on_message_create_notifications on public.messages;
create trigger on_message_create_notifications after insert on public.messages
for each row execute function public.create_message_notifications();

create or replace function public.create_chat_profile()
returns trigger language plpgsql security definer set search_path = ''
as $squad$
declare chosen_username text;
begin
  chosen_username := new.raw_user_meta_data ->> 'username';
  if chosen_username is null or chosen_username !~ '^[A-Za-z0-9_]{3,20}$' then
    chosen_username := 'user_' || replace(new.id::text, '-', '');
  end if;
  insert into public.profiles (id, username) values (new.id, chosen_username);
  return new;
end;
$squad$;
drop trigger if exists on_auth_user_created_chat_profile on auth.users;
create trigger on_auth_user_created_chat_profile after insert on auth.users for each row execute function public.create_chat_profile();

do $squad$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions'
  ) then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_appearance'
  ) then
    alter publication supabase_realtime add table public.conversation_appearance;
  end if;
end $squad$;

create table if not exists public.conversation_appearance (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  background_kind text not null default 'default'
    check (background_kind in ('default', 'solid', 'gradient', 'image')),
  background_value text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.conversation_appearance enable row level security;
revoke all on table public.conversation_appearance from anon, authenticated;
grant select, insert, update on public.conversation_appearance to authenticated;
drop policy if exists "Conversation members read shared appearance" on public.conversation_appearance;
create policy "Conversation members read shared appearance"
  on public.conversation_appearance for select to authenticated
  using (public.is_chat_member(conversation_id));
drop policy if exists "Conversation members create shared appearance" on public.conversation_appearance;
create policy "Conversation members create shared appearance"
  on public.conversation_appearance for insert to authenticated
  with check (public.is_chat_member(conversation_id) and updated_by = (select auth.uid()));
drop policy if exists "Conversation members update shared appearance" on public.conversation_appearance;
create policy "Conversation members update shared appearance"
  on public.conversation_appearance for update to authenticated
  using (public.is_chat_member(conversation_id))
  with check (public.is_chat_member(conversation_id) and updated_by = (select auth.uid()));
`;

type Chat = {
  id: string;
  title: string | null;
  is_group: boolean;
  created_at: string;
  group_cover_url?: string | null;
  last_message?: string;
  last_message_sender_id?: string;
  last_message_id?: string;
  last_activity?: string;
  last_activity_actor_id?: string;
  unread_count?: number;
  avatar_seed?: string | null;
  avatar_url?: string | null;
  peer_id?: string | null;
  peer_is_admin?: boolean;
  peer_is_suspended?: boolean;
  peer_is_unavailable?: boolean;
};
let currentUserRole: 'user' | 'admin' = 'user';
let offlineQueueSyncBusy = false;
const offlinePhotoPreviewUrls = new Map<string, string[]>();
let suspendedLockActive = false;
let accountStatusTimer: ReturnType<typeof setInterval> | null = null;
type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
};
type MessageReaction = {
  message_id: string;
  conversation_id: string;
  user_id: string;
  emoji: string;
};
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢'];
const REACTION_PREVIEW_PREFIX = '[[SQUADCHAT_REACTION_PREVIEW_V1]]';
const REPLY_MARKER = '[[SQUADCHAT_REPLY_V1]]';
type ReplyPreview = { id: string; sender_id: string; content: string };
let pendingReply: ReplyPreview | null = null;
function decodeReplyContent(raw: string): { reply: ReplyPreview | null; text: string } {
  if (!raw.startsWith(REPLY_MARKER)) return { reply: null, text: raw };
  const end = raw.indexOf('\n');
  if (end < 0) return { reply: null, text: raw };
  try {
    const reply = JSON.parse(raw.slice(REPLY_MARKER.length, end)) as ReplyPreview;
    if (!reply || typeof reply.id !== 'string' || typeof reply.sender_id !== 'string' || typeof reply.content !== 'string') return { reply: null, text: raw };
    return { reply, text: raw.slice(end + 1) };
  } catch { return { reply: null, text: raw }; }
}
function setPendingReply(message: Message) {
  const decoded = decodeReplyContent(message.content);
  pendingReply = { id: message.id, sender_id: message.sender_id, content: decoded.text };
  el<HTMLTextAreaElement>('messageInput').focus();
}
function clearPendingReply() {
  pendingReply = null;
}
let supabase: SupabaseClient | null = null;
let currentUser: User | null = null;
let latestAndroidFcmToken: string | null = null;

declare global {
  interface Window {
    SquadChatNative?: { requestFcmToken: () => void; clearConversationNotifications?: (conversationId: string) => void };
    onSquadChatFcmToken?: (token: string) => void;
    onSquadChatNotificationOpen?: (conversationId: string) => void;
  }
}

async function registerAndroidPushToken() {
  if (!currentUser || !supabase || !latestAndroidFcmToken) return;
  const { error } = await supabase.functions.invoke('register-push-token', {
    body: { action: 'register', fcm_token: latestAndroidFcmToken },
  });
  if (error) console.warn('SquadChat push-token registration failed:', error.message);
}

function requestAndroidPushToken() {
  if (window.SquadChatNative?.requestFcmToken) {
    window.SquadChatNative.requestFcmToken();
  }
}

async function unregisterAndroidPushToken() {
  if (!currentUser || !supabase || !latestAndroidFcmToken) return;
  const { error } = await supabase.functions.invoke('register-push-token', {
    body: { action: 'unregister', fcm_token: latestAndroidFcmToken },
  });
  if (error) console.warn('SquadChat push-token removal failed:', error.message);
}

window.onSquadChatFcmToken = (token: string) => {
  latestAndroidFcmToken = token;
  void registerAndroidPushToken();
};

let pendingNotificationConversationId: string | null = null;
window.onSquadChatNotificationOpen = (conversationId: string) => {
  if (!conversationId) return;
  pendingNotificationConversationId = conversationId;
  void openPendingNotificationChat();
};
let currentChat: Chat | null = null;
let chats: Chat[] = [];
let chatListLoading = false;
let channel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;
let chatOpenSequence = 0;
let directMessageInProgress = false;
let openingChatId: string | null = null;
let messageSyncTimer: ReturnType<typeof setInterval> | null = null;
let chatListSyncTimer: ReturnType<typeof setInterval> | null = null;
let lastSeenHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let presenceLabelRefreshTimer: ReturnType<typeof setInterval> | null = null;
let chatListSyncBusy = false;
let chatListLoadPromise: Promise<void> | null = null;
let chatListCacheHydratedUserId: string | null = null;
let notificationOpenInProgress = false;
let lastAppResumeAt = 0;
const messageSyncInFlight = new Set<string>();
let presenceChannel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;
let currentUsername = '';
const onlineUsers = new Set<string>();
const lastSeenCache = new Map<string, string>();
const avatarSeedByUserId = new Map<string, string>();
const avatarPhotoByUserId = new Map<string, string>();
const senderNameByUserId = new Map<string, string>();
const senderUsernameByUserId = new Map<string, string>();
const senderProfileLoadedIds = new Set<string>();
let currentMode: 'login' | 'signup' = 'login';
let currentAvatarSeed = '';
// The email-code reset flow owns its form after OTP verification; suppress the
// separate recovery-link form while that flow is active.
let otpRecoveryInProgress = false;
let otpRecoverySessionReady = false;
let busy = false;
const avatarSeeds = ['Akira', 'Hana', 'Ren', 'Yuki', 'Kai', 'Sora', 'Mika', 'Rin', 'Haruto', 'Aiko', 'Kyo', 'Nami'];
const avatarUrl = (seed: string) => `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(seed)}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`;

const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = `
<div class="app-shell">
  <header class="topbar" id="appTopbar" hidden>
    <div class="brand"><div class="brand-mark"><img src="/resources/squadchat-logo.png" alt="SquadChat logo"></div><div><h1>SquadChat</h1><p>Your people, one place.</p><span class="fiery-wordmark">FIERY</span></div></div>
    <div class="top-actions"><span class="pill" id="connectionPill">● Not connected</span></div>
  </header>
  <div id="notice" role="status" aria-live="polite"></div>
  <div id="sessionBoot" class="session-boot" role="status">Loading SquadChat…</div>
  <section id="authScreen" class="auth-wrap" hidden>
    <div class="auth-head"><div class="brand"><div class="brand-mark"><img src="/resources/squadchat-logo.png" alt="SquadChat logo"></div><div><h1>SquadChat</h1><p>Private chats. Your crew.</p></div></div><h2 id="authHeading">Welcome back</h2><p class="muted" id="authSubtitle">Sign in to catch up with your people.</p></div>
    <div class="card">
      <div class="auth-tabs"><button id="loginTab" class="active" type="button">Log in</button><button id="signupTab" type="button">Create account</button></div>
      <form id="authForm" class="stack">
        <div id="usernameField" hidden><label for="username">Username</label><input id="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" placeholder="e.g. cristian_22" autocomplete="username"></div>
        <label for="email">Email address</label><input id="email" type="email" required autocomplete="email" placeholder="you@example.com">
        <label for="password">Password</label><div class="password-field-wrap"><input id="password" type="password" minlength="8" required autocomplete="current-password" placeholder="At least 8 characters"><button class="password-toggle" id="togglePassword" type="button" aria-label="Show password" aria-pressed="false"><svg class="password-eye" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
        <button class="btn auth-submit-button" id="authSubmit" type="submit">Log in</button>
        <button class="btn ghost" id="resetPassword" type="button">Forgot password?</button>
      </form>
    </div>
  </section>
  <section id="chatScreen" hidden>
    <div class="layout">
      <aside class="sidebar">
        <div class="card search-card">
          <div class="section-title"><h3>Find friends</h3><span>⌕</span></div>
          <form id="searchForm"><label for="friendSearch">Search exact username</label><div class="form-row"><input id="friendSearch" placeholder="friend_username" autocomplete="off" required><button class="btn small" type="submit">Find</button></div></form>
          <div id="searchResult"></div>
          <hr>
          <form id="groupForm">
            <div class="section-title"><h3>Create a group</h3><span>＋</span></div>
            <label for="groupTitle">Group name</label><input id="groupTitle" maxlength="60" placeholder="Weekend squad" required>
            <label for="groupMembers">Member usernames</label><input id="groupMembers" placeholder="alex, sam" required>
            <p class="tiny">Use registered usernames separated by commas.</p>
            <button id="createGroupButton" class="btn secondary" type="submit" style="width:100%">Create group</button>
          </form>
        </div>
        <div class="card chat-list-card">
          <div class="section-title"><h3>Your conversations</h3><button id="refreshChats" class="btn ghost small" type="button">Refresh</button></div>
          <div class="conversation-search-wrap"><span aria-hidden="true">⌕</span><input id="conversationSearch" type="search" aria-label="Search conversations" placeholder="Search conversations" autocomplete="off"><button id="clearConversationSearch" type="button" aria-label="Clear conversation search" hidden>×</button></div>
          <div id="chatList" class="chat-list"><div class="empty">Your chats will appear here.</div></div>
        </div>
        <div class="card profile-card"><div class="section-title"><h3>Your profile</h3><span>◉</span></div><div class="profile-summary"><div class="profile-avatar" id="profileAvatar">SC</div><div class="profile-summary-text"><strong id="profileName">Not signed in</strong><p class="muted" id="profileEmail"></p></div></div><button id="profileButton" class="btn ghost small" type="button">View & edit profile</button><button id="adminPanelButton" class="btn admin-entry-button small" type="button" hidden>⚙ Admin dashboard</button><button id="logoutButton" class="profile-logout" type="button">↪ <span>Log Out</span></button></div>
      </aside>
      <main class="card chat-main">
        <div class="chat-header"><button class="btn ghost small mobile-back" id="backToChats" type="button" aria-label="Back to conversations">←</button><div class="chat-heading-wrap"><button class="chat-cover-avatar" id="chatCoverAvatar" type="button" hidden aria-label="View chatmate profile"></button><div class="chat-heading-text"><h2 id="chatTitle">Choose a conversation</h2><p id="chatSubtitle">Select a chat or find a friend to start.</p></div></div><button class="btn secondary small" id="groupSettingsButton" type="button" hidden>Group settings</button><span class="pill" id="chatKind">READY</span><div class="improvements-wrap" id="improvementsWrap" hidden><button class="improvements-trigger" id="improvementsButton" type="button" aria-label="Conversation improvements" aria-expanded="false" title="Conversation improvements">!</button><div class="improvements-menu" id="improvementsMenu" hidden><button type="button" data-improvement="background"><span class="improvement-icon">◐</span><span>Change chat background</span></button><button type="button" data-improvement="photos"><span class="improvement-icon">▦</span><span>Shared photos</span></button><button type="button" data-improvement="group-settings" id="improvementsGroupSettings" hidden><span class="improvement-icon">⚙</span><span>Group settings</span></button></div></div></div>
        <div id="messages" class="messages"><div class="empty"><div><div class="empty-icon">✦</div><strong>Your next conversation starts here.</strong><p class="muted">Find a friend by username or create a group.</p></div></div></div>
        <div id="typingIndicator" class="typing-indicator" aria-live="polite" hidden>Typing..</div>
        <form id="composer" class="composer"><input id="imageInput" type="file" accept="image/*" multiple hidden><button class="btn secondary" id="attachImageButton" type="button" disabled aria-label="Attach photos" title="Choose one or more photos">＋ Photo</button><div class="composer-field-wrap"><div id="photoPreviewTray" class="photo-preview-tray" hidden aria-label="Selected photos"></div><textarea id="messageInput" maxlength="2000" rows="1" placeholder="Write a message…" autocomplete="off" disabled></textarea></div><button class="btn" id="sendButton" disabled type="submit">Send ➤</button></form>
      </main>
    </div>
    <nav class="bottom-nav"><button class="active" data-nav="chats"><span>▤</span>Chats</button><button data-nav="friends"><span>⌕</span>Friends</button><button data-nav="profile"><span>◉</span>Profile</button></nav>
  </section>
</div>
<div id="modalRoot"></div>`;

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function closeImprovementsMenu() {
  const menu = document.getElementById('improvementsMenu');
  const button = document.getElementById('improvementsButton');
  if (menu) {
    menu.classList.add('is-closing');
    window.setTimeout(() => {
      menu.hidden = true;
      menu.classList.remove('is-closing');
    }, 160);
  }
  if (button) button.setAttribute('aria-expanded', 'false');
}
function toggleImprovementsMenu() {
  const menu = el<HTMLDivElement>('improvementsMenu');
  const button = el<HTMLButtonElement>('improvementsButton');
  const opening = menu.hidden;
  if (opening) {
    const rect = button.getBoundingClientRect();
    menu.style.top = Math.min(rect.bottom + 8, window.innerHeight - menu.offsetHeight - 12) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    menu.style.left = 'auto';
    menu.hidden = false;
  } else {
    closeImprovementsMenu();
  }
  button.setAttribute('aria-expanded', String(opening));
}

// Keep the menu outside the chat panel's overflow/stacking context so it always floats above messages.
const improvementsMenu = el<HTMLDivElement>('improvementsMenu');
document.body.append(improvementsMenu);
window.addEventListener('resize', () => { if (!improvementsMenu.hidden) closeImprovementsMenu(); });
el<HTMLButtonElement>('improvementsButton').addEventListener('click', event => {
  event.stopPropagation(); toggleImprovementsMenu();
});
el<HTMLDivElement>('improvementsMenu').addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-improvement]');
  if (!target) return;
  closeImprovementsMenu();
  if (target.dataset.improvement === 'background') void openBackgroundPicker();
  if (target.dataset.improvement === 'photos') void openSharedPhotosGallery();
  if (target.dataset.improvement === 'group-settings' && currentChat?.is_group) void openGroupSettings();
});
document.addEventListener('click', event => {
  const wrap = document.getElementById('improvementsWrap');
  if (wrap && !wrap.contains(event.target as Node)) closeImprovementsMenu();
});

function confirmAccountDeletion(username: string): Promise<boolean> {
  const modalRoot = el<HTMLDivElement>('modalRoot');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop delete-confirm-backdrop';
  backdrop.id = 'deleteAccountBackdrop';
  backdrop.innerHTML = `
    <section class="card modal-card stack" role="dialog" aria-modal="true" aria-labelledby="deleteAccountTitle">
      <h2 id="deleteAccountTitle">Delete account?</h2>
      <p class="muted" id="deleteAccountMessage"></p>
      <p class="tiny">This permanently removes the account and its related content. This action cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn secondary" id="cancelAccountDelete" type="button">Cancel</button>
        <button class="btn danger" id="confirmAccountDelete" type="button">Delete</button>
      </div>
    </section>`;
  modalRoot.append(backdrop);
  el<HTMLElement>('deleteAccountMessage').textContent = 'Permanently delete @' + username + '?';
  return new Promise(resolve => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKeydown);
      resolve(confirmed);
    };
    const onKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(false); };
    el<HTMLButtonElement>('cancelAccountDelete').addEventListener('click', () => finish(false));
    el<HTMLButtonElement>('confirmAccountDelete').addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', event => { if (event.target === event.currentTarget) finish(false); });
    document.addEventListener('keydown', onKeydown);
    el<HTMLButtonElement>('cancelAccountDelete').focus();
  });
}

let noticeTimer: number | null = null;
const notice = (text: string, kind = '') => {
  const node = el<HTMLDivElement>('notice');
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  node.className = text ? `notice ${kind} is-visible` : '';
  node.textContent = text;
  if (text) {
    noticeTimer = window.setTimeout(() => {
      node.classList.remove('is-visible');
      node.classList.add('is-hiding');
      window.setTimeout(() => {
        if (node.classList.contains('is-hiding')) {
          node.className = '';
          node.textContent = '';
        }
      }, 260);
      noticeTimer = null;
    }, kind === 'error' ? 7000 : 5000);
  }
};
const escapeText = (value: string) => value;
const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const initials = (value: string) =>
  value.replace(/^@/, '').slice(0, 2).toUpperCase() || 'SC';
const timeLabel = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

function setConnection(text: string, connected: boolean) {
  el<HTMLSpanElement>('connectionPill').textContent =
    (connected ? '● ' : '○ ') + text;
  el<HTMLSpanElement>('connectionPill').style.color = connected
    ? '#8ee2be'
    : '#f3c98a';
}

let connectionToastTimer: number | null = null;
function showConnectionToast(message: string, kind: 'success' | 'offline') {
  let toast = document.getElementById('connectionStatusToast') as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'connectionStatusToast';
    toast.className = 'connection-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.append(toast);
  }
  if (connectionToastTimer !== null) window.clearTimeout(connectionToastTimer);
  toast.className = `connection-toast ${kind} is-visible`;
  toast.textContent = message;
  connectionToastTimer = window.setTimeout(() => {
    toast?.classList.remove('is-visible');
    connectionToastTimer = null;
  }, 4200);
}
const DEFAULT_SUPABASE_URL = 'https://xochwkeytdumpvvjzpdv.supabase.co';
const DEFAULT_SUPABASE_KEY = 'sb_publishable_qD2XJDu4UJcvV3GZf8rrgg_t3TJ0NE9';

function configured() {
  return Boolean(DEFAULT_SUPABASE_URL && DEFAULT_SUPABASE_KEY);
}
function connect() {
  const url = (localStorage.getItem('squadchat_url') || DEFAULT_SUPABASE_URL).trim();
  const key = (localStorage.getItem('squadchat_key') || DEFAULT_SUPABASE_KEY).trim();
  if (!url || !key) {
    supabase = null;
    setConnection('Setup required', false);
    return false;
  }
  try {
    supabase = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: !isSignupConfirmationCallback,
      },
    });
    setConnection('Supabase configured', true);
    return true;
  } catch {
    supabase = null;
    setConnection('Invalid configuration', false);
    return false;
  }
}
function requireClient() {
  if (!supabase)
    throw new Error('Connect your Supabase project first using Setup.');
  return supabase;
}
function showAuth() {
  el<HTMLElement>('sessionBoot').hidden = true;
  el<HTMLElement>('appTopbar').hidden = true;
  el<HTMLElement>('authScreen').hidden = false;
  el<HTMLElement>('chatScreen').hidden = true;
  el<HTMLButtonElement>('logoutButton').hidden = true;
}
function showChat() {
  el<HTMLElement>('sessionBoot').hidden = true;
  el<HTMLElement>('appTopbar').hidden = false;
  el<HTMLElement>('authScreen').hidden = true;
  el<HTMLElement>('chatScreen').hidden = false;
  el<HTMLButtonElement>('logoutButton').hidden = false;
}

async function showConversationList() {
  // Every fresh login starts from the list, never from a previously selected chat.
  currentChat = null;
  openingChatId = null;
  chatOpenSequence += 1;
  if (messageSyncTimer) {
    clearInterval(messageSyncTimer);
    messageSyncTimer = null;
  }
  if (channel && supabase) {
    await supabase.removeChannel(channel);
    channel = null;
  }

  const screen = el<HTMLElement>('chatScreen');
  screen.classList.remove('mobile-chat-open', 'mobile-friends-open', 'mobile-profile-open', 'chat-opening');
  document.querySelectorAll('[data-nav]').forEach(item => item.classList.remove('active'));
  document.querySelector<HTMLButtonElement>('[data-nav="chats"]')?.classList.add('active');

  el<HTMLHeadingElement>('chatTitle').textContent = 'Choose a conversation';
  el<HTMLParagraphElement>('chatSubtitle').textContent = 'Select a chat or find a friend to start.';
  el<HTMLElement>('chatKind').textContent = 'READY';
  el<HTMLDivElement>('improvementsWrap').hidden = true;
  closeImprovementsMenu();
  applySharedAppearance(null);
  const coverAvatar = el<HTMLButtonElement>('chatCoverAvatar');
  coverAvatar.hidden = true;
  coverAvatar.style.backgroundImage = '';
  coverAvatar.textContent = '';
  coverAvatar.onclick = null;
  el<HTMLButtonElement>('groupSettingsButton').hidden = true;
  el<HTMLDivElement>('messages').innerHTML = '<div class="empty"><div><div class="empty-icon">✦</div><strong>Your next conversation starts here.</strong><p class="muted">Find a friend by username or create a group.</p></div></div>';
  el<HTMLInputElement>('messageInput').disabled = true;
  el<HTMLInputElement>('messageInput').placeholder = 'Write a message…';
  el<HTMLButtonElement>('sendButton').disabled = true;
  el<HTMLButtonElement>('attachImageButton').disabled = true;

  renderChats();
  showChat();
}
function showSuspendedLock(message: string, title = 'Account suspended') {
  suspendedLockActive = true;
  el<HTMLElement>('sessionBoot').hidden = true;
  el<HTMLElement>('appTopbar').hidden = true;
  el<HTMLElement>('authScreen').hidden = true;
  el<HTMLElement>('chatScreen').hidden = true;
  el<HTMLDivElement>('modalRoot').innerHTML = `
    <section class="account-lock-screen" role="alert" aria-live="assertive">
      <div class="account-lock-card">
        <div class="account-lock-icon">!</div>
        <p class="account-lock-eyebrow">SQUADCHAT ACCOUNT STATUS</p>
        <h1>${title}</h1>
        <p>${message}</p>
        <p class="account-lock-note">Chats, Friends, Profile, search, messaging, and notifications are unavailable while your account is suspended.</p>
        <button class="btn account-lock-logout" id="suspendedLogoutButton" type="button">↪ Log out</button>
      </div>
    </section>`;
  el<HTMLButtonElement>('suspendedLogoutButton').addEventListener('click', () => {
    el<HTMLButtonElement>('logoutButton').click();
  });
  startAccountStatusMonitor();
}
async function checkAccountStatus(): Promise<boolean> {
  if (!currentUser || !supabase) return true;
  const { data, error } = await supabase.functions.invoke('admin-api', { body: { action: 'get_account_status' } });
  if (error) {
    console.warn('SquadChat account status check failed:', error.message);
    // A temporary network/function error is not proof of suspension.
    // Keep a previously verified suspension lock in place, but never create
    // a new lock unless the server explicitly returns status = suspended.
    return !suspendedLockActive;
  }
  if (data?.status === 'suspended') {
    localStorage.setItem('squadchat_pending_lift_notice_' + currentUser.id, 'true');
    showSuspendedLock(data.event?.message || 'Your account has been suspended by an administrator. You can only log out until access is restored.');
    return false;
  }
  if (data?.status !== 'active') {
    console.warn('SquadChat account status response was missing or invalid.');
    return !suspendedLockActive;
  }
  if (suspendedLockActive && data?.status === 'active') {
    localStorage.setItem('squadchat_status_event_' + currentUser.id, data.event.id);
    window.location.reload();
    return false;
  }
  const event = data?.event;
  const pendingLiftNoticeKey = 'squadchat_pending_lift_notice_' + currentUser.id;
  const pendingLiftNotice = localStorage.getItem(pendingLiftNoticeKey) === 'true';
  if (event?.status === 'active' && pendingLiftNotice) {
    localStorage.removeItem(pendingLiftNoticeKey);
    localStorage.setItem('squadchat_status_event_' + currentUser.id, event.id || 'acknowledged');
    notice(event.message || 'Your suspension has been lifted. You can use SquadChat normally again.', 'success');
  } else if (event?.status === 'active' && event.id) {
    // A historical active event is not a new reactivation for this device.
    localStorage.setItem('squadchat_status_event_' + currentUser.id, event.id);
  }
  return true;
}
function startAccountStatusMonitor() {
  if (accountStatusTimer) clearInterval(accountStatusTimer);
  accountStatusTimer = setInterval(() => {
    if (currentUser) void checkAccountStatus();
  }, 10000);
}
type PeerAccountStatus = 'active' | 'suspended' | 'unknown';
const peerAccountStatusCache = new Map<string, { status: PeerAccountStatus; checkedAt: number }>();
async function getPeerAccountStatus(userId: string): Promise<PeerAccountStatus> {
  if (!supabase || !userId) return 'unknown';
  const cached = peerAccountStatusCache.get(userId);
  if (cached && Date.now() - cached.checkedAt < 15000) return cached.status;
  const { data, error } = await supabase.functions.invoke('admin-api', { body: { action: 'get_peer_status', user_id: userId } });
  if (error || !data || !['active', 'suspended'].includes(data.status)) {
    console.warn('SquadChat peer status check failed:', error?.message || 'Invalid status response');
    peerAccountStatusCache.set(userId, { status: 'unknown', checkedAt: Date.now() });
    return 'unknown';
  }
  const status = data.status as PeerAccountStatus;
  peerAccountStatusCache.set(userId, { status, checkedAt: Date.now() });
  return status;
}
function authMode(mode: 'login' | 'signup') {
  currentMode = mode;
  el<HTMLElement>('usernameField').hidden = mode !== 'signup';
  el<HTMLButtonElement>('loginTab').classList.toggle(
    'active',
    mode === 'login'
  );
  el<HTMLButtonElement>('signupTab').classList.toggle(
    'active',
    mode === 'signup'
  );
  el<HTMLHeadingElement>('authHeading').textContent =
    mode === 'login' ? 'Welcome back' : 'Meet your crew';
  el<HTMLParagraphElement>('authSubtitle').textContent =
    mode === 'login'
      ? 'Sign in to catch up with your people.'
      : 'Create an account to start chatting.';
  el<HTMLButtonElement>('authSubmit').textContent =
    mode === 'login' ? 'Log in' : 'Create account';
  el<HTMLButtonElement>('resetPassword').hidden = mode !== 'login';
  el<HTMLInputElement>('password').autocomplete =
    mode === 'login' ? 'current-password' : 'new-password';
}
function openSetup() {
  const url = localStorage.getItem('squadchat_url') || '';
  const key = localStorage.getItem('squadchat_key') || '';
  el<HTMLDivElement>('modalRoot').innerHTML = `
  <div class="modal-backdrop" id="modalBackdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="setupTitle">
    <h2 id="setupTitle">Connect Supabase</h2>
    <p class="muted">Create a free project at supabase.com, then copy the Project URL and publishable key from Project Settings → API Keys. This starter connects directly from your browser.</p>
    <div class="notice">Only use the public publishable key (or legacy anon key). Never enter a service_role or secret key here. RLS policies must be enabled before using real accounts.</div>
    <form id="setupForm">
      <label for="projectUrl">Supabase project URL</label><input id="projectUrl" type="url" required placeholder="https://your-project.supabase.co" value="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
      <label for="publishableKey">Publishable key</label><input id="publishableKey" required autocomplete="off" placeholder="sb_publishable_…" value="${key.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
      <p class="tiny">These values are saved in this browser only. The URL and publishable key are not passwords, but database security depends on your RLS policies.</p>
      <div class="modal-actions"><button class="btn" type="submit">Save & connect</button><button class="btn secondary" id="showSql" type="button">View database SQL</button><button class="btn ghost" id="closeSetup" type="button">Cancel</button></div>
    </form>
    <div id="sqlArea" hidden><hr><label for="sqlText">Copy all SQL and run it in Supabase → SQL Editor</label><textarea id="sqlText" readonly></textarea><div class="modal-actions"><button class="btn" id="copySql" type="button">Copy SQL</button><button class="btn ghost" id="hideSql" type="button">Hide SQL</button></div><p class="tiny">Run this once in a new project. If Realtime publication already contains messages, the final ALTER PUBLICATION line may say the table is already added; if so, omit that line and run the rest.</p></div>
  </section></div>`;
  el<HTMLFormElement>('setupForm').addEventListener('submit', async event => {
    event.preventDefault();
    const nextUrl = el<HTMLInputElement>('projectUrl')
      .value.trim()
      .replace(/\/$/, '');
    const nextKey = el<HTMLInputElement>('publishableKey').value.trim();
    if (!/^https:\/\/[a-zA-Z0-9-]+\.supabase\.co$/.test(nextUrl)) {
      notice(
        'Enter the Project URL shown in your Supabase dashboard.',
        'error'
      );
      return;
    }
    localStorage.setItem('squadchat_url', nextUrl);
    localStorage.setItem('squadchat_key', nextKey);
    if (!connect()) {
      notice('Could not configure Supabase. Check the URL and key.', 'error');
      return;
    }
    el<HTMLDivElement>('modalRoot').innerHTML = '';
    notice(
      'Supabase settings saved on this device. Run the database SQL before creating accounts.',
      'success'
    );
    await restoreSession();
  });
  el<HTMLButtonElement>('showSql').addEventListener('click', () => {
    el<HTMLTextAreaElement>('sqlText').value = SQL_SETUP;
    el<HTMLElement>('sqlArea').hidden = false;
  });
  el<HTMLButtonElement>('copySql').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(SQL_SETUP);
      notice('SQL copied. Paste it into Supabase SQL Editor.', 'success');
    } catch {
      el<HTMLTextAreaElement>('sqlText').focus();
      el<HTMLTextAreaElement>('sqlText').select();
      notice('Select the SQL text and copy it manually.');
    }
  });
  el<HTMLButtonElement>('hideSql').addEventListener('click', () => {
    el<HTMLElement>('sqlArea').hidden = true;
  });
  el<HTMLButtonElement>('closeSetup').addEventListener('click', () => {
    el<HTMLDivElement>('modalRoot').innerHTML = '';
  });
}
el<HTMLButtonElement>('groupSettingsButton').addEventListener('click', () => { if (currentChat?.is_group) void openGroupSettings(); });
el<HTMLButtonElement>('loginTab').addEventListener('click', () =>
  authMode('login')
);
el<HTMLButtonElement>('signupTab').addEventListener('click', () =>
  authMode('signup')
);
el<HTMLButtonElement>('togglePassword').addEventListener('click', () => {
  const password = el<HTMLInputElement>('password');
  const toggle = el<HTMLButtonElement>('togglePassword');
  const showing = password.type === 'password';
  password.type = showing ? 'text' : 'password';
  toggle.innerHTML = showing
    ? '<svg class="password-eye" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.2A10.8 10.8 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.1 3.9M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10.6 10.6 0 004.1-.8"/></svg>'
    : '<svg class="password-eye" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  toggle.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
  toggle.setAttribute('aria-pressed', String(showing));
});

el<HTMLFormElement>('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = el<HTMLButtonElement>('authSubmit');
  button.disabled = true;
  try {
    const db = requireClient();
    const email = el<HTMLInputElement>('email').value.trim();
    const password = el<HTMLInputElement>('password').value;
    if (password.length < 8)
      throw new Error('Use a password with at least 8 characters.');
    if (currentMode === 'signup') {
      const username = el<HTMLInputElement>('username').value.trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username))
        throw new Error(
          'Username must be 3–20 letters, numbers, or underscores.'
        );
      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: { data: { username } },
      });
      if (error) throw error;
      if (!data.session) {
        notice(
          'Account created. Check your email to confirm it, then log in.',
          'success'
        );
        authMode('login');
      } else {
        currentUser = data.user;
        await loadProfile();
        await loadChats();
        await showConversationList();
        startPresence();
        requestAndroidPushToken();
        notice('Welcome to SquadChat!', 'success');
        setConnection(navigator.onLine ? 'Connected' : 'Offline', navigator.onLine);
        showConnectionToast(
          navigator.onLine ? 'You’re connected to the internet.' : 'Internet connection lost. Messages will be saved on this device.',
          navigator.onLine ? 'success' : 'offline'
        );
      }
    } else {
      const { data, error } = await db.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        if (/banned|suspend/i.test(error.message)) throw new Error('This SquadChat account is suspended. Please contact an administrator.');
        throw error;
      }
      currentUser = data.user;
      if (!(await checkAccountStatus())) return;
      await loadProfile();
      await loadChats();
      await showConversationList();
      startPresence();
      startAccountStatusMonitor();
      requestAndroidPushToken();
      notice('');
      setConnection(navigator.onLine ? 'Connected' : 'Offline', navigator.onLine);
      showConnectionToast(
        navigator.onLine ? 'You’re connected to the internet.' : 'Internet connection lost. Messages will be saved on this device.',
        navigator.onLine ? 'success' : 'offline'
      );
    }
  } catch (error) {
    notice((error as Error).message || 'Authentication failed.', 'error');
  } finally {
    busy = false;
    button.disabled = false;
  }
});

el<HTMLButtonElement>('resetPassword').addEventListener('click', async () => {
  // A new reset request starts a fresh recovery flow.
  otpRecoveryInProgress = false;
  const db = requireClient();
  const email = el<HTMLInputElement>('email').value.trim();
  if (!email) {
    notice('Enter your email address first.', 'error');
    el<HTMLInputElement>('email').focus();
    return;
  }

  const button = el<HTMLButtonElement>('resetPassword');
  button.disabled = true;
  try {
    const { error } = await db.auth.resetPasswordForEmail(email);
    if (error) throw error;
    otpRecoveryInProgress = false;
    otpRecoverySessionReady = false;

    const modalRoot = el<HTMLDivElement>('modalRoot');
    const safeEmail = email.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    modalRoot.innerHTML = `<div class="modal-backdrop otp-reset-backdrop" id="otpResetBackdrop"><form class="card modal-card stack otp-reset-modal" id="otpResetForm"><h2>Reset your password</h2><p class="muted">Enter the newest 6-digit code sent to <strong>${safeEmail}</strong>, then choose your new password.</p><label for="resetOtp">6-digit email verification code</label><input id="resetOtp" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" autocomplete="one-time-code" required placeholder="Enter 6-digit code"><label for="otpNewPassword">New password</label><input id="otpNewPassword" type="password" minlength="8" autocomplete="new-password" required placeholder="At least 8 characters"><label for="otpConfirmPassword">Retype new password</label><input id="otpConfirmPassword" type="password" minlength="8" autocomplete="new-password" required placeholder="Type the new password again"><p class="otp-reset-feedback" id="otpResetFeedback" role="status" aria-live="polite"></p><div class="modal-actions"><button class="btn ghost" id="resendResetOtp" type="button">Resend code</button><button class="btn" id="confirmOtpReset" type="submit">Confirm reset</button></div><p class="tiny">Use the newest email code. Requesting another code can invalidate an older one.</p></form></div>`;
    const showResetFeedback = (message: string, isError = true) => {
      const feedback = el<HTMLParagraphElement>('otpResetFeedback');
      feedback.textContent = message;
      feedback.classList.toggle('is-error', isError);
      feedback.classList.toggle('is-success', !isError);
    };
    requestAnimationFrame(() => el<HTMLInputElement>('resetOtp').focus());
    modalRoot.querySelector<HTMLDivElement>('#otpResetBackdrop')?.addEventListener('click', event => {
      if (event.target === event.currentTarget) modalRoot.innerHTML = '';
    });

    const resendButton = el<HTMLButtonElement>('resendResetOtp');
    resendButton.addEventListener('click', async () => {
      resendButton.disabled = true;
      try {
        const { error: resendError } = await db.auth.resetPasswordForEmail(email);
        if (resendError) throw resendError;
        otpRecoveryInProgress = false;
        otpRecoverySessionReady = false;
        notice('If the account exists, a new reset code has been sent.', 'success');
      } catch (resendError) {
        notice((resendError as Error).message || 'Could not resend the code.', 'error');
      } finally {
        resendButton.disabled = false;
      }
    });

    el<HTMLFormElement>('otpResetForm').addEventListener('submit', async event => {
      event.preventDefault();
      const token = el<HTMLInputElement>('resetOtp').value.trim();
      if (!/^[0-9]{6}$/.test(token)) { showResetFeedback('Enter the 6-digit code from your newest email.', true); return; }
      const password = el<HTMLInputElement>('otpNewPassword').value;
      const confirmation = el<HTMLInputElement>('otpConfirmPassword').value;
      if (!token) { notice('Enter the verification code from your email.', 'error'); return; }
      if (password.length < 8) { notice('Your password must be at least 8 characters.', 'error'); return; }
      if (password !== confirmation) { notice('The passwords do not match.', 'error'); return; }

      const confirmButton = el<HTMLButtonElement>('confirmOtpReset');
      const originalLabel = confirmButton.textContent || 'Confirm reset';
      confirmButton.disabled = true;
      confirmButton.textContent = otpRecoverySessionReady ? 'Saving password…' : 'Verifying code…';
      showResetFeedback(otpRecoverySessionReady ? 'Code already verified. Saving your new password…' : 'Checking your code…', false);
      try {
        if (!otpRecoverySessionReady) {
          // verifyOtp emits PASSWORD_RECOVERY. Keep this form in control of that event.
          otpRecoveryInProgress = true;
          const { data: verifyData, error: verifyError } = await db.auth.verifyOtp({ email, token, type: 'recovery' });
          if (verifyError) throw verifyError;
          if (!verifyData.session) throw new Error('The code could not start a recovery session. Request a new code and use the newest email.');
          otpRecoverySessionReady = true;
        }
        showResetFeedback('Code verified. Saving your new password…', false);
        const { error: updateError } = await db.auth.updateUser({ password });
        if (updateError) throw updateError;
        modalRoot.innerHTML = '';
        await db.auth.signOut();
        otpRecoverySessionReady = false;
        otpRecoveryInProgress = false;
        currentUser = null;
        history.replaceState(null, document.title, window.location.pathname);
        showAuth();
        notice('Password reset successfully. Log in with your new password.', 'success');
      } catch (resetError) {
        if (!otpRecoverySessionReady) otpRecoveryInProgress = false;
        const message = (resetError as Error).message || 'Could not reset your password. Check the code and try again.';
        showResetFeedback(message + (message.toLowerCase().includes('expired') ? ' Request a new code and enter the newest email code.' : ''), true);
      } finally {
        confirmButton.disabled = false;
        confirmButton.textContent = originalLabel;
      }
    });
    notice('Check your email for the password-reset code.', 'success');
  } catch (error) {
    notice((error as Error).message || 'Could not start password reset.', 'error');
  } finally {
    button.disabled = false;
  }
});


async function callAdminApi<T = any>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireClient().functions.invoke('admin-api', { body });
  if (error) {
    const message = (data as any)?.error || error.message || 'Admin request failed.';
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

async function openAdminPanel() {
  if (currentUserRole !== 'admin') {
    notice('Admin access required.', 'error');
    return;
  }

  const modalRoot = el<HTMLDivElement>('modalRoot');
  modalRoot.innerHTML = `
    <div class="modal-backdrop admin-backdrop" id="adminBackdrop">
      <section class="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="adminTitle">
        <div class="admin-heading">
          <div>
            <p class="profile-eyebrow">SQUADCHAT CONTROL CENTER</p>
            <h2 id="adminTitle">Admin dashboard</h2>
            <p class="muted">Manage accounts and monitor the community.</p>
          </div>
          <button class="btn ghost small" id="closeAdminPanel" type="button" aria-label="Close admin dashboard">✕</button>
        </div>
        <div id="adminActionNotice" class="admin-action-notice" role="status" aria-live="polite" hidden></div>
        <div class="admin-stats" id="adminStats"><div class="admin-stat">Loading dashboard…</div></div>

        <section class="admin-users-section">
          <div class="admin-users-heading">
            <div><h3>User management</h3><p class="tiny">Search accounts and filter by status or role.</p></div>
            <button class="btn ghost small" id="refreshAdminUsers" type="button">Refresh</button>
          </div>
          <input id="adminUserSearch" type="search" placeholder="Search username or display name…" autocomplete="off">
          <div class="admin-user-filters">
            <select id="adminUserStatusFilter" aria-label="Filter accounts by status">
              <option value="all">All statuses</option>
              <option value="active">Active accounts</option>
              <option value="suspended">Suspended accounts</option>
            </select>
            <select id="adminUserRoleFilter" aria-label="Filter accounts by role">
              <option value="all">All roles</option>
              <option value="user">Members</option>
              <option value="admin">Administrators</option>
            </select>
          </div>
          <div id="adminUserList" class="admin-user-list"><div class="empty">Loading accounts…</div></div>
          <p id="adminUserLimitNote" class="tiny admin-user-limit-note" hidden>Showing the newest 200 matching accounts. Search to find older accounts.</p>
        </section>

        <details class="admin-activity-section" id="adminActivityDetails">
          <summary class="admin-activity-toggle">
            <span>
              <strong>Admin activity</strong>
              <small>Latest account actions recorded by SquadChat</small>
            </span>
            <span class="admin-activity-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="admin-activity-content">
            <div id="adminActivityList" class="admin-activity-list"><div class="empty">Open to load activity…</div></div>
            <button class="btn ghost small admin-activity-refresh" id="refreshAdminActivity" type="button">Refresh activity</button>
          </div>
        </details>

        <p class="tiny admin-warning">Permanent deletion removes the account, its messages, reactions, profile photo and related records. This cannot be undone.</p>
      </section>
    </div>`;

  const backdrop = el<HTMLDivElement>('adminBackdrop');
  const close = () => { modalRoot.innerHTML = ''; };
  el<HTMLButtonElement>('closeAdminPanel').onclick = close;
  backdrop.onclick = event => { if (event.target === event.currentTarget) close(); };

  const formatAdminDate = (value?: string | null) => {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  };

  const showAdminFeedback = (message: string, kind: 'success' | 'error' | 'warning') => {
    const feedback = el<HTMLDivElement>('adminActionNotice');
    feedback.hidden = false;
    feedback.className = 'admin-action-notice ' + kind;
    feedback.textContent = message;
  };

  const renderStats = async () => {
    const result = await callAdminApi<{stats: Record<string, number>}>({ action: 'overview' });
    const stats = result.stats;
    const labels: Array<[string, string, string?]> = [
      ['Registered users', 'totalUsers'],
      ['Online now', 'onlineUsers', 'Seen within 2 minutes'],
      ['New today', 'registeredToday'],
      ['New this week', 'registeredThisWeek'],
      ['Active accounts', 'activeUsers'],
      ['Suspended accounts', 'suspendedUsers'],
      ['Conversations', 'conversations'],
      ['Groups', 'groups'],
      ['Messages', 'messages'],
    ];

    const container = el<HTMLDivElement>('adminStats');
    container.replaceChildren();
    labels.forEach(([label, key, hint]) => {
      const card = document.createElement('div');
      card.className = 'admin-stat';
      const value = document.createElement('strong');
      value.textContent = String(stats[key] ?? 0);
      const caption = document.createElement('span');
      caption.textContent = label;
      card.append(value, caption);
      if (hint) {
        const note = document.createElement('small');
        note.className = 'admin-stat-hint';
        note.textContent = hint;
        card.append(note);
      }
      container.append(card);
    });
  };

  const openUserDetails = async (user: any, trigger: HTMLButtonElement) => {
    trigger.disabled = true;
    trigger.textContent = 'Loading…';
    try {
      const result = await callAdminApi<{
        user: any;
        stats: { messages_sent: number; conversations_joined: number; groups_joined: number; groups_created: number };
        recent_actions: Array<any>;
      }>({ action: 'user_details', user_id: user.id });

      const overlay = document.createElement('div');
      overlay.className = 'admin-user-detail-backdrop';
      overlay.setAttribute('role', 'presentation');
      const dialog = document.createElement('section');
      dialog.className = 'admin-user-detail-modal';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'adminUserDetailTitle');

      const heading = document.createElement('div');
      heading.className = 'admin-user-detail-heading';
      const headingText = document.createElement('div');
      const eyebrow = document.createElement('p');
      eyebrow.className = 'profile-eyebrow';
      eyebrow.textContent = 'ACCOUNT OVERVIEW';
      const title = document.createElement('h2');
      title.id = 'adminUserDetailTitle';
      title.textContent = result.user.display_name || result.user.username || 'SquadChat member';
      const username = document.createElement('p');
      username.className = 'muted';
      username.textContent = '@' + (result.user.username || 'unknown');
      headingText.append(eyebrow, title, username);
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'btn ghost small';
      closeButton.textContent = '✕';
      closeButton.setAttribute('aria-label', 'Close user details');
      closeButton.onclick = () => overlay.remove();
      heading.append(headingText, closeButton);

      const status = document.createElement('span');
      status.className = 'admin-status ' + (result.user.account_status === 'suspended' ? 'is-suspended' : 'is-active');
      status.textContent = (result.user.account_status === 'suspended' ? 'Suspended' : 'Active') +
        (result.user.role === 'admin' ? ' · Administrator' : ' · Member');

      const facts = document.createElement('div');
      facts.className = 'admin-user-detail-facts';
      const addFact = (label: string, value: string) => {
        const item = document.createElement('div');
        item.className = 'admin-user-detail-fact';
        const caption = document.createElement('small');
        caption.textContent = label;
        const content = document.createElement('strong');
        content.textContent = value;
        item.append(caption, content);
        facts.append(item);
      };
      addFact('Joined', formatAdminDate(result.user.created_at));
      addFact('Last seen', formatAdminDate(result.user.last_seen_at));
      addFact('Messages sent', String(result.stats.messages_sent));
      addFact('Conversations', String(result.stats.conversations_joined));
      addFact('Groups joined', String(result.stats.groups_joined));
      addFact('Groups created', String(result.stats.groups_created));

      const bio = document.createElement('p');
      bio.className = 'admin-user-detail-bio';
      bio.textContent = result.user.bio?.trim() || 'No profile bio added.';

      const activityHeading = document.createElement('h3');
      activityHeading.textContent = 'Recent account actions';
      const activity = document.createElement('div');
      activity.className = 'admin-user-detail-activity';
      if (!result.recent_actions.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No admin actions recorded for this account.';
        activity.append(empty);
      } else {
        result.recent_actions.forEach((event: any) => {
          const item = document.createElement('article');
          item.className = 'admin-user-detail-event';
          const action = document.createElement('strong');
          action.textContent = String(event.action || 'account action').replaceAll('_', ' ');
          const meta = document.createElement('small');
          meta.textContent = '@' + event.admin_username + ' · ' + formatAdminDate(event.created_at);
          item.append(action, meta);
          activity.append(item);
        });
      }

      dialog.append(heading, status, facts, bio, activityHeading, activity);
      overlay.append(dialog);
      overlay.addEventListener('click', event => {
        if (event.target === overlay) overlay.remove();
      });
      modalRoot.append(overlay);
      closeButton.focus();
    } catch (error) {
      showAdminFeedback((error as Error).message || 'Could not load account details.', 'error');
    } finally {
      trigger.disabled = false;
      trigger.textContent = 'View details';
    }
  };

  let searchTimer: number | undefined;
  const renderUsers = async () => {
    const list = el<HTMLDivElement>('adminUserList');
    const search = el<HTMLInputElement>('adminUserSearch').value.trim();
    const status = el<HTMLSelectElement>('adminUserStatusFilter').value;
    const role = el<HTMLSelectElement>('adminUserRoleFilter').value;
    const limitNote = el<HTMLParagraphElement>('adminUserLimitNote');
    limitNote.hidden = true;
    list.innerHTML = '<div class="empty">Loading accounts…</div>';

    try {
      const result = await callAdminApi<{users: Array<any>; truncated?: boolean}>({
        action: 'list_users',
        search,
        status,
        role,
      });
      list.replaceChildren();
      limitNote.hidden = !result.truncated;

      if (!result.users.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No matching accounts.';
        list.append(empty);
        return;
      }

      result.users.forEach(user => {
        const row = document.createElement('article');
        row.className = 'admin-user-row';
        const info = document.createElement('div');
        info.className = 'admin-user-info';

        const name = document.createElement('strong');
        name.textContent = user.display_name || user.username || 'SquadChat member';
        if (user.role === 'admin') {
          const badge = document.createElement('span');
          badge.className = 'admin-badge';
          badge.textContent = 'ADMIN ✓';
          name.append(' ', badge);
        }

        const handle = document.createElement('small');
        handle.textContent = '@' + (user.username || 'unknown');
        const details = document.createElement('small');
        details.className = 'admin-user-meta';
        details.textContent = 'Joined: ' + formatAdminDate(user.created_at);

        info.append(name, handle, details);
        if (user.account_status === 'suspended') {
          const statusLabel = document.createElement('span');
          statusLabel.className = 'admin-status is-suspended';
          statusLabel.textContent = 'Suspended';
          info.append(statusLabel);
        }

        const actions = document.createElement('div');
        actions.className = 'admin-user-actions';
        const detailsButton = document.createElement('button');
        detailsButton.type = 'button';
        detailsButton.className = 'btn secondary small';
        detailsButton.textContent = 'View details';
        detailsButton.onclick = () => void openUserDetails(user, detailsButton);
        actions.append(detailsButton);
        if (user.id === currentUser?.id) {
          const self = document.createElement('span');
          self.className = 'tiny';
          self.textContent = 'You';
          actions.append(self);
        } else {
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'btn secondary small';
          toggle.textContent = user.account_status === 'suspended' ? 'Reactivate' : 'Suspend';
          toggle.onclick = async () => {
            const nextStatus = user.account_status === 'suspended' ? 'active' : 'suspended';
            if (!confirm((nextStatus === 'suspended' ? 'Suspend' : 'Reactivate') + ' @' + user.username + '?')) return;
            toggle.disabled = true;
            try {
              const actionResult = await callAdminApi<{audit_logged?: boolean}>({
                action: 'set_status',
                user_id: user.id,
                status: nextStatus,
              });
              if (actionResult.audit_logged === false) {
                showAdminFeedback('Account status changed, but the activity record could not be saved.', 'warning');
              } else {
                showAdminFeedback('@' + user.username + ' is now ' + nextStatus + '.', 'success');
              }
              await Promise.all([renderStats(), renderUsers(), renderActivity()]);
            } catch (error) {
              notice((error as Error).message, 'error');
              toggle.disabled = false;
            }
          };

          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'btn danger small';
          remove.textContent = 'Delete';
          remove.onclick = async () => {
            const confirmed = await confirmAccountDeletion(user.username);
            if (!confirmed) return;
            remove.disabled = true;
            try {
              const actionResult = await callAdminApi<{audit_logged?: boolean}>({
                action: 'delete_user',
                user_id: user.id,
                confirmed: true,
              });
              showAdminFeedback(
                actionResult.audit_logged === false
                  ? '@' + user.username + ' was deleted, but the activity record could not be saved.'
                  : '@' + user.username + ' and their account content were permanently deleted.',
                actionResult.audit_logged === false ? 'warning' : 'success',
              );
              await Promise.all([renderStats(), renderUsers(), renderActivity()]);
            } catch (error) {
              showAdminFeedback(
                'Could not delete @' + user.username + ': ' + ((error as Error).message || 'Unknown error'),
                'error',
              );
              remove.disabled = false;
            }
          };
          actions.append(toggle, remove);
        }

        row.append(info, actions);
        list.append(row);
      });
    } catch (error) {
      list.replaceChildren();
      const message = document.createElement('div');
      message.className = 'notice error';
      message.textContent = (error as Error).message || 'Could not load users.';
      list.append(message);
    }
  };

  const renderActivity = async () => {
    const list = el<HTMLDivElement>('adminActivityList');
    list.innerHTML = '<div class="empty">Loading activity…</div>';
    try {
      const result = await callAdminApi<{events: Array<any>}>({ action: 'list_activity' });
      list.replaceChildren();
      if (!result.events.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No admin activity has been recorded yet.';
        list.append(empty);
        return;
      }

      result.events.forEach(event => {
        const row = document.createElement('article');
        row.className = 'admin-activity-row';
        const summary = document.createElement('div');
        summary.className = 'admin-activity-summary';
        const title = document.createElement('strong');
        const actor = '@' + (event.admin_username || 'admin');
        const target = '@' + (event.target_username || 'account');
        if (event.action === 'suspend_user') title.textContent = actor + ' suspended ' + target;
        else if (event.action === 'reactivate_user') title.textContent = actor + ' reactivated ' + target;
        else if (event.action === 'delete_user') title.textContent = actor + ' deleted ' + target;
        else title.textContent = actor + ' performed ' + String(event.action || 'an action').replaceAll('_', ' ');

        const detail = document.createElement('small');
        detail.textContent = formatAdminDate(event.created_at);
        summary.append(title, detail);
        if (event.action === 'delete_user' && typeof event.details?.storage_files_removed === 'number') {
          const extra = document.createElement('small');
          extra.textContent = event.details.storage_files_removed + ' stored file(s) removed';
          summary.append(extra);
        }
        row.append(summary);
        list.append(row);
      });
    } catch (error) {
      list.replaceChildren();
      const message = document.createElement('div');
      message.className = 'notice error';
      message.textContent = (error as Error).message || 'Could not load admin activity.';
      list.append(message);
    }
  };

  const refreshAll = async () => {
    await Promise.all([renderStats(), renderUsers()]);
  };

  el<HTMLDetailsElement>('adminActivityDetails').addEventListener('toggle', () => {
    if (el<HTMLDetailsElement>('adminActivityDetails').open) void renderActivity();
  });

  el<HTMLInputElement>('adminUserSearch').addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void renderUsers(), 250);
  });
  el<HTMLSelectElement>('adminUserStatusFilter').addEventListener('change', () => void renderUsers());
  el<HTMLSelectElement>('adminUserRoleFilter').addEventListener('change', () => void renderUsers());
  el<HTMLButtonElement>('refreshAdminUsers').onclick = () => void refreshAll();
  el<HTMLButtonElement>('refreshAdminActivity').onclick = () => void renderActivity();

  try {
    await refreshAll();
  } catch (error) {
    notice((error as Error).message || 'Could not open the admin dashboard.', 'error');
  }
}

el<HTMLButtonElement>('adminPanelButton').addEventListener('click', () => void openAdminPanel());

async function loadProfile() {
  if (!currentUser) return;
  const db = requireClient();
  const { data, error } = await db
    .from('profiles')
    .select('username,display_name,bio,avatar_seed,profile_photo_url,role')
    .eq('id', currentUser.id)
    .maybeSingle();
  if (error) throw error;
  const username = data?.username || 'profile not ready';
  currentUserRole = data?.role === 'admin' ? 'admin' : 'user';
  el<HTMLButtonElement>('adminPanelButton').hidden = currentUserRole !== 'admin';
  const displayName = data?.display_name?.trim() || '';
  el<HTMLElement>('profileName').textContent = displayName || '@' + username;
  el<HTMLElement>('profileEmail').textContent = '@' + username + (currentUser.email ? ' · ' + currentUser.email : '');
  currentUsername = username;
  currentAvatarSeed = data?.avatar_seed || '';
  const profilePhotoUrl = data?.profile_photo_url || '';
  const avatar = document.getElementById('profileAvatar');
  if (avatar) {
    avatar.textContent = profilePhotoUrl || currentAvatarSeed ? '' : (displayName || username || 'SC').trim().slice(0, 2).toUpperCase();
    avatar.style.backgroundImage = profilePhotoUrl ? `url("${profilePhotoUrl}")` : currentAvatarSeed ? `url("${avatarUrl(currentAvatarSeed)}")` : '';
    avatar.classList.toggle('has-avatar-image', !!(profilePhotoUrl || currentAvatarSeed));
  }
}
async function loadChatsFromServer() {
  if (!currentUser) return;
  const userId = currentUser.id;
  const db = requireClient();
  const { data, error } = await db
    .from('conversation_members')
    .select('conversation_id, conversations(id,title,is_group,created_at,group_cover_url)')
    .eq('user_id', userId);
  if (error) throw error;

  const loaded = (data || []).map((row: any) => row.conversations).filter(Boolean) as Chat[];
  if (!loaded.length) {
    if (currentUser?.id !== userId) return;
    chats = [];
    chatListLoading = false;
    renderChats();
    void openPendingNotificationChat();
    return;
  }

  const conversationIds = loaded.map(chat => chat.id);
  const { data: memberships, error: membershipsError } = await db
    .from('conversation_members').select('conversation_id,user_id')
    .in('conversation_id', conversationIds);
  if (membershipsError) throw membershipsError;
  const memberIds = [...new Set((memberships || []).map((member: any) => member.user_id))];
  const { data: profiles, error: profilesError } = await db
    .from('profiles')
    .select('id,username,display_name,avatar_seed,profile_photo_url,role,last_seen_at')
    .in('id', memberIds);
  if (profilesError) throw profilesError;
  if (currentUser?.id !== userId) return;

  const profileById = new Map((profiles || []).map((profile: any) => [profile.id, profile]));
  (profiles || []).forEach((profile: any) => {
    if (profile.avatar_seed) avatarSeedByUserId.set(profile.id, profile.avatar_seed);
    else avatarSeedByUserId.delete(profile.id);
    if (profile.profile_photo_url) avatarPhotoByUserId.set(profile.id, profile.profile_photo_url);
    else avatarPhotoByUserId.delete(profile.id);
    if (profile.display_name) senderNameByUserId.set(profile.id, profile.display_name);
    if (profile.username) senderUsernameByUserId.set(profile.id, profile.username);
    if (profile.last_seen_at) lastSeenCache.set(profile.id, profile.last_seen_at);
    else lastSeenCache.delete(profile.id);
    senderProfileLoadedIds.add(profile.id);
  });

  const membersByChat = new Map<string, string[]>();
  (memberships || []).forEach((member: any) => {
    const ids = membersByChat.get(member.conversation_id) || [];
    ids.push(member.user_id);
    membersByChat.set(member.conversation_id, ids);
  });
  const namedChats = loaded.map(chat => {
    if (chat.is_group) return chat;
    const otherId = (membersByChat.get(chat.id) || []).find(id => id !== userId);
    const profile: any = otherId ? profileById.get(otherId) : null;
    const displayName = profile?.display_name?.trim() || profile?.username || '';
    const peerUnavailable = !otherId || !profile;
    return {
      ...chat,
      ...(peerUnavailable ? { title: 'User not available' } : displayName ? { title: displayName } : {}),
      avatar_seed: profile?.avatar_seed || null,
      avatar_url: profile?.profile_photo_url || null,
      peer_id: otherId || null,
      peer_username: profile?.username || '',
      peer_is_admin: profile?.role === 'admin',
      peer_is_unavailable: peerUnavailable,
    };
  });

  const peerIds = [...new Set(namedChats.map(chat => chat.peer_id).filter((id): id is string => !!id))];
  const [peerStatusEntries, recentMessagesResult, recentReactionsResult, readRowsResult] = await Promise.all([
    Promise.all(peerIds.map(async id => [id, await getPeerAccountStatus(id)] as const)),
    db.from('messages').select('id,conversation_id,content,created_at,sender_id')
      .in('conversation_id', conversationIds).order('created_at', { ascending: false }),
    db.from('message_reactions').select('message_id,conversation_id,user_id,emoji,created_at')
      .in('conversation_id', conversationIds).order('created_at', { ascending: false }).limit(500),
    db.from('conversation_reads').select('conversation_id,last_read_at')
      .eq('user_id', userId).in('conversation_id', conversationIds),
  ]);
  if (currentUser?.id !== userId) return;
  if (recentMessagesResult.error) throw recentMessagesResult.error;
  if (readRowsResult.error) throw readRowsResult.error;

  const reactionMessageIds = [...new Set((recentReactionsResult.data || []).map((reaction: any) => reaction.message_id))];
  const reactionSenderByMessage = new Map<string, string>();
  if (!recentReactionsResult.error && reactionMessageIds.length) {
    const reactionMessages = await db.from('messages').select('id,sender_id').in('id', reactionMessageIds);
    if (!reactionMessages.error) {
      (reactionMessages.data || []).forEach((message: any) => reactionSenderByMessage.set(message.id, message.sender_id));
    }
  }
  const latestOwnMessageReactions = new Map<string, any>();
  if (!recentReactionsResult.error) {
    for (const reaction of recentReactionsResult.data || []) {
      if (reaction.user_id === userId || reactionSenderByMessage.get(reaction.message_id) !== userId) continue;
      if (!latestOwnMessageReactions.has(reaction.conversation_id)) latestOwnMessageReactions.set(reaction.conversation_id, reaction);
    }
  }

  const peerStatuses = new Map<string, PeerAccountStatus>(peerStatusEntries);
  const namedChatsWithStatus = namedChats.map(chat => ({
    ...chat,
    peer_is_suspended: chat.peer_id ? peerStatuses.get(chat.peer_id) === 'suspended' : false,
  }));
  const readAtByChat = new Map((readRowsResult.data || []).map((row: any) => [row.conversation_id, row.last_read_at]));
  const latest = new Map<string, { id: string; content: string; created_at: string; sender_id: string }>();
  const unreadCounts = new Map<string, number>();
  for (const message of recentMessagesResult.data || []) {
    if (!latest.has(message.conversation_id)) latest.set(message.conversation_id, message);
    const readAt = readAtByChat.get(message.conversation_id);
    if (message.sender_id !== userId && (!readAt || new Date(message.created_at).getTime() > new Date(readAt).getTime())) {
      unreadCounts.set(message.conversation_id, (unreadCounts.get(message.conversation_id) || 0) + 1);
    }
  }
  chats = namedChatsWithStatus.map(chat => {
    const message = latest.get(chat.id);
    const reaction = latestOwnMessageReactions.get(chat.id);
    const reactionIsLatest = !!reaction && new Date(reaction.created_at).getTime() > new Date(message?.created_at || chat.created_at).getTime();
    return {
      ...chat,
      last_message: reactionIsLatest ? REACTION_PREVIEW_PREFIX + reaction.emoji : (message?.content || ''),
      last_message_sender_id: message?.sender_id || '',
      last_message_id: message?.id || '',
      last_activity: reactionIsLatest ? reaction.created_at : (message?.created_at || chat.created_at),
      last_activity_actor_id: reactionIsLatest ? reaction.user_id : undefined,
      unread_count: unreadCounts.get(chat.id) || 0,
    };
  });
  chats.sort((a, b) => new Date(b.last_activity || b.created_at).getTime() - new Date(a.last_activity || a.created_at).getTime());
  chatListLoading = false;
  renderChats();
  void openPendingNotificationChat();
}
async function loadChats() {
  if (!currentUser) return;
  if (chatListLoadPromise) return chatListLoadPromise;
  const userId = currentUser.id;
  const task = (async () => {
    if (chatListCacheHydratedUserId !== userId) {
      const cached = await getOfflineChatList<Chat>(userId).catch(() => null);
      if (currentUser?.id !== userId) return;
      chatListCacheHydratedUserId = userId;
      if (cached) {
        chats = cached;
        chatListLoading = false;
        renderChats();
        void openPendingNotificationChat();
      }
    }
    if (!navigator.onLine) {
      chatListLoading = false;
      renderChats();
      setConnection('Offline · showing saved conversations', false);
      void openPendingNotificationChat();
      return;
    }
    try {
      await loadChatsFromServer();
      if (currentUser?.id === userId) {
        await saveOfflineChatList(userId, chats);
        void syncOfflineQueue();
      }
    } catch (error) {
      if (currentUser?.id !== userId) return;
      if (!chats.length) throw error;
      setConnection('Connected · showing saved conversations while refreshing', true);
      console.warn('SquadChat background conversation refresh failed:', (error as Error).message);
    }
  })();
  chatListLoadPromise = task;
  try {
    await task;
  } finally {
    if (chatListLoadPromise === task) chatListLoadPromise = null;
  }
}
async function syncOfflineQueue() {
  if (!currentUser || !supabase || !navigator.onLine || suspendedLockActive || offlineQueueSyncBusy) return;
  offlineQueueSyncBusy = true;
  const userId = currentUser.id;
  try {
    const duplicateQueueIds = await removeDuplicateQueuedPhotoAlbums(userId);
    duplicateQueueIds.forEach(id => {
      removeMessage(id);
      (offlinePhotoPreviewUrls.get(id) || []).forEach(url => URL.revokeObjectURL(url));
      offlinePhotoPreviewUrls.delete(id);
    });
    if (!(await checkAccountStatus())) return;
    const pending = await getOfflineQueue();
    for (const item of pending) {
      if (!currentUser || currentUser.id !== userId || item.user_id !== userId) break;
      const chat = chats.find(entry => entry.id === item.conversation_id);
      if (!chat || chat.peer_is_unavailable || chat.peer_is_suspended) continue;
      if (!chat.is_group && chat.peer_id && await getPeerAccountStatus(chat.peer_id) !== 'active') continue;
      const db = requireClient();
      const membership = await db.from('conversation_members').select('conversation_id').eq('conversation_id', item.conversation_id).eq('user_id', userId).maybeSingle();
      if (membership.error || !membership.data) continue;
      let content = item.content || '';
      if (item.kind === 'photos') {
        const urls: string[] = [];
        for (let index = 0; index < (item.files || []).length; index++) {
          const fileData = item.files![index];
          const extension = fileData.type === 'image/jpeg' ? 'jpg' : (fileData.type.split('/')[1] || 'jpg');
          const folder = item.conversation_id + '/' + userId;
          const filename = 'offline-' + item.id + '-' + index + '.' + extension;
          const path = folder + '/' + filename;
          const storage = db.storage.from('squadchat-images');
          const existing = await storage.list(folder, { search: filename, limit: 100 });
          if (existing.error) throw existing.error;
          const alreadyUploaded = (existing.data || []).some(file => file.name === filename);
          if (!alreadyUploaded) {
            const upload = await storage.upload(path, fileData.blob, { contentType: fileData.type, upsert: false });
            if (upload.error) {
              const confirmed = await storage.list(folder, { search: filename, limit: 100 });
              if (confirmed.error || !(confirmed.data || []).some(file => file.name === filename)) throw upload.error;
            }
          }
          urls.push(storage.getPublicUrl(path).data.publicUrl);
        }
        content = urls.length === 1 ? 'IMG:' + urls[0] : 'IMGSET:' + JSON.stringify(urls);
      }
      const inserted = await db.from('messages').insert({ id: item.id, conversation_id: item.conversation_id, sender_id: userId, content }).select('id,conversation_id,sender_id,content,created_at').single();
      let savedMessage = inserted.data as Message | null;
      if (inserted.error) {
        if (inserted.error.code !== '23505') throw inserted.error;
        const existing = await db.from('messages').select('id,conversation_id,sender_id,content,created_at').eq('id', item.id).eq('conversation_id', item.conversation_id).eq('sender_id', userId).maybeSingle();
        if (existing.error || !existing.data || existing.data.content !== content) throw inserted.error;
        savedMessage = existing.data as Message;
      }
      await removeOfflineQueueItem(item.id);
      if (savedMessage) {
        await upsertOfflineMessage(userId, item.conversation_id, savedMessage).catch(error => console.warn('Could not refresh saved offline conversation history:', error));
        if (item.kind === 'photos') void cacheOfflineMessagePhotos(userId, [savedMessage]);
      }
      if (savedMessage && currentChat?.id === item.conversation_id) {
        if (item.kind === 'photos') {
          removeMessage(item.id);
          (offlinePhotoPreviewUrls.get(item.id) || []).forEach(url => URL.revokeObjectURL(url));
          offlinePhotoPreviewUrls.delete(item.id);
        }
        addMessage(savedMessage);
        const receipt = el<HTMLDivElement>('messages').querySelector<HTMLElement>('[data-message-id="' + CSS.escape(savedMessage.id) + '"] .read-receipt');
        if (receipt) receipt.textContent = 'Sent';
      }
    }
    if (currentUser?.id === userId) await loadChats().catch(() => {});
    const remaining = (await getOfflineQueue()).filter(item => item.user_id === userId).length;
    setConnection(remaining ? remaining + ' message(s) waiting to sync' : 'Connected · messages synced', true);
  } catch (error) {
    console.warn('SquadChat offline queue sync paused:', (error as Error).message);
    setConnection('Connection restored · retrying queued messages', false);
  } finally {
    offlineQueueSyncBusy = false;
  }
}

function formatLastSeen(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < 60_000) return '1m';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.min(7, Math.max(1, Math.floor(elapsed / 86_400_000)));
  return `${days}d`;
}
function startPresence() {
  if (!supabase || !currentUser) return;
  if (chatListSyncTimer) clearInterval(chatListSyncTimer);
  if (lastSeenHeartbeatTimer) clearInterval(lastSeenHeartbeatTimer);
  if (presenceLabelRefreshTimer) clearInterval(presenceLabelRefreshTimer);
  chatListSyncTimer = setInterval(() => {
    if (!currentUser || document.visibilityState !== 'visible' || chatListSyncBusy) return;
    chatListSyncBusy = true;
    void loadChats().catch(() => {}).finally(() => { chatListSyncBusy = false; });
  }, 30000);
  if (presenceChannel) void supabase.removeChannel(presenceChannel);
  const db = supabase;
  presenceChannel = db.channel('squadchat-online-presence', { config: { presence: { key: currentUser.id } } });
  // Refresh the conversation list immediately when any participant sends a message.
  // This keeps unread badges and latest-message previews current while the list is open.
  presenceChannel.on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    payload => {
      const incoming = payload.new as Message;
      const chatIndex = chats.findIndex(chat => chat.id === incoming.conversation_id);
      if (chatIndex >= 0) {
        const chat = chats[chatIndex];
        if (chat.last_message_id !== incoming.id) {
          const isOpen = currentChat?.id === incoming.conversation_id;
          chats[chatIndex] = {
            ...chat,
            last_message: incoming.content,
            last_message_sender_id: incoming.sender_id,          last_message_id: incoming.id,
          last_activity: incoming.created_at,
          last_activity_actor_id: undefined,
          unread_count: incoming.sender_id !== currentUser?.id && !isOpen
              ? (chat.unread_count || 0) + 1
              : isOpen ? 0 : (chat.unread_count || 0),
          };
          chats.sort((a, b) => new Date(b.last_activity || b.created_at).getTime() - new Date(a.last_activity || a.created_at).getTime());
          renderChats();
        }
      } else {
        void loadChats().catch(() => {});
      }
      if (currentChat?.id === incoming.conversation_id) {
        void syncNewMessages(incoming.conversation_id);
      }
    }
  );
  // Rebuild the latest activity preview when a reaction is added or removed.
  presenceChannel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'message_reactions' },
    () => { void loadChats().catch(() => {}); }
  );
  const refreshOnline = () => {
    onlineUsers.clear();
    const state = presenceChannel?.presenceState() || {};
    Object.entries(state).forEach(([userId, entries]) => {
      if (entries.length) onlineUsers.add(userId);
    });
    document.querySelectorAll<HTMLElement>('[data-presence-user]').forEach(node => {
      const userId = node.dataset.presenceUser || '';
      const online = onlineUsers.has(userId);
      if (node.classList.contains('conversation-presence-dot')) {
        node.classList.toggle('is-online', online);
        node.title = online ? 'Online' : 'Offline';
        node.setAttribute('aria-label', online ? 'Online' : 'Offline');
      } else if (node.classList.contains('conversation-presence-text')) {
        node.textContent = online ? '' : formatLastSeen(lastSeenCache.get(userId));
        node.classList.toggle('presence-online', online);
        node.classList.toggle('presence-offline', !online);
      } else {
        node.textContent = online ? '● Online' : formatLastSeen(lastSeenCache.get(userId));
        node.classList.toggle('presence-online', online);
        node.classList.toggle('presence-offline', !online);
      }
    });
    // Presence is displayed in the conversation list, not in the chat header.
  };
  presenceChannel.on('presence', { event: 'sync' }, refreshOnline);
  presenceChannel.on('presence', { event: 'join' }, refreshOnline);
  presenceChannel.on('presence', { event: 'leave' }, refreshOnline);
  presenceChannel.subscribe(async state => {
    if (state === 'SUBSCRIBED') {
      const timestamp = new Date().toISOString();
      lastSeenCache.set(currentUser!.id, timestamp);
      await Promise.all([
        presenceChannel?.track({ user_id: currentUser!.id, username: currentUsername, online_at: timestamp }),
        supabase?.from('profiles').update({ last_seen_at: timestamp }).eq('id', currentUser!.id)
      ]);
      setConnection('Online presence active', true);
      lastSeenHeartbeatTimer = setInterval(() => {
        if (!currentUser || !supabase || document.visibilityState !== 'visible') return;
        const activeAt = new Date().toISOString();
        lastSeenCache.set(currentUser.id, activeAt);
        void supabase.from('profiles').update({ last_seen_at: activeAt }).eq('id', currentUser.id);
      }, 60_000);
      presenceLabelRefreshTimer = setInterval(() => {
        document.querySelectorAll<HTMLElement>('.conversation-presence-text[data-presence-user]').forEach(node => {
          const userId = node.dataset.presenceUser || '';
          if (!onlineUsers.has(userId)) node.textContent = formatLastSeen(lastSeenCache.get(userId));
        });
      }, 60_000);
    }
  });
  const markOffline = () => {
    if (!currentUser || !supabase) return;
    const timestamp = new Date().toISOString();
    lastSeenCache.set(currentUser.id, timestamp);
    void supabase.from('profiles').update({ last_seen_at: timestamp }).eq('id', currentUser.id);
  };
  window.addEventListener('pagehide', markOffline, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') markOffline();
    else if (presenceChannel && currentUser) {
      const activeAt = new Date().toISOString();
      lastSeenCache.set(currentUser.id, activeAt);
      void supabase?.from('profiles').update({ last_seen_at: activeAt }).eq('id', currentUser.id);
      void presenceChannel.track({ user_id: currentUser.id, username: currentUsername, online_at: activeAt });
    }
  });
}
async function deleteConversation(chat: Chat) {
  if (!currentUser) return;
  const label = chat.title || (chat.is_group ? 'this group' : 'this private conversation');
  if (!confirm('Remove "' + label + '" from your chat list? The messages and other members’ access will remain.')) return;
  try {
    const db = requireClient();
    const result = await db
      .from('conversation_members')
      .delete()
      .eq('conversation_id', chat.id)
      .eq('user_id', currentUser.id)
      .select('conversation_id,user_id');
    if (result.error) throw result.error;
    if (!result.data || result.data.length === 0) {
      throw new Error('The conversation was not removed from the database. Refresh and try again. If this keeps happening, the Supabase delete policy needs to be checked.');
    }
    chats = chats.filter(item => item.id !== chat.id);
    if (currentChat?.id === chat.id) {
      currentChat = null;
      el<HTMLHeadingElement>('chatTitle').textContent = 'Choose a conversation';
      el<HTMLParagraphElement>('chatSubtitle').textContent = 'Select a chat or find a friend to start.';
      el<HTMLElement>('chatKind').textContent = 'READY';
      el<HTMLButtonElement>('groupSettingsButton').hidden = true;
      el<HTMLElement>('messages').innerHTML = '<div class="empty">Conversation removed from your chat list.</div>';
      el<HTMLInputElement>('messageInput').disabled = true;
      el<HTMLButtonElement>('sendButton').disabled = true;
      el<HTMLButtonElement>('attachImageButton').disabled = true;
    }
    await loadChats();
    if (chats.some(item => item.id === chat.id)) {
      throw new Error('The conversation still appears in your chat list after removal. The database membership may still exist; please try again and check Supabase permissions.');
    }
    notice('Conversation removed from your chat list. Messages were kept for other members.', 'success');
  } catch (err) {
    notice((err as Error).message || 'Could not remove this conversation.', 'error');
  }
}

const conversationAvatarNodes = new Map<string, { url: string; image: HTMLImageElement }>();

function renderChats() {
  const list = el<HTMLDivElement>('chatList');
  list.replaceChildren();
  if (chatListLoading) {
    const loading = document.createElement('div');
    loading.className = 'chat-list-loading';
    loading.setAttribute('role', 'status');
    loading.textContent = 'Loading your chats…';
    list.append(loading);
    return;
  }
  const searchTerm = el<HTMLInputElement>('conversationSearch')?.value.trim().toLowerCase() || '';
  const visibleChats = chats.filter(chat => {
    const title = (chat.title || (chat.is_group ? 'Group chat' : 'Private chat')).toLowerCase();
    const username = (chat.peer_username || '').toLowerCase();
    return title.includes(searchTerm) || username.includes(searchTerm);
  });
  if (!chats.length) {
    const empty = document.createElement('div');
    empty.className = 'empty chat-list-empty';
    empty.textContent = 'No chats yet. Search for a friend or create a group.';
    list.append(empty);
    return;
  }
  if (!visibleChats.length) {
    const empty = document.createElement('div');
    empty.className = 'empty chat-list-empty';
    empty.textContent = 'No conversations found.';
    list.append(empty);
    return;
  }
  visibleChats.forEach(chat => {
    const row = document.createElement('div');
    row.className = 'chat-item-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-item' + (currentChat?.id === chat.id ? ' active' : '');
    const avatar = document.createElement('span');
    avatar.className = 'avatar chat-avatar' + (chat.is_group ? ' group-avatar' : '');
    avatar.textContent = initials(chat.title || 'Chat');
    const avatarImageUrl = chat.is_group
      ? (chat.group_cover_url || '')
      : (chat.avatar_url || (chat.avatar_seed ? avatarUrl(chat.avatar_seed) : ''));
    if (avatarImageUrl) {
      avatar.textContent = '';
      const avatarCacheKey = chat.id;
      let cachedAvatar = conversationAvatarNodes.get(avatarCacheKey);
      if (!cachedAvatar || cachedAvatar.url !== avatarImageUrl) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'eager';
        image.decoding = 'async';
        image.src = avatarImageUrl;
        cachedAvatar = { url: avatarImageUrl, image };
        conversationAvatarNodes.set(avatarCacheKey, cachedAvatar);
        image.onerror = () => {
          if (conversationAvatarNodes.get(avatarCacheKey)?.image === image) {
            conversationAvatarNodes.delete(avatarCacheKey);
            image.remove();
            avatar.textContent = initials(chat.title || 'Chat');
          }
        };
      }
      avatar.append(cachedAvatar.image);
      avatar.classList.add('has-avatar-image');
    }
    const avatarWrap = document.createElement('span');
    avatarWrap.className = 'chat-avatar-wrap';
    avatarWrap.append(avatar);
    if (!chat.is_group && chat.peer_id) {
      const presenceDot = document.createElement('span');
      presenceDot.className = 'conversation-presence-dot' + (onlineUsers.has(chat.peer_id) ? ' is-online' : '');
      presenceDot.dataset.presenceUser = chat.peer_id;
      presenceDot.title = onlineUsers.has(chat.peer_id) ? 'Online' : 'Offline';
      presenceDot.setAttribute('aria-label', presenceDot.title);
      avatarWrap.append(presenceDot);
      const presenceText = document.createElement('small');
      presenceText.className = 'conversation-presence-text ' + (onlineUsers.has(chat.peer_id) ? 'presence-online' : 'presence-offline');
      presenceText.dataset.presenceUser = chat.peer_id;
      presenceText.textContent = onlineUsers.has(chat.peer_id) ? '' : formatLastSeen(lastSeenCache.get(chat.peer_id));
      avatarWrap.append(presenceText);
    }
    const meta = document.createElement('span');
    meta.className = 'chat-meta';
    const topLine = document.createElement('span');
    topLine.className = 'chat-item-topline';
    const title = document.createElement('strong');
    title.textContent = chat.peer_is_unavailable ? 'User not available' : chat.title || (chat.is_group ? 'Group chat' : 'Private chat');
    if (chat.peer_is_unavailable) row.classList.add('chat-item-unavailable');
    if (!chat.is_group && chat.peer_is_admin && !chat.peer_is_suspended) {
      const badge = document.createElement('span');
      badge.className = 'admin-badge';
      badge.textContent = 'ADMIN ✓';
      title.append(' ', badge);
    }
    const activity = document.createElement('time');
    activity.className = 'chat-activity';
    const activityDate = new Date(chat.last_activity || chat.created_at);
    activity.textContent = activityDate.toDateString() === new Date().toDateString()
      ? activityDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
      : activityDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
    topLine.append(title, activity);
    const subtitle = document.createElement('small');
    subtitle.className = 'chat-preview';
    const lastMessage = chat.last_message || '';
    const isReactionPreview = lastMessage.startsWith(REACTION_PREVIEW_PREFIX);
    const reactionEmoji = isReactionPreview ? lastMessage.slice(REACTION_PREVIEW_PREFIX.length) : '';
    const reactionActorName = chat.last_activity_actor_id
      ? (senderNameByUserId.get(chat.last_activity_actor_id) || senderUsernameByUserId.get(chat.last_activity_actor_id) || 'Someone')
      : 'Someone';
    const decodedLastMessage = decodeReplyContent(lastMessage);
    const isReplyMessage = !!decodedLastMessage.reply;
    const groupSenderName = chat.is_group && chat.last_message_sender_id
      ? (senderNameByUserId.get(chat.last_message_sender_id) || senderUsernameByUserId.get(chat.last_message_sender_id) || 'Member')
      : '';
    const isPhotoMessage = /\/storage\/v1\/object\/(?:public|sign)\/squadchat-images\//i.test(lastMessage) || /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?$/i.test(lastMessage);
    subtitle.textContent = chat.peer_is_unavailable
      ? 'This account is no longer available · Messaging disabled'
      : isReactionPreview
        ? (chat.is_group ? reactionActorName + ': Reacted ' + reactionEmoji + ' to your message' : 'Reacted ' + reactionEmoji + ' to your message')
        : isReplyMessage
        ? (chat.is_group
            ? (groupSenderName + ': ' + (decodedLastMessage.text.trim() || 'Replied to a message'))
            : (chat.last_message_sender_id === currentUser?.id ? 'You replied to a message' : 'Replied to a message'))
        : isPhotoMessage
          ? (chat.last_message_sender_id === currentUser?.id ? 'Photo sent' : 'Sent a photo')
          : (lastMessage || (chat.is_group ? 'Group conversation' : 'Start a conversation'));
    meta.append(topLine, subtitle);
    if ((chat.unread_count || 0) > 0 && currentChat?.id !== chat.id) {
      const unread = document.createElement('span');
      unread.className = 'unread-badge';
      unread.textContent = chat.unread_count! > 99 ? '99+' : String(chat.unread_count);
      unread.setAttribute('aria-label', `${chat.unread_count} unread messages`);
      button.append(avatarWrap, meta, unread);
    } else {
      button.append(avatarWrap, meta);
    }
    let holdTriggered = false;
    let holdTimer: number | undefined;
    const clearHold = () => {
      if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      holdTimer = undefined;
    };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      holdTriggered = false;
      clearHold();
      holdTimer = window.setTimeout(() => {
        holdTriggered = true;
        void deleteConversation(chat);
      }, 650);
    });
    button.addEventListener('pointerup', clearHold);
    button.addEventListener('pointerleave', clearHold);
    button.addEventListener('pointercancel', clearHold);
    button.addEventListener('contextmenu', event => event.preventDefault());
    button.addEventListener('click', event => {
      if (holdTriggered) {
        event.preventDefault();
        event.stopImmediatePropagation();
        holdTriggered = false;
        return;
      }
      void openChat(chat);
    });
    row.append(button);
    list.append(row);
  });
}
el<HTMLInputElement>('conversationSearch').addEventListener('input', () => {
  el<HTMLButtonElement>('clearConversationSearch').hidden = !el<HTMLInputElement>('conversationSearch').value;
  renderChats();
});
el<HTMLInputElement>('conversationSearch').addEventListener('search', () => {
  el<HTMLButtonElement>('clearConversationSearch').hidden = !el<HTMLInputElement>('conversationSearch').value;
  renderChats();
});
el<HTMLButtonElement>('clearConversationSearch').addEventListener('click', () => {
  const search = el<HTMLInputElement>('conversationSearch');
  search.value = '';
  el<HTMLButtonElement>('clearConversationSearch').hidden = true;
  renderChats();
  search.focus();
});
async function findProfiles(names: string[]) {
  const db = requireClient();
  const normalized = [
    ...new Set(
      names
        .map(name => name.trim().replace(/^@/, ''))
        .filter(Boolean)
        .map(name => name.toLowerCase())
    ),
  ];
  if (!normalized.length) throw new Error('Enter at least one username.');
  if (normalized.some(name => !/^[a-zA-Z0-9_]{3,20}$/.test(name)))
    throw new Error(
      'Usernames can contain only letters, numbers, and underscores.'
    );
  // Compare usernames case-insensitively so a profile named "Fiery"
  // can still be found when someone types "fiery" or "FIERY".
  const { data, error } = await db
    .from('profiles')
    .select('id,username');
  if (error) throw error;
  const allProfiles = data || [];
  const found = allProfiles.filter(profile =>
    normalized.includes(profile.username.toLowerCase())
  );
  const foundNames = found.map(profile => profile.username.toLowerCase());
  const missing = normalized.filter(name => !foundNames.includes(name));
  if (missing.length)
    throw new Error('Username not found: ' + missing.join(', '));
  if (found.some(profile => profile.id === currentUser?.id))
    throw new Error('You cannot add your own username.');
  return found;
}
async function createConversation(
  members: { id: string; username: string }[],
  isGroup: boolean,
  title: string
) {
  if (!currentUser) throw new Error('Please log in again.');
  const db = requireClient();
  const { data: chat, error: chatError } = await db
    .from('conversations')
    .insert({
      title: title.trim() || (isGroup ? 'Group chat' : 'Private chat'),
      is_group: isGroup,
      created_by: currentUser.id,
    })
    .select('id,title,is_group,created_at')
    .single();
  if (chatError) throw chatError;
  const memberRows = [currentUser.id, ...members.map(member => member.id)].map(
    user_id => ({ conversation_id: chat.id, user_id, role: user_id === currentUser!.id ? 'admin' : 'member' })
  );
  const creatorInsert = await db.from('conversation_members').insert(memberRows[0]);
  if (creatorInsert.error) throw new Error('Could not add the group creator: ' + creatorInsert.error.message);
  const otherMembers = memberRows.slice(1);
  if (otherMembers.length) {
    const { error: memberError } = await db.from('conversation_members').insert(otherMembers);
    if (memberError) throw new Error('Group created, but adding members failed: ' + memberError.message);
  }
  await loadChats();
  await openChat({ ...chat, group_cover_url: null } as Chat);
}
el<HTMLFormElement>('searchForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const name = el<HTMLInputElement>('friendSearch').value.trim();
    const found = await findProfiles([name]);
    const profile = found[0];
    const { data: presenceProfile, error: presenceError } = await requireClient().from('profiles').select('last_seen_at').eq('id', profile.id).maybeSingle();
    if (presenceError) throw presenceError;
    if (presenceProfile?.last_seen_at) lastSeenCache.set(profile.id, presenceProfile.last_seen_at);
    const box = el<HTMLDivElement>('searchResult');
    box.replaceChildren();
    const row = document.createElement('div');
    row.className = 'notice';
    const text = document.createElement('div');
    text.textContent = '@' + profile.username;
    const status = document.createElement('small');
    status.className = 'presence-status ' + (onlineUsers.has(profile.id) ? 'presence-online' : 'presence-offline');
    status.dataset.presenceUser = profile.id;
    status.textContent = onlineUsers.has(profile.id) ? '● Online' : formatLastSeen(lastSeenCache.get(profile.id));
    text.append(document.createElement('br'), status);
    const button = document.createElement('button');
    button.className = 'btn small message-open-button';
    button.textContent = 'Message';
    button.addEventListener('click', async () => {
      // Lock synchronously before the first await. A second tap cannot start another request.
      if (directMessageInProgress || button.disabled) return;
      directMessageInProgress = true;
      button.disabled = true;
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
      button.innerHTML = '<span class="button-spinner" aria-hidden="true"></span><span>Opening chat…</span>';
      try {
        // Reuse an existing one-to-one chat if this pair already shares one.
        const { data: memberships, error } = await requireClient()
          .from('conversation_members')
          .select(
            'conversation_id, conversations(id,title,is_group,created_at)'
          )
          .eq('user_id', currentUser!.id);
        if (error) throw error;
        const myChats = (memberships || [])
          .map((r: any) => r.conversations)
          .filter(Boolean) as (Chat & { is_group: boolean })[];
        for (const chat of myChats.filter(c => !c.is_group)) {
          const { data: people, error: peopleError } = await requireClient()
            .from('conversation_members')
            .select('user_id')
            .eq('conversation_id', chat.id);
          if (peopleError) throw peopleError;
          if (
            people?.length === 2 &&
            people.some(p => p.user_id === profile.id)
          ) {
            await openChat(chat);
            return;
          }
        }
        await createConversation(
          [profile],
          false,
          'Chat with @' + profile.username
        );
      } catch (error) {
        notice((error as Error).message, 'error');
      } finally {
        directMessageInProgress = false;
        button.disabled = false;
        button.classList.remove('is-loading');
        button.removeAttribute('aria-busy');
        button.textContent = 'Message';
      }
    });
    row.append(text, button);
    box.append(row);
    notice('Friend found.', 'success');
  } catch (error) {
    notice((error as Error).message, 'error');
  }
});
el<HTMLFormElement>('groupForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = el<HTMLFormElement>('groupForm');
  const createButton = el<HTMLButtonElement>('createGroupButton');
  if (createButton.disabled) return;
  createButton.disabled = true;
  createButton.textContent = 'Creating group…';
  try {
    const title = el<HTMLInputElement>('groupTitle').value.trim();
    if (!title || title.length > 60)
      throw new Error('Group name must be between 1 and 60 characters.');
    const members = await findProfiles(
      el<HTMLInputElement>('groupMembers').value.split(',')
    );
    if (members.length < 2)
      throw new Error('Add at least two friends for a group chat.');

    // Reuse a matching group instead of creating a second copy.
    const db = requireClient();
    const { data: memberships, error: membershipsError } = await db
      .from('conversation_members')
      .select('conversation_id, conversations(id,title,is_group,created_at,group_cover_url)')
      .eq('user_id', currentUser!.id);
    if (membershipsError) throw membershipsError;
    const myGroups = (memberships || [])
      .map((row: any) => row.conversations)
      .filter((chat: any) => chat && chat.is_group && chat.title?.trim().toLowerCase() === title.toLowerCase());
    const desiredIds = [currentUser!.id, ...members.map(member => member.id)].sort();
    for (const group of myGroups as (Chat & { is_group: boolean })[]) {
      const { data: groupMembers, error: groupMembersError } = await db
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', group.id);
      if (groupMembersError) throw groupMembersError;
      const existingIds = (groupMembers || []).map((member: any) => member.user_id).sort();
      if (existingIds.length === desiredIds.length && existingIds.every((id, index) => id === desiredIds[index])) {
        await openChat(group);
        notice('That group already exists. Opened the existing group.', 'success');
        return;
      }
    }

    await createConversation(members, true, title);
    el<HTMLInputElement>('groupTitle').value = '';
    el<HTMLInputElement>('groupMembers').value = '';
    notice('Group created.', 'success');
  } catch (error) {
    notice((error as Error).message, 'error');
  } finally {
    createButton.disabled = false;
    createButton.textContent = 'Create group';
  }
});

async function openGroupSettings() {
  const chat = currentChat; if (!chat || !chat.is_group || !currentUser) return;
  const root = el<HTMLDivElement>('modalRoot');
  root.innerHTML = '<div class="modal-backdrop" id="groupSettingsBackdrop"><section class="modal group-settings-modal" role="dialog" aria-modal="true" aria-labelledby="groupSettingsTitle"><div class="group-settings-heading"><div><p class="profile-eyebrow">YOUR SQUAD</p><h2 id="groupSettingsTitle">Group settings</h2><p class="muted">Manage your group and members.</p></div><button class="btn ghost small" id="closeGroupSettings" type="button" aria-label="Close group settings">✕</button></div><section class="group-settings-section"><h3>Group information</h3><div class="group-cover-preview" id="groupCoverPreview">Group cover photo</div><label for="renameGroupInput">Group name</label><div class="form-row"><input id="renameGroupInput" maxlength="60" value="' + escapeAttribute(chat.title || '') + '" placeholder="Enter group name"><button class="btn small" id="renameGroupButton" type="button">Save name</button></div><input id="groupCoverInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden><button class="btn secondary" id="changeGroupCover" type="button">Change cover photo</button></section><section class="group-settings-section"><h3>Group tools</h3><input id="groupMessageSearch" placeholder="Search messages in this group"><div id="groupSearchResults" class="group-tool-results"></div><button class="btn secondary" id="showGroupPins" type="button">Pinned messages</button><div id="groupPinsResults" class="group-tool-results"></div><label class="group-mute-toggle"><input id="muteGroupNotifications" type="checkbox"> Mute notifications for this group</label></section><section class="group-settings-section"><h3>Group members</h3><div id="groupMembersList">Loading members…</div></section><section class="group-settings-section"><h3>Add members</h3><label for="addGroupMembersInput">Usernames, separated by commas</label><input id="addGroupMembersInput" placeholder="alex, sam"><button class="btn" id="addGroupMembersButton" type="button">＋ Add members</button></section><section class="group-settings-section group-leave-section"><h3>Leave group</h3><p class="tiny">You will no longer see this group in your conversations.</p><button class="btn danger" id="leaveGroupButton" type="button">Leave group</button></section></section></div>';
  const close = () => {
    if (!root.querySelector('#groupSettingsBackdrop')) return;
    settingsBackdrop.classList.add('modal-exit-left');
    window.setTimeout(() => { if (root.contains(settingsBackdrop)) root.innerHTML = ''; }, 240);
  };
  const settingsBackdrop = el<HTMLDivElement>('groupSettingsBackdrop');
  settingsBackdrop.style.position = 'fixed';
  settingsBackdrop.style.inset = '0';
  settingsBackdrop.style.zIndex = '10000';
  settingsBackdrop.style.display = 'flex';
  settingsBackdrop.style.alignItems = 'center';
  settingsBackdrop.style.justifyContent = 'center';
  el<HTMLButtonElement>('closeGroupSettings').onclick = close;
  settingsBackdrop.onclick = event => { if (event.target === event.currentTarget) close(); };
  el<HTMLButtonElement>('renameGroupButton').onclick = async () => {
    const saveButton = el<HTMLButtonElement>('renameGroupButton');
    const input = el<HTMLInputElement>('renameGroupInput');
    const newTitle = input.value.trim();
    if (!newTitle) { notice('Please enter a group name.', 'error'); return; }
    if (newTitle.length > 60) { notice('Group names must be 60 characters or fewer.', 'error'); return; }
    if (newTitle === (chat.title || '')) { notice('The group name has not changed.', ''); return; }
    saveButton.disabled = true;
    try {
      const result = await requireClient().from('conversations').update({ title: newTitle }).eq('id', chat.id);
      if (result.error) throw result.error;
      chat.title = newTitle;
      if (currentChat?.id === chat.id) {
        currentChat.title = newTitle;
        el<HTMLHeadingElement>('chatTitle').textContent = newTitle;
      }
      await loadChats();
      notice('Group name updated.', 'success');
    } catch (err) {
      notice('Could not rename the group. ' + ((err as Error).message || ''), 'error');
    } finally {
      saveButton.disabled = false;
    }
  };
  const preview = el<HTMLDivElement>('groupCoverPreview'); if (chat.group_cover_url) preview.style.backgroundImage = 'linear-gradient(#0002,#0005),url("' + chat.group_cover_url + '")';
  let viewerIsGroupAdmin = false;
  const renderMembers = async () => {
    const db = requireClient();
    const list = el<HTMLDivElement>('groupMembersList');
    list.textContent = 'Loading members…';
    const result = await db.from('conversation_members').select('user_id,role').eq('conversation_id', chat.id).order('joined_at', { ascending: true });
    if (result.error) throw result.error;
    const memberships = result.data || [];
    viewerIsGroupAdmin = memberships.some((row: any) => row.user_id === currentUser!.id && row.role === 'admin');
    const ids = memberships.map((row: any) => row.user_id);
    if (!ids.length) { list.textContent = 'No members found. Check the group membership records.'; return; }
    const found = await db.from('profiles').select('id,username,display_name').in('id', ids);
    if (found.error) throw found.error;
    const byId = new Map((found.data || []).map((profile: any) => [profile.id, profile]));
    list.replaceChildren();
    memberships.forEach((membership: any) => {
      const profile: any = byId.get(membership.user_id);
      const row = document.createElement('div'); row.className = 'group-member-row';
      const label = document.createElement('div'); label.className = 'group-member-identity';
      const name = document.createElement('strong'); name.textContent = profile ? (profile.display_name || profile.username || 'SquadChat member') : 'Unavailable member';
      const username = document.createElement('small'); username.textContent = profile?.username ? '@' + profile.username : 'Profile unavailable';
      label.append(name, username);
      if (membership.role === 'admin') { const badge = document.createElement('span'); badge.className = 'admin-badge'; badge.textContent = 'ADMIN'; label.append(badge); }
      row.append(label);
      if (viewerIsGroupAdmin && membership.user_id !== currentUser!.id) {
        const actions = document.createElement('div'); actions.className = 'group-member-actions';
        const roleButton = document.createElement('button'); roleButton.type = 'button'; roleButton.className = 'btn ghost small'; roleButton.textContent = membership.role === 'admin' ? 'Demote' : 'Make admin';
        roleButton.onclick = async () => { roleButton.disabled = true; try { const changed = await db.from('conversation_members').update({ role: membership.role === 'admin' ? 'member' : 'admin' }).eq('conversation_id', chat.id).eq('user_id', membership.user_id); if (changed.error) throw changed.error; await renderMembers(); notice('Group role updated.', 'success'); } catch (err) { notice('Could not update role: ' + (err as Error).message, 'error'); roleButton.disabled = false; } };
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn danger small'; remove.textContent = 'Remove';
        remove.onclick = async () => {
          if (!confirm('Remove this member from the group?')) return;
          remove.disabled = true;
          let activityMessageId = '';
          try {
            const memberLabel = profile?.username ? '@' + profile.username : name.textContent || 'a member';
            const activity = await db.from('messages').insert({
              conversation_id: chat.id,
              sender_id: currentUser!.id,
              content: 'ℹ️ Removed ' + memberLabel + ' from the group.'
            }).select('id').single();
            if (activity.error) throw activity.error;
            activityMessageId = activity.data.id;
            const deleted = await db.from('conversation_members').delete().eq('conversation_id', chat.id).eq('user_id', membership.user_id);
            if (deleted.error) {
              await db.from('messages').delete().eq('id', activityMessageId);
              throw deleted.error;
            }
            await renderMembers();
            await loadChats();
            notice('Member removed.', 'success');
          } catch (err) {
            notice('Could not remove member: ' + (err as Error).message, 'error');
            remove.disabled = false;
          }
        };
        actions.append(roleButton, remove); row.append(actions);
      }
      list.append(row);
    });
  };
  try { await renderMembers(); } catch (err) { el<HTMLDivElement>('groupMembersList').textContent = 'Could not load members: ' + (err as Error).message; notice('Could not load group members. ' + (err as Error).message, 'error'); }
  el<HTMLElement>('renameGroupInput').toggleAttribute('disabled', !viewerIsGroupAdmin);
  el<HTMLButtonElement>('renameGroupButton').hidden = !viewerIsGroupAdmin;
  el<HTMLButtonElement>('changeGroupCover').hidden = !viewerIsGroupAdmin;
  el<HTMLButtonElement>('addGroupMembersButton').hidden = !viewerIsGroupAdmin;
  el<HTMLInputElement>('addGroupMembersInput').hidden = !viewerIsGroupAdmin;
  const muteBox = el<HTMLInputElement>('muteGroupNotifications');
  try { const pref = await requireClient().from('group_preferences').select('muted').eq('conversation_id', chat.id).eq('user_id', currentUser!.id).maybeSingle(); if (pref.error) throw pref.error; muteBox.checked = !!pref.data?.muted; } catch (err) { notice('Mute setting is not ready. Run the latest group database SQL in Supabase. ' + (err as Error).message, 'error'); }
  muteBox.onchange = async () => { const previous = !muteBox.checked; muteBox.disabled = true; try { const saved = await requireClient().from('group_preferences').upsert({ conversation_id: chat.id, user_id: currentUser!.id, muted: muteBox.checked }, { onConflict: 'conversation_id,user_id' }); if (saved.error) throw saved.error; notice(muteBox.checked ? 'Group muted.' : 'Group unmuted.', 'success'); } catch (err) { muteBox.checked = previous; notice('Could not save mute setting: ' + (err as Error).message, 'error'); } finally { muteBox.disabled = false; } };
  el<HTMLInputElement>('groupMessageSearch').oninput = async () => { const term = el<HTMLInputElement>('groupMessageSearch').value.trim(); const out = el<HTMLDivElement>('groupSearchResults'); out.replaceChildren(); if (term.length < 2) return; const found = await requireClient().from('messages').select('id,content,created_at').eq('conversation_id', chat.id).ilike('content', '%' + term.replace(/[%_]/g, '') + '%').order('created_at', { ascending: false }).limit(20); if (found.error) { out.textContent = found.error.message; return; } (found.data || []).forEach((m: any) => { const item = document.createElement('button'); item.type = 'button'; item.className = 'group-tool-result'; item.textContent = (m.content.startsWith('IMG:') ? 'Photo' : decodeReplyContent(m.content).text).slice(0, 120); item.onclick = () => { const node = document.querySelector('[data-message-id="' + CSS.escape(m.id) + '"]'); node?.scrollIntoView({ behavior: 'smooth', block: 'center' }); close(); }; out.append(item); }); if (!found.data?.length) out.textContent = 'No matching messages.'; };
  el<HTMLButtonElement>('showGroupPins').onclick = async () => { const out = el<HTMLDivElement>('groupPinsResults'); out.textContent = 'Loading pinned messages…'; const found = await requireClient().from('group_pins').select('message_id,created_at').eq('conversation_id', chat.id).order('created_at', { ascending: false }); if (found.error) { out.textContent = 'Pinned messages unavailable: ' + found.error.message; return; } out.replaceChildren(); const ids = (found.data || []).map((pin: any) => pin.message_id); if (!ids.length) { out.textContent = 'No pinned messages yet.'; return; } const messages = await requireClient().from('messages').select('id,content,created_at').in('id', ids); if (messages.error) { out.textContent = 'Could not load pinned messages: ' + messages.error.message; return; } (found.data || []).forEach((pin: any) => { const message: any = (messages.data || []).find((item: any) => item.id === pin.message_id); if (!message) return; const item = document.createElement('button'); item.type = 'button'; item.className = 'group-tool-result'; item.textContent = message.content.startsWith('IMG:') ? '📷 Shared photo' : decodeReplyContent(message.content).text.slice(0, 120); item.onclick = () => { close(); document.querySelector('[data-message-id="' + CSS.escape(message.id) + '"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }; out.append(item); }); if (!out.childElementCount) out.textContent = 'No pinned messages yet.'; };
  el<HTMLButtonElement>('addGroupMembersButton').onclick = async () => {
    const button = el<HTMLButtonElement>('addGroupMembersButton');
    button.disabled = true;
    const db = requireClient();
    try {
      const profiles = await findProfiles(el<HTMLInputElement>('addGroupMembersInput').value.split(','));
      const existing = await db.from('conversation_members').select('user_id').eq('conversation_id', chat.id);
      if (existing.error) throw existing.error;
      const ids = new Set((existing.data || []).map((row: any) => row.user_id));
      const additions = profiles.filter(profile => !ids.has(profile.id));
      if (!additions.length) throw new Error('Those people are already in this group.');
      const inserted = await db.from('conversation_members').insert(additions.map(profile => ({ conversation_id: chat.id, user_id: profile.id, role: 'member' })));
      if (inserted.error) throw inserted.error;
      const addedNames = additions.map(profile => profile.username ? '@' + profile.username : (profile.display_name || 'a member'));
      const activity = await db.from('messages').insert({
        conversation_id: chat.id,
        sender_id: currentUser!.id,
        content: 'ℹ️ Added ' + addedNames.join(', ') + ' to the group.'
      });
      if (activity.error) {
        await db.from('conversation_members').delete().eq('conversation_id', chat.id).in('user_id', additions.map(profile => profile.id));
        throw activity.error;
      }
      el<HTMLInputElement>('addGroupMembersInput').value = '';
      await renderMembers();
      await loadChats();
      notice('People added to the group.', 'success');
    } catch (err) {
      notice((err as Error).message, 'error');
    } finally {
      button.disabled = false;
    }
  };
  el<HTMLButtonElement>('changeGroupCover').onclick = () => el<HTMLInputElement>('groupCoverInput').click();
  el<HTMLInputElement>('groupCoverInput').onchange = async event => { const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return; if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) { notice('Choose a JPG, PNG, WEBP, or GIF image under 5 MB.', 'error'); return; } try { const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]; const path = chat.id + '/covers/' + crypto.randomUUID() + '.' + extension; const db = requireClient(); const upload = await db.storage.from('squadchat-images').upload(path, file, { contentType: file.type, upsert: false }); if (upload.error) throw upload.error; const url = db.storage.from('squadchat-images').getPublicUrl(path).data.publicUrl; const update = await db.from('conversations').update({ group_cover_url: url }).eq('id', chat.id); if (update.error) throw update.error; chat.group_cover_url = url; if (currentChat?.id === chat.id) currentChat.group_cover_url = url; preview.style.backgroundImage = 'linear-gradient(#0002,#0005),url("' + url + '")'; preview.textContent = ''; const coverAvatar = el<HTMLDivElement>('chatCoverAvatar'); if (currentChat?.id === chat.id) { coverAvatar.hidden = false; coverAvatar.style.backgroundImage = 'url("' + url + '")'; } await loadChats(); notice('Group cover photo updated.', 'success'); } catch (err) { notice('Could not change cover photo. Run the updated database SQL from Setup in Supabase first if needed. ' + (err as Error).message, 'error'); } };
  el<HTMLButtonElement>('leaveGroupButton').onclick = async () => {
    if (!confirm('Leave this group? You will no longer see it in your conversations.')) return;
    const db = requireClient();
    let activityMessageId = '';
    try {
      const activity = await db.from('messages').insert({
        conversation_id: chat.id,
        sender_id: currentUser!.id,
        content: 'ℹ️ Left the group.'
      }).select('id').single();
      if (activity.error) throw activity.error;
      activityMessageId = activity.data.id;
      const result = await db.from('conversation_members').delete().eq('conversation_id', chat.id).eq('user_id', currentUser!.id);
      if (result.error) {
        await db.from('messages').delete().eq('id', activityMessageId);
        throw result.error;
      }
      close();
      currentChat = null;
      el<HTMLHeadingElement>('chatTitle').textContent = 'Choose a conversation';
      el<HTMLParagraphElement>('chatSubtitle').textContent = 'Select a chat or find a friend to start.';
      el<HTMLElement>('chatKind').textContent = 'READY';
      el<HTMLButtonElement>('groupSettingsButton').hidden = true;
      el<HTMLElement>('messages').innerHTML = '<div class="empty">You left the group.</div>';
      el<HTMLInputElement>('messageInput').disabled = true;
      el<HTMLButtonElement>('sendButton').disabled = true;
      el<HTMLButtonElement>('attachImageButton').disabled = true;
      await loadChats();
      notice('You left the group.', 'success');
    } catch (err) {
      notice((err as Error).message, 'error');
    }
  };
}
async function openFriendProfile(userId: string) {
  if (!currentUser || !userId || userId === currentUser.id) return;
  const root = el<HTMLDivElement>('modalRoot');
  root.innerHTML = '<div class="modal-backdrop" id="friendProfileBackdrop"><section class="modal friend-profile-modal" role="dialog" aria-modal="true" aria-labelledby="friendProfileName"><div class="friend-profile-top"><p class="profile-eyebrow">SQUADCHAT PROFILE</p><button class="btn ghost small" id="closeFriendProfile" type="button" aria-label="Close profile">✕</button></div><div class="friend-profile-content"><div class="profile-avatar profile-avatar-large" id="friendProfileAvatar">SC</div><h2 id="friendProfileName">Loading profile…</h2><p class="friend-profile-username" id="friendProfileUsername"></p><p class="friend-profile-bio" id="friendProfileBio"></p></div></section></div>';
  const close = () => {
    if (!root.querySelector('#friendProfileBackdrop')) return;
    profileBackdrop.classList.add('modal-exit-bottom');
    window.setTimeout(() => { if (root.contains(profileBackdrop)) root.innerHTML = ''; }, 240);
  };
  const profileBackdrop = el<HTMLDivElement>('friendProfileBackdrop');
  profileBackdrop.style.position = 'fixed';
  profileBackdrop.style.inset = '0';
  profileBackdrop.style.zIndex = '10001';
  profileBackdrop.style.display = 'flex';
  profileBackdrop.style.alignItems = 'center';
  profileBackdrop.style.justifyContent = 'center';
  el<HTMLButtonElement>('closeFriendProfile').onclick = close;
  profileBackdrop.onclick = event => { if (event.target === event.currentTarget) close(); };
  try {
    const { data, error } = await requireClient().from('profiles').select('id,username,display_name,bio,avatar_seed,profile_photo_url,role').eq('id', userId).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('This profile is unavailable.');
    const avatar = el<HTMLDivElement>('friendProfileAvatar');
    const photo = data.profile_photo_url || (data.avatar_seed ? avatarUrl(data.avatar_seed) : '');
    avatar.textContent = photo ? '' : initials(data.display_name || data.username || 'SC');
    avatar.style.backgroundImage = photo ? 'url("' + escapeAttribute(photo) + '")' : '';
    avatar.classList.toggle('has-avatar-image', !!photo);
    el<HTMLElement>('friendProfileName').textContent = data.display_name || data.username || 'SquadChat member';
    const peerStatus = await getPeerAccountStatus(userId);
    if (data.role === 'admin' && peerStatus !== 'suspended') { const badge = document.createElement('span'); badge.className = 'admin-badge profile-admin-badge'; badge.textContent = 'ADMIN ✓'; el<HTMLElement>('friendProfileName').append(' ', badge); }
    el<HTMLElement>('friendProfileUsername').textContent = data.username ? '@' + data.username : '';
    el<HTMLElement>('friendProfileBio').textContent = data.bio || 'No bio added yet.';
  } catch (error) {
    el<HTMLElement>('friendProfileName').textContent = 'Could not load profile';
    el<HTMLElement>('friendProfileBio').textContent = (error as Error).message || 'Please try again.';
  }
}

async function openChat(chat: Chat, preserveMessages = false) {
  if (openingChatId === chat.id) return;
  openingChatId = chat.id;
  const openSequence = ++chatOpenSequence;
  const screen = el<HTMLElement>('chatScreen');
  screen.classList.add('chat-opening');
  window.setTimeout(() => screen.classList.remove('chat-opening'), 520);
  if (messageSyncTimer) {
    clearInterval(messageSyncTimer);
    messageSyncTimer = null;
  }
  currentChat = chat;
  if (!preserveMessages) {
    const messageBox = el<HTMLDivElement>('messages');
    messageBox.replaceChildren();
    messageBox.classList.add('is-loading-messages');
  }
  el<HTMLElement>('chatScreen').classList.add('mobile-chat-open');
  el<HTMLElement>('chatScreen').classList.remove('mobile-friends-open', 'mobile-profile-open');
  if (channel && supabase) {
    await supabase.removeChannel(channel);
    channel = null;
  }
  el<HTMLHeadingElement>('chatTitle').textContent =
    chat.title || 'Conversation';
  const coverAvatar = el<HTMLDivElement>('chatCoverAvatar');
  coverAvatar.hidden = chat.is_group ? !chat.group_cover_url : !chat.peer_id;
  coverAvatar.style.backgroundImage = chat.is_group && chat.group_cover_url
    ? 'url("' + chat.group_cover_url + '")'
    : !chat.is_group && (chat.avatar_url || chat.avatar_seed)
      ? 'url("' + (chat.avatar_url || avatarUrl(chat.avatar_seed || 'SquadChat')) + '")'
      : '';
  coverAvatar.textContent = !chat.is_group && !(chat.avatar_url || chat.avatar_seed) ? initials(chat.title || 'SC') : '';
  coverAvatar.classList.toggle('friend-profile-trigger', !chat.is_group && !!chat.peer_id);
  coverAvatar.setAttribute('aria-label', chat.is_group ? 'Group cover photo' : 'View chatmate profile');
  coverAvatar.onclick = !chat.is_group && chat.peer_id ? () => void openFriendProfile(chat.peer_id!) : null;
  el<HTMLParagraphElement>('chatSubtitle').dataset.peerId = '';
  el<HTMLParagraphElement>('chatSubtitle').textContent = chat.is_group ? 'Group conversation' : 'Private conversation';
  el<HTMLElement>('chatKind').textContent = chat.is_group ? 'GROUP' : 'PRIVATE';
  el<HTMLDivElement>('improvementsWrap').hidden = false;
  closeImprovementsMenu();
  applySharedAppearance(null);
  void loadSharedAppearance(chat.id);
  el<HTMLButtonElement>('groupSettingsButton').hidden = true;
  el<HTMLButtonElement>('improvementsGroupSettings').hidden = !chat.is_group;
  el<HTMLButtonElement>('improvementsGroupSettings').style.display = chat.is_group ? 'flex' : 'none';
  const messageInput = el<HTMLInputElement>('messageInput');
  const sendButton = el<HTMLButtonElement>('sendButton');
  const attachButton = el<HTMLButtonElement>('attachImageButton');
  messageInput.disabled = true;
  sendButton.disabled = true;
  attachButton.disabled = true;
  const peerStatusPromise: Promise<PeerAccountStatus> = !chat.is_group && chat.peer_id
    ? (navigator.onLine ? getPeerAccountStatus(chat.peer_id) : Promise.resolve(chat.peer_is_suspended ? 'suspended' : 'active'))
    : Promise.resolve('active');
  if (!chat.peer_is_unavailable) {
    if (preserveMessages) void syncNewMessages(chat.id);
    else await loadMessages(chat.id);
  }
  const peerStatus = await peerStatusPromise;
  if (openSequence !== chatOpenSequence || currentChat?.id !== chat.id) { openingChatId = null; return; }
  chat.peer_is_suspended = peerStatus === 'suspended';
  const peerBlocked = peerStatus !== 'active';
  const peerUnavailable = !chat.is_group && !!chat.peer_is_unavailable;
  messageInput.disabled = peerBlocked || peerUnavailable;
  messageInput.placeholder = peerUnavailable ? 'User not available.' : peerStatus === 'suspended' ? 'This account has been suspended.' : peerStatus === 'unknown' ? 'Unable to verify account status.' : 'Write a message…';
  sendButton.disabled = peerBlocked || peerUnavailable;
  attachButton.disabled = peerBlocked || peerUnavailable;
  if (peerUnavailable) {
    el<HTMLParagraphElement>('chatSubtitle').textContent = 'This account is no longer available.';
    const messageBox = el<HTMLDivElement>('messages');
    messageBox.replaceChildren();
    messageBox.classList.remove('is-loading-messages');
    const unavailable = document.createElement('div');
    unavailable.className = 'empty unavailable-chat-notice';
    unavailable.textContent = 'This user is not available. Messaging, replies, reactions, and attachments are disabled.';
    messageBox.append(unavailable);
    renderChats();
    openingChatId = null;
    return;
  }
  if (peerStatus === 'suspended') el<HTMLParagraphElement>('chatSubtitle').textContent = 'This account has been suspended.';
  else if (peerStatus === 'unknown') el<HTMLParagraphElement>('chatSubtitle').textContent = 'Unable to verify this account. Try reopening the chat.';
  renderChats();
  if (openSequence !== chatOpenSequence || currentChat?.id !== chat.id) return;
  void markConversationRead(chat.id);
  void refreshReadReceipts(chat.id);
  const db = requireClient();
  // Both participants must subscribe to the exact same topic for this conversation.
  if (remoteTypingTimer) clearTimeout(remoteTypingTimer);
  remoteTypingTimer = null;
  localTypingActive = false;
  if (typingStopTimer) clearTimeout(typingStopTimer);
  typingStopTimer = null;
  el<HTMLDivElement>('typingIndicator').hidden = true;
  channel = db
    .channel('squadchat-' + chat.id)
    .on('broadcast', { event: 'typing' }, payload => {
      const typingUserId = payload.payload?.user_id as string | undefined;
      const eventConversationId = payload.payload?.conversation_id as string | undefined;
      const isTyping = payload.payload?.typing === true;
      if (!typingUserId || typingUserId === currentUser?.id || eventConversationId !== chat.id || currentChat?.id !== chat.id) return;
      const indicator = el<HTMLDivElement>('typingIndicator');
      if (remoteTypingTimer) clearTimeout(remoteTypingTimer);
      indicator.hidden = !isTyping;
      if (isTyping) {
        indicator.textContent = 'Typing..';
        remoteTypingTimer = setTimeout(() => {
          if (currentChat?.id === chat.id) indicator.hidden = true;
          remoteTypingTimer = null;
        }, 2600);
      } else {
        remoteTypingTimer = null;
      }
    })
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: 'conversation_id=eq.' + chat.id,
      },
      async payload => {
        const message = payload.new as Message;
        if (!senderProfileLoadedIds.has(message.sender_id)) {
          const { data: senderProfile } = await db.from('profiles').select('avatar_seed,profile_photo_url,display_name,username').eq('id', message.sender_id).maybeSingle();
          if (senderProfile) {
            if (senderProfile.avatar_seed) avatarSeedByUserId.set(message.sender_id, senderProfile.avatar_seed);
            if (senderProfile.profile_photo_url) avatarPhotoByUserId.set(message.sender_id, senderProfile.profile_photo_url);
            if (senderProfile.display_name) senderNameByUserId.set(message.sender_id, senderProfile.display_name);
            if (senderProfile.username) senderUsernameByUserId.set(message.sender_id, senderProfile.username);
          }
          senderProfileLoadedIds.add(message.sender_id);
        }
        if (currentChat?.id === chat.id) {
          const messageBox = el<HTMLDivElement>('messages');
          const nearBottom = messageBox.scrollHeight - messageBox.scrollTop - messageBox.clientHeight < 100;
          addMessage(message, nearBottom);
          if (message.sender_id !== currentUser?.id) {
            void markConversationRead(chat.id);
          }
        }
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'messages' },
      payload => {
        const removed = payload.old as Partial<Message>;
        if (removed.conversation_id === chat.id && removed.id) {
          removeMessage(removed.id);
        }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversation_appearance', filter: 'conversation_id=eq.' + chat.id },
      payload => {
        const row = (payload.new || payload.old) as { conversation_id?: string; background_kind?: string; background_value?: string | null };
        if (row.conversation_id === chat.id && currentChat?.id === chat.id) {
          applySharedAppearance(payload.eventType === 'DELETE' ? null : {
            background_kind: row.background_kind || 'default',
            background_value: row.background_value || null
          });
        }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'message_reactions', filter: 'conversation_id=eq.' + chat.id },
      payload => {
        const changed = (payload.new || payload.old) as Partial<MessageReaction>;
        if (changed.message_id && currentChat?.id === chat.id) void loadMessageReactions(changed.message_id);
      }
    )
    .subscribe(state => {
      if (state === 'SUBSCRIBED') {
        setConnection('Live · ' + (currentUser?.email || 'connected'), true);
        // Catch messages inserted between the initial history query and subscription setup.
        void syncNewMessages(chat.id);
      }
      if (
        (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') &&
        document.visibilityState === 'visible'
      ) {
        setConnection('Reconnecting live updates…', false);
        notice(
          'Live updates interrupted. Checking for new messages automatically.',
          'error'
        );
      }
    });
  // Poll as a fallback so messages still appear if the realtime subscription is unavailable.
  if (document.visibilityState === 'visible') {
    messageSyncTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && currentChat?.id === chat.id) void syncNewMessages(chat.id);
    }, 2000);
  }
  openingChatId = null;
  // Clear only this conversation's Android notifications after it has opened successfully.
  window.SquadChatNative?.clearConversationNotifications?.(chat.id);
}

async function resolveNotificationChat(conversationId: string): Promise<Chat | null> {
  const inMemory = chats.find(item => item.id === conversationId);
  if (inMemory) return inMemory;
  if (!currentUser) return null;
  const userId = currentUser.id;
  const cached = await getOfflineChatList<Chat>(userId).catch(() => null);
  if (currentUser?.id !== userId) return null;
  if (cached) {
    chats = cached;
    chatListLoading = false;
    renderChats();
    const cachedChat = cached.find(item => item.id === conversationId);
    if (cachedChat) return cachedChat;
  }
  const db = requireClient();
  const membership = await db.from('conversation_members')
    .select('conversation_id,conversations(id,title,is_group,created_at,group_cover_url)')
    .eq('user_id', userId).eq('conversation_id', conversationId).maybeSingle();
  if (membership.error) throw membership.error;
  const base = membership.data?.conversations as Chat | null;
  if (!base || currentUser?.id !== userId) return null;
  const [membersResult, latestResult] = await Promise.all([
    db.from('conversation_members').select('user_id').eq('conversation_id', conversationId),
    db.from('messages').select('id,content,created_at,sender_id')
      .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (membersResult.error) throw membersResult.error;
  if (latestResult.error) throw latestResult.error;
  const peerId = (membersResult.data || []).map((row: any) => row.user_id).find((id: string) => id !== userId) || null;
  let peerProfile: any = null;
  if (!base.is_group && peerId) {
    const profileResult = await db.from('profiles')
      .select('id,username,display_name,avatar_seed,profile_photo_url,role,last_seen_at')
      .eq('id', peerId).maybeSingle();
    if (profileResult.error) throw profileResult.error;
    peerProfile = profileResult.data;
    if (peerProfile?.avatar_seed) avatarSeedByUserId.set(peerId, peerProfile.avatar_seed);
    if (peerProfile?.profile_photo_url) avatarPhotoByUserId.set(peerId, peerProfile.profile_photo_url);
    if (peerProfile?.display_name) senderNameByUserId.set(peerId, peerProfile.display_name);
    if (peerProfile?.username) senderUsernameByUserId.set(peerId, peerProfile.username);
    if (peerProfile?.last_seen_at) lastSeenCache.set(peerId, peerProfile.last_seen_at);
    senderProfileLoadedIds.add(peerId);
  }
  const unavailable = !base.is_group && (!peerId || !peerProfile);
  const latest = latestResult.data;
  return {
    ...base,
    title: base.is_group ? (base.title || 'Group chat') : unavailable ? 'User not available' :
      (peerProfile.display_name?.trim() || peerProfile.username || 'Private chat'),
    peer_id: peerId,
    peer_username: peerProfile?.username || '',
    avatar_seed: peerProfile?.avatar_seed || null,
    avatar_url: peerProfile?.profile_photo_url || null,
    peer_is_admin: peerProfile?.role === 'admin',
    peer_is_unavailable: unavailable,
    last_message: latest?.content || '',
    last_message_sender_id: latest?.sender_id || '',
    last_message_id: latest?.id || '',
    last_activity: latest?.created_at || base.created_at,
    unread_count: 0,
  } as Chat;
}

async function openPendingNotificationChat() {
  if (!pendingNotificationConversationId || !currentUser || notificationOpenInProgress) return;
  notificationOpenInProgress = true;
  const targetId = pendingNotificationConversationId;
  try {
    const chat = await resolveNotificationChat(targetId);
    if (!chat || !currentUser || pendingNotificationConversationId !== targetId) return;
    await openChat(chat);
    if (currentChat?.id === targetId) pendingNotificationConversationId = null;
  } catch (error) {
    console.warn('Could not open notification conversation yet:', (error as Error).message);
  } finally {
    notificationOpenInProgress = false;
  }
}

function handleAppResume() {
  if (!currentUser || document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - lastAppResumeAt < 1100) return;
  lastAppResumeAt = now;
  void syncOfflineQueue();
  if (pendingNotificationConversationId) {
    void openPendingNotificationChat();
  } else if (currentChat) {
    if (!openingChatId) void openChat(currentChat, true);
  } else {
    void loadChats().catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (messageSyncTimer) clearInterval(messageSyncTimer);
    messageSyncTimer = null;
    return;
  }
  handleAppResume();
});
window.addEventListener('pageshow', handleAppResume);
window.addEventListener('focus', handleAppResume);

window.addEventListener('online', () => {
  setConnection('Connected · syncing saved messages', true);
  showConnectionToast('Connection restored. You’re back online.', 'success');
  void syncOfflineQueue();
  handleAppResume();
});
window.addEventListener('offline', () => {
  setConnection('Offline · messages will be saved on this device', false);
  showConnectionToast('Internet connection lost. Messages will be saved on this device.', 'offline');
});

async function syncNewMessages(chatId: string) {
  if (messageSyncInFlight.has(chatId)) return;
  messageSyncInFlight.add(chatId);
  try {
    await syncNewMessagesNow(chatId);
  } finally {
    messageSyncInFlight.delete(chatId);
  }
}
async function syncNewMessagesNow(chatId: string) {
  if (!currentUser || !currentChat || currentChat.id !== chatId || !supabase || !navigator.onLine || document.visibilityState !== 'visible') return;
  const box = el<HTMLDivElement>('messages');
  const rows = box.querySelectorAll<HTMLElement>('[data-message-id]');
  const latestRow = rows.length ? rows[rows.length - 1] : null;
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  let query = requireClient().from('messages')
    .select('id,conversation_id,sender_id,content,created_at')
    .eq('conversation_id', chatId).order('created_at', { ascending: true }).limit(100);
  if (latestRow?.dataset.createdAt) query = query.gte('created_at', latestRow.dataset.createdAt);
  const { data, error } = await query;
  if (error || currentChat?.id !== chatId) return;
  const senderIds = [...new Set((data || []).map((message: Message) => message.sender_id))];
  const missingIds = senderIds.filter(id => !senderProfileLoadedIds.has(id));
  if (missingIds.length) {
    const { data: profiles } = await requireClient().from('profiles')
      .select('id,avatar_seed,profile_photo_url,display_name,username').in('id', missingIds);
    if (currentChat?.id !== chatId) return;
    (profiles || []).forEach((profile: any) => {
      if (profile.avatar_seed) avatarSeedByUserId.set(profile.id, profile.avatar_seed);
      if (profile.profile_photo_url) avatarPhotoByUserId.set(profile.id, profile.profile_photo_url);
      if (profile.display_name) senderNameByUserId.set(profile.id, profile.display_name);
      if (profile.username) senderUsernameByUserId.set(profile.id, profile.username);
      senderProfileLoadedIds.add(profile.id);
    });
    missingIds.forEach(id => senderProfileLoadedIds.add(id));
  }
  if (currentChat?.id !== chatId) return;
  const beforeCount = box.querySelectorAll<HTMLElement>('[data-message-id]').length;
  (data || []).forEach((message: Message) => addMessage(message, false));
  const afterCount = box.querySelectorAll<HTMLElement>('[data-message-id]').length;
  if (wasNearBottom && afterCount > beforeCount) box.scrollTop = box.scrollHeight;
  if ((data || []).some((message: Message) => message.sender_id !== currentUser?.id)) void markConversationRead(chatId);
  void refreshReadReceipts(chatId);
}
async function markConversationRead(chatId: string) {
  if (!currentUser || !supabase || !navigator.onLine) return;
  const { error } = await requireClient().from('conversation_reads').upsert({
    conversation_id: chatId,
    user_id: currentUser.id,
    last_read_at: new Date().toISOString(),
  }, { onConflict: 'conversation_id,user_id' });
  if (error) {
    console.warn('Could not update conversation read status:', error.message);
    notice('Could not update read status. Your messages are still available.', 'error');
    return;
  }
  void loadChats().catch(() => {});
}
async function refreshReadReceipts(chatId: string) {
  if (!currentUser || !supabase || !navigator.onLine || currentChat?.id !== chatId) return;
  const db = requireClient();
  const { data: members, error: membersError } = await db
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', chatId)
    .neq('user_id', currentUser.id);
  if (membersError) return;
  const otherIds = (members || []).map((member: any) => member.user_id);
  if (!otherIds.length) return;
  const { data: receipts, error } = await db
    .from('conversation_reads')
    .select('user_id,last_read_at')
    .eq('conversation_id', chatId)
    .in('user_id', otherIds);
  if (error) return;
  const readTimes = (receipts || []).map((receipt: any) => new Date(receipt.last_read_at).getTime());
  el<HTMLDivElement>('messages').querySelectorAll<HTMLElement>('[data-message-id]').forEach(row => {    const createdAt = new Date(row.dataset.createdAt || '').getTime();
    const receipt = row.querySelector<HTMLElement>('.read-receipt');
    if (!receipt) return;
    const hasRead = readTimes.some(time => time >= createdAt);
    receipt.textContent = hasRead ? 'Read' : 'Sent';
    receipt.classList.toggle('is-read', hasRead);
  });
}
async function loadMessageReactions(messageId: string) {
  if (!currentUser || !currentChat || !supabase) return;
  const row = el<HTMLDivElement>('messages').querySelector<HTMLElement>('[data-message-id="' + CSS.escape(messageId) + '"]');
  if (!row) return;
  const { data, error } = await requireClient().from('message_reactions').select('message_id,conversation_id,user_id,emoji').eq('message_id', messageId);
  if (error) return;
  renderMessageReactions(row, (data || []) as MessageReaction[]);
}
function renderMessageReactions(row: HTMLElement, reactions: MessageReaction[]) {
  row.querySelector('.reaction-area')?.remove();
  const area = document.createElement('div');
  area.className = 'reaction-area';
  const groups = new Map<string, MessageReaction[]>();
  reactions.forEach(reaction => groups.set(reaction.emoji, [...(groups.get(reaction.emoji) || []), reaction]));
  groups.forEach((items, emoji) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'reaction-chip' + (items.some(item => item.user_id === currentUser?.id) ? ' selected' : '');
    chip.textContent = emoji + (items.length > 1 ? ' ' + items.length : '');
    chip.setAttribute('aria-label', emoji + ' reaction, ' + items.length);
    chip.addEventListener('click', event => {
      event.stopPropagation();
      void toggleReaction(row.dataset.messageId || '', emoji);
    });
    area.append(chip);
  });
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  REACTION_EMOJIS.forEach(emoji => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-option';
    button.textContent = emoji;
    button.setAttribute('aria-label', 'React with ' + emoji);
    button.addEventListener('click', event => {
      event.stopPropagation();
      void toggleReaction(row.dataset.messageId || '', emoji);
      row.classList.remove('message-tools-visible');
    });
    picker.append(button);
  });
  const actionMenu = row.querySelector('.message-actions');
  if (actionMenu) actionMenu.prepend(picker);
  else area.append(picker);
  const bubble = row.querySelector('.bubble');
  if (bubble) bubble.append(area);
}
async function toggleReaction(messageId: string, emoji: string) {
  if (!currentUser || !currentChat) return;
  const db = requireClient();
  const { data: existing, error: readError } = await db.from('message_reactions').select('message_id').eq('message_id', messageId).eq('user_id', currentUser.id).eq('emoji', emoji).maybeSingle();
  if (readError) { notice('Reactions need the updated database setup. Open Setup → View database SQL, then run the updated SQL in Supabase.', 'error'); return; }
  if (existing) {
    const { error } = await db.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', currentUser.id).eq('emoji', emoji);
    if (error) { notice('Could not remove reaction: ' + error.message, 'error'); return; }
  } else {
    const { error } = await db.from('message_reactions').insert({ message_id: messageId, conversation_id: currentChat.id, user_id: currentUser.id, emoji });
    if (error) { notice('Could not add reaction: ' + error.message, 'error'); return; }
  }
  await loadMessageReactions(messageId);
}
async function loadMessagesFromServer(chatId: string, preserveExisting = true) {
  const box = el<HTMLDivElement>('messages');
  const hadExistingMessages = !!box.querySelector('[data-message-id]');
  const wasNearBottom = !hadExistingMessages || box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  if (!preserveExisting && !hadExistingMessages) box.replaceChildren();
  if (!hadExistingMessages) box.classList.add('is-loading-messages');
  const db = requireClient();
  const [readReceiptResult, messagesResult] = await Promise.all([
    db.from('conversation_reads').select('last_read_at')
      .eq('conversation_id', chatId).eq('user_id', currentUser!.id).maybeSingle(),
    db.from('messages').select('id,conversation_id,sender_id,content,created_at')
      .eq('conversation_id', chatId).order('created_at', { ascending: false }).limit(200),
  ]);
  if (messagesResult.error) {
    box.classList.remove('is-loading-messages');
    throw messagesResult.error;
  }
  const lastReadAt = readReceiptResult.data?.last_read_at
    ? new Date(readReceiptResult.data.last_read_at).getTime() : 0;
  const data = (messagesResult.data || []).reverse() as Message[];
  if (currentUser) {
    await saveOfflineMessages(currentUser.id, chatId, data).catch(() => {});
    void cacheOfflineMessagePhotos(currentUser.id, data);
  }
  const senderIds = [...new Set(data.map(message => message.sender_id))];
  if (senderIds.length) {
    const { data: senderProfiles, error: senderProfilesError } = await db.from('profiles')
      .select('id,avatar_seed,profile_photo_url,display_name,username').in('id', senderIds);
    if (senderProfilesError) {
      box.classList.remove('is-loading-messages');
      throw senderProfilesError;
    }
    if (currentChat?.id !== chatId) return;
    (senderProfiles || []).forEach((profile: any) => {
      if (profile.avatar_seed) avatarSeedByUserId.set(profile.id, profile.avatar_seed);
      else avatarSeedByUserId.delete(profile.id);
      if (profile.profile_photo_url) avatarPhotoByUserId.set(profile.id, profile.profile_photo_url);
      else avatarPhotoByUserId.delete(profile.id);
      if (profile.display_name) senderNameByUserId.set(profile.id, profile.display_name);
      else senderNameByUserId.delete(profile.id);
      if (profile.username) senderUsernameByUserId.set(profile.id, profile.username);
      senderProfileLoadedIds.add(profile.id);
    });
  }
  if (currentChat?.id !== chatId) return;
  if (!data.length && !box.querySelector('[data-message-id]')) {
    box.classList.remove('is-loading-messages');
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<div><div class="empty-icon">✦</div><strong>Say hello 👋</strong><p class="muted">Your conversation starts here.</p></div>';
    box.append(empty);
    return;
  }
  box.querySelector('.new-messages-divider')?.remove();
  data.forEach(message => addMessage(message, false));
  if (wasNearBottom) box.scrollTop = box.scrollHeight;
  box.classList.remove('is-loading-messages');

  const messageIds = data.map(message => message.id);
  if (messageIds.length) {
    void db.from('message_reactions').select('message_id,conversation_id,user_id,emoji')
      .in('message_id', messageIds).then(result => {
        if (result.error || currentChat?.id !== chatId) return;
        const reactionsByMessage = new Map<string, MessageReaction[]>();
        (result.data || []).forEach((reaction: MessageReaction) => {
          const items = reactionsByMessage.get(reaction.message_id) || [];
          items.push(reaction);
          reactionsByMessage.set(reaction.message_id, items);
        });
        reactionsByMessage.forEach((items, messageId) => {
          const row = box.querySelector<HTMLElement>('[data-message-id="' + CSS.escape(messageId) + '"]');
          if (row) renderMessageReactions(row, items);
        });
      });
  }
  const firstUnread = data.find(message =>
    message.sender_id !== currentUser?.id && new Date(message.created_at).getTime() > lastReadAt
  );
  const unreadRow = firstUnread ? box.querySelector<HTMLElement>('[data-message-id="' + CSS.escape(firstUnread.id) + '"]') : null;
  if (unreadRow) {
    const divider = document.createElement('div');
    divider.className = 'new-messages-divider';
    divider.setAttribute('role', 'separator');
    divider.textContent = 'New messages';
    unreadRow.before(divider);
  }
  void refreshReadReceipts(chatId);
}
async function loadMessages(chatId: string) {
  if (!currentUser) return;
  const userId = currentUser.id;
  const box = el<HTMLDivElement>('messages');
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  const [cached, queuedItems] = await Promise.all([
    getOfflineMessages<Message>(userId, chatId).catch(() => null),
    getOfflineQueue().catch(() => []),
  ]);
  if (currentUser?.id !== userId || currentChat?.id !== chatId) return;

  if (cached?.length) {
    const hydratedCached = await Promise.all(cached.map(async message => {
      const urls = imageUrlsFromMessage(message.content);
      if (!urls.length) return message;
      const offlineUrls = await Promise.all(urls.map(async url => {
        if (/^blob:/i.test(url)) return url;
        const blob = await getOfflinePhoto(userId, url).catch(() => null);
        return blob ? URL.createObjectURL(blob) : url;
      }));
      const content = message.content.trim().startsWith('IMGSET:')
        ? 'IMGSET:' + JSON.stringify(offlineUrls)
        : 'IMG:' + (offlineUrls[0] || urls[0]);
      return { ...message, content };
    }));
    if (currentChat?.id !== chatId) return;
    hydratedCached.forEach(message => addMessage(message, false));
  }

  const queued = queuedItems.filter(item => item.user_id === userId && item.conversation_id === chatId);
  queued.forEach(item => {
    const queuedPhotoUrls = item.kind === 'photos' ? createOfflinePhotoPreview(item.id, item.files || []) : [];
    const message: Message = {
      id: item.id, conversation_id: item.conversation_id, sender_id: item.user_id,
      content: item.kind === 'text' ? (item.content || '') :
        (queuedPhotoUrls.length === 1 ? 'IMG:' + queuedPhotoUrls[0] : 'IMGSET:' + JSON.stringify(queuedPhotoUrls)),
      created_at: item.created_at,
    };
    addMessage(message, false);
    const row = box.querySelector<HTMLElement>('[data-message-id="' + CSS.escape(item.id) + '"]');
    const receipt = row?.querySelector<HTMLElement>('.read-receipt');
    if (receipt) receipt.textContent = 'Waiting for connection';
  });

  const hasLocalMessages = !!box.querySelector('[data-message-id]');
  if (hasLocalMessages) {
    box.classList.remove('is-loading-messages');
    if (wasNearBottom) box.scrollTop = box.scrollHeight;
  }
  if (!navigator.onLine) {
    if (!hasLocalMessages) {
      box.classList.remove('is-loading-messages');
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No saved messages on this device yet.';
      box.append(empty);
    }
    setConnection('Offline · showing saved messages', false);
    return;
  }
  void loadMessagesFromServer(chatId, true).catch(error => {
    if (currentChat?.id !== chatId) return;
    box.classList.remove('is-loading-messages');
    if (!box.querySelector('[data-message-id]')) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Messages could not be refreshed. Check your connection and try again.';
      box.append(empty);
    }
    console.warn('Conversation background refresh failed:', (error as Error).message);
  });
}
function removeMessage(messageId: string) {
  const box = el<HTMLDivElement>('messages');
  box.querySelector('[data-message-id="' + CSS.escape(messageId) + '"]')?.remove();
  if (!box.querySelector('[data-message-id]')) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<div><div class="empty-icon">✦</div><strong>Say hello 👋</strong><p class="muted">Your conversation starts here.</p></div>';
    box.append(empty);
  }
}
async function deleteMessage(messageId: string) {
  if (!currentUser || !currentChat) return;
  if (!confirm('Delete this message? This cannot be undone.')) return;
  try {
    const { error } = await requireClient()
      .from('messages')
      .delete()
      .eq('id', messageId)
      .eq('conversation_id', currentChat.id)
      .eq('sender_id', currentUser.id);
    if (error) throw error;
    removeMessage(messageId);
    notice('Message deleted.', 'success');
    void loadChats().catch(() => {});
  } catch (error) {
    notice('Message could not be deleted. Run the updated database SQL in Setup, then try again. ' + (error as Error).message, 'error');
  }
}
let activeImageViewer: HTMLDivElement | null = null;
let imageViewerPopHandler: (() => void) | null = null;

type SharedPhotoMessage = Message;

function imageUrlsFromMessage(content: string): string[] {
  const raw = decodeReplyContent(content).text.trim();
  if (raw.startsWith('IMGSET:')) {
    try {
      const urls = JSON.parse(raw.slice(7));
      return Array.isArray(urls) ? urls.filter((url): url is string =>
        typeof url === 'string' && (
          (/^https:\/\//i.test(url) && url.includes('/storage/v1/object/public/squadchat-images/')) ||
          /^blob:/i.test(url)
        )
      ) : [];
    } catch { return []; }
  }
  if (raw.startsWith('IMG:')) return [raw.slice(4).trim()];
  if (/^https?:\/\//i.test(raw) && raw.includes('/storage/v1/object/public/squadchat-images/')) return [raw];
  return [];
}
function imageUrlFromMessage(content: string): string {
  return imageUrlsFromMessage(content)[0] || '';
}

async function cacheOfflineMessagePhotos(userId: string, messages: Message[]) {
  const urls = [...new Set(messages.slice(-100).flatMap(message => imageUrlsFromMessage(message.content)).filter(url => /^https:\/\//i.test(url)))].slice(-120);
  await Promise.allSettled(urls.map(async url => {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error('Photo cache request failed');
    const blob = await response.blob();
    if (blob.size > 12 * 1024 * 1024) return;
    await saveOfflinePhoto(userId, url, blob);
  }));
}

function isPhotoNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return !navigator.onLine || /network|fetch|offline|timeout|timed out|failed to connect|load failed|request failed|internet connection|connection reset|connection refused|err_[a-z_]+/i.test(message);
}

function createOfflinePhotoPreview(messageId: string, files: Array<Blob | { blob: Blob }>): string[] {
  const urls = files.map(file => URL.createObjectURL(file instanceof Blob ? file : file.blob));
  offlinePhotoPreviewUrls.set(messageId, urls);
  return urls;
}
function appendLinkedMessageText(parent: HTMLElement, value: string) {
  const pattern = /((?:https?:\/\/|www\.)[^\s<]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|app|ph|edu|gov|co|me|info|biz|site|online|xyz)(?:\/[^\s<]*)?)/gi;
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    let candidate = match[0];
    const clean = candidate.replace(/[.,!?;:]+$/, '');
    if (!clean) continue;
    parent.append(document.createTextNode(value.slice(last, start)));
    const href = /^https?:\/\//i.test(clean) ? clean : 'https://' + clean;
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.textContent = clean;
    // Same-window navigation lets Android WebViewClient safely hand the URL to the phone browser.
    anchor.target = '_self';
    anchor.rel = 'noopener noreferrer';
    anchor.addEventListener('click', event => {
      event.stopPropagation();
      const nativeBridge = (window as Window & { SquadChatNative?: { openExternalUrl?: (url: string) => void } }).SquadChatNative;
      if (typeof nativeBridge?.openExternalUrl === 'function') {
        event.preventDefault();
        nativeBridge.openExternalUrl(anchor.href);
      }
    });
    parent.append(anchor, document.createTextNode(candidate.slice(clean.length)));
    last = start + candidate.length;
  }
  parent.append(document.createTextNode(value.slice(last)));
}

function applySharedAppearance(appearance: { background_kind: string; background_value: string | null } | null) {
  const box = el<HTMLDivElement>('messages');
  box.style.backgroundImage = '';
  box.style.backgroundColor = '';
  box.style.backgroundSize = '';
  box.style.backgroundPosition = '';
  box.style.backgroundRepeat = '';
  if (!appearance || appearance.background_kind === 'default') return;
  if (appearance.background_kind === 'solid' && appearance.background_value) {
    box.style.backgroundColor = appearance.background_value;
  } else if (appearance.background_kind === 'gradient' && appearance.background_value) {
    box.style.backgroundImage = appearance.background_value;
  } else if (appearance.background_kind === 'image' && appearance.background_value) {
    const url = requireClient().storage.from('squadchat-images').getPublicUrl(appearance.background_value).data.publicUrl;
    box.style.backgroundImage = 'linear-gradient(#10080935,#10080955),url(' + JSON.stringify(url) + ')';
    box.style.backgroundSize = 'cover';
    box.style.backgroundPosition = 'center';
    box.style.backgroundRepeat = 'no-repeat';
  }
}

async function loadSharedAppearance(conversationId: string) {
  const result = await requireClient().from('conversation_appearance')
    .select('background_kind,background_value').eq('conversation_id', conversationId).maybeSingle();
  if (result.error) {
    console.warn('Shared background load failed:', result.error.message);
    applySharedAppearance(null);
    return;
  }
  if (currentChat?.id === conversationId) applySharedAppearance(result.data || null);
}

async function saveSharedAppearance(kind: string, value: string | null) {
  if (!currentChat || !currentUser) throw new Error('Open a conversation first.');
  const id = currentChat.id;
  const result = await requireClient().from('conversation_appearance').upsert({
    conversation_id: id, background_kind: kind, background_value: value,
    updated_by: currentUser.id, updated_at: new Date().toISOString()
  }, { onConflict: 'conversation_id' });
  if (result.error) throw result.error;
  if (currentChat?.id === id) applySharedAppearance({ background_kind: kind, background_value: value });
}

async function openBackgroundPicker() {
  if (!currentChat || !currentUser) return;
  const root = el<HTMLDivElement>('modalRoot');
  root.innerHTML = '<div class="modal-backdrop shared-feature-backdrop" id="backgroundPickerBackdrop"><section class="modal shared-feature-modal" role="dialog" aria-modal="true"><div class="shared-feature-heading"><div><p class="profile-eyebrow">SHARED CONVERSATION STYLE</p><h2>Chat background</h2></div><button class="btn ghost small" id="closeBackgroundPicker" type="button">×</button></div><p class="muted">Everyone in this conversation will see your choice.</p><h3>Solid colors</h3><div class="background-swatches" id="solidBackgrounds"></div><h3>Gradients</h3><div class="background-swatches" id="gradientBackgrounds"></div><div class="background-picker-actions"><button class="btn secondary small" id="uploadBackgroundButton" type="button">＋ Upload image</button><button class="btn ghost small" id="resetBackgroundButton" type="button">Reset to default</button></div><input id="backgroundImageInput" type="file" accept="image/jpeg,image/png,image/webp" hidden></section></div>';
  const close = () => { root.innerHTML = ''; };
  el<HTMLButtonElement>('closeBackgroundPicker').onclick = close;
  el<HTMLDivElement>('backgroundPickerBackdrop').onclick = event => { if (event.target === event.currentTarget) close(); };
  const solids: [string, string][] = [
    ['Midnight', '#170d10'], ['Burgundy', '#35171d'], ['Charcoal', '#202124'], ['Forest', '#14251f'],
    ['Navy', '#17243a'], ['Plum', '#2a1b32'], ['Coffee', '#33231b'], ['Rose', '#382026']
  ];
  solids.forEach(([name, color]) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'background-swatch'; button.style.background = color;
    button.title = name; button.setAttribute('aria-label', name + ' background');
    button.onclick = async () => {
      try { await saveSharedAppearance('solid', color); close(); notice('Shared chat background updated.', 'success'); }
      catch (error) { notice('Could not save background: ' + (error as Error).message, 'error'); }
    };
    el<HTMLDivElement>('solidBackgrounds').append(button);
  });
  const gradients: [string, string][] = [
    ['Burgundy glow', 'linear-gradient(145deg,#351318,#160b0d 72%)'],
    ['Gold dusk', 'linear-gradient(145deg,#49301d,#211214 72%)'],
    ['Plum night', 'linear-gradient(145deg,#332039,#170d10 72%)'],
    ['Forest night', 'linear-gradient(145deg,#20372d,#101714 72%)'],
    ['Ocean night', 'linear-gradient(145deg,#1c3442,#10151c 72%)'],
    ['Rose dusk', 'linear-gradient(145deg,#512a35,#1d1115 72%)']
  ];
  gradients.forEach(([name, gradient]) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'background-swatch background-gradient-swatch';
    button.style.background = gradient; button.title = name; button.setAttribute('aria-label', name + ' background');
    button.onclick = async () => {
      try { await saveSharedAppearance('gradient', gradient); close(); notice('Shared chat background updated.', 'success'); }
      catch (error) { notice('Could not save background: ' + (error as Error).message, 'error'); }
    };
    el<HTMLDivElement>('gradientBackgrounds').append(button);
  });
  el<HTMLButtonElement>('resetBackgroundButton').onclick = async () => {
    try { await saveSharedAppearance('default', null); close(); notice('Chat background reset.', 'success'); }
    catch (error) { notice('Could not reset background: ' + (error as Error).message, 'error'); }
  };
  el<HTMLButtonElement>('uploadBackgroundButton').onclick = () => el<HTMLInputElement>('backgroundImageInput').click();
  el<HTMLInputElement>('backgroundImageInput').onchange = async event => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      notice('Choose a JPG, PNG, or WEBP image under 5 MB.', 'error'); return;
    }
    try {
      const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
      const path = currentChat!.id + '/backgrounds/' + currentUser!.id + '/' + crypto.randomUUID() + '.' + ext;
      const upload = await requireClient().storage.from('squadchat-images').upload(path, file, { contentType: file.type, upsert: false });
      if (upload.error) throw upload.error;
      await saveSharedAppearance('image', path);
      close(); notice('Shared chat background updated.', 'success');
    } catch (error) { notice('Could not upload background: ' + (error as Error).message, 'error'); }
  };
}

async function openSharedPhotosGallery() {
  if (!currentChat) return;
  const chat = currentChat;
  const root = el<HTMLDivElement>('modalRoot');
  root.innerHTML = '<div class="modal-backdrop shared-feature-backdrop" id="sharedPhotosBackdrop"><section class="modal shared-feature-modal shared-gallery-modal" role="dialog" aria-modal="true"><div class="shared-feature-heading"><div><p class="profile-eyebrow">CONVERSATION MEDIA</p><h2>Shared photos</h2></div><button class="btn ghost small" id="closeSharedPhotos" type="button">×</button></div><p class="muted" id="sharedPhotosSubtitle">Photos shared in this conversation.</p><div class="shared-photos-grid" id="sharedPhotosGrid"><div class="empty">Loading photos…</div></div></section></div>';
  const close = () => { root.innerHTML = ''; };
  el<HTMLButtonElement>('closeSharedPhotos').onclick = close;
  el<HTMLDivElement>('sharedPhotosBackdrop').onclick = event => { if (event.target === event.currentTarget) close(); };
  const grid = el<HTMLDivElement>('sharedPhotosGrid');
  try {
    const result = await requireClient().from('messages').select('id,conversation_id,sender_id,content,created_at')
      .eq('conversation_id', chat.id).or('content.like.IMG:%,content.like.IMGSET:%').order('created_at', { ascending: false }).limit(100);
    if (result.error) throw result.error;
    const photos = ((result.data || []) as SharedPhotoMessage[]).flatMap(message =>
      imageUrlsFromMessage(message.content).map((url, index) => ({
        ...message, id: message.id + ':' + index, content: 'IMG:' + url
      }))
    );
    if (currentChat?.id !== chat.id || !root.contains(grid)) return;
    if (!photos.length) { grid.innerHTML = '<div class="empty">No shared photos yet.</div>'; return; }
    const ids = Array.from(new Set(photos.map(photo => photo.sender_id)));
    const profiles = await requireClient().from('profiles').select('id,display_name,username').in('id', ids);
    if (!profiles.error) profiles.data?.forEach((profile: any) => {
      if (profile.display_name) senderNameByUserId.set(profile.id, profile.display_name);
      if (profile.username) senderUsernameByUserId.set(profile.id, profile.username);
    });
    grid.replaceChildren();
    photos.forEach((photo, index) => {
      const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'shared-photo-tile';
      const image = document.createElement('img'); image.src = imageUrlFromMessage(photo.content);
      image.alt = 'Shared photo'; image.loading = 'lazy';
      image.onerror = () => tile.remove();
      const label = document.createElement('span');
      label.textContent = (senderNameByUserId.get(photo.sender_id) || senderUsernameByUserId.get(photo.sender_id) || 'Member') + ' · ' + timeLabel(photo.created_at);
      tile.append(image, label);
      tile.onclick = () => openImageViewer(image.src, photos, index);
      grid.append(tile);
    });
  } catch (error) { grid.textContent = 'Shared photos could not be loaded: ' + (error as Error).message; }
}

function showImageViewerNotice(message: string, kind: 'success' | 'error') {
  const viewer = activeImageViewer;
  if (!viewer) { notice(message, kind); return; }
  viewer.querySelector('.image-viewer-notice')?.remove();
  const toast = document.createElement('div');
  toast.className = 'image-viewer-notice ' + kind;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const icon = document.createElement('span');
  icon.className = 'image-viewer-notice-icon';
  icon.textContent = kind === 'success' ? '✓' : '!';
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(icon, text);
  viewer.append(toast);
  window.requestAnimationFrame(() => toast.classList.add('is-visible'));
  window.setTimeout(() => {
    toast.classList.remove('is-visible');
    toast.classList.add('is-hiding');
    window.setTimeout(() => toast.remove(), 260);
  }, kind === 'error' ? 7000 : 4500);
}

async function downloadSharedImage(imageUrl: string) {
  try {
    const marker = '/storage/v1/object/public/squadchat-images/';
    const index = imageUrl.indexOf(marker);
    if (index < 0) throw new Error('This image is not stored in SquadChat storage.');
    const path = decodeURIComponent(imageUrl.slice(index + marker.length).split('?')[0]);
    const result = await requireClient().storage.from('squadchat-images').download(path);
    if (result.error || !result.data) throw result.error || new Error('No image data was returned.');
    const ext = result.data.type.includes('png') ? 'png' : result.data.type.includes('webp') ? 'webp' : result.data.type.includes('gif') ? 'gif' : 'jpg';
    const filename = 'SquadChat-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;
    const file = new File([result.data], filename, { type: result.data.type || 'image/jpeg' });

    // The SquadChat Android APK exposes a native bridge that writes the original image
    // into Pictures/SquadChat through Android MediaStore (visible in Gallery).
    const nativeBridge = (window as any).SquadChatNative;
    if (nativeBridge && typeof nativeBridge.saveImage === 'function') {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read the image for Android saving.'));
        reader.readAsDataURL(result.data);
      });
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
      if (!base64) throw new Error('Could not prepare the image for Android saving.');
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (success: boolean, message: string) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          delete (window as any).onSquadChatImageSaved;
          if (success) resolve();
          else reject(new Error(message || 'Android could not save this image.'));
        };
        const timeout = window.setTimeout(
          () => finish(false, 'Android did not respond to the save request. Please try again.'),
          30000
        );
        (window as any).onSquadChatImageSaved = finish;
        try {
          nativeBridge.saveImage(base64, result.data.type || 'image/jpeg', filename);
        } catch (error) {
          finish(false, (error as Error).message || 'Android save request failed.');
        }
      });
      showImageViewerNotice('Downloaded! Saved to Pictures/SquadChat.', 'success');
      return;
    }

    // Older Android APKs do not have the native Gallery-saving bridge.
    // Ask those users to update instead of showing a browser share/download flow
    // that may not save the image to their Gallery.
    const androidUserAgent = navigator.userAgent || '';
    const isAndroidWebView = /Android/i.test(androidUserAgent) &&
      (androidUserAgent.includes('; wv') ||
        (androidUserAgent.includes('Version/4.0') && androidUserAgent.includes('Chrome/')));
    if (isAndroidWebView) {
      showImageViewerNotice('Please update SquadChat to the latest version to download photos to your Gallery. Install the latest APK, then try again.', 'error');
      return;
    }

    // Keep browser fallback for users opening SquadChat outside the Android APK.
    if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Save SquadChat image', text: 'Choose a destination to save this image.' });
      showImageViewerNotice('Image shared. Choose Save, Files, or Gallery in the Android share menu if available.', 'success');
      return;
    }

    const objectUrl = URL.createObjectURL(result.data);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    window.setTimeout(() => anchor.remove(), 1000);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    showImageViewerNotice('Download requested. If your app does not save it, use the image menu to save the opened original.', 'success');
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    showImageViewerNotice('Could not save image: ' + (error as Error).message, 'error');
  }
}


function openImageViewer(imageUrl: string, photos: SharedPhotoMessage[] = [], startIndex = 0) {
  if (activeImageViewer) return;
  let index = Math.max(0, Math.min(startIndex, Math.max(photos.length - 1, 0)));
  let activeUrl = imageUrl;
  const viewer = document.createElement('div');
  viewer.className = 'image-viewer-overlay';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.setAttribute('aria-label', 'Image preview');
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.className = 'image-viewer-close';
  closeButton.textContent = '×'; closeButton.setAttribute('aria-label', 'Close image');
  const downloadButton = document.createElement('button');
  downloadButton.type = 'button'; downloadButton.className = 'image-viewer-download';
  downloadButton.textContent = '↓'; downloadButton.title = 'Download original image';
  downloadButton.setAttribute('aria-label', 'Download original image');
  downloadButton.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    if (downloadButton.disabled) return;
    downloadButton.disabled = true;
    downloadButton.textContent = '…';
    void downloadSharedImage(activeUrl).finally(() => {
      if (downloadButton.isConnected) {
        downloadButton.disabled = false;
        downloadButton.textContent = '↓';
      }
    });
  };
  const fullImage = document.createElement('img');
  fullImage.className = 'image-viewer-full'; fullImage.alt = 'Picture attachment';
  const metadata = document.createElement('div'); metadata.className = 'image-viewer-metadata';
  const thumbnails = document.createElement('div');
  thumbnails.className = 'image-viewer-thumbnails';
  thumbnails.setAttribute('aria-label', 'Choose a photo from this album');
  photos.forEach((photo, photoIndex) => {
    const thumbnailButton = document.createElement('button');
    thumbnailButton.type = 'button';
    thumbnailButton.className = 'image-viewer-thumbnail';
    thumbnailButton.setAttribute('aria-label', 'View photo ' + (photoIndex + 1));
    const thumbnail = document.createElement('img');
    thumbnail.src = imageUrlFromMessage(photo.content);
    thumbnail.alt = '';
    thumbnail.loading = 'lazy';
    thumbnailButton.append(thumbnail);
    thumbnailButton.addEventListener('click', event => {
      event.stopPropagation();
      index = photoIndex;
      renderPhoto();
    });
    thumbnails.append(thumbnailButton);
  });
  thumbnails.hidden = photos.length < 2;
  const previous = document.createElement('button');
  previous.type = 'button'; previous.className = 'image-viewer-nav image-viewer-prev';
  previous.textContent = '‹'; previous.setAttribute('aria-label', 'Previous image');
  const next = document.createElement('button');
  next.type = 'button'; next.className = 'image-viewer-nav image-viewer-next';
  next.textContent = '›'; next.setAttribute('aria-label', 'Next image');
  const renderPhoto = () => {
    const photo = photos[index];
    activeUrl = photo ? imageUrlFromMessage(photo.content) : imageUrl;
    fullImage.src = activeUrl;
    previous.hidden = photos.length < 2 || index <= 0;
    next.hidden = photos.length < 2 || index >= photos.length - 1;
    if (photo) {
      const sender = senderNameByUserId.get(photo.sender_id) || senderUsernameByUserId.get(photo.sender_id) || 'Member';
      metadata.textContent = (index + 1) + ' of ' + photos.length + ' · ' + sender + ' · ' + new Date(photo.created_at).toLocaleString();
    } else metadata.textContent = '';
    thumbnails.querySelectorAll('.image-viewer-thumbnail').forEach((button, photoIndex) => {
      button.classList.toggle('active', photoIndex === index);
      if (photoIndex === index) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
  };
  previous.onclick = () => { if (index > 0) { index--; renderPhoto(); } };
  next.onclick = () => { if (index < photos.length - 1) { index++; renderPhoto(); } };
  viewer.append(closeButton, downloadButton, previous, fullImage, next, thumbnails, metadata);
  document.body.append(viewer); activeImageViewer = viewer; renderPhoto();
  history.pushState({ ...(history.state || {}), squadChatImageViewer: true }, '', location.href);
  const closeViewer = () => {
    if (!activeImageViewer) return;
    activeImageViewer.remove(); activeImageViewer = null;
    if (imageViewerPopHandler) { window.removeEventListener('popstate', imageViewerPopHandler); imageViewerPopHandler = null; }
    window.removeEventListener('keydown', onViewerKeydown);
  };
  imageViewerPopHandler = closeViewer;
  const onViewerKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); history.back(); }
    if (event.key === 'ArrowLeft' && index > 0) { index--; renderPhoto(); }
    if (event.key === 'ArrowRight' && index < photos.length - 1) { index++; renderPhoto(); }
  };
  window.addEventListener('popstate', closeViewer);
  window.addEventListener('keydown', onViewerKeydown);
  closeButton.addEventListener('click', () => history.back());
  viewer.addEventListener('click', event => { if (event.target === viewer) history.back(); });
}

function addMessage(message: Message, scroll = true) {
  const box = el<HTMLDivElement>('messages');
  if (box.querySelector('[data-message-id="' + CSS.escape(message.id) + '"]'))
    return;
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const mine = message.sender_id === currentUser?.id;
  const row = document.createElement('div');
  row.className = 'bubble-row' + (mine ? ' mine' : '');
  row.dataset.messageId = message.id;
  row.dataset.createdAt = message.created_at;
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.style.width = '29px';
  avatar.style.height = '29px';
  avatar.style.borderRadius = '10px';
  avatar.style.fontSize = '10px';
  const senderPhoto = avatarPhotoByUserId.get(message.sender_id);
  const senderAvatarSeed = avatarSeedByUserId.get(message.sender_id);
  const senderFallback = senderNameByUserId.get(message.sender_id) || senderUsernameByUserId.get(message.sender_id) || 'SC';
  if (senderPhoto || senderAvatarSeed) {
    avatar.textContent = '';
    avatar.style.backgroundImage = `url("${senderPhoto || avatarUrl(senderAvatarSeed!)}")`;
    avatar.classList.add('has-avatar-image');
  } else {
    avatar.textContent = initials(senderFallback);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const swipeIndicator = document.createElement('span');
  swipeIndicator.className = 'reply-swipe-indicator';
  swipeIndicator.textContent = '↩';
  swipeIndicator.setAttribute('aria-hidden', 'true');
  if (!mine && currentChat?.is_group) {
    const sender = document.createElement('div');
    sender.className = 'sender';
    sender.textContent = senderNameByUserId.get(message.sender_id) || senderUsernameByUserId.get(message.sender_id) || 'Member';
    bubble.append(sender);
  }
  const body = document.createElement('div');
  body.className = 'body';
  const decodedMessage = decodeReplyContent(message.content);
  if (decodedMessage.reply) {
    row.classList.add('has-reply');
    const quoted = document.createElement('div');
    quoted.className = 'message-reply-quote';
    const quotedName = document.createElement('strong');
    quotedName.textContent = decodedMessage.reply.sender_id === currentUser?.id ? 'You' : (senderNameByUserId.get(decodedMessage.reply.sender_id) || senderUsernameByUserId.get(decodedMessage.reply.sender_id) || 'Member');
    const quotedText = document.createElement('span');
    quotedText.textContent = decodedMessage.reply.content.startsWith('IMG:') ? 'Photo' : decodedMessage.reply.content.slice(0, 140);
    quoted.append(quotedName, quotedText);
    row.append(quoted);
  }
  const storedContent = decodedMessage.text.trim();
  const imageUrls = imageUrlsFromMessage(storedContent);
  if (imageUrls.length) {
    bubble.classList.add('image-message-bubble');
    const pack = document.createElement('div');
    pack.className = imageUrls.length > 1 ? 'message-image-pack' : 'message-image-single';
    const viewerPhotos = imageUrls.map((photoUrl, photoIndex) => ({
      ...message, id: message.id + ':' + photoIndex, content: 'IMG:' + photoUrl
    }));

    if (imageUrls.length > 1) {
      pack.classList.add('is-photo-stack');
      pack.setAttribute('role', 'button');
      pack.tabIndex = 0;
      pack.setAttribute('aria-label', 'Open album with ' + imageUrls.length + ' photos');
      imageUrls.slice(0, 3).forEach((url, index) => {
        const image = document.createElement('img');
        image.className = 'message-image stack-photo stack-photo-' + index;
        image.src = url;
        image.alt = 'Photo ' + (index + 1) + ' of ' + imageUrls.length;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => {
          image.style.visibility = 'hidden';
        }, { once: true });
        pack.append(image);
      });
      const count = document.createElement('span');
      count.className = 'message-image-count';
      count.textContent = imageUrls.length + (imageUrls.length === 1 ? ' photo' : ' photos');
      pack.append(count);
      const openAlbum = () => openImageViewer(imageUrls[0], viewerPhotos, 0);
      pack.addEventListener('click', event => {
        event.stopPropagation();
        openAlbum();
      });
      pack.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openAlbum();
        }
      });
    } else {
      const image = document.createElement('img');
      image.className = 'message-image';
      image.src = imageUrls[0];
      image.alt = 'Picture 1';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('click', event => {
        event.stopPropagation();
        openImageViewer(imageUrls[0], viewerPhotos, 0);
      });
      image.addEventListener('error', () => {
        image.replaceWith(document.createTextNode('Picture could not be loaded.'));
      }, { once: true });
      pack.append(image);
    }
    body.append(pack);
  } else {
    const messageText = document.createElement('span');
    appendLinkedMessageText(messageText, decodedMessage.text);
    body.append(messageText);
  }
  const time = document.createElement('time');
  time.textContent = timeLabel(message.created_at);
  time.dateTime = message.created_at;
  bubble.append(body, time);
  if (mine) {
    const receipt = document.createElement('small');
    receipt.className = 'read-receipt';
    receipt.textContent = 'Sent';
    bubble.append(receipt);
  }
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const replyButton = document.createElement('button');
  replyButton.type = 'button';
  replyButton.className = 'message-action-button';
  replyButton.textContent = 'Reply';
  replyButton.addEventListener('click', event => {
    event.stopPropagation();
    row.classList.remove('message-tools-visible');
    setPendingReply(message);
  });
  actions.append(replyButton);
  if (currentChat?.is_group) {
    const pinButton = document.createElement('button');
    pinButton.type = 'button';
    pinButton.className = 'message-action-button';
    pinButton.textContent = 'Pin';
    pinButton.addEventListener('click', async event => {
      event.stopPropagation();
      pinButton.disabled = true;
      try {
        const db = requireClient();
        const chatId = currentChat?.id;
        if (!chatId) throw new Error('Conversation is no longer open.');
        const membership = await db.from('conversation_members').select('role').eq('conversation_id', chatId).eq('user_id', currentUser!.id).maybeSingle();
        if (membership.error) throw membership.error;
        if (membership.data?.role !== 'admin') throw new Error('Only group admins can pin messages.');
        const existing = await db.from('group_pins').select('id').eq('conversation_id', chatId).eq('message_id', message.id).maybeSingle();
        if (existing.error) throw existing.error;
        if (existing.data) {
          const removed = await db.from('group_pins').delete().eq('id', existing.data.id);
          if (removed.error) throw removed.error;
          pinButton.textContent = 'Pin';
          notice('Message unpinned.', 'success');
        } else {
          const added = await db.from('group_pins').insert({ conversation_id: chatId, message_id: message.id, pinned_by: currentUser!.id });
          if (added.error) throw added.error;
          pinButton.textContent = 'Unpin';
          notice('Message pinned.', 'success');
        }
      } catch (err) {
        notice('Pin action failed. ' + (err as Error).message, 'error');
      } finally {
        pinButton.disabled = false;
      }
    });
    actions.append(pinButton);
  }
  if (mine) {
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'message-action-button is-danger';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', event => {
      event.stopPropagation();
      row.classList.remove('message-tools-visible');
      void deleteMessage(message.id);
    });
    actions.prepend(deleteButton);
  }
  row.append(actions);
  let holdTimer: number | undefined;
  let holdTriggered = false;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeDeltaX = 0;
  let swipeDeltaY = 0;
  let swipeHandled = false;
  let activePointerId: number | null = null;
  const clearMessageHold = () => {
    if (holdTimer !== undefined) window.clearTimeout(holdTimer);
    holdTimer = undefined;
  };
  const replySwipeDirection = mine ? -1 : 1;
  const updateSwipeVisual = (delta: number) => {
    const distance = Math.max(0, Math.min(76, Math.abs(delta)));
    if (distance > 3) row.classList.add('is-swiping-reply');
    bubble.style.transform = distance > 0 ? `translateX(${Math.sign(delta) * distance * 0.58}px)` : '';
    swipeIndicator.style.opacity = String(Math.min(1, distance / 34));
    swipeIndicator.style.transform = `scale(${0.72 + Math.min(1, distance / 58) * 0.28})`;
    swipeIndicator.classList.toggle('is-ready', distance >= 45);
  };
  const resetSwipeVisual = () => {
    row.classList.remove('is-swiping-reply');
    bubble.style.transform = '';
    swipeIndicator.style.opacity = '0';
    swipeIndicator.style.transform = 'scale(.72)';
    swipeIndicator.classList.remove('is-ready');
  };
  const showMessageTools = () => {
    box.querySelectorAll('.message-tools-visible').forEach(item => item.classList.remove('message-tools-visible'));
    row.classList.add('message-tools-visible');
    const menu = row.querySelector<HTMLElement>('.message-actions');
    if (!menu) return;
    menu.style.position = 'fixed';
    menu.style.visibility = 'hidden';
    menu.style.left = '50%';
    menu.style.top = '0px';
    menu.style.transform = 'translateX(-50%)';
    requestAnimationFrame(() => {
      if (!row.classList.contains('message-tools-visible')) return;
      const anchor = bubble.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const margin = 10;
      const halfWidth = menuRect.width / 2;
      const centerX = Math.max(margin + halfWidth, Math.min(window.innerWidth - margin - halfWidth, anchor.left + anchor.width / 2));
      const belowTop = anchor.bottom + 8;
      const aboveTop = anchor.top - menuRect.height - 8;
      const maxTop = Math.max(margin, window.innerHeight - margin - menuRect.height);
      const top = belowTop + menuRect.height <= window.innerHeight - margin
        ? belowTop
        : aboveTop >= margin
          ? aboveTop
          : Math.max(margin, Math.min(maxTop, belowTop));
      menu.style.left = `${centerX}px`;
      menu.style.top = `${top}px`;
      menu.style.visibility = 'visible';
    });
  };
  if (document.documentElement.dataset.messageMenuDismissBound !== 'true') {
    document.documentElement.dataset.messageMenuDismissBound = 'true';
    document.addEventListener('pointerdown', event => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.message-actions')) return;
      document.querySelectorAll('.bubble-row.message-tools-visible').forEach(item => item.classList.remove('message-tools-visible'));
    }, true);
  }
  // Mouse/pen gestures use Pointer Events. Android touch gestures use the
  // dedicated Touch Events below so WebView pointer capture cannot swallow
  // the final swipe coordinates.
  row.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    activePointerId = event.pointerId;
    swipeStartX = event.clientX;
    swipeStartY = event.clientY;
    swipeDeltaX = 0;
    swipeDeltaY = 0;
    swipeHandled = false;
    holdTriggered = false;
    clearMessageHold();
    holdTimer = window.setTimeout(() => {
      if (Math.abs(swipeDeltaX) < 12 && Math.abs(swipeDeltaY) < 12) {
        holdTriggered = true;
        showMessageTools();
      }
    }, 550);
  });
  row.addEventListener('pointermove', event => {
    if (activePointerId !== event.pointerId) return;
    swipeDeltaX = event.clientX - swipeStartX;
    swipeDeltaY = event.clientY - swipeStartY;
    if (Math.abs(swipeDeltaX) > 10 || Math.abs(swipeDeltaY) > 10) clearMessageHold();
    if (swipeDeltaX * replySwipeDirection > 0 && Math.abs(swipeDeltaX) > Math.abs(swipeDeltaY) * 1.15) updateSwipeVisual(swipeDeltaX);
  });
  row.addEventListener('pointerup', event => {
    if (activePointerId !== event.pointerId) return;
    clearMessageHold();
    const dx = event.clientX - swipeStartX;
    const dy = event.clientY - swipeStartY;
    activePointerId = null;
    resetSwipeVisual();
    if (!holdTriggered && dx * replySwipeDirection > 45 && Math.abs(dy) < 65 && !(event.target as HTMLElement).closest('button')) {
      swipeHandled = true;
      event.preventDefault();
      event.stopPropagation();
      setPendingReply(message);
    }
  });
  row.addEventListener('pointercancel', () => {
    clearMessageHold();
    activePointerId = null;
    resetSwipeVisual();
  });

  let touchStartX = 0;
  let touchStartY = 0;
  let touchTracking = false;
  let touchIsHorizontal = false;
  bubble.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || (event.target as HTMLElement).closest('button')) return;
    const touch = event.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchTracking = true;
    touchIsHorizontal = false;
    swipeHandled = false;
    holdTriggered = false;
    swipeDeltaX = 0;
    swipeDeltaY = 0;
    clearMessageHold();
    holdTimer = window.setTimeout(() => {
      if (touchTracking && Math.abs(swipeDeltaX) < 12 && Math.abs(swipeDeltaY) < 12) {
        holdTriggered = true;
        showMessageTools();
      }
    }, 550);
  }, { passive: true });
  bubble.addEventListener('touchmove', event => {
    if (!touchTracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    swipeDeltaX = touch.clientX - touchStartX;
    swipeDeltaY = touch.clientY - touchStartY;
    if (Math.abs(swipeDeltaX) > 10 || Math.abs(swipeDeltaY) > 10) clearMessageHold();
    if (swipeDeltaX * replySwipeDirection > 8 && Math.abs(swipeDeltaX) > Math.abs(swipeDeltaY) * 1.15) {
      touchIsHorizontal = true;
      updateSwipeVisual(swipeDeltaX);
      if (event.cancelable) event.preventDefault();
    }
  }, { passive: false });
  bubble.addEventListener('touchend', event => {
    if (!touchTracking) return;
    clearMessageHold();
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    touchTracking = false;
    resetSwipeVisual();
    if (!holdTriggered && dx * replySwipeDirection > 45 && Math.abs(dy) < 65) {
      swipeHandled = true;
      event.preventDefault();
      event.stopPropagation();
      setPendingReply(message);
    }
  }, { passive: false });
  bubble.addEventListener('touchcancel', () => {
    clearMessageHold();
    touchTracking = false;
    touchIsHorizontal = false;
    resetSwipeVisual();
  });
  row.addEventListener('contextmenu', event => {
    event.preventDefault();
    showMessageTools();
  });
  row.addEventListener('click', event => {
    if (holdTriggered || swipeHandled) {
      event.preventDefault();
      event.stopPropagation();
      holdTriggered = false;
      swipeHandled = false;
    } else if (!(event.target as HTMLElement).closest('button')) {
      row.classList.remove('message-tools-visible');
    }
  });
  if (mine) row.append(bubble);
  else row.append(avatar, bubble);
  row.append(swipeIndicator);
  box.append(row);
  const replyQuote = row.querySelector< HTMLDivElement >('.message-reply-quote');
  if (replyQuote) replyQuote.style.width = Math.min(bubble.getBoundingClientRect().width, box.clientWidth * 0.92) + 'px';
  void loadMessageReactions(message.id);
  if (scroll) box.scrollTop = box.scrollHeight;
}
let selectedChatPhotos: File[] = [];
let messageSendInProgress = false;
const selectedPhotoObjectUrls = new Map<File, string>();

function getSelectedPhotoUrl(file: File): string {
  let url = selectedPhotoObjectUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    selectedPhotoObjectUrls.set(file, url);
  }
  return url;
}

function releaseSelectedPhotoUrl(file: File) {
  const url = selectedPhotoObjectUrls.get(file);
  if (url) URL.revokeObjectURL(url);
  selectedPhotoObjectUrls.delete(file);
}

function clearSelectedChatPhotos() {
  selectedChatPhotos.forEach(releaseSelectedPhotoUrl);
  selectedChatPhotos = [];
  const input = el<HTMLInputElement>('imageInput');
  input.value = '';
  const tray = el<HTMLDivElement>('photoPreviewTray');
  tray.replaceChildren();
  tray.hidden = true;
  tray.removeAttribute('aria-busy');
  el<HTMLButtonElement>('attachImageButton').disabled = !currentChat || !!currentChat.peer_is_unavailable || !!currentChat.peer_is_suspended;
  el<HTMLButtonElement>('sendButton').disabled = !currentChat || !!currentChat.peer_is_suspended;
}

function renderSelectedChatPhotos() {
  const tray = el<HTMLDivElement>('photoPreviewTray');
  tray.replaceChildren();
  tray.hidden = selectedChatPhotos.length === 0;
  tray.setAttribute('aria-label', selectedChatPhotos.length + ' selected photos');
  selectedChatPhotos.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'photo-preview-item';
    const image = document.createElement('img');
    image.src = getSelectedPhotoUrl(file);
    image.alt = 'Selected photo ' + (index + 1);
    image.loading = 'eager';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      item.classList.add('preview-unavailable');
      image.removeAttribute('src');
      image.alt = 'Preview unavailable';
    }, { once: true });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-preview-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove photo ' + (index + 1));
    remove.addEventListener('click', () => {
      const [removedFile] = selectedChatPhotos.splice(index, 1);
      if (removedFile) releaseSelectedPhotoUrl(removedFile);
      renderSelectedChatPhotos();
    });
    item.append(image, remove);
    tray.append(item);
  });
  el<HTMLButtonElement>('sendButton').disabled = !currentChat || !!currentChat.peer_is_suspended;
}

async function prepareChatPhoto(file: File): Promise<File> {
  const maxBytes = 4.5 * 1024 * 1024;
  if (file.size <= maxBytes) return file;
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This phone cannot resize this photo. Choose a smaller image.');
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('Could not prepare a selected photo.');
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let quality = 0.84;
  let blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  while (blob && blob.size > maxBytes && quality > 0.48) {
    quality -= 0.08;
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  if (!blob || blob.size > 5 * 1024 * 1024) {
    throw new Error('A selected photo could not be reduced below 5 MB.');
  }

  const safeName = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], safeName + '.jpg', {
    type: 'image/jpeg',
    lastModified: Date.now()
  });
}

async function addSelectedChatPhotos(files: File[]) {
  if (!files.length || !currentUser || !currentChat || currentChat.peer_is_unavailable || currentChat.peer_is_suspended) return;
  if (files.length + selectedChatPhotos.length > 10) {
    notice('Choose up to 10 photos per message.', 'error');
    return;
  }
  if (files.some(file => !file.type.startsWith('image/'))) {
    notice('One or more selected files are not images.', 'error');
    return;
  }

  const prepared: File[] = [];
  try {
    for (const file of files) prepared.push(await prepareChatPhoto(file));
  } catch (error) {
    notice('Photos could not be prepared: ' + ((error as Error).message || 'Please choose smaller images.'), 'error');
    return;
  }

  selectedChatPhotos.push(...prepared);
  renderSelectedChatPhotos();
  notice(selectedChatPhotos.length + ' photo(s) ready. Press Send to share them.', 'success');
}

(window as any).onSquadChatNativePhotosSelected = (payload: string) => {
  try {
    const items = JSON.parse(payload) as Array<{name:string;type:string;data:string}>;
    const files = items.map(item => {
      const binary = atob(item.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], item.name || 'photo.jpg', { type: item.type || 'image/jpeg', lastModified: Date.now() });
    });
    addSelectedChatPhotos(files);
  } catch (error) {
    notice('Could not read the selected photos. Please try again.', 'error');
  }
};

el<HTMLButtonElement>('attachImageButton').addEventListener('click', () => {
  // Always use the HTML file input. In the Android APK, WebChromeClient
  // intercepts it and opens SquadChat's custom bottom-sheet photo gallery.
  // In a normal browser, the browser's standard file picker remains available.
  el<HTMLInputElement>('imageInput').click();
});
el<HTMLInputElement>('imageInput').addEventListener('change', () => {
  const input = el<HTMLInputElement>('imageInput');
  void addSelectedChatPhotos(Array.from(input.files || []));
  input.value = '';
});
el<HTMLFormElement>('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (messageSendInProgress || !currentUser || !currentChat) return;
  if (currentChat.peer_is_unavailable) { notice('This user is not available. Messaging is disabled.', 'error'); return; }
  if (currentChat.peer_is_suspended) { notice('This account has been suspended.', 'error'); return; }
  if (selectedChatPhotos.length) {
    const filesToSend = [...selectedChatPhotos];
    const sendingChatId = currentChat.id;
    const senderId = currentUser.id;
    const attachButton = el<HTMLButtonElement>('attachImageButton');
    const sendButton = el<HTMLButtonElement>('sendButton');
    const uploadedPaths: string[] = [];
    const photoMessageId = crypto.randomUUID();
    const queuedAt = new Date().toISOString();
    const previewUrls = createOfflinePhotoPreview(photoMessageId, filesToSend);
    const localMessage: Message = {
      id: photoMessageId,
      conversation_id: sendingChatId,
      sender_id: senderId,
      content: previewUrls.length === 1 ? 'IMG:' + previewUrls[0] : 'IMGSET:' + JSON.stringify(previewUrls),
      created_at: queuedAt
    };
    if (currentChat?.id === sendingChatId) {
      addMessage(localMessage);
      const receipt = el<HTMLDivElement>('messages').querySelector<HTMLElement>('[data-message-id="' + CSS.escape(photoMessageId) + '"] .read-receipt');
      if (receipt) receipt.textContent = 'Saving on this device…';
    }
    const discardLocalPreview = () => {
      removeMessage(photoMessageId);
      (offlinePhotoPreviewUrls.get(photoMessageId) || []).forEach(url => URL.revokeObjectURL(url));
      offlinePhotoPreviewUrls.delete(photoMessageId);
    };
    messageSendInProgress = true;
    attachButton.disabled = true;
    sendButton.disabled = true;
    const originalSendLabel = sendButton.textContent || 'Send ➤';
    sendButton.textContent = 'Sending…';
    el<HTMLDivElement>('photoPreviewTray').setAttribute('aria-busy', 'true');
    notice('Processing photo album…', 'success');
    try {
      const alreadyQueued = await hasPendingPhotoAlbum(senderId, sendingChatId, filesToSend);
      if (alreadyQueued) {
        discardLocalPreview();
        clearSelectedChatPhotos();
        notice('This photo album is already waiting to send. No extra copy was added.', 'success');
        return;
      }
      if (!navigator.onLine) {
        sendButton.textContent = 'Saving…';
        notice('Saving photo album on this device…', 'success');
        await addOfflineQueueItem({ id: photoMessageId, user_id: senderId, conversation_id: sendingChatId, kind: 'photos', files: filesToSend.map(file => ({ blob: file, name: file.name, type: file.type })), created_at: queuedAt });
        const receipt = el<HTMLDivElement>('messages').querySelector<HTMLElement>('[data-message-id="' + CSS.escape(photoMessageId) + '"] .read-receipt');
        if (receipt) receipt.textContent = 'Waiting for connection';
        void rememberPhotoAlbum(senderId, sendingChatId, filesToSend).catch(error => console.warn('Could not save recent photo-send fingerprint:', error));
        clearSelectedChatPhotos();
        notice('Photo album saved on this device. It will send together when your connection returns.', 'success');
        return;
      }
      const db = requireClient();
      const urls: string[] = [];
      for (const file of filesToSend) {
        const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
        const path = `${sendingChatId}/${senderId}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await db.storage.from('squadchat-images').upload(path, file, { contentType: file.type, upsert: false });
        if (uploadError) throw uploadError;
        uploadedPaths.push(path);
        urls.push(db.storage.from('squadchat-images').getPublicUrl(path).data.publicUrl);
      }
      const content = urls.length === 1 ? 'IMG:' + urls[0] : 'IMGSET:' + JSON.stringify(urls);
      const { data, error } = await db.from('messages').insert({ id: photoMessageId, conversation_id: sendingChatId, sender_id: senderId, content }).select('id,conversation_id,sender_id,content,created_at').single();
      if (error) throw error;
      discardLocalPreview();
      if (currentChat?.id === sendingChatId) addMessage(data as Message);
      await rememberPhotoAlbum(senderId, sendingChatId, filesToSend);
      clearSelectedChatPhotos();
      notice(urls.length === 1 ? 'Picture sent.' : urls.length + ' photos sent together.', 'success');
    } catch (photoError) {
      if (uploadedPaths.length) await requireClient().storage.from('squadchat-images').remove(uploadedPaths).catch(() => {});
      if (isPhotoNetworkFailure(photoError)) {
        try {
          await addOfflineQueueItem({ id: photoMessageId, user_id: senderId, conversation_id: sendingChatId, kind: 'photos', files: filesToSend.map(file => ({ blob: file, name: file.name, type: file.type })), created_at: queuedAt });
        } catch (queueError) {
          discardLocalPreview();
          notice('SquadChat could not save these photos on this device. Keep the photos selected, free some phone storage, and try again. ' + ((queueError as Error).message || ''), 'error');
          return;
        }
        const receipt = el<HTMLDivElement>('messages').querySelector<HTMLElement>('[data-message-id="' + CSS.escape(photoMessageId) + '"] .read-receipt');
        if (receipt) receipt.textContent = 'Waiting for connection';
        void rememberPhotoAlbum(senderId, sendingChatId, filesToSend).catch(error => console.warn('Could not save recent photo-send fingerprint:', error));
        clearSelectedChatPhotos();
        notice('Connection lost. Your photo album is saved and will send together when you reconnect.', 'success');
      } else {
        discardLocalPreview();
        notice('Photos could not be sent: ' + ((photoError as Error).message || 'Please try again.'), 'error');
      }
    } finally {
      messageSendInProgress = false;
      attachButton.disabled = !currentChat || !!currentChat.peer_is_unavailable || !!currentChat.peer_is_suspended;
      sendButton.disabled = !currentChat || !!currentChat.peer_is_suspended;
      sendButton.textContent = originalSendLabel;
      el<HTMLDivElement>('photoPreviewTray').removeAttribute('aria-busy');
    }
    return;
  }
  const input = el<HTMLTextAreaElement>('messageInput');
  const plainContent = input.value.trim();
  const content = pendingReply
    ? REPLY_MARKER + JSON.stringify(pendingReply) + '\n' + plainContent
    : plainContent;
  if (!content || content.length > 2000) return;
  const button = el<HTMLButtonElement>('sendButton');
  const sendingChatId = currentChat.id;
  messageSendInProgress = true;
  button.disabled = true;
  const messageId = crypto.randomUUID();
  try {
    if (!navigator.onLine) {
      const queuedAt = new Date().toISOString();
      await addOfflineQueueItem({ id: messageId, user_id: currentUser.id, conversation_id: sendingChatId, kind: 'text', content, created_at: queuedAt });
      const localMessage: Message = { id: messageId, conversation_id: sendingChatId, sender_id: currentUser.id, content, created_at: queuedAt };
      if (currentChat?.id === sendingChatId) {
        addMessage(localMessage);
        const receipt = el<HTMLDivElement>('messages').querySelector<HTMLElement>('[data-message-id="' + CSS.escape(messageId) + '"] .read-receipt');
        if (receipt) receipt.textContent = 'Waiting for connection';
        input.value = '';
        resizeMessageInput();
        clearPendingReply();
      }
      notice('Message saved on this device. It will send when your connection returns.', 'success');
      return;
    }
    const { data, error } = await requireClient()
      .from('messages')
      .insert({
        id: messageId,
        conversation_id: currentChat.id,
        sender_id: currentUser.id,
        content,
      })
      .select('id,conversation_id,sender_id,content,created_at')
      .single();
    if (error) throw error;
    if (currentChat?.id === sendingChatId && input.value.trim() === plainContent) {
      input.value = '';
      resizeMessageInput();
      clearPendingReply();
    }
    if (currentChat?.id === sendingChatId) addMessage(data as Message);
  } catch (error) {
    const message = (error as Error).message || '';
    if (/network|fetch|offline|timeout|failed to connect/i.test(message)) {
      const queuedAt = new Date().toISOString();
      await addOfflineQueueItem({ id: messageId, user_id: currentUser.id, conversation_id: sendingChatId, kind: 'text', content, created_at: queuedAt });
      const localMessage: Message = { id: messageId, conversation_id: sendingChatId, sender_id: currentUser.id, content, created_at: queuedAt };
      if (currentChat?.id === sendingChatId) {
        addMessage(localMessage);
        const receipt = el<HTMLDivElement>('messages').querySelector<HTMLElement>('[data-message-id="' + CSS.escape(messageId) + '"] .read-receipt');
        if (receipt) receipt.textContent = 'Waiting for connection';
        input.value = '';
        resizeMessageInput();
        clearPendingReply();
      }
      notice('Connection lost. Your message is saved and will send automatically when you reconnect.', 'success');
    } else if (currentChat?.id === sendingChatId && currentChat.peer_id && /row-level security|permission denied|42501/i.test(message)) {
      const status = await getPeerAccountStatus(currentChat.peer_id);
      if (status === 'suspended') {
        currentChat.peer_is_suspended = true;
        input.disabled = true;
        input.placeholder = 'This account has been suspended.';
        button.disabled = true;
        el<HTMLButtonElement>('attachImageButton').disabled = true;
        el<HTMLParagraphElement>('chatSubtitle').textContent = 'This account has been suspended.';
        renderChats();
        notice('This account has been suspended.', 'error');
      } else {
        notice('Message could not be sent. Please check your connection and try again.', 'error');
      }
    } else {
      notice('Message could not be sent. Please try again.', 'error');
    }
  } finally {
    messageSendInProgress = false;
    button.disabled = !currentChat || !!currentChat.peer_is_suspended;
    if (currentChat?.id === sendingChatId && !currentChat.peer_is_suspended) input.focus();
  }
});

function resizeMessageInput() {
  const input = el<HTMLTextAreaElement>('messageInput');
  input.style.height = '42px';
  const maxHeight = 66;
  const nextHeight = Math.min(Math.max(input.scrollHeight, 42), maxHeight);
  input.style.height = nextHeight + 'px';
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
}
let typingStopTimer: ReturnType<typeof setTimeout> | null = null;
let remoteTypingTimer: ReturnType<typeof setTimeout> | null = null;
let localTypingActive = false;
function sendTypingState(typing: boolean) {
  if (!channel || !currentUser || !currentChat) return;
  void channel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { user_id: currentUser.id, typing, conversation_id: currentChat.id }
  });
}
const messageInput = el<HTMLTextAreaElement>('messageInput');
messageInput.addEventListener('input', () => {
  resizeMessageInput();
  if (!currentChat || !currentUser || messageInput.disabled) return;
  if (messageInput.value.trim()) {
    if (!localTypingActive) {
      localTypingActive = true;
      sendTypingState(true);
    }
    if (typingStopTimer) clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(() => {
      localTypingActive = false;
      sendTypingState(false);
    }, 1200);
  } else if (localTypingActive) {
    localTypingActive = false;
    if (typingStopTimer) clearTimeout(typingStopTimer);
    typingStopTimer = null;
    sendTypingState(false);
  }
});
messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    el<HTMLFormElement>('composer').requestSubmit();
  }
});
el<HTMLButtonElement>('refreshChats').addEventListener('click', () => {
  window.location.reload();
});
el<HTMLButtonElement>('logoutButton').addEventListener('click', async () => {
  if (!confirm('Log out of SquadChat?')) return;
  try {
    if (channel && supabase) await supabase.removeChannel(channel);
    channel = null;
    if (messageSyncTimer) clearInterval(messageSyncTimer);
    messageSyncTimer = null;
    if (chatListSyncTimer) clearInterval(chatListSyncTimer);
    chatListSyncTimer = null;
    if (accountStatusTimer) clearInterval(accountStatusTimer);
    accountStatusTimer = null;
    if (presenceChannel && supabase) await supabase.removeChannel(presenceChannel);
    presenceChannel = null;
    if (currentUser && supabase) {
      await unregisterAndroidPushToken();
      const timestamp = new Date().toISOString();
      await supabase.from('profiles').update({ last_seen_at: timestamp }).eq('id', currentUser.id);
    }
    const { error } = await requireClient().auth.signOut();
    if (error) throw error;
    currentUser = null;
    suspendedLockActive = false;
    el<HTMLDivElement>('modalRoot').innerHTML = '';
    currentUserRole = 'user';
    el<HTMLButtonElement>('adminPanelButton').hidden = true;
    currentChat = null;
    chats = [];
    showAuth();
    notice('You have logged out.', 'success');  } catch (error) {
    notice((error as Error).message, 'error');
  }
});
el<HTMLButtonElement>('profileButton').addEventListener('click', async () => {
  if (!currentUser) return;
  try {
    const { data, error } = await requireClient().from('profiles')
      .select('username,display_name,bio,avatar_seed,profile_photo_url,role').eq('id', currentUser.id).maybeSingle();
    if (error) throw error;
    currentUserRole = data?.role === 'admin' ? 'admin' : 'user';
    el<HTMLButtonElement>('adminPanelButton').hidden = currentUserRole !== 'admin';
    const username = data?.username || '';
    const displayName = data?.display_name || '';
    const bio = data?.bio || '';
    let selectedAvatarSeed = data?.avatar_seed || '';
    let selectedPhotoUrl = data?.profile_photo_url || '';
    let selectedPhotoFile: File | null = null;
    const safe = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const avatarText = (displayName || username || 'SC').trim().slice(0, 2).toUpperCase();
    const avatarChoices = avatarSeeds.map(seed => `<button class="avatar-choice${selectedAvatarSeed === seed ? ' selected' : ''}" type="button" data-avatar-seed="${seed}" aria-label="Choose ${seed}"><img src="${avatarUrl(seed)}" alt="${seed} anime-style avatar" loading="lazy"><span>${seed}</span></button>`).join('');
    el<HTMLDivElement>('modalRoot').innerHTML =
      `<div class="modal-backdrop" id="profileBackdrop"><section class="modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="profileModalTitle"><div class="profile-modal-hero"><div class="profile-avatar profile-avatar-large${selectedPhotoUrl || selectedAvatarSeed ? ' has-avatar-image' : ''}" id="profileModalAvatar" style="${selectedPhotoUrl ? `background-image:url(&quot;${safe(selectedPhotoUrl)}&quot;)` : selectedAvatarSeed ? `background-image:url(&quot;${avatarUrl(selectedAvatarSeed)}&quot;)` : ''}">${selectedPhotoUrl || selectedAvatarSeed ? '' : safe(avatarText)}</div><div><p class="profile-eyebrow">YOUR SQUADCHAT ID</p><h2 id="profileModalTitle">Edit profile${currentUserRole === 'admin' ? ' <span class="admin-badge">ADMIN ✓</span>' : ''}</h2><p class="muted">Choose a photo or use an anime avatar.</p></div></div><div class="profile-photo-tools"><label class="btn secondary small profile-photo-label" for="profilePhotoInput">Choose from photos<input id="profilePhotoInput" class="profile-photo-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="Choose a profile photo"></label><button class="btn ghost small" id="removeProfilePhoto" type="button">Use avatar instead</button><p class="tiny">JPG, PNG, WEBP or GIF · up to 5 MB</p></div><label>Anime avatars</label><div class="avatar-picker">${avatarChoices}</div><form id="editProfileForm"><label for="displayNameInput">Display name</label><input id="displayNameInput" maxlength="40" placeholder="What should friends call you?" value="${safe(displayName)}"><p class="tiny">Up to 40 characters. Leave blank to use your username.</p><label for="profileBioInput">About you</label><textarea id="profileBioInput" maxlength="160" rows="3" placeholder="A short bio (optional)">${safe(bio)}</textarea><div class="profile-char-count" id="bioCounter">${bio.length}/160</div><label>Username</label><div class="profile-readonly">@${safe(username)}</div><label>Account email</label><div class="profile-readonly">${safe(currentUser?.email || 'Not available')}</div><p class="tiny">Your username and email are kept unchanged. Your display name and bio are saved to your profile.</p><div class="modal-actions"><button class="btn secondary" id="closeProfile" type="button">Cancel</button><button class="btn" id="saveProfile" type="submit">Save profile</button></div></form></section></div>`;
    el<HTMLButtonElement>('modalRoot').querySelectorAll<HTMLButtonElement>('[data-avatar-seed]').forEach(choice => choice.addEventListener('click', () => {
      selectedAvatarSeed = choice.dataset.avatarSeed || '';
      selectedPhotoUrl = '';
      selectedPhotoFile = null;
      el<HTMLButtonElement>('modalRoot').querySelectorAll('[data-avatar-seed]').forEach(item => item.classList.toggle('selected', item === choice));
      const preview = el<HTMLDivElement>('profileModalAvatar');
      preview.textContent = '';
      preview.style.backgroundImage = `url("${avatarUrl(selectedAvatarSeed)}")`;
      preview.classList.add('has-avatar-image');
    }));
    const bioInput = el<HTMLTextAreaElement>('profileBioInput');
    const photoInput = el<HTMLInputElement>('profilePhotoInput');
    el<HTMLButtonElement>('removeProfilePhoto').addEventListener('click', () => {
      selectedPhotoUrl = '';
      selectedPhotoFile = null;
      const preview = el<HTMLDivElement>('profileModalAvatar');
      preview.style.backgroundImage = selectedAvatarSeed ? `url("${avatarUrl(selectedAvatarSeed)}")` : '';
      preview.textContent = selectedAvatarSeed ? '' : avatarText;
      preview.classList.toggle('has-avatar-image', !!selectedAvatarSeed);
    });
    photoInput.addEventListener('change', () => {
      const file = photoInput.files?.[0];
      if (!file) return;
      if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) {
        notice('Choose a JPG, PNG, WEBP, or GIF image under 5 MB.', 'error');
        photoInput.value = '';
        return;
      }
      selectedPhotoFile = file;
      selectedPhotoUrl = '';
      selectedAvatarSeed = '';
      el<HTMLButtonElement>('modalRoot').querySelectorAll('[data-avatar-seed]').forEach(item => item.classList.remove('selected'));
      const preview = el<HTMLDivElement>('profileModalAvatar');
      preview.textContent = '';
      preview.style.backgroundImage = `url("${URL.createObjectURL(file)}")`;
      preview.classList.add('has-avatar-image');
    });
    bioInput.addEventListener('input', () => { el<HTMLElement>('bioCounter').textContent = bioInput.value.length + '/160'; });
    el<HTMLButtonElement>('closeProfile').addEventListener('click', () => { el<HTMLDivElement>('modalRoot').innerHTML = ''; });
    el<HTMLDivElement>('profileBackdrop').addEventListener('click', event => { if (event.target === event.currentTarget) el<HTMLDivElement>('modalRoot').innerHTML = ''; });
    let isSavingProfile = false;
    el<HTMLFormElement>('editProfileForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (isSavingProfile) return;
      isSavingProfile = true;
      const saveButton = el<HTMLButtonElement>('saveProfile');
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
      el<HTMLButtonElement>('closeProfile').disabled = true;
      try {
        const nextName = el<HTMLInputElement>('displayNameInput').value.trim();
        const nextBio = bioInput.value.trim();
        if (nextName.length > 40 || nextBio.length > 160) throw new Error('Please shorten your profile details.');
        let nextPhotoUrl = selectedPhotoUrl || null;
        if (selectedPhotoFile) {
          const extension = selectedPhotoFile.type === 'image/jpeg' ? 'jpg' : selectedPhotoFile.type.split('/')[1];
          const path = currentUser!.id + '/profile/' + crypto.randomUUID() + '.' + extension;
          const db = requireClient();
          const uploaded = await db.storage.from('squadchat-images').upload(path, selectedPhotoFile, { contentType: selectedPhotoFile.type, upsert: false });
          if (uploaded.error) throw uploaded.error;
          nextPhotoUrl = db.storage.from('squadchat-images').getPublicUrl(path).data.publicUrl;
        }
        const { error: saveError } = await requireClient().from('profiles').update({ display_name: nextName || null, bio: nextBio || null, avatar_seed: nextPhotoUrl ? null : (selectedAvatarSeed || null), profile_photo_url: nextPhotoUrl }).eq('id', currentUser!.id);
        if (saveError) throw saveError;
        // The database has confirmed the update; update the profile panel locally instead of making a second network request.
        const savedName = nextName || currentUsername || 'SquadChat member';
        el<HTMLElement>('profileName').textContent = nextName || '@' + currentUsername;
        currentAvatarSeed = nextPhotoUrl ? '' : (selectedAvatarSeed || '');
        const profileAvatar = document.getElementById('profileAvatar');
        if (profileAvatar) {
          profileAvatar.textContent = nextPhotoUrl || currentAvatarSeed ? '' : savedName.trim().slice(0, 2).toUpperCase();
          profileAvatar.style.backgroundImage = nextPhotoUrl ? `url(\"${nextPhotoUrl}\")` : currentAvatarSeed ? `url(\"${avatarUrl(currentAvatarSeed)}\")` : '';
          profileAvatar.classList.toggle('has-avatar-image', !!(nextPhotoUrl || currentAvatarSeed));
        }
        el<HTMLDivElement>('modalRoot').innerHTML = '';
        notice('Profile saved.', 'success');
      } catch (saveError) {
        notice((saveError as Error).message || 'Could not save profile.', 'error');
      } finally {
        isSavingProfile = false;
        if (saveButton.isConnected) {
          saveButton.disabled = false;
          saveButton.textContent = 'Save profile';
          const closeButton = document.getElementById('closeProfile') as HTMLButtonElement | null;
          if (closeButton) closeButton.disabled = false;
        }
      }
    });
  } catch (error) {
    notice((error as Error).message || 'Could not load your profile.', 'error');
  }
});
function deactivateMobileConversation() {
  // A hidden chat must not keep syncing or mark incoming messages as read.
  if (typingStopTimer) clearTimeout(typingStopTimer);
  if (remoteTypingTimer) clearTimeout(remoteTypingTimer);
  typingStopTimer = null;
  remoteTypingTimer = null;
  localTypingActive = false;
  el<HTMLDivElement>('typingIndicator').hidden = true;
  currentChat = null;
  openingChatId = null;
  chatOpenSequence += 1;
  if (messageSyncTimer) {
    clearInterval(messageSyncTimer);
    messageSyncTimer = null;
  }
  if (channel && supabase) {
    const activeChannel = channel;
    channel = null;
    void supabase.removeChannel(activeChannel);
  }
  renderChats();
}

document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button =>
  button.addEventListener('click', () => {
    deactivateMobileConversation();
    const screen = el<HTMLElement>('chatScreen');
    document.querySelectorAll('[data-nav]').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    screen.classList.remove('mobile-chat-open', 'mobile-friends-open', 'mobile-profile-open');
    if (button.dataset.nav === 'friends') {
      screen.classList.add('mobile-friends-open');
      el<HTMLInputElement>('friendSearch').focus();
    }
    if (button.dataset.nav === 'profile') screen.classList.add('mobile-profile-open');
    if (button.dataset.nav === 'chats') el<HTMLElement>('chatList').scrollIntoView({ behavior: 'smooth', block: 'start' });
  })
);
el<HTMLButtonElement>('backToChats').addEventListener('click', () => {
  deactivateMobileConversation();
  const screen = el<HTMLElement>('chatScreen');
  screen.classList.remove('mobile-chat-open', 'mobile-friends-open', 'mobile-profile-open');
  document.querySelectorAll('[data-nav]').forEach(item => item.classList.remove('active'));
  document.querySelector<HTMLButtonElement>('[data-nav="chats"]')?.classList.add('active');
});

async function finishSessionRestore() {
  setConnection(navigator.onLine ? 'Connected' : 'Offline', navigator.onLine);
  showConnectionToast(
    navigator.onLine ? 'You’re connected to the internet.' : 'Internet connection lost. Messages will be saved on this device.',
    navigator.onLine ? 'success' : 'offline'
  );
  chats = [];
  chatListLoading = true;
  await showConversationList();
  const restoringUserId = currentUser?.id;
  void Promise.all([loadProfile(), loadChats()])
    .then(() => {
      if (!currentUser || currentUser.id !== restoringUserId) return;
      startPresence();
      startAccountStatusMonitor();
      requestAndroidPushToken();
    })
    .catch(error => {
      if (!currentUser || currentUser.id !== restoringUserId) return;
      chatListLoading = false;
      renderChats();
      notice((error as Error).message || 'Could not finish loading your chats.', 'error');
      startPresence();
      startAccountStatusMonitor();
      requestAndroidPushToken();
    });
}

async function restoreSession() {
  if (!connect()) {
    showAuth();
    el<HTMLElement>('setupBanner').hidden = false;
    return;
  }
  try {
    if (isSignupConfirmationCallback) {
      // Render only a standalone confirmation page. Do not expose the login UI behind it.
      history.replaceState(null, document.title, window.location.pathname);
      document.body.innerHTML = '<main class="modal-backdrop" style="position:fixed;inset:0;display:grid;place-items:center;min-height:100vh;background:#09070b;padding:24px;box-sizing:border-box"><section class="modal" role="status" aria-live="polite" style="width:min(520px,100%);text-align:center;background:#17120f;border:1px solid #8a642f;border-radius:18px;padding:28px;box-sizing:border-box;color:#f5ead8"><h1 style="color:#e6bd75;margin:0 0 14px;font-size:24px">Email verified successfully!</h1><p style="line-height:1.6">Your SquadChat account is now verified.</p><p style="line-height:1.6;margin-bottom:0">Return to the SquadChat app and log in using your email address and password.</p></section></main>';
      return;
    }
    const recoveryLinkAtStartup = window.location.hash.includes('type=recovery') || new URLSearchParams(window.location.search).get('type') === 'recovery';
    const { data, error } = await supabase!.auth.getSession();
    if (error) throw error;
    if (recoveryLinkAtStartup) {
      // Keep the recovery route visible; never send a recovery link straight into the chat UI.
      showAuth();
    } else if (data.session?.user) {
      currentUser = data.session.user;
      if (!(await checkAccountStatus())) return;
      await finishSessionRestore();
    } else showAuth();
    supabase!.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        currentUser = null;
        suspendedLockActive = false;
        if (accountStatusTimer) clearInterval(accountStatusTimer);
        accountStatusTimer = null;
        el<HTMLDivElement>('modalRoot').innerHTML = '';
        currentChat = null;
        showAuth();
      }
      const isRecoveryRoute = window.location.hash.includes('type=recovery') || new URLSearchParams(window.location.search).get('type') === 'recovery';
      if (!otpRecoveryInProgress && (event === 'PASSWORD_RECOVERY' || (isRecoveryRoute && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')))) {
        const modalRoot = el<HTMLDivElement>('modalRoot');
        modalRoot.innerHTML = `<div class="modal-backdrop" id="recoveryBackdrop"><form class="card modal-card stack" id="recoveryForm"><h2>Choose a new password</h2><p class="muted">Enter a new password for your SquadChat account.</p><label for="recoveryPassword">New password</label><input id="recoveryPassword" type="password" minlength="8" autocomplete="new-password" required placeholder="At least 8 characters"><label for="recoveryPasswordConfirm">Confirm new password</label><input id="recoveryPasswordConfirm" type="password" minlength="8" autocomplete="new-password" required placeholder="Type it again"><div class="modal-actions"><button class="btn" id="saveRecoveryPassword" type="submit">Save new password</button></div></form></div>`;
        el<HTMLDivElement>('recoveryBackdrop').addEventListener('click', event => {
          if (event.target === event.currentTarget) modalRoot.innerHTML = '';
        });
        el<HTMLFormElement>('recoveryForm').addEventListener('submit', async event => {
          event.preventDefault();
          const password = el<HTMLInputElement>('recoveryPassword').value;
          const confirmation = el<HTMLInputElement>('recoveryPasswordConfirm').value;
          if (password.length < 8) { notice('Your password must be at least 8 characters.', 'error'); return; }
          if (password !== confirmation) { notice('The passwords do not match.', 'error'); return; }
          const saveButton = el<HTMLButtonElement>('saveRecoveryPassword');
          saveButton.disabled = true;
          try {
            const { error } = await requireClient().auth.updateUser({ password });
            if (error) throw error;
            modalRoot.innerHTML = '';
            // Remove recovery tokens from the URL so a refresh does not reopen recovery mode.
            history.replaceState(null, document.title, window.location.pathname);
            currentUser = null;
            await requireClient().auth.signOut();
            showAuth();
            notice('Password updated successfully. Please log in with your new password.', 'success');
          } catch (error) {
            notice((error as Error).message || 'Could not update your password. Please request a new reset email.', 'error');
          } finally {
            saveButton.disabled = false;
          }
        });
      }
      if (session?.user && !currentUser && !otpRecoveryInProgress && event !== 'PASSWORD_RECOVERY' && event !== 'USER_UPDATED' && !isRecoveryRoute) {
        currentUser = session.user;
        void checkAccountStatus().then(allowed => {
          if (!allowed) return;
          return finishSessionRestore();
        })
          .catch(error => { showAuth(); notice((error as Error).message, 'error'); });
      }
    });
  } catch (error) {
    notice('Supabase connection failed: ' + (error as Error).message, 'error');
    showAuth();
  }
}
// Handle Android/browser Back consistently across the app. Keep one in-app history
// entry so Back closes the current overlay or returns from a mobile sub-screen first.
let squadChatBackGuardReady = false;
const armSquadChatBackGuard = () => {
  if (squadChatBackGuardReady) return;
  squadChatBackGuardReady = true;
  history.pushState({ squadChatBackGuard: true }, '', location.href);
};
window.addEventListener('popstate', () => {
  const modalRoot = document.getElementById('modalRoot');
  if (modalRoot?.children.length) {
    modalRoot.innerHTML = '';
  } else {
    const screen = document.getElementById('chatScreen');
    if (screen?.classList.contains('mobile-chat-open') ||
        screen?.classList.contains('mobile-friends-open') ||
        screen?.classList.contains('mobile-profile-open')) {
      screen.classList.remove('mobile-chat-open', 'mobile-friends-open', 'mobile-profile-open');
      document.querySelectorAll('[data-nav]').forEach(item => item.classList.remove('active'));
      document.querySelector<HTMLButtonElement>('[data-nav="chats"]')?.classList.add('active');
    }
  }
  armSquadChatBackGuard();
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'Backspace' && !/INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName || '')) {
    const modalRoot = document.getElementById('modalRoot');
    if (modalRoot?.children.length) modalRoot.innerHTML = '';
    else {
      const screen = document.getElementById('chatScreen');
      if (screen?.classList.contains('mobile-chat-open') ||
          screen?.classList.contains('mobile-friends-open') ||
          screen?.classList.contains('mobile-profile-open')) {
        screen.classList.remove('mobile-chat-open', 'mobile-friends-open', 'mobile-profile-open');
        document.querySelector<HTMLButtonElement>('[data-nav="chats"]')?.click();
      }
    }
  }
});
armSquadChatBackGuard();

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(error => console.warn('SquadChat offline app shell registration failed:', error));
  }, { once: true });
}
authMode('login');
if (configured()) void restoreSession();
else {
  showAuth();
  setConnection('Setup required', false);
}
