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
    private static final String CONVERSATION_KEY = "conversation_id";
    private static final String NOTIFICATION_TAG_PREFIX = "squadchat:";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(TOKEN_KEY, token).apply();
        MainActivity.deliverFcmToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        String title = "SquadChat";
        String body = "You have a new message";
        String conversationId = null;

        if (remoteMessage.getNotification() != null) {
            if (remoteMessage.getNotification().getTitle() != null) title = remoteMessage.getNotification().getTitle();
            if (remoteMessage.getNotification().getBody() != null) body = remoteMessage.getNotification().getBody();
        }

        if (remoteMessage.getData() != null) {
            if (remoteMessage.getData().containsKey("title")) title = remoteMessage.getData().get("title");
            if (remoteMessage.getData().containsKey("body")) body = remoteMessage.getData().get("body");
            conversationId = remoteMessage.getData().get(CONVERSATION_KEY);
        }

        showNotification(title, body, conversationId);
    }

    private void showNotification(String title, String body, String conversationId) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Notifications for new SquadChat messages");
            manager.createNotificationChannel(channel);
        }

        String safeConversationId = (conversationId == null || conversationId.trim().isEmpty())
            ? "unlinked"
            : conversationId.trim();
        String notificationTag = NOTIFICATION_TAG_PREFIX + safeConversationId;

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (conversationId != null && !conversationId.trim().isEmpty()) {
            intent.putExtra(MainActivity.EXTRA_CONVERSATION_ID, conversationId);
        }

        int requestCode = safeConversationId.hashCode();
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH);

        builder.setSmallIcon(R.drawable.squadchat_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);

        // A stable tag per conversation allows the app to replace and later clear
        // only that conversation's notification. The web app calls the native bridge
        // when that conversation is actually opened.
        manager.notify(notificationTag, 0, builder.build());
    }
}
