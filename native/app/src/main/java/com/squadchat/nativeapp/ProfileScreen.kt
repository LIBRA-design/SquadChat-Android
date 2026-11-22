package com.squadchat.nativeapp

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.storage.storage
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

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
    @SerialName("profile_photo_url") val profilePhotoUrl: String? = null,
    val role: String? = null
)

@Composable
fun ProfileScreen(userId: String, email: String) {
    val supabase = SupabaseClientProvider.client
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var profile by remember(userId) { mutableStateOf<NativeProfileRow?>(null) }
    var displayName by remember(userId) { mutableStateOf("") }
    var bio by remember(userId) { mutableStateOf("") }
    var loading by remember(userId) { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var uploading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") }
    var selectedPhoto by remember { mutableStateOf<Uri?>(null) }

    suspend fun loadProfile() {
        try {
            profile = supabase.postgrest["profiles"]
                .select(columns = Columns.list("username", "display_name", "bio", "profile_photo_url", "role")) {
                    filter { eq("id", userId) }
                    limit(count = 1)
                }.decodeList<NativeProfileRow>().firstOrNull()
            profile?.let {
                displayName = it.displayName.orEmpty()
                bio = it.bio.orEmpty()
            }
            if (profile == null) error = "Profile information is not available."
        } catch (e: Exception) {
            error = e.message?.take(180) ?: "Could not load your profile. Check your connection."
        } finally { loading = false }
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        selectedPhoto = uri
        notice = ""
        error = ""
    }

    LaunchedEffect(userId) { loadProfile() }

    Column(
        modifier = Modifier.fillMaxSize().background(ProfileBg).verticalScroll(rememberScrollState()).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("My Profile", color = ProfileGold, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(20.dp))
        when {
            loading -> Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = ProfileGold)
            }
            profile != null -> {
                val current = profile!!
                val photoModel: Any? = selectedPhoto ?: current.profilePhotoUrl
                if (photoModel != null) {
                    AsyncImage(
                        model = photoModel, contentDescription = "Profile photo",
                        modifier = Modifier.padding(bottom = 10.dp).size(112.dp).clip(CircleShape).background(ProfilePanel),
                        contentScale = ContentScale.Crop
                    )
                } else {
                    Surface(modifier = Modifier.padding(bottom = 10.dp), color = ProfilePanel, shape = CircleShape) {
                        Text(current.username.take(1).uppercase(), color = ProfileGold, fontSize = 34.sp,
                            fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 30.dp, vertical = 22.dp))
                    }
                }
                if (current.role == "admin") {
                    Surface(color = ProfileGold.copy(alpha = 0.16f), shape = RoundedCornerShape(20.dp)) {
                        Text("ADMIN ✓", color = ProfileGold, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                    }
                    Spacer(Modifier.height(8.dp))
                }
                TextButton(onClick = { photoPicker.launch("image/*") }, enabled = !uploading && !saving) {
                    Text("Choose profile photo", color = ProfileGold)
                }
                Surface(color = ProfilePanel, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Display name", color = ProfileMuted, fontSize = 12.sp)
                        OutlinedTextField(value = displayName, onValueChange = { displayName = it },
                            modifier = Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text(current.username) })
                        Text("Username · cannot be changed here", color = ProfileMuted, fontSize = 12.sp)
                        Text("@${current.username}", color = ProfileText, fontSize = 15.sp)
                        Text("Email", color = ProfileMuted, fontSize = 12.sp)
                        Text(email.ifBlank { "Not available" }, color = ProfileText, fontSize = 14.sp)
                        Text("Bio", color = ProfileMuted, fontSize = 12.sp)
                        OutlinedTextField(value = bio, onValueChange = { bio = it },
                            modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 4,
                            placeholder = { Text("Write something about yourself") })
                        Button(
                            onClick = {
                                scope.launch {
                                    saving = true; error = ""; notice = ""
                                    try {
                                        supabase.postgrest["profiles"].update(buildJsonObject {
                                            put("display_name", displayName.trim())
                                            put("bio", bio.trim())
                                        }) { filter { eq("id", userId) } }
                                        loadProfile()
                                        notice = "Profile saved."
                                    } catch (e: Exception) {
                                        error = e.message?.take(180) ?: "Could not save profile."
                                    } finally { saving = false }
                                }
                            },
                            enabled = !saving && !uploading,
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = ProfileGold, contentColor = ProfileBg)
                        ) { Text(if (saving) "Saving…" else "Save profile", fontWeight = FontWeight.Bold) }
                        if (selectedPhoto != null) {
                            OutlinedButton(
                                onClick = {
                                    val uri = selectedPhoto!!
                                    scope.launch {
                                        uploading = true; error = ""; notice = ""
                                        try {
                                            val bytes = readProfileImage(context, uri)
                                            require(bytes.size <= 5 * 1024 * 1024) { "Choose an image smaller than 5 MB." }
                                            val ext = context.contentResolver.getType(uri)?.substringAfter("/")?.lowercase()
                                                ?.takeIf { it in listOf("jpeg", "jpg", "png", "webp", "gif") } ?: "jpg"
                                            val path = "$userId/profile/${UUID.randomUUID()}.$ext"
                                            supabase.storage.from("squadchat-images").upload(path, bytes)
                                            val publicUrl = supabase.storage.from("squadchat-images").publicUrl(path)
                                            supabase.postgrest["profiles"].update(buildJsonObject {
                                                put("profile_photo_url", publicUrl)
                                            }) { filter { eq("id", userId) } }
                                            selectedPhoto = null
                                            loadProfile()
                                            notice = "Profile photo updated."
                                        } catch (e: Exception) {
                                            error = e.message?.take(180) ?: "Photo upload failed. Check your connection."
                                        } finally { uploading = false }
                                    }
                                },
                                enabled = !uploading && !saving,
                                modifier = Modifier.fillMaxWidth()
                            ) { Text(if (uploading) "Uploading photo…" else "Upload selected photo") }
                        }
                    }
                }
                if (notice.isNotBlank()) Text(notice, color = ProfileGold, modifier = Modifier.padding(8.dp))
                if (error.isNotBlank()) Text(error, color = Color(0xFFFFB4AB), modifier = Modifier.padding(8.dp))
            }
            else -> Text(error, color = Color(0xFFFFB4AB), modifier = Modifier.padding(20.dp))
        }
    }
}

private fun readProfileImage(context: Context, uri: Uri): ByteArray {
    return context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        ?: error("Could not read the selected image.")
}
