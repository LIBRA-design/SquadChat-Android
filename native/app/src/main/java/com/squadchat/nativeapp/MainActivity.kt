package com.squadchat.nativeapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Maroon = Color(0xFF430D0C)
private val DeepMaroon = Color(0xFF170B0D)
private val Gold = Color(0xFFE0B169)
private val WarmWhite = Color(0xFFF5F0E8)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Gold,
                    onPrimary = DeepMaroon,
                    background = DeepMaroon,
                    surface = Maroon,
                    onSurface = WarmWhite
                )
            ) {
                NativeFoundationScreen()
            }
        }
    }
}

@Composable
private fun NativeFoundationScreen() {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = DeepMaroon
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(DeepMaroon)
                .padding(28.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Text(
                    text = "SquadChat",
                    color = Gold,
                    fontSize = 38.sp,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "NATIVE ANDROID",
                    color = WarmWhite.copy(alpha = 0.72f),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 3.sp
                )
                Spacer(Modifier.height(34.dp))
                Surface(
                    color = Maroon,
                    shape = RoundedCornerShape(20.dp)
                ) {
                    Column(
                        modifier = Modifier.padding(22.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            text = "Independent app foundation",
                            color = Gold,
                            fontSize = 18.sp,
                            fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center
                        )
                        Spacer(Modifier.height(12.dp))
                        Text(
                            text = "This is a separate native Android project. It does not load or modify your live AppDeploy app.",
                            color = WarmWhite,
                            fontSize = 14.sp,
                            lineHeight = 21.sp,
                            textAlign = TextAlign.Center
                        )
                        Spacer(Modifier.height(16.dp))
                        Text(
                            text = "Next: connect Supabase authentication, then rebuild chat features one stage at a time.",
                            color = WarmWhite.copy(alpha = 0.76f),
                            fontSize = 13.sp,
                            lineHeight = 19.sp,
                            textAlign = TextAlign.Center
                        )
                    }
                }
            }
        }
    }
}
