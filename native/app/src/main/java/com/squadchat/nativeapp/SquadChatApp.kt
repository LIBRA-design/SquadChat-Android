package com.squadchat.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.providers.builtin.Email
import io.github.jan.supabase.auth.status.SessionStatus
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID
import java.time.Instant

private val Maroon = Color(0xFF430D0C)
private val DeepMaroon = Color(0xFF170B0D)
private val Gold = Color(0xFFE0B169)
private val WarmWhite = Color(0xFFF5F0E8)
private val Muted = Color(0xFFBDAEAA)

@Composable
fun SquadChatApp() {
    val supabase = SupabaseClientProvider.client
    val scope = rememberCoroutineScope()
    var checkingSession by remember { mutableStateOf(true) }
    var signedIn by remember { mutableStateOf(false) }
    var signedInEmail by remember { mutableStateOf("") }
    var signedInUserId by remember { mutableStateOf("") }
    var activeConversationId by remember { mutableStateOf<String?>(null) }
    var activeConversationTitle by remember { mutableStateOf("") }
    var activeConversationIsGroup by remember { mutableStateOf(false) }
    var selectedMainTab by remember { mutableStateOf("chats") }
    var logoutMessage by remember { mutableStateOf("") }

    LaunchedEffect(signedInUserId) {
        if (signedInUserId.isNotBlank()) {
            while (true) {
                runCatching {
                    supabase.postgrest["profiles"].update(buildJsonObject {
                        put("last_seen_at", Instant.now().toString())
                    }) { filter { eq("id", signedInUserId) } }
                }
                kotlinx.coroutines.delay(60_000)
            }
        }
    }

    LaunchedEffect(supabase) {
        supabase.auth.sessionStatus.collect { status ->
            when (status) {
                is SessionStatus.Authenticated -> {
                    signedIn = true
                    signedInEmail = status.session.user?.email.orEmpty()
                    signedInUserId = status.session.user?.id.orEmpty()
                    checkingSession = false
                }
                is SessionStatus.NotAuthenticated -> {
                    signedIn = false
                    signedInEmail = ""
                    signedInUserId = ""
                    activeConversationId = null
                    checkingSession = false
                }
                SessionStatus.Initializing -> checkingSession = true
                is SessionStatus.RefreshFailure -> {
                    signedIn = false
                    signedInEmail = ""
                    signedInUserId = ""
                    activeConversationId = null
                    checkingSession = false
                }
                else -> checkingSession = true
            }
        }
    }

    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Gold,
            onPrimary = DeepMaroon,
            background = DeepMaroon,
            surface = Maroon,
            onSurface = WarmWhite
        )
    ) {
        Surface(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing), color = DeepMaroon) {
            when {
                checkingSession -> LoadingScreen()
                signedIn && activeConversationId != null -> ChatScreen(
                    userId = signedInUserId,
                    conversationId = activeConversationId!!,
                    conversationTitle = activeConversationTitle,
                    isGroup = activeConversationIsGroup,
                    onBack = { activeConversationId = null }
                )
                signedIn -> Column(modifier = Modifier.fillMaxSize()) {
                    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        if (selectedMainTab == "profile") {
                            ProfileScreen(userId = signedInUserId, email = signedInEmail)
                        } else {
                            ConversationListScreen(
                                userId = signedInUserId,
                                email = signedInEmail,
                                onSignOut = {
                                    scope.launch {
                                        runCatching { supabase.auth.signOut() }
                                            .onFailure { logoutMessage = "Could not log out. Check your connection and try again." }
                                    }
                                },
                                onOpenChat = { id, title, isGroup ->
                                    activeConversationId = id
                                    activeConversationTitle = title
                                    activeConversationIsGroup = isGroup
                                }
                            )
                        }
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth().background(DeepMaroon).padding(horizontal = 20.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        TextButton(onClick = { selectedMainTab = "chats" }) {
                            Text("Chats", color = if (selectedMainTab == "chats") Gold else Muted, fontWeight = FontWeight.SemiBold)
                        }
                        TextButton(onClick = { selectedMainTab = "profile" }) {
                            Text("Profile", color = if (selectedMainTab == "profile") Gold else Muted, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                else -> AuthenticationScreen()
            }
        }
    }
}

@Composable
private fun LoadingScreen() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = Gold)
            Spacer(Modifier.height(16.dp))
            Text("Checking your session…", color = WarmWhite)
        }
    }
}

@Composable
private fun SignedInScreen(email: String, message: String, onSignOut: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(DeepMaroon)
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("SquadChat", color = Gold, fontSize = 36.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text("NATIVE ANDROID", color = Muted, fontSize = 12.sp, letterSpacing = 3.sp)
            Spacer(Modifier.height(30.dp))
            Surface(color = Maroon, shape = RoundedCornerShape(20.dp)) {
                Column(
                    modifier = Modifier.padding(22.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text("Authentication connected", color = Gold, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(12.dp))
                    Text("Signed in as", color = Muted)
                    Text(email.ifBlank { "Your account" }, color = WarmWhite, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(14.dp))
                    Text(
                        "Your account session is active. The conversation list and messaging features will be added in the next stages.",
                        color = WarmWhite,
                        textAlign = TextAlign.Center,
                        lineHeight = 21.sp
                    )
                    if (message.isNotBlank()) {
                        Spacer(Modifier.height(10.dp))
                        Text(message, color = Color(0xFFFFB4AB), textAlign = TextAlign.Center)
                    }
                    Spacer(Modifier.height(20.dp))
                    Button(
                        onClick = onSignOut,
                        colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = DeepMaroon),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Log out", fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
private fun AuthenticationScreen() {
    val supabase = SupabaseClientProvider.client
    val scope = rememberCoroutineScope()
    var isSignUp by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var isError by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DeepMaroon)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 26.dp, vertical = 34.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text("SquadChat", color = Gold, fontSize = 38.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text("NATIVE ANDROID", color = Muted, fontSize = 12.sp, letterSpacing = 3.sp)
        Spacer(Modifier.height(30.dp))

        Surface(color = Maroon, shape = RoundedCornerShape(22.dp), modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(22.dp)) {
                Text(
                    if (isSignUp) "Create your account" else "Welcome back",
                    color = Gold,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    if (isSignUp) "Use your email address to create a SquadChat account." else "Sign in to continue to SquadChat.",
                    color = WarmWhite,
                    fontSize = 14.sp
                )
                Spacer(Modifier.height(20.dp))

                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it.trimStart(); message = "" },
                    label = { Text("Email address") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; message = "" },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        TextButton(onClick = { showPassword = !showPassword }) {
                            Text(if (showPassword) "Hide" else "Show", color = Gold)
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                if (isSignUp) {
                    Text(
                        "Use at least 6 characters. If email confirmation is enabled, you must confirm your email before signing in.",
                        color = Muted,
                        fontSize = 12.sp,
                        lineHeight = 17.sp
                    )
                }
                if (message.isNotBlank()) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        message,
                        color = if (isError) Color(0xFFFFB4AB) else Gold,
                        fontSize = 13.sp,
                        lineHeight = 18.sp
                    )
                }
                Spacer(Modifier.height(18.dp))

                Button(
                    onClick = {
                        val cleanEmail = email.trim()
                        when {
                            cleanEmail.isBlank() || !cleanEmail.contains("@") -> {
                                isError = true
                                message = "Enter a valid email address."
                            }
                            password.length < 6 -> {
                                isError = true
                                message = "Password must be at least 6 characters."
                            }
                            else -> {
                                scope.launch {
                                    busy = true
                                    message = ""
                                    try {
                                        if (isSignUp) {
                                            // The existing database profile trigger requires usernames of 3–20
                                            // letters, digits, or underscores. Supply one so its fallback
                                            // (which currently exceeds 20 characters) is not used.
                                            val generatedUsername = "user_" + UUID.randomUUID()
                                                .toString()
                                                .replace("-", "")
                                                .take(15)
                                            val user = supabase.auth.signUpWith(
                                                Email,
                                                redirectUrl = SupabaseClientProvider.AUTH_REDIRECT_URL
                                            ) {
                                                this.email = cleanEmail
                                                this.password = password
                                                data = buildJsonObject {
                                                    put("username", generatedUsername)
                                                }
                                            }
                                            isError = false
                                            message = if (user != null) {
                                                "Account request submitted. Check your email and confirm it before signing in."
                                            } else {
                                                "Account created. You can now sign in."
                                            }
                                        } else {
                                            supabase.auth.signInWith(Email) {
                                                this.email = cleanEmail
                                                this.password = password
                                            }
                                            isError = false
                                            message = "Sign-in successful."
                                        }
                                    } catch (error: Exception) {
                                        isError = true
                                        message = friendlyAuthError(error.message)
                                    } finally {
                                        busy = false
                                    }
                                }
                            }
                        }
                    },
                    enabled = !busy,
                    colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = DeepMaroon),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    if (busy) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(18.dp),
                            color = DeepMaroon,
                            strokeWidth = 2.dp
                        )
                    } else {
                        Text(if (isSignUp) "Create account" else "Log in", fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(Modifier.height(10.dp))
                OutlinedButton(
                    onClick = {
                        isSignUp = !isSignUp
                        message = ""
                        isError = false
                    },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        if (isSignUp) "I already have an account" else "Create a new account",
                        color = WarmWhite
                    )
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        Text(
            "Your existing AppDeploy SquadChat remains separate and unchanged.",
            color = Muted,
            fontSize = 12.sp,
            textAlign = TextAlign.Center
        )
    }
}

private fun friendlyAuthError(raw: String?): String {
    val value = raw.orEmpty()
    return when {
        value.contains("Invalid login credentials", ignoreCase = true) ->
            "Email or password is incorrect. Check your details and try again."
        value.contains("Email not confirmed", ignoreCase = true) ->
            "Please confirm your email first, then try signing in."
        value.contains("already registered", ignoreCase = true) ->
            "This email already has an account. Try logging in instead."
        value.contains("password", ignoreCase = true) && value.contains("weak", ignoreCase = true) ->
            "Choose a stronger password."
        value.contains("network", ignoreCase = true) || value.contains("connect", ignoreCase = true) ->
            "Network problem. Check your internet connection and try again."
        value.isBlank() -> "Authentication failed. Please try again."
        else -> value.take(180)
    }
}
