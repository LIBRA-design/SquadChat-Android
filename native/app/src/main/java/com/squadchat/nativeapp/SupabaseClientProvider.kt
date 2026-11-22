package com.squadchat.nativeapp

import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.auth.FlowType

/**
 * Public client configuration only.
 * Never place a Supabase service-role or secret key in this Android app.
 */
object SupabaseClientProvider {
    const val AUTH_REDIRECT_URL = "squadchat://auth-callback"

    val client = createSupabaseClient(
        supabaseUrl = BuildConfig.SUPABASE_URL,
        supabaseKey = BuildConfig.SUPABASE_PUBLISHABLE_KEY
    ) {
        install(Auth) {
            flowType = FlowType.PKCE
            scheme = "squadchat"
            host = "auth-callback"
            alwaysAutoRefresh = true
            autoLoadFromStorage = true
        }
    }
}
