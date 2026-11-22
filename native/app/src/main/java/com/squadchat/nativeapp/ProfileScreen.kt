package com.squadchat.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

private val ProfileBg = Color(0xFF170B0D)
private val ProfilePanel = Color(0xFF430D0C)
private val ProfileGold = Color(0xFFE0B169)
private val ProfileText = Color(0xFFF5F0E8)
private val ProfileMuted = Color(0xFFBDAEAA)

@Serializable
private data class NativeProfileRow(
    val username: String,
    @SerialName("display_name") val displayName: String? = null,
    val bio: String? = null,
    @SerialName("profile_photo_url") val profilePhotoUrl: String? = null
)

@Composable
fun ProfileScreen(userId: String, email: String) {
    val supabase = SupabaseClientProvider.client
    var profile by remember(userId) { mutableStateOf<NativeProfileRow?>(null) }
    var loading by remember(userId) { mutableStateOf(true) }
    var error by remember(userId) { mutableStateOf("") }

    LaunchedEffect(userId) {
        try {
            profile = supabase.postgrest["profiles"]
                .select(columns = Columns.list("username", "display_name", "bio", "profile_photo_url")) {
                    filter { eq("id", userId) }
                    limit(count = 1)
                }.decodeList<NativeProfileRow>().firstOrNull()
            if (profile == null) error = "Profile information is not available."
        } catch (e: Exception) {
            error = e.message?.take(180) ?: "Could not load your profile. Check your connection."
        } finally {
            loading = false
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().background(ProfileBg).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("My Profile", color = ProfileGold, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(24.dp))
        when {
            loading -> Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = ProfileGold)
            }
            profile != null -> {
                val current = profile!!
                if (!current.profilePhotoUrl.isNullOrBlank()) {
                    AsyncImage(
                        model = current.profilePhotoUrl,
                        contentDescription = "Profile photo",
                        modifier = Modifier.padding(bottom = 18.dp).size(112.dp).clip(CircleShape).background(ProfilePanel),
                        contentScale = ContentScale.Crop
                    )
                } else {
                    Surface(
                        modifier = Modifier.padding(bottom = 18.dp),
                        color = ProfilePanel,
                        shape = CircleShape
                    ) {
                        Text(
                            current.username.take(1).uppercase(),
                            color = ProfileGold,
                            fontSize = 34.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 30.dp, vertical = 22.dp)
                        )
                    }
                }
                Surface(color = ProfilePanel, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        ProfileField("Display name", current.displayName?.takeIf { it.isNotBlank() } ?: current.username)
                        ProfileField("Username", "@${current.username}")
                        ProfileField("Email", email.ifBlank { "Not available" })
                        ProfileField("Bio", current.bio?.takeIf { it.isNotBlank() } ?: "No bio added")
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    "Profile details are shown from your SquadChat account. Editing and photo changes will be added in a later stage.",
                    color = ProfileMuted,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center
                )
            }
            else -> Text(error, color = Color(0xFFFFB4AB), modifier = Modifier.padding(20.dp))
        }
    }
}

@Composable
private fun ProfileField(label: String, value: String) {
    Column {
        Text(label, color = ProfileMuted, fontSize = 11.sp)
        Spacer(Modifier.height(3.dp))
        Text(value, color = ProfileText, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    }
}
