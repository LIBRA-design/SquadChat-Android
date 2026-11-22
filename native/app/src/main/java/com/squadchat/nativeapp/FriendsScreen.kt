package com.squadchat.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.coroutines.delay
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

private val FriendsBg = Color(0xFF160B0D)
private val FriendsPanel = Color(0xFF271113)
private val FriendsGold = Color(0xFFD8A65C)
private val FriendsText = Color(0xFFFFF2DF)
private val FriendsMuted = Color(0xFFBDAEAA)

@Serializable
private data class FriendDirectoryProfile(
    val id: String,
    val username: String,
    @SerialName("display_name") val displayName: String? = null,
    val bio: String? = null,
    @SerialName("profile_photo_url") val photoUrl: String? = null,
    @SerialName("last_seen_at") val lastSeenAt: String? = null
)

@Composable
fun FriendsScreen(userId: String) {
    val supabase = SupabaseClientProvider.client
    var people by remember(userId) { mutableStateOf<List<FriendDirectoryProfile>>(emptyList()) }
    var search by remember { mutableStateOf("") }
    var loading by remember(userId) { mutableStateOf(true) }
    var error by remember { mutableStateOf("") }

    LaunchedEffect(userId) {
        try {
            people = supabase.postgrest["profiles"]
                .select(columns = Columns.list("id", "username", "display_name", "bio", "profile_photo_url", "last_seen_at"))
                .decodeList<FriendDirectoryProfile>()
                .filterNot { it.id == userId }
                .sortedBy { (it.displayName ?: it.username).lowercase() }
        } catch (e: Exception) {
            error = e.message?.take(160) ?: "Could not load people."
        } finally {
            loading = false
        }
    }

    val filtered = people.filter {
        val term = search.trim().removePrefix("@").lowercase()
        term.isBlank() || it.username.lowercase().contains(term) ||
            it.displayName.orEmpty().lowercase().contains(term)
    }

    Column(Modifier.fillMaxSize().background(FriendsBg).padding(horizontal = 18.dp, vertical = 16.dp)) {
        Text("Friends", color = FriendsText, fontSize = 25.sp, fontWeight = FontWeight.Bold)
        Text("Find people on SquadChat", color = FriendsMuted, fontSize = 13.sp)
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = search, onValueChange = { search = it },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true, placeholder = { Text("Search username or name") }
        )
        Spacer(Modifier.height(12.dp))
        when {
            loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = FriendsGold)
            }
            error.isNotBlank() -> Text(error, color = Color(0xFFFFB4AB))
            filtered.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(if (people.isEmpty()) "No other profiles found yet." else "No matching people.", color = FriendsMuted)
            }
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                items(filtered, key = { it.id }) { person ->
                    Surface(color = FriendsPanel, shape = RoundedCornerShape(17.dp)) {
                        Row(
                            Modifier.fillMaxWidth().padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            if (!person.photoUrl.isNullOrBlank()) {
                                AsyncImage(
                                    model = person.photoUrl, contentDescription = "Profile photo",
                                    modifier = Modifier.size(48.dp).clip(CircleShape),
                                    contentScale = androidx.compose.ui.layout.ContentScale.Crop
                                )
                            } else {
                                Box(Modifier.size(48.dp).clip(CircleShape).background(Color(0xFF382123)), contentAlignment = Alignment.Center) {
                                    Text((person.displayName ?: person.username).take(1).uppercase(), color = FriendsGold, fontWeight = FontWeight.Bold)
                                }
                            }
                            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                                Text(person.displayName?.takeIf { it.isNotBlank() } ?: "@${person.username}", color = FriendsText, fontWeight = FontWeight.SemiBold)
                                if (!person.displayName.isNullOrBlank()) Text("@${person.username}", color = FriendsMuted, fontSize = 11.sp)
                                if (!person.bio.isNullOrBlank()) Text(person.bio, color = FriendsMuted, fontSize = 12.sp, maxLines = 2)
                            }
                        }
                    }
                }
            }
        }
    }
}
