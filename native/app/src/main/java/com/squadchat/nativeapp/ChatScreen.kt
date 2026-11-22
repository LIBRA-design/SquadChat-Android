package com.squadchat.nativeapp

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import coil.compose.AsyncImage
import io.github.jan.supabase.storage.storage
import kotlinx.serialization.json.JsonPrimitive

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.input.pointer.pointerInput
import kotlin.math.abs
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val ChatBg = Color(0xFF170B0D)
private val ChatHeader = Color(0xFF430D0C)
private val ChatGold = Color(0xFFE0B169)
private val ChatText = Color(0xFFF5F0E8)
private val ChatMuted = Color(0xFFBDAEAA)
private val ChatIncoming = Color(0xFF392426)
private val ChatReactionOptions = listOf("👍", "❤️", "😂", "😮", "😢")
private const val NativeReplyMarker = "[[SQUADCHAT_REPLY_V1]]"
private data class NativePendingReply(val id: String, val senderId: String, val content: String)

@Serializable
private data class ChatMessageRow(
    val id: String,
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("sender_id") val senderId: String,
    val content: String,
    @SerialName("created_at") val createdAt: String
)

@Serializable
private data class ChatReactionRow(
    @SerialName("message_id") val messageId: String,
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("user_id") val userId: String,
    val emoji: String
)

@Serializable
private data class ChatReadRow(
    @SerialName("user_id") val userId: String,
    @SerialName("last_read_at") val lastReadAt: String
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(userId: String, conversationId: String, conversationTitle: String, isGroup: Boolean, onBack: () -> Unit) {
    val supabase = SupabaseClientProvider.client
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var messages by remember { mutableStateOf<List<ChatMessageRow>>(emptyList()) }
    var reactions by remember { mutableStateOf<List<ChatReactionRow>>(emptyList()) }
    var readRows by remember { mutableStateOf<List<ChatReadRow>>(emptyList()) }
    var draft by remember { mutableStateOf("") }
    var pendingReply by remember { mutableStateOf<NativePendingReply?>(null) }
    var selectedPhotos by remember { mutableStateOf<List<Uri>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var sending by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<ChatMessageRow?>(null) }
    var chatOptionsExpanded by remember { mutableStateOf(false) }
    var showBackgroundPicker by remember { mutableStateOf(false) }
    var showSharedPhotos by remember { mutableStateOf(false) }
    var chatBackground by remember { mutableStateOf(Color(0xFF170B0D)) }
    val backgroundChoices = listOf("Midnight" to Color(0xFF170D10), "Burgundy" to Color(0xFF35171D), "Charcoal" to Color(0xFF202124), "Forest" to Color(0xFF14251F), "Navy" to Color(0xFF17243A), "Plum" to Color(0xFF2A1B32), "Coffee" to Color(0xFF33231B), "Rose" to Color(0xFF382026))
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { selectedPhotos = it.take(10) }

    suspend fun loadMessages() {
        try {
            messages = supabase.postgrest["messages"]
                .select(columns = Columns.list("id", "conversation_id", "sender_id", "content", "created_at")) {
                    filter { eq("conversation_id", conversationId) }
                    order(column = "created_at", order = Order.DESCENDING)
                    limit(count = 300)
                }.decodeList<ChatMessageRow>().reversed()
            reactions = supabase.postgrest["message_reactions"]
                .select(columns = Columns.list("message_id", "conversation_id", "user_id", "emoji")) {
                    filter { eq("conversation_id", conversationId) }
                }.decodeList<ChatReactionRow>()
            readRows = supabase.postgrest["conversation_reads"]
                .select(columns = Columns.list("user_id", "last_read_at")) {
                    filter {
                        eq("conversation_id", conversationId)
                        neq("user_id", userId)
                    }
                }.decodeList<ChatReadRow>()
            errorMessage = ""
        } catch (e: Exception) {
            errorMessage = e.message?.take(180) ?: "Could not load chat updates. Check your connection."
        } finally {
            loading = false
        }
    }

    suspend fun markConversationRead() {
        try {
            supabase.postgrest["conversation_reads"].upsert(buildJsonObject {
                put("conversation_id", conversationId)
                put("user_id", userId)
                put("last_read_at", Instant.now().toString())
            }) {
                onConflict = "conversation_id,user_id"
            }
        } catch (_: Exception) {
            // The chat remains usable if read status cannot be updated while offline.
        }
    }

    LaunchedEffect(conversationId) {
        loadMessages()
        markConversationRead()
        // Poll only while this conversation screen is open. This avoids
        // relying on SDK-specific Realtime APIs and still keeps chats fresh.
        while (true) {
            kotlinx.coroutines.delay(3000)
            loadMessages()
            markConversationRead()
        }
    }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    fun sendMessage() {
        val text = draft.trim()
        if (text.isBlank() || sending) return
        scope.launch {
            sending = true
            errorMessage = ""
            try {
                val storedContent = pendingReply?.let { reply ->
                    NativeReplyMarker + buildJsonObject {
                        put("id", reply.id)
                        put("sender_id", reply.senderId)
                        put("content", reply.content)
                    }.toString() + "\n" + text
                } ?: text
                supabase.postgrest["messages"].insert(buildJsonObject {
                    put("conversation_id", conversationId)
                    put("sender_id", userId)
                    put("content", storedContent)
                })
                draft = ""
                pendingReply = null
                loadMessages()
            } catch (e: Exception) {
                errorMessage = e.message?.take(180) ?: "Message could not be sent. Check your connection."
            } finally {
                sending = false
            }
        }
    }

    fun sendPhotos() {
        if (selectedPhotos.isEmpty() || sending) return
        val chosen = selectedPhotos
        scope.launch {
            sending = true
            errorMessage = ""
            try {
                val urls = mutableListOf<String>()
                chosen.forEach { uri ->
                    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error("Could not read a selected photo.")
                    require(bytes.size <= 5 * 1024 * 1024) { "Each photo must be 5 MB or smaller." }
                    val ext = context.contentResolver.getType(uri)?.substringAfter("/")?.lowercase()?.takeIf { it in listOf("jpeg", "jpg", "png", "webp", "gif") } ?: "jpg"
                    val path = "$conversationId/$userId/${java.util.UUID.randomUUID()}.$ext"
                    supabase.storage.from("squadchat-images").upload(path, bytes)
                    urls.add(supabase.storage.from("squadchat-images").publicUrl(path))
                }
                val content = if (urls.size == 1) "IMG:" + urls.first() else "IMGSET:" + kotlinx.serialization.json.buildJsonArray { urls.forEach { add(JsonPrimitive(it)) } }.toString()
                supabase.postgrest["messages"].insert(buildJsonObject { put("conversation_id", conversationId); put("sender_id", userId); put("content", content) })
                selectedPhotos = emptyList()
                loadMessages()
            } catch (e: Exception) { errorMessage = e.message?.take(180) ?: "Photo upload failed." }
            finally { sending = false }
        }
    }

    fun toggleReaction(messageId: String, emoji: String) {
        scope.launch {
            try {
                val existing = supabase.postgrest["message_reactions"]
                    .select(columns = Columns.list("message_id")) {
                        filter {
                            eq("message_id", messageId)
                            eq("user_id", userId)
                            eq("emoji", emoji)
                        }
                    }.decodeList<kotlinx.serialization.json.JsonObject>()
                if (existing.isNotEmpty()) {
                    supabase.postgrest["message_reactions"].delete {
                        filter {
                            eq("message_id", messageId)
                            eq("user_id", userId)
                            eq("emoji", emoji)
                        }
                    }
                } else {
                    supabase.postgrest["message_reactions"].insert(buildJsonObject {
                        put("message_id", messageId)
                        put("conversation_id", conversationId)
                        put("user_id", userId)
                        put("emoji", emoji)
                    })
                }
                loadMessages()
            } catch (e: Exception) {
                errorMessage = "Could not update reaction. " + (e.message?.take(140) ?: "")
            }
        }
    }

    fun deleteMessage(message: ChatMessageRow) {
        scope.launch {
            try {
                supabase.postgrest["messages"].delete {
                    filter {
                        eq("id", message.id)
                        eq("conversation_id", conversationId)
                        eq("sender_id", userId)
                    }
                }
                messages = messages.filterNot { it.id == message.id }
                reactions = reactions.filterNot { it.messageId == message.id }
                deleteTarget = null
            } catch (e: Exception) {
                errorMessage = "Could not delete this message. " + (e.message?.take(140) ?: "")
            }
        }
    }


    if (showBackgroundPicker) {
        AlertDialog(
            onDismissRequest = { showBackgroundPicker = false },
            title = { Text("Chat background", color = ChatGold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("This background is shared with everyone in this conversation.", color = ChatMuted, fontSize = 12.sp)
                    backgroundChoices.chunked(2).forEach { pair ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            pair.forEach { (name, color) ->
                                TextButton(
                                    modifier = Modifier.weight(1f).background(color, RoundedCornerShape(9.dp)),
                                    onClick = {
                                        scope.launch {
                                            try {
                                                val hex = "#%06X".format(0xFFFFFF and color.toArgb())
                                                supabase.postgrest["conversation_appearance"].upsert(buildJsonObject {
                                                    put("conversation_id", conversationId)
                                                    put("background_kind", "solid")
                                                    put("background_value", hex)
                                                    put("updated_by", userId)
                                                    put("updated_at", Instant.now().toString())
                                                }) { onConflict = "conversation_id" }
                                                chatBackground = color
                                                showBackgroundPicker = false
                                            } catch (e: Exception) {
                                                errorMessage = "Could not save background: " + (e.message?.take(120) ?: "")
                                            }
                                        }
                                    }
                                ) { Text(name, color = Color.White, fontSize = 10.sp) }
                            }
                        }
                    }
                    TextButton(onClick = {
                        scope.launch {
                            try {
                                supabase.postgrest["conversation_appearance"].upsert(buildJsonObject {
                                    put("conversation_id", conversationId)
                                    put("background_kind", "default")
                                    put("background_value", kotlinx.serialization.json.JsonNull)
                                    put("updated_by", userId)
                                    put("updated_at", Instant.now().toString())
                                }) { onConflict = "conversation_id" }
                                chatBackground = Color(0xFF170B0D)
                                showBackgroundPicker = false
                            } catch (e: Exception) {
                                errorMessage = "Could not reset background: " + (e.message?.take(120) ?: "")
                            }
                        }
                    }) { Text("Reset to default", color = ChatGold) }
                }
            },
            confirmButton = { TextButton(onClick = { showBackgroundPicker = false }) { Text("Close", color = ChatGold) } }
        )
    }

    if (showSharedPhotos) {
        val photoMessages = messages.filter { it.content.startsWith("IMG:") || it.content.startsWith("IMGSET:") }
        AlertDialog(
            onDismissRequest = { showSharedPhotos = false },
            title = { Text("Shared photos", color = ChatGold) },
            text = {
                if (photoMessages.isEmpty()) Text("No shared photos in this conversation yet.", color = ChatMuted)
                else Column(Modifier.heightIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    photoMessages.forEach { photo -> MessageContent(photo.content) }
                }
            },
            confirmButton = { TextButton(onClick = { showSharedPhotos = false }) { Text("Close", color = ChatGold) } }
        )
    }

    if (deleteTarget != null) {
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete message?") },
            text = { Text("This will delete your message for everyone in this conversation.") },
            confirmButton = {
                TextButton(onClick = { deleteTarget?.let(::deleteMessage) }) {
                    Text("Delete", color = Color(0xFFFF8A80))
                }
            },
            dismissButton = { TextButton(onClick = { deleteTarget = null }) { Text("Cancel") } }
        )
    }

    Surface(Modifier.fillMaxSize(), color = ChatBg) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().background(ChatHeader).padding(horizontal = 8.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                TextButton(onClick = onBack) { Text("‹ Back", color = ChatGold) }
                Column(Modifier.weight(1f).padding(start = 4.dp)) {
                    Text(conversationTitle, color = ChatText, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                    Text(if (isGroup) "GROUP CHAT · LIVE" else "PRIVATE CHAT · LIVE", color = ChatMuted, fontSize = 9.sp, letterSpacing = 1.sp)
                }
                TextButton(onClick = { scope.launch { loadMessages() } }) { Text("Refresh", color = ChatGold, fontSize = 12.sp) }
                Box {
                    TextButton(onClick = { chatOptionsExpanded = true }) { Text("⋮", color = ChatGold, fontSize = 22.sp) }
                    DropdownMenu(expanded = chatOptionsExpanded, onDismissRequest = { chatOptionsExpanded = false }) {
                        DropdownMenuItem(text = { Text("Change chat background") }, onClick = { chatOptionsExpanded = false; showBackgroundPicker = true })
                        DropdownMenuItem(text = { Text("Shared photos") }, onClick = { chatOptionsExpanded = false; showSharedPhotos = true })
                        if (isGroup) DropdownMenuItem(text = { Text("Group settings") }, onClick = { chatOptionsExpanded = false; errorMessage = "Group settings are not yet implemented in the native app." })
                    }
                }
            }
            if (errorMessage.isNotBlank()) {
                Text(errorMessage, color = Color(0xFFFFB4AB), fontSize = 12.sp, modifier = Modifier.padding(12.dp))
            }
            when {
                loading -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = ChatGold)
                }
                messages.isEmpty() -> Box(Modifier.weight(1f).fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("No messages yet", color = ChatGold, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(6.dp))
                        Text("Send a message to start the conversation.", color = ChatMuted, textAlign = TextAlign.Center)
                    }
                }
                else -> LazyColumn(
                    Modifier.weight(1f).fillMaxWidth().background(chatBackground).padding(horizontal = 12.dp, vertical = 10.dp),
                    state = listState,
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(messages, key = { it.id }) { message ->
                        val mine = message.senderId == userId
                        val messageReactions = reactions.filter { it.messageId == message.id }
                        val readTime = readRows.maxOfOrNull { runCatching { Instant.parse(it.lastReadAt) }.getOrNull() ?: Instant.MIN }
                        val isRead = mine && readTime != null &&
                            (runCatching { Instant.parse(message.createdAt) }.getOrNull()?.let { !readTime.isBefore(it) } == true)
                        Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
                            val decodedReply = remember(message.content) { decodeNativeReply(message.content) }
                            var dragOffset by remember(message.id) { mutableFloatStateOf(0f) }
                            var menuExpanded by remember(message.id) { mutableStateOf(false) }
                            Column(
                                Modifier.fillMaxWidth(0.82f)
                                    .graphicsLayer { translationX = dragOffset }
                                    .pointerInput(message.id) {
                                        var dragTotal = 0f
                                        detectHorizontalDragGestures(
                                            onHorizontalDrag = { change, amount ->
                                                dragTotal += amount
                                                dragOffset = (dragOffset + amount).coerceIn(-150f, 150f)
                                                change.consume()
                                            },
                                            onDragEnd = {
                                                if (abs(dragTotal) > 55f) {
                                                    pendingReply = NativePendingReply(message.id, message.senderId, decodedReply.second)
                                                }
                                                dragOffset = 0f
                                                dragTotal = 0f
                                            },
                                            onDragCancel = { dragOffset = 0f; dragTotal = 0f }
                                        )
                                    }
                                    .combinedClickable(
                                        onClick = {},
                                        onLongClick = { menuExpanded = true }
                                    )
                                    .background(if (mine) ChatHeader else ChatIncoming, RoundedCornerShape(17.dp))
                                    .padding(horizontal = 13.dp, vertical = 9.dp)
                            ) {
                                decodedReply.first?.let { quote ->
                                    Column(Modifier.fillMaxWidth().padding(bottom = 6.dp).background(ChatBg.copy(alpha = 0.55f), RoundedCornerShape(8.dp)).padding(8.dp)) {
                                        Text(if (quote.senderId == userId) "You" else "Reply", color = ChatGold, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                                        Text(if (quote.content.startsWith("IMG:") || quote.content.startsWith("IMGSET:")) "Photo" else quote.content.take(120), color = ChatMuted, fontSize = 11.sp, maxLines = 2)
                                    }
                                }
                                MessageContent(decodedReply.second)
                                Spacer(Modifier.height(4.dp))
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                                    Text(formatChatTime(message.createdAt), color = ChatMuted, fontSize = 9.sp)
                                    if (mine) {
                                        Spacer(Modifier.width(6.dp))
                                        Text(if (isRead) "Read" else "Sent", color = if (isRead) ChatGold else ChatMuted, fontSize = 9.sp)
                                    }
                                }
                            }
                            if (messageReactions.isNotEmpty()) {
                                Row(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    messageReactions.groupBy { it.emoji }.forEach { (emoji, items) ->
                                        Surface(
                                            color = if (items.any { it.userId == userId }) ChatGold.copy(alpha = 0.22f) else ChatIncoming,
                                            shape = RoundedCornerShape(14.dp),
                                            modifier = Modifier.clickable { toggleReaction(message.id, emoji) }
                                        ) {
                                            Text("$emoji ${items.size}", color = ChatText, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
                                        }
                                    }
                                }
                            }
                            Box(Modifier.padding(top = 1.dp)) {
                                TextButton(onClick = { menuExpanded = true }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                                    Text("⋯", color = ChatMuted, fontSize = 18.sp)
                                }
                                DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                                    DropdownMenuItem(
                                        text = {
                                            Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                                                ChatReactionOptions.forEach { emoji ->
                                                    TextButton(
                                                        onClick = { menuExpanded = false; toggleReaction(message.id, emoji) },
                                                        contentPadding = PaddingValues(horizontal = 5.dp, vertical = 3.dp),
                                                        modifier = Modifier.width(42.dp)
                                                    ) { Text(emoji, fontSize = 20.sp) }
                                                }
                                            }
                                        },
                                        onClick = {}
                                    )
                                    if (mine) DropdownMenuItem(
                                        text = { Text("Delete message", color = Color(0xFFFF8A80)) },
                                        onClick = { menuExpanded = false; deleteTarget = message }
                                    )
                                }
                            }
                        }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().background(ChatHeader)) {
                pendingReply?.let { reply ->
                    Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 8.dp, top = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(if (reply.senderId == userId) "Replying to your message" else "Replying to message", color = ChatGold, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            Text(if (reply.content.startsWith("IMG:") || reply.content.startsWith("IMGSET:")) "Photo" else reply.content.take(100), color = ChatMuted, fontSize = 11.sp, maxLines = 1)
                        }
                        TextButton(onClick = { pendingReply = null }) { Text("Cancel", color = ChatGold, fontSize = 11.sp) }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { photoPicker.launch("image/*") }, enabled = !sending) { Text("＋", color = ChatGold, fontSize = 21.sp) }
                Box(Modifier.weight(1f).background(ChatBg, RoundedCornerShape(22.dp)).padding(horizontal = 15.dp, vertical = 12.dp)) {
                    if (draft.isBlank()) Text("Message…", color = ChatMuted, fontSize = 14.sp)
                    BasicTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !sending,
                        textStyle = androidx.compose.ui.text.TextStyle(color = ChatText, fontSize = 14.sp),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        maxLines = 5
                    )
                }
                Spacer(Modifier.width(8.dp))
                Button(
                    onClick = { if (selectedPhotos.isNotEmpty()) sendPhotos() else sendMessage() },
                    enabled = (draft.isNotBlank() || selectedPhotos.isNotEmpty()) && !sending,
                    colors = ButtonDefaults.buttonColors(containerColor = ChatGold, contentColor = ChatBg),
                    shape = RoundedCornerShape(20.dp)
                ) { Text(if (sending) "…" else if (selectedPhotos.isNotEmpty()) "Send ${selectedPhotos.size}" else "Send", fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

private fun decodeNativeReply(raw: String): Pair<NativePendingReply?, String> {
    if (!raw.startsWith(NativeReplyMarker)) return null to raw
    val newline = raw.indexOf('\n')
    if (newline < 0) return null to raw
    return try {
        val obj = kotlinx.serialization.json.Json.parseToJsonElement(raw.substring(NativeReplyMarker.length, newline)) as kotlinx.serialization.json.JsonObject
        val id = (obj["id"] as? JsonPrimitive)?.content ?: return null to raw
        val sender = (obj["sender_id"] as? JsonPrimitive)?.content ?: return null to raw
        val content = (obj["content"] as? JsonPrimitive)?.content ?: return null to raw
        NativePendingReply(id, sender, content) to raw.substring(newline + 1)
    } catch (_: Exception) { null to raw }
}

private fun formatChatTime(value: String): String = try {
    Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("h:mm a"))
} catch (_: Exception) { "" }

@Composable
private fun MessageContent(content: String) {
    val urls = try {
        when {
            content.startsWith("IMGSET:") -> (kotlinx.serialization.json.Json.parseToJsonElement(content.removePrefix("IMGSET:")) as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty()
            content.startsWith("IMG:") -> listOf(content.removePrefix("IMG:"))
            else -> emptyList()
        }
    } catch (_: Exception) { emptyList() }
    if (urls.isEmpty()) Text(content, color = ChatText, fontSize = 14.sp, lineHeight = 20.sp)
    else if (urls.size == 1) AsyncImage(model = urls.first(), contentDescription = "Photo message", modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp).clip(RoundedCornerShape(12.dp)), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
    else Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        urls.forEachIndexed { index, url ->
            Surface(
                modifier = Modifier.fillMaxWidth().padding(start = (index * 4).coerceAtMost(16).dp, end = ((urls.lastIndex - index) * 4).coerceAtMost(16).dp),
                color = Color(0xFF4A3032),
                shape = RoundedCornerShape(15.dp),
                shadowElevation = 5.dp
            ) {
                Column(Modifier.padding(5.dp)) {
                    AsyncImage(model = url, contentDescription = "Album photo ${index + 1}", modifier = Modifier.fillMaxWidth().height(170.dp).clip(RoundedCornerShape(11.dp)), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
                    Text("${index + 1} / ${urls.size}", color = ChatMuted, fontSize = 10.sp, modifier = Modifier.align(Alignment.End).padding(top = 3.dp, end = 5.dp))
                }
            }
        }
    }
}
