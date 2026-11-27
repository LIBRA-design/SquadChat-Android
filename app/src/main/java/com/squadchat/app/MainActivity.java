package com.squadchat.app;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.ClipData;
import android.Manifest;
import android.content.pm.PackageManager;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.drawable.GradientDrawable;
import android.provider.OpenableColumns;
import android.widget.Button;
import android.widget.GridView;
import android.widget.BaseAdapter;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.view.Window;
import android.view.WindowManager;
import android.view.ViewGroup;
import android.widget.AbsListView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
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
    private static final int PHOTO_PERMISSION_REQUEST_CODE = 3003;
    private Runnable pendingPhotoGallery;

    private WebView webView;
    private ProgressBar progressBar;
    private TextView errorText;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean pageLoadFailed = false;
    private String launcherLogoDataUri;

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
        // Required for WebView to read the content:// URIs returned by the
        // in-app MediaStore gallery through the file chooser callback.
        settings.setAllowContentAccess(true);
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
                    // Keep the two in-app brand marks identical to this APK's launcher icon.
                    // The hosted web app and its other assets remain unchanged.
                    String launcherLogo = getLauncherLogoDataUri();
                    if (!launcherLogo.isEmpty()) {
                        String script = "(() => { const src = '" + launcherLogo + "'; " +
                            "document.querySelectorAll('#authScreen .brand-mark img, #appTopbar .brand-mark img').forEach(img => { img.src = src; }); })();";
                        webView.evaluateJavascript(script, null);
                    }
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
                    // Route the HTML file input to SquadChat's own bottom-sheet gallery.
                    // The gallery returns selected content:// URIs through this callback,
                    // allowing WebView to create normal File objects without Base64 IPC.
                    MainActivity.this.openPhotoGallery();
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


    // Build a compact data URI from the exact launcher image packaged in this APK.
    // Downscaling keeps the WebView injection lightweight while preserving the logo artwork.
    private String getLauncherLogoDataUri() {
        if (launcherLogoDataUri != null) return launcherLogoDataUri;
        Bitmap source = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
        if (source == null) return "";
        Bitmap icon = source;
        int maxDimension = 256;
        int largest = Math.max(source.getWidth(), source.getHeight());
        if (largest > maxDimension) {
            float scale = (float) maxDimension / largest;
            icon = Bitmap.createScaledBitmap(
                source,
                Math.max(1, Math.round(source.getWidth() * scale)),
                Math.max(1, Math.round(source.getHeight() * scale)),
                true
            );
            source.recycle();
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        icon.compress(Bitmap.CompressFormat.PNG, 100, output);
        if (icon != source) icon.recycle();
        launcherLogoDataUri = "data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        return launcherLogoDataUri;
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

    private static class GalleryPhoto {
        final Uri uri;
        final String name;
        GalleryPhoto(Uri uri, String name) { this.uri = uri; this.name = name; }
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable roundedBackground(int color, int radiusDp) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radiusDp));
        return shape;
    }

    private void openPhotoGallery() {
        if (Build.VERSION.SDK_INT >= 34) {
            boolean full = checkSelfPermission("android.permission.READ_MEDIA_IMAGES") == PackageManager.PERMISSION_GRANTED;
            boolean selected = checkSelfPermission("android.permission.READ_MEDIA_VISUAL_USER_SELECTED") == PackageManager.PERMISSION_GRANTED;
            if (!full && !selected) {
                pendingPhotoGallery = this::showPhotoGallery;
                requestPermissions(new String[]{"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"}, PHOTO_PERMISSION_REQUEST_CODE);
                return;
            }
        } else if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.READ_MEDIA_IMAGES") != PackageManager.PERMISSION_GRANTED) {
                pendingPhotoGallery = this::showPhotoGallery;
                requestPermissions(new String[]{"android.permission.READ_MEDIA_IMAGES"}, PHOTO_PERMISSION_REQUEST_CODE);
                return;
            }
        } else if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingPhotoGallery = this::showPhotoGallery;
            requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, PHOTO_PERMISSION_REQUEST_CODE);
            return;
        }
        showPhotoGallery();
    }

    private List<GalleryPhoto> loadGalleryPhotos() {
        List<GalleryPhoto> photos = new ArrayList<>();
        Uri collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        String[] projection = {MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME};
        try (Cursor cursor = getContentResolver().query(collection, projection, null, null, MediaStore.Images.Media.DATE_ADDED + " DESC")) {
            if (cursor != null) {
                int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                int nameColumn = cursor.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME);
                while (cursor.moveToNext() && photos.size() < 300) {
                    long id = cursor.getLong(idColumn);
                    String name = nameColumn >= 0 ? cursor.getString(nameColumn) : "Photo";
                    photos.add(new GalleryPhoto(ContentUris.withAppendedId(collection, id), name == null ? "Photo" : name));
                }
            }
        } catch (Exception ignored) {}
        return photos;
    }

    private void showPhotoGallery() {
        List<GalleryPhoto> photos = loadGalleryPhotos();
        if (photos.isEmpty()) {
            Toast.makeText(this, "No accessible photos found. Check SquadChat photo permission in Settings.", Toast.LENGTH_LONG).show();
            return;
        }
        DialogHolder holder = new DialogHolder();
        android.app.Dialog dialog = new android.app.Dialog(this);
        holder.dialog = dialog;
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(12), dp(12), dp(12), dp(12));
        panel.setBackground(roundedBackground(Color.rgb(20, 12, 14), 22));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("All photos");
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        TextView close = new TextView(this);
        close.setText("×");
        close.setTextColor(Color.WHITE);
        close.setTextSize(28);
        close.setGravity(Gravity.CENTER);
        header.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        panel.addView(header);

        GridView grid = new GridView(this);
        grid.setNumColumns(3);
        grid.setHorizontalSpacing(dp(3));
        grid.setVerticalSpacing(dp(3));
        grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        grid.setSelector(android.R.color.transparent);
        LinearLayout.LayoutParams gridParams = new LinearLayout.LayoutParams(-1, 0, 1);
        gridParams.topMargin = dp(8);
        panel.addView(grid, gridParams);

        Button send = new Button(this);
        send.setText("Send photos");
        send.setTextColor(Color.rgb(40, 18, 20));
        send.setTextSize(16);
        send.setAllCaps(false);
        send.setTypeface(null, android.graphics.Typeface.BOLD);
        send.setBackground(roundedBackground(Color.rgb(224, 177, 105), 28));
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(-1, dp(54));
        sendParams.topMargin = dp(10);
        panel.addView(send, sendParams);

        LinkedHashSet<Uri> selected = new LinkedHashSet<>();
        BaseAdapter adapter = new BaseAdapter() {
            @Override public int getCount() { return photos.size(); }
            @Override public Object getItem(int position) { return photos.get(position); }
            @Override public long getItemId(int position) { return position; }
            @Override public View getView(int position, View convertView, ViewGroup parent) {
                FrameLayout cell = convertView instanceof FrameLayout ? (FrameLayout) convertView : new FrameLayout(MainActivity.this);
                cell.setLayoutParams(new AbsListView.LayoutParams(-1, dp(116)));
                ImageView image = cell.getChildCount() > 0 && cell.getChildAt(0) instanceof ImageView ? (ImageView) cell.getChildAt(0) : new ImageView(MainActivity.this);
                image.setScaleType(ImageView.ScaleType.CENTER_CROP);
                if (image.getParent() == null) cell.addView(image, new FrameLayout.LayoutParams(-1, -1));
                GalleryPhoto photo = photos.get(position);
                image.setImageURI(photo.uri);
                TextView number = cell.getChildCount() > 1 && cell.getChildAt(1) instanceof TextView ? (TextView) cell.getChildAt(1) : new TextView(MainActivity.this);
                number.setGravity(Gravity.CENTER);
                number.setTextColor(Color.WHITE);
                number.setTextSize(13);
                number.setTypeface(null, android.graphics.Typeface.BOLD);
                FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(dp(28), dp(28), Gravity.TOP | Gravity.RIGHT);
                badgeParams.setMargins(0, dp(5), dp(5), 0);
                if (number.getParent() == null) cell.addView(number, badgeParams);
                int selectedIndex = new ArrayList<>(selected).indexOf(photo.uri);
                number.setText(selectedIndex >= 0 ? String.valueOf(selectedIndex + 1) : "");
                number.setBackground(selectedIndex >= 0 ? roundedBackground(Color.rgb(225, 91, 115), 20) : roundedBackground(0x66000000, 20));
                cell.setForeground(roundedBackground(selectedIndex >= 0 ? 0x337FFFFF : 0x00000000, 8));
                return cell;
            }
        };
        grid.setAdapter(adapter);
        grid.setOnItemClickListener((parent, view, position, id) -> {
            Uri uri = photos.get(position).uri;
            if (selected.contains(uri)) selected.remove(uri);
            else if (selected.size() < 10) selected.add(uri);
            else Toast.makeText(this, "Choose up to 10 photos.", Toast.LENGTH_SHORT).show();
            send.setText(selected.isEmpty() ? "Select photos" : "Send " + selected.size());
            send.setEnabled(!selected.isEmpty());
            adapter.notifyDataSetChanged();
        });
        send.setEnabled(false);
        close.setOnClickListener(v -> {
            dialog.dismiss();
            completePhotoFileChooser(null);
        });
        dialog.setOnCancelListener(ignored -> completePhotoFileChooser(null));
        send.setOnClickListener(v -> {
            if (selected.isEmpty()) return;
            Uri[] chosen = selected.toArray(new Uri[0]);
            dialog.dismiss();
            // Returning URIs through WebChromeClient's chooser callback lets the
            // WebView read each image as a File. This avoids oversized Base64
            // evaluateJavascript calls that fail for multi-photo batches.
            completePhotoFileChooser(chosen);
        });

        dialog.setContentView(panel);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams params = window.getAttributes();
            params.gravity = Gravity.BOTTOM;
            params.width = WindowManager.LayoutParams.MATCH_PARENT;
            params.height = Math.round(getResources().getDisplayMetrics().heightPixels * 0.72f);
            params.dimAmount = 0.55f;
            window.setAttributes(params);
        }
        dialog.show();
        if (window != null) {
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, Math.round(getResources().getDisplayMetrics().heightPixels * 0.72f));
            window.setBackgroundDrawableResource(android.R.color.transparent);
        }
    }

    private static class DialogHolder { android.app.Dialog dialog; }

    private Bitmap decodeGalleryBitmap(Uri uri) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(input, null, bounds);
        }
        int sample = 1;
        while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > 1800) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            Bitmap bitmap = BitmapFactory.decodeStream(input, null, options);
            if (bitmap == null) return null;
            int max = 1800;
            int width = bitmap.getWidth(), height = bitmap.getHeight();
            float scale = Math.min(1f, (float) max / Math.max(width, height));
            if (scale < 1f) {
                Bitmap scaled = Bitmap.createScaledBitmap(bitmap, Math.round(width * scale), Math.round(height * scale), true);
                bitmap.recycle();
                return scaled;
            }
            return bitmap;
        }
    }

    private void completePhotoFileChooser(Uri[] selectedUris) {
        ValueCallback<Uri[]> callback = filePathCallback;
        filePathCallback = null;
        if (callback != null) callback.onReceiveValue(selectedUris);
    }

    private void deliverPhotoPermissionResult(int[] grantResults) {
        Runnable pending = pendingPhotoGallery;
        pendingPhotoGallery = null;
        if (pending == null) return;
        boolean granted = false;
        for (int result : grantResults) if (result == PackageManager.PERMISSION_GRANTED) granted = true;
        if (granted) pending.run();
        else {
            Toast.makeText(this, "SquadChat needs photo access to show your gallery.", Toast.LENGTH_LONG).show();
            completePhotoFileChooser(null);
        }
    }

    private class FcmBridge {
        @JavascriptInterface
        public void openPhotoGallery() {
            runOnUiThread(() -> MainActivity.this.openPhotoGallery());
        }

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
            sendFcmTokenToWeb();
        } else if (requestCode == PHOTO_PERMISSION_REQUEST_CODE) {
            deliverPhotoPermissionResult(grantResults);
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
