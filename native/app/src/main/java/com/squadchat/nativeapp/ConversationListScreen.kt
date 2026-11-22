package com.squadchat.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val ListDeepMaroon = Color(0xFF170B0D)
private val ListMaroon = Color(0xFF430D0C)
private val ListGold = Color(0xFFE0B169)
private val ListText = Color(0xFFF5F0E8)
private val ListMuted = Color(0xFFBDAEAA)
private val ListLine = Color(0xFF76504D)

@Serializable
private data class MembershipRow(
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("user_id") val userId: String
)

@Serializable
private data class ConversationUserRow(
    @SerialName("user_id") val userId: String
)

@Serializable
private data class UnreadMessageRow(
    @SerialName("sender_id") val senderId: String
)

@Serializable
private data class ConversationRow(
    val id: String,
    val title: String? = null,
    @SerialName("is_group") val isGroup: Boolean,
    @SerialName("created_by") val createdBy: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("group_cover_url") val groupCoverUrl: String? = null
)

@Serializable
private data class ProfileRow(
    val id: String,
    val username: String,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("avatar_seed") val avatarSeed: String? = null,
    @SerialName("profile_photo_url") val profilePhotoUrl: String? = null,
    @SerialName("last_seen_at") val lastSeenAt: String? = null
)

@Serializable
private data class MessageRow(
    val content: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("sender_id") val senderId: String
)

@Serializable
private data class ConversationMessageRow(
    val content: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("sender_id") val senderId: String,
    @SerialName("conversation_id") val conversationId: String
)

@Serializable
private data class ConversationReadRow(
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("last_read_at") val lastReadAt: String
)

@Serializable
private data class ConversationUnreadRow(
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("created_at") val createdAt: String
)

@Serializable
private data class ReadRow(
    @SerialName("last_read_at") val lastReadAt: String
)

private data class ConversationPreview(
    val id: String,
    val title: String,
    val subtitle: String,
    val timestamp: String,
    val sortTime: String,
    val avatarText: String,
    val avatarUrl: String?,
    val isGroup: Boolean,
    val unreadCount: Int
)

@Composable
fun ConversationListScreen(
    userId: String,
    email: String,
    onSignOut: () -> Unit,
    onOpenChat: (String, String, Boolean) -> Unit
) {
    val supabase = SupabaseClientProvider.client
    val scope = rememberCoroutineScope()
    var conversations by remember { mutableStateOf<List<ConversationPreview>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf("") }
    var search by remember { mutableStateOf("") }

    suspend fun refreshList() {
        if (userId.isBlank()) {
            errorMessage = "Your account session is not ready. Please reopen the app."
            loading = false
            refreshing = false
            return
        }
        try {
            errorMessage = ""
            val memberships = supabase.postgrest["conversation_members"]
                .select(columns = Columns.list("conversation_id", "user_id")) {
                    filter { eq("user_id", userId) }
                }.decodeList<MembershipRow>()
            val conversationIds = memberships.map { it.conversationId }.distinct()
            if (conversationIds.isEmpty()) {
                conversations = emptyList()
                return
            }

            // Fetch shared conversation data in batches instead of issuing several requests per chat.
            val conversationRows = supabase.postgrest["conversations"]
                .select(columns = Columns.list("id", "title", "is_group", "created_by", "created_at", "group_cover_url")) {
                    filter { isIn("id", conversationIds) }
                }.decodeList<ConversationRow>()
            val memberRows = supabase.postgrest["conversation_members"]
                .select(columns = Columns.list("conversation_id", "user_id")) {
                    filter { isIn("conversation_id", conversationIds) }
                }.decodeList<MembershipRow>()
            val otherUserIds = memberRows.map { it.userId }.filter { it != userId }.distinct()
            val profiles = if (otherUserIds.isNotEmpty()) {
                supabase.postgrest["profiles"]
                    .select(columns = Columns.list("id", "username", "display_name", "avatar_seed", "profile_photo_url", "last_seen_at")) {
                        filter { isIn("id", otherUserIds) }
                    }.decodeList<ProfileRow>()
            } else emptyList()
            val latestMessages = supabase.postgrest["messages"]
                .select(columns = Columns.list("content", "created_at", "sender_id", "conversation_id")) {
                    filter { isIn("conversation_id", conversationIds) }
                    order(column = "created_at", order = Order.DESCENDING)
                    limit(count = 2000)
                }.decodeList<ConversationMessageRow>()
            val readRows = supabase.postgrest["conversation_reads"]
                .select(columns = Columns.list("conversation_id", "last_read_at")) {
                    filter {
                        isIn("conversation_id", conversationIds)
                        eq("user_id", userId)
                    }
                }.decodeList<ConversationReadRow>()
            val unreadRows = supabase.postgrest["messages"]
                .select(columns = Columns.list("conversation_id", "created_at")) {
                    filter {
                        isIn("conversation_id", conversationIds)
                        neq("sender_id", userId)
                    }
                    limit(count = 5000)
                }.decodeList<ConversationUnreadRow>()

            val profileById = profiles.associateBy { it.id }
            val conversationById = conversationRows.associateBy { it.id }
            val membersByConversation = memberRows.groupBy { it.conversationId }
            val latestByConversation = latestMessages.distinctBy { it.conversationId }.associateBy { it.conversationId }
            val readByConversation = readRows.associateBy { it.conversationId }
            val unreadCountByConversation = unreadRows.groupBy { it.conversationId }.mapValues { (id, rows) ->
                val readAt = readByConversation[id]?.lastReadAt
                if (readAt == null) rows.size else rows.count { it.createdAt > readAt }
            }

            val results = conversationIds.mapNotNull { id ->
                val conversation = conversationById[id] ?: return@mapNotNull null
                val members = membersByConversation[id].orEmpty()
                val otherUserId = members.firstOrNull { it.userId != userId }?.userId
                val otherProfile = otherUserId?.let(profileById::get)
                val latestMessage = latestByConversation[id]
                val title = if (conversation.isGroup) {
                    conversation.title?.takeIf { it.isNotBlank() } ?: "Group chat"
                } else {
                    otherProfile?.displayName?.takeIf { it.isNotBlank() }
                        ?: otherProfile?.username
                        ?: "SquadChat member"
                }
                val previewText = latestMessage?.content?.takeIf { it.isNotBlank() } ?: "No messages yet"
                val subtitle = if (conversation.isGroup && latestMessage == null) "${members.size} members" else previewText
                val avatarText = title.trim().split(Regex("\\s+"))
                    .take(2).mapNotNull { it.firstOrNull()?.toString() }
                    .joinToString("").ifBlank { "S" }.uppercase()
                ConversationPreview(
                    id = conversation.id,
                    title = title,
                    subtitle = subtitle,
                    timestamp = latestMessage?.createdAt?.let(::formatConversationTime).orEmpty(),
                    sortTime = latestMessage?.createdAt ?: conversation.createdAt,
                    avatarText = avatarText,
                    avatarUrl = if (conversation.isGroup) conversation.groupCoverUrl else otherProfile?.profilePhotoUrl,
                    isGroup = conversation.isGroup,
                    unreadCount = unreadCountByConversation[id] ?: 0
                )
            }
            conversations = results.sortedByDescending { it.sortTime }
        } catch (error: Exception) {
            errorMessage = error.message?.take(220)
                ?: "Could not load conversations. Check your internet connection and try again."
        } finally {
            loading = false
            refreshing = false
        }
    }

    LaunchedEffect(userId) { refreshList() }

    val filtered = conversations.filter {
        it.title.contains(search, ignoreCase = true) ||
            it.subtitle.contains(search, ignoreCase = true)
    }

    Surface(modifier = Modifier.fillMaxSize(), color = ListDeepMaroon) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(ListMaroon)
                    .padding(horizontal = 18.dp, vertical = 18.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("SquadChat", color = ListGold, fontSize = 27.sp, fontWeight = FontWeight.Bold)
                    Text("CHATS", color = ListMuted, fontSize = 10.sp, letterSpacing = 3.sp)
                }
                TextButton(
                    onClick = {
                        refreshing = true
                        scope.launch { refreshList() }
                    },
                    enabled = !refreshing
                ) { Text(if (refreshing) "Loading…" else "Refresh", color = ListGold) }
                TextButton(onClick = onSignOut) { Text("Log out", color = ListText) }
            }

            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text(
                    "Your conversations",
                    color = ListText,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = search,
                    onValueChange = { search = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("Search conversations", color = ListMuted) },
                    shape = RoundedCornerShape(16.dp)
                )
            }

            if (errorMessage.isNotBlank()) {
                Surface(
                    color = ListMaroon,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text("Couldn't load conversations", color = Color(0xFFFFB4AB), fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(4.dp))
                        Text(errorMessage, color = ListText, fontSize = 12.sp)
                        TextButton(onClick = {
                            loading = true
                            scope.launch { refreshList() }
                        }) { Text("Try again", color = ListGold) }
                    }
                }
            }

            when {
                loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(color = ListGold)
                        Spacer(Modifier.height(12.dp))
                        Text("Loading your conversations…", color = ListMuted)
                    }
                }
                filtered.isEmpty() -> Box(
                    modifier = Modifier.fillMaxSize().padding(28.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (search.isBlank()) "No conversations yet" else "No matching conversations", color = ListGold, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(8.dp))
                        Text(
                            if (search.isBlank()) "When you have private or group chats, they will appear here." else "Try another name or keyword.",
                            color = ListMuted,
                            fontSize = 14.sp
                        )
                        if (search.isBlank()) {
                            Spacer(Modifier.height(14.dp))
                            Text("The next stage will add opening chats and sending messages.", color = ListMuted, fontSize = 12.sp)
                        }
                    }
                }
                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(1.dp)
                ) {
                    items(filtered, key = { it.id }) { item ->
                        ConversationRowView(item = item, onClick = { onOpenChat(item.id, item.title, item.isGroup) })
                    }
                }
            }
        }
    }


}

@Composable
private fun ConversationRowView(item: ConversationPreview, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier.size(54.dp).clip(CircleShape).background(ListMaroon),
            contentAlignment = Alignment.Center
        ) {
            if (!item.avatarUrl.isNullOrBlank()) {
                AsyncImage(
                    model = item.avatarUrl,
                    contentDescription = "${item.title} profile photo",
                    modifier = Modifier.fillMaxSize().clip(CircleShape),
                    contentScale = ContentScale.Crop
                )
            } else {
                Text(item.avatarText, color = ListGold, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.width(13.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.title,
                    color = ListText,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (item.timestamp.isNotBlank()) {
                    Text(item.timestamp, color = ListMuted, fontSize = 10.sp)
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(
                (if (item.isGroup) "GROUP · " else "") + item.subtitle,
                color = ListMuted,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        if (item.unreadCount > 0) {
            Spacer(Modifier.width(8.dp))
            Surface(color = ListGold, shape = CircleShape) {
                Text(
                    if (item.unreadCount > 99) "99+" else item.unreadCount.toString(),
                    color = ListDeepMaroon,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 4.dp)
                )
            }
        }
    }
    Box(Modifier.fillMaxWidth().padding(start = 82.dp, end = 16.dp).height(1.dp).background(ListLine.copy(alpha = 0.35f)))
}

private fun formatConversationTime(value: String): String {
    return try {
        val instant = Instant.parse(value)
        val local = instant.atZone(ZoneId.systemDefault())
        val today = LocalDate.now(ZoneId.systemDefault())
        if (local.toLocalDate() == today) {
            local.format(DateTimeFormatter.ofPattern("h:mm a"))
        } else {
            local.format(DateTimeFormatter.ofPattern("MMM d"))
        }
    } catch (_: Exception) {
        ""
    }
}
