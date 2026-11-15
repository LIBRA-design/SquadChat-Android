package com.squadchat.app;

import android.app.Activity;
import android.Manifest;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.graphics.Color;
import android.view.View;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.view.Gravity;
import android.window.OnBackInvokedDispatcher;
import org.json.JSONObject;
import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 2002;
    static final String EXTRA_CONVERSATION_ID = "squadchat_conversation_id";
    private static final String NOTIFICATION_TAG_PREFIX = "squadchat:";

    private WebView webView;
    private ProgressBar progressBar;
    private TextView errorText;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean pageLoadFailed = false;
    private String pendingConversationId;
    private int pendingDeliveryAttempts = 0;

    private static volatile MainActivity activeActivity;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeActivity = this;
        pendingConversationId = getIntent() == null ? null :
            getIntent().getStringExtra(EXTRA_CONVERSATION_ID);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                () -> handleBackPress()
            );
        }

        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(Color.rgb(67, 13, 12));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, 8, Gravity.TOP
        );

        errorText = new TextView(this);
        errorText.setTextColor(Color.rgb(245, 240, 232));
        errorText.setTextSize(18);
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(32, 32, 32, 32);
        errorText.setText("Loading SquadChat...\n\nPlease wait.");
        errorText.setVisibility(View.VISIBLE);
        errorText.setOnClickListener(v -> {
            pageLoadFailed = false;
            errorText.setText("Reconnecting to SquadChat...\n\nPlease wait.");
            errorText.setVisibility(View.VISIBLE);
            webView.setVisibility(View.GONE);
            progressBar.setVisibility(View.VISIBLE);
            webView.reload();
        });

        webView = new WebView(this);
        webView.addJavascriptInterface(new FcmBridge(), "SquadChatNative");
        webView.setVisibility(View.GONE);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setSupportZoom(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageLoadFailed = false;
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    pageLoadFailed = true;
                    errorText.setText("No internet connection\n\nPlease connect to the internet, then tap here to retry.");
                    errorText.setVisibility(View.VISIBLE);
                    webView.setVisibility(View.GONE);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                if (!pageLoadFailed) {
                    errorText.setVisibility(View.GONE);
                    webView.setVisibility(View.VISIBLE);
                    deliverPendingConversationOpen();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("SquadChat").setMessage(message)
                    .setPositiveButton("Confirm", (dialog, which) -> result.confirm())
                    .setNegativeButton("Cancel", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("SquadChat").setMessage(message)
                    .setPositiveButton("OK", (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.confirm()).show();
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int progress) {
                progressBar.setProgress(progress);
                progressBar.setVisibility(progress == 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
            }
        });

        layout.addView(webView);
        layout.addView(errorText);
        layout.addView(progressBar, barParams);
        setContentView(layout);

        try {
            webView.loadUrl("https://squadchat-ew2b04.v2.appdeploy.ai/");
        } catch (Exception e) {
            errorText.setText("Unable to start SquadChat: " + e.getMessage());
            errorText.setVisibility(View.VISIBLE);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        pendingConversationId = intent == null ? null :
            intent.getStringExtra(EXTRA_CONVERSATION_ID);
        pendingDeliveryAttempts = 0;
        deliverPendingConversationOpen();
    }

    private void deliverPendingConversationOpen() {
        if (webView == null || pendingConversationId == null || pendingConversationId.trim().isEmpty()) return;
        final String conversationId = pendingConversationId;
        webView.post(() -> {
            if (webView == null || pendingConversationId == null) return;
            String javascript = "(function(){ if (typeof window.onSquadChatNotificationOpen !== 'function') return false; " +
                "window.onSquadChatNotificationOpen(" + JSONObject.quote(conversationId) + "); return true; })()";
            webView.evaluateJavascript(javascript, value -> {
                if ("true".equals(value)) {
                    pendingConversationId = null;
                    pendingDeliveryAttempts = 0;
                } else if (pendingDeliveryAttempts < 40 && webView != null) {
                    pendingDeliveryAttempts++;
                    webView.postDelayed(this::deliverPendingConversationOpen, 250);
                }
            });
        });
    }

    private class FcmBridge {
        @JavascriptInterface
        public void requestFcmToken() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST_CODE);
                }
                sendFcmTokenToWeb();
            });
        }

        @JavascriptInterface
        public void clearConversationNotifications(String conversationId) {
            if (conversationId == null || conversationId.trim().isEmpty()) return;
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(NOTIFICATION_TAG_PREFIX + conversationId, 0);
        }
    }

    static void deliverFcmToken(String token) {
        MainActivity activity = activeActivity;
        if (activity == null || activity.webView == null) return;
        activity.webView.post(() -> {
            if (activity.webView == null) return;
            String javascript = "window.onSquadChatFcmToken && window.onSquadChatFcmToken(" +
                JSONObject.quote(token) + ")";
            activity.webView.evaluateJavascript(javascript, null);
        });
    }

    private void sendFcmTokenToWeb() {
        if (webView == null) return;
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (task.isSuccessful() && webView != null) {
                String token = task.getResult();
                String javascript = "window.onSquadChatFcmToken && window.onSquadChatFcmToken(" +
                    JSONObject.quote(token) + ")";
                webView.evaluateJavascript(javascript, null);
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST_CODE) sendFcmTokenToWeb();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback != null) {
                Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void handleBackPress() {
        if (webView == null || webView.getVisibility() != View.VISIBLE) return;
        webView.evaluateJavascript(
            "window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));",
            null
        );
    }

    @Override
    public void onBackPressed() { handleBackPress(); }

    @Override
    protected void onDestroy() {
        if (activeActivity == this) activeActivity = null;
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
