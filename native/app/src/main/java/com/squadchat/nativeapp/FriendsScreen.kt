package com.squadchat.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID

private val FriendsBg = Color(0xFF160B0D)
private val FriendsPanel = Color(0xFF271113)
private val FriendsGold = Color(0xFFD8A65C)
private val FriendsText = Color(0xFFFFF2DF)
private val FriendsMuted = Color(0xFFBDAEAA)

@Serializable
private data class FriendProfile(
    val id: String,
    val username: String,
    @SerialName("display_name") val displayName: String? = null,
    val bio: String? = null,
    @SerialName("profile_photo_url") val photoUrl: String? = null,
    @SerialName("last_seen_at") val lastSeenAt: String? = null
)
@Serializable
private data class FriendMembership(@SerialName("conversation_id") val conversationId: String, @SerialName("user_id") val userId: String)
@Serializable
private data class FriendConversation(val id: String, val title: String? = null, @SerialName("is_group") val isGroup: Boolean)

@Composable
fun FriendsScreen(userId: String, onOpenChat: (String, String, Boolean) -> Unit) {
    val supabase = SupabaseClientProvider.client
    val scope = rememberCoroutineScope()
    var usernameSearch by remember { mutableStateOf("") }
    var foundPerson by remember { mutableStateOf<FriendProfile?>(null) }
    var searching by remember { mutableStateOf(false) }
    var groupName by remember { mutableStateOf("") }
    var groupUsernames by remember { mutableStateOf("") }
    var creatingGroup by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var isError by remember { mutableStateOf(false) }

    fun showError(value: String) { message = value; isError = true }
    fun showNotice(value: String) { message = value; isError = false }

    suspend fun openPrivateChat(person: FriendProfile) {
        val mine = supabase.postgrest["conversation_members"].select(columns = Columns.list("conversation_id", "user_id")) {
            filter { eq("user_id", userId) }
        }.decodeList<FriendMembership>()
        val theirs = supabase.postgrest["conversation_members"].select(columns = Columns.list("conversation_id", "user_id")) {
            filter { eq("user_id", person.id) }
        }.decodeList<FriendMembership>()
        val shared = mine.map { it.conversationId }.toSet().intersect(theirs.map { it.conversationId }.toSet())
        val existing = if (shared.isEmpty()) null else supabase.postgrest["conversations"].select(columns = Columns.list("id", "title", "is_group")) {
            filter { isIn("id", shared.toList()); eq("is_group", false) }
        }.decodeList<FriendConversation>().firstOrNull()
        val id = existing?.id ?: UUID.randomUUID().toString().also { newId ->
            supabase.postgrest["conversations"].insert(buildJsonObject { put("id", newId); put("is_group", false); put("created_by", userId) })
            supabase.postgrest["conversation_members"].insert(buildJsonObject { put("conversation_id", newId); put("user_id", userId) })
            supabase.postgrest["conversation_members"].insert(buildJsonObject { put("conversation_id", newId); put("user_id", person.id) })
        }
        onOpenChat(id, person.displayName?.takeIf { it.isNotBlank() } ?: person.username, false)
    }

    Column(Modifier.fillMaxSize().background(FriendsBg).padding(horizontal = 18.dp, vertical = 14.dp)) {
        Text("Friends", color = FriendsText, fontSize = 25.sp, fontWeight = FontWeight.Bold)
        Text("Find people by exact username or create a group", color = FriendsMuted, fontSize = 13.sp)
        Spacer(Modifier.height(14.dp))
        Surface(color = FriendsPanel, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("Find a friend", color = FriendsGold, fontWeight = FontWeight.SemiBold)
                OutlinedTextField(value = usernameSearch, onValueChange = { usernameSearch = it; foundPerson = null; message = "" },
                    modifier = Modifier.fillMaxWidth(), singleLine = true, label = { Text("Exact username") }, placeholder = { Text("Enter username") })
                Button(onClick = {
                    scope.launch {
                        searching = true; foundPerson = null; message = ""
                        try {
                            val term = usernameSearch.trim().removePrefix("@")
                            require(term.isNotBlank()) { "Enter a username to search." }
                            val result = supabase.postgrest["profiles"].select(columns = Columns.list("id", "username", "display_name", "bio", "profile_photo_url", "last_seen_at")) {
                                filter { eq("username", term) }; limit(count = 1)
                            }.decodeList<FriendProfile>().firstOrNull()
                            if (result == null || result.id == userId) showError("No other user was found with that exact username.")
                            else { foundPerson = result; showNotice("User found.") }
                        } catch (e: Exception) { showError(e.message?.take(180) ?: "Username search failed.") }
                        finally { searching = false }
                    }
                }, enabled = !searching, colors = ButtonDefaults.buttonColors(containerColor = FriendsGold, contentColor = FriendsBg)) {
                    Text(if (searching) "Searching…" else "Search username")
                }
                foundPerson?.let { person ->
                    HorizontalDivider(color = FriendsMuted.copy(alpha = .25f))
                    Text(person.displayName?.takeIf { it.isNotBlank() } ?: "@${person.username}", color = FriendsText, fontWeight = FontWeight.Bold)
                    if (!person.displayName.isNullOrBlank()) Text("@${person.username}", color = FriendsMuted, fontSize = 12.sp)
                    if (!person.bio.isNullOrBlank()) Text(person.bio, color = FriendsMuted, fontSize = 12.sp)
                    Text(presenceText(person.lastSeenAt), color = FriendsGold, fontSize = 12.sp)
                    Button(onClick = {
                        scope.launch {
                            searching = true
                            try { openPrivateChat(person) }
                            catch (e: Exception) { showError(e.message?.take(180) ?: "Could not open this conversation.") }
                            finally { searching = false }
                        }
                    }, enabled = !searching, colors = ButtonDefaults.buttonColors(containerColor = FriendsGold, contentColor = FriendsBg)) { Text("Message") }
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        Surface(color = FriendsPanel, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("Create a group", color = FriendsGold, fontWeight = FontWeight.SemiBold)
                OutlinedTextField(value = groupName, onValueChange = { groupName = it.take(60) }, modifier = Modifier.fillMaxWidth(),
                    singleLine = true, label = { Text("Group name (up to 60 characters)") })
                Text("${groupName.length}/60", color = FriendsMuted, fontSize = 10.sp)
                OutlinedTextField(value = groupUsernames, onValueChange = { groupUsernames = it }, modifier = Modifier.fillMaxWidth(),
                    minLines = 2, maxLines = 3, label = { Text("Member usernames") }, placeholder = { Text("username1, username2") })
                Button(onClick = {
                    scope.launch {
                        creatingGroup = true; message = ""
                        try {
                            val title = groupName.trim()
                            require(title.isNotBlank()) { "Enter a group name." }
                            require(title.length <= 60) { "Group name must be 60 characters or fewer." }
                            val names = groupUsernames.split(",").map { it.trim().removePrefix("@") }.filter { it.isNotBlank() }.distinct()
                            require(names.size >= 2) { "Enter at least two member usernames." }
                            val me = supabase.postgrest["profiles"].select(columns = Columns.list("username")) {
                                filter { eq("id", userId) }; limit(count = 1)
                            }.decodeList<kotlinx.serialization.json.JsonObject>().firstOrNull()?.get("username")?.toString()?.trim('"')
                            require(names.none { it.equals(me, ignoreCase = true) }) { "Do not enter your own username. You are included as the group creator." }
                            val found = supabase.postgrest["profiles"].select(columns = Columns.list("id", "username")) {
                                filter { isIn("username", names) }
                            }.decodeList<kotlinx.serialization.json.JsonObject>()
                            val resolved = found.associate { it["username"]!!.toString().trim('"') to it["id"]!!.toString().trim('"') }
                            val missing = names.filterNot { n -> resolved.keys.any { it.equals(n, ignoreCase = true) } }
                            require(missing.isEmpty()) { "Unknown username(s): ${missing.joinToString(", ")}" }
                            val memberIds = (resolved.values + userId).distinct().sorted()
                            require(memberIds.size >= 3) { "A group needs you and at least two other members." }
                            val myGroupIds = supabase.postgrest["conversation_members"].select(columns = Columns.list("conversation_id")) {
                                filter { eq("user_id", userId) }
                            }.decodeList<kotlinx.serialization.json.JsonObject>().map { it["conversation_id"]!!.toString().trim('"') }.distinct()
                            val candidates = if (myGroupIds.isEmpty()) emptyList() else supabase.postgrest["conversations"].select(columns = Columns.list("id", "title", "is_group")) {
                                filter { isIn("id", myGroupIds); eq("is_group", true); eq("title", title) }
                            }.decodeList<FriendConversation>()
                            val candidateMembers = if (candidates.isEmpty()) emptyList() else supabase.postgrest["conversation_members"].select(columns = Columns.list("conversation_id", "user_id")) {
                                filter { isIn("conversation_id", candidates.map { it.id }) }
                            }.decodeList<FriendMembership>()
                            val reused = candidates.firstOrNull { c -> candidateMembers.filter { it.conversationId == c.id }.map { it.userId }.toSet() == memberIds.toSet() }
                            val id = reused?.id ?: UUID.randomUUID().toString().also { newId ->
                                supabase.postgrest["conversations"].insert(buildJsonObject { put("id", newId); put("title", title); put("is_group", true); put("created_by", userId) })
                                memberIds.forEach { memberId -> supabase.postgrest["conversation_members"].insert(buildJsonObject { put("conversation_id", newId); put("user_id", memberId) }) }
                            }
                            groupName = ""; groupUsernames = ""
                            onOpenChat(id, title, true)
                        } catch (e: Exception) { showError(e.message?.take(220) ?: "Could not create group.") }
                        finally { creatingGroup = false }
                    }
                }, enabled = !creatingGroup, colors = ButtonDefaults.buttonColors(containerColor = FriendsGold, contentColor = FriendsBg)) {
                    Text(if (creatingGroup) "Creating…" else "Create group")
                }
            }
        }
        if (message.isNotBlank()) {
            Spacer(Modifier.height(10.dp))
            Text(message, color = if (isError) Color(0xFFFFB4AB) else FriendsGold, fontSize = 12.sp)
        }
    }
}

private fun presenceText(value: String?): String {
    if (value.isNullOrBlank()) return "Presence unavailable"
    return try {
        val minutes = java.time.Duration.between(Instant.parse(value), Instant.now()).toMinutes().coerceAtLeast(0)
        when { minutes <= 2 -> "Online"; minutes < 60 -> "Last seen $minutes min ago"; minutes < 1440 -> "Last seen ${minutes / 60} hr ago"; else -> "Last seen ${minutes / 1440} d ago" }
    } catch (_: Exception) { "Presence unavailable" }
}
