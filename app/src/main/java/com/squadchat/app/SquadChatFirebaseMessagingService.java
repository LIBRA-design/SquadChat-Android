package com.squadchat.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class SquadChatFirebaseMessagingService extends FirebaseMessagingService {

    private static final String CHANNEL_ID = "squadchat_messages";
    private static final String CHANNEL_NAME = "Chat messages";
    private static final String PREFS_NAME = "squadchat_push";
    private static final String TOKEN_KEY = "fcm_token";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(TOKEN_KEY, token).apply();

        // If the app is currently open, immediately forward the refreshed token
        // to the authenticated web app so it can update Supabase.
        MainActivity.deliverFcmToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        String title = "SquadChat";
        String body = "You have a new message";

        if (remoteMessage.getNotification() != null) {
            if (remoteMessage.getNotification().getTitle() != null) {
                title = remoteMessage.getNotification().getTitle();
            }
            if (remoteMessage.getNotification().getBody() != null) {
                body = remoteMessage.getNotification().getBody();
            }
        }

        if (remoteMessage.getData() != null) {
            if (remoteMessage.getData().containsKey("title")) {
                title = remoteMessage.getData().get("title");
            }
            if (remoteMessage.getData().containsKey("body")) {
                body = remoteMessage.getData().get("body");
            }
        }

        String conversationId = remoteMessage.getData() == null
            ? ""
            : remoteMessage.getData().getOrDefault("conversation_id", "");
        showNotification(title, body, conversationId);
    }

    private void showNotification(String title, String body, String conversationId) {
        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        if (manager == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Notifications for new SquadChat messages");
            manager.createNotificationChannel(channel);
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        Intent intentWithConversation = intent;
        if (conversationId != null && !conversationId.isEmpty()) {
            intentWithConversation.putExtra("conversation_id", conversationId);
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            conversationId == null ? 0 : conversationId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this)
                .setPriority(Notification.PRIORITY_HIGH);
        }

        builder.setSmallIcon(R.drawable.squadchat_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);

        if (conversationId != null && !conversationId.isEmpty()) {
            // One replaceable notification per conversation; the native bridge can
            // reliably cancel it when that conversation is opened from the app icon.
            manager.notify(conversationId, 0, builder.build());
        } else {
            manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), builder.build());
        }
    }
}
