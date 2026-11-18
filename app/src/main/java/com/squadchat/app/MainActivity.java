package com.squadchat.app;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.ClipData;
import android.Manifest;
import android.content.pm.PackageManager;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Environment;
import android.graphics.Color;
import android.view.View;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import android.webkit.WebViewClient;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.provider.MediaStore;
import android.util.Base64;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.view.Gravity;
import android.window.OnBackInvokedDispatcher;
import org.json.JSONObject;
import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends Activity {

    private static final String TRUSTED_HOST = "squadchat-ew2b04.v2.appdeploy.ai";
    private static final String TRUSTED_URL = "https://" + TRUSTED_HOST + "/";

    private boolean isTrustedSquadChatUrl(String url) {
        if (url == null) return false;
        try {
            Uri uri = Uri.parse(url);
            return "https".equalsIgnoreCase(uri.getScheme())
                && TRUSTED_HOST.equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getUserInfo() == null;
        } catch (Exception e) {
            return false;
        }
    }

    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 2002;

    private WebView webView;
    private ProgressBar progressBar;
    private TextView errorText;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean pageLoadFailed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeActivity = this;

        // Android 13+ uses the predictive Back dispatcher; register explicitly
        // so Back is handled inside SquadChat instead of finishing the Activity.
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                () -> handleBackPress()
            );
        }

        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(Color.rgb(67, 13, 12));

        progressBar = new ProgressBar(
            this, null,
            android.R.attr.progressBarStyleHorizontal
        );

        FrameLayout.LayoutParams barParams =
            new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, 8,
                Gravity.TOP
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
        // SquadChat is HTTPS-only; do not allow local files or mixed HTTP content.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        webView.setWebViewClient(new WebViewClient() {
            private boolean openExternalHttpUrl(String url) {
                if (url == null) return true;
                try {
                    Uri uri = Uri.parse(url);
                    String scheme = uri.getScheme();
                    if (uri.getUserInfo() != null ||
                        !("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))) {
                        return true;
                    }
                    Intent external = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(external);
                } catch (Exception ignored) {
                    // Do not allow unsupported or unsafe navigation into the WebView.
                }
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return true;
                String url = request.getUrl().toString();
                if (isTrustedSquadChatUrl(url)) return false;
                return openExternalHttpUrl(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (isTrustedSquadChatUrl(url)) return false;
                return openExternalHttpUrl(url);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Never bypass certificate errors, even if the user is offline.
                handler.cancel();
                if (view == webView) {
                    pageLoadFailed = true;
                    errorText.setText("Secure connection failed\\n\\nPlease check your connection and try again.");
                    errorText.setVisibility(View.VISIBLE);
                    webView.setVisibility(View.GONE);
                }
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (!isTrustedSquadChatUrl(url)) {
                    view.stopLoading();
                    pageLoadFailed = true;
                    errorText.setText("Blocked an untrusted page. SquadChat can only open its official website.");
                    errorText.setVisibility(View.VISIBLE);
                    view.setVisibility(View.GONE);
                    return;
                }
                pageLoadFailed = false;
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
            ) {
                if (request.isForMainFrame()) {
                    pageLoadFailed = true;
                    errorText.setText(
                        "No internet connection\n\n" +
                        "Please connect to the internet, then tap here to retry."
                    );
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
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("SquadChat")
                    .setMessage(message)
                    .setPositiveButton("Confirm", (dialog, which) -> result.confirm())
                    .setNegativeButton("Cancel", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("SquadChat")
                    .setMessage(message)
                    .setPositiveButton("OK", (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.confirm())
                    .show();
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int progress) {
                progressBar.setProgress(progress);
                progressBar.setVisibility(
                    progress == 100 ? View.GONE : View.VISIBLE
                );
            }

            @Override
            public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> filePathCallback,
                FileChooserParams fileChooserParams
            ) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }

                MainActivity.this.filePathCallback = filePathCallback;

                try {
                    Intent intent;
                    if (Build.VERSION.SDK_INT >= 33) {
                        // Android Photo Picker: a native, privacy-preserving photo gallery
                        // that appears as the system's bottom-sheet picker on supported devices.
                        // It returns content URIs directly to WebView without broad media access.
                        intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
                        intent.setType("image/*");
                        if (Build.VERSION.SDK_INT >= 34) {
                            intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 10);
                        }
                    } else {
                        // Android 12 and older use the system document picker with multi-select.
                        intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("image/*");
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    filePathCallback.onReceiveValue(null);
                    return false;
                }
            }
        });

        layout.addView(webView);
        layout.addView(errorText);
        layout.addView(progressBar, barParams);

        setContentView(layout);

        try {
            webView.loadUrl(
                TRUSTED_URL
            );
        } catch (Exception e) {
            errorText.setText("Unable to start SquadChat: " + e.getMessage());
            errorText.setVisibility(View.VISIBLE);
        }
    }


    private static volatile MainActivity activeActivity;

    private final ExecutorService imageSaveExecutor = Executors.newSingleThreadExecutor();

    private void reportImageSave(boolean success, String message) {
        if (webView == null) return;
        String javascript = "window.onSquadChatImageSaved && window.onSquadChatImageSaved(" +
            success + "," + JSONObject.quote(message) + ")";
        webView.post(() -> {
            if (webView != null) webView.evaluateJavascript(javascript, null);
        });
    }

    private class FcmBridge {
        @JavascriptInterface
        public void saveImage(String base64Data, String mimeType, String fileName) {
            if (Build.VERSION.SDK_INT < 29) {
                reportImageSave(false, "Saving to Gallery requires Android 10 or newer.");
                return;
            }
            if (base64Data == null || base64Data.isEmpty() || base64Data.length() > 36_000_000) {
                reportImageSave(false, "The image is empty or too large to save.");
                return;
            }
            imageSaveExecutor.execute(() -> {
                Uri savedUri = null;
                try {
                    byte[] imageBytes = Base64.decode(base64Data, Base64.DEFAULT);
                    if (imageBytes.length == 0 || imageBytes.length > 25 * 1024 * 1024) {
                        throw new IllegalArgumentException("Image exceeds the 25 MB save limit.");
                    }
                    String safeName = (fileName == null || fileName.trim().isEmpty())
                        ? "SquadChat-" + System.currentTimeMillis() + ".jpg"
                        : fileName.replaceAll("[^A-Za-z0-9._-]", "_");
                    String safeMime = (mimeType == null || !mimeType.startsWith("image/"))
                        ? "image/jpeg" : mimeType;
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Images.Media.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Images.Media.MIME_TYPE, safeMime);
                    values.put(MediaStore.Images.Media.RELATIVE_PATH,
                        Environment.DIRECTORY_PICTURES + "/SquadChat");
                    values.put(MediaStore.Images.Media.IS_PENDING, 1);
                    savedUri = getContentResolver().insert(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                    if (savedUri == null) throw new IllegalStateException("Android could not create the image file.");
                    try (OutputStream output = getContentResolver().openOutputStream(savedUri)) {
                        if (output == null) throw new IllegalStateException("Could not open the image file.");
                        output.write(imageBytes);
                        output.flush();
                    }
                    ContentValues ready = new ContentValues();
                    ready.put(MediaStore.Images.Media.IS_PENDING, 0);
                    getContentResolver().update(savedUri, ready, null, null);
                    reportImageSave(true, "Saved to Pictures/SquadChat");
                } catch (Exception e) {
                    if (savedUri != null) getContentResolver().delete(savedUri, null, null);
                    reportImageSave(false, e.getMessage() == null ? "Android could not save this image." : e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void openExternalUrl(String rawUrl) {
            if (rawUrl == null) return;
            try {
                Uri uri = Uri.parse(rawUrl);
                String scheme = uri.getScheme();
                if (uri.getUserInfo() != null ||
                    !("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)) ||
                    isTrustedSquadChatUrl(rawUrl)) return;
                // JavascriptInterface methods run on a WebView background thread.
                // Android UI intents must be launched on the Activity's UI thread.
                runOnUiThread(() -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                        // No compatible browser/app is installed for this URL.
                    }
                });
            } catch (Exception ignored) {
                // Unsupported URLs are intentionally ignored.
            }
        }

        @JavascriptInterface
        public void clearConversationNotifications(String conversationId) {
            if (conversationId == null || conversationId.trim().isEmpty()) return;
            NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                // The FCM service uses the conversation UUID as the notification tag.
                // This clears only this conversation and leaves other chat alerts intact.
                manager.cancel(conversationId, 0);
            }
        }

        @JavascriptInterface
        public void requestFcmToken() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        NOTIFICATION_PERMISSION_REQUEST_CODE
                    );
                }
                // Register the FCM token even when notification permission is denied.
                // Android may suppress display, but the device token can still be saved.
                sendFcmTokenToWeb();
            });
        }
    }

    static void deliverFcmToken(String token) {
        MainActivity activity = activeActivity;
        if (activity == null || activity.webView == null) return;
        activity.webView.post(() -> {
            if (activity.webView == null) return;
            String javascript =
                "window.onSquadChatFcmToken && window.onSquadChatFcmToken(" +
                JSONObject.quote(token) + ")";
            activity.webView.evaluateJavascript(javascript, null);
        });
    }

    private void sendFcmTokenToWeb() {
        if (webView == null) return;

        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (task.isSuccessful() && webView != null) {
                String token = task.getResult();
                String javascript =
                    "window.onSquadChatFcmToken && window.onSquadChatFcmToken(" +
                    JSONObject.quote(token) + ")";
                webView.evaluateJavascript(javascript, null);
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        String[] permissions,
        int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode == NOTIFICATION_PERMISSION_REQUEST_CODE) {
            // Permission controls whether Android displays notifications, not whether
            // Firebase can issue a registration token for this installation.
            sendFcmTokenToWeb();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    java.util.LinkedHashSet<Uri> selectedUris = new java.util.LinkedHashSet<>();
                    ClipData clipData = data.getClipData();
                    if (clipData != null) {
                        for (int i = 0; i < clipData.getItemCount(); i++) {
                            Uri selected = clipData.getItemAt(i).getUri();
                            if (selected != null) selectedUris.add(selected);
                        }
                    }
                    // Some Android pickers return the first item in data.getData()
                    // and the remaining items in ClipData; merge both without duplicates.
                    Uri singleUri = data.getData();
                    if (singleUri != null) selectedUris.add(singleUri);
                    if (!selectedUris.isEmpty()) {
                        results = selectedUris.toArray(new Uri[0]);
                    }
                }
                ValueCallback<Uri[]> callback = filePathCallback;
                filePathCallback = null;
                callback.onReceiveValue(results);
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void handleBackPress() {
        if (webView == null || webView.getVisibility() != View.VISIBLE) {
            return;
        }

        // SquadChat is a single-page app. Send Escape to its existing
        // navigation handler so it closes dialogs/viewers or returns from
        // a mobile sub-screen before Android can close the APK.
        webView.evaluateJavascript(
            "window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));",
            null
        );
    }

    @Override
    public void onBackPressed() {
        handleBackPress();
    }

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
