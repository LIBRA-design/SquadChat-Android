package com.squadchat.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.coroutines.delay
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

@Serializable
private data class ChatMessageRow(
    val id: String,
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("sender_id") val senderId: String,
    val content: String,
    @SerialName("created_at") val createdAt: String
)

@Composable
fun ChatScreen(userId: String, conversationId: String, conversationTitle: String, isGroup: Boolean, onBack: () -> Unit) {
    val supabase = SupabaseClientProvider.client
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var messages by remember { mutableStateOf<List<ChatMessageRow>>(emptyList()) }
    var draft by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var sending by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf("") }

    suspend fun loadMessages() {
        try {
            messages = supabase.postgrest["messages"]
                .select(columns = Columns.list("id", "conversation_id", "sender_id", "content", "created_at")) {
                    filter { eq("conversation_id", conversationId) }
                    order(column = "created_at", order = Order.ASCENDING)
                    limit(count = 300)
                }.decodeList<ChatMessageRow>()
            errorMessage = ""
        } catch (e: Exception) {
            errorMessage = e.message?.take(180) ?: "Could not load messages. Check your connection."
        } finally {
            loading = false
        }
    }

    LaunchedEffect(conversationId) {
        loadMessages()
        // Polling is used until messages are enabled in the Supabase Realtime publication.
        while (true) {
            delay(4000)
            loadMessages()
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
                supabase.postgrest["messages"].insert(buildJsonObject {
                    put("conversation_id", conversationId)
                    put("sender_id", userId)
                    put("content", text)
                })
                draft = ""
                loadMessages()
            } catch (e: Exception) {
                errorMessage = e.message?.take(180) ?: "Message could not be sent. Check your connection."
            } finally {
                sending = false
            }
        }
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
                    Text(if (isGroup) "GROUP CHAT" else "PRIVATE CHAT", color = ChatMuted, fontSize = 9.sp, letterSpacing = 2.sp)
                }
                TextButton(onClick = { scope.launch { loadMessages() } }) { Text("Refresh", color = ChatGold, fontSize = 12.sp) }
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
                    Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                    state = listState,
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(messages, key = { it.id }) { message ->
                        val mine = message.senderId == userId
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
                            Column(
                                Modifier.fillMaxWidth(0.82f)
                                    .background(if (mine) ChatHeader else ChatIncoming, RoundedCornerShape(17.dp))
                                    .padding(horizontal = 13.dp, vertical = 9.dp)
                            ) {
                                Text(message.content, color = ChatText, fontSize = 14.sp, lineHeight = 20.sp)
                                Spacer(Modifier.height(4.dp))
                                Text(formatChatTime(message.createdAt), color = ChatMuted, fontSize = 9.sp, modifier = Modifier.align(Alignment.End))
                            }
                        }
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().background(ChatHeader).padding(horizontal = 10.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
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
                    onClick = { sendMessage() },
                    enabled = draft.isNotBlank() && !sending,
                    colors = ButtonDefaults.buttonColors(containerColor = ChatGold, contentColor = ChatBg),
                    shape = RoundedCornerShape(20.dp)
                ) { Text(if (sending) "…" else "Send", fontWeight = FontWeight.Bold) }
            }
        }
    }
}

private fun formatChatTime(value: String): String = try {
    Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("h:mm a"))
} catch (_: Exception) { "" }
