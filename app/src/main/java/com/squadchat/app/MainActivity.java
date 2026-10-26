package com.squadchat.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.graphics.Color;
import android.view.View;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.ValueCallback;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.view.Gravity;

public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;

    private WebView webView;
    private ProgressBar progressBar;
    private TextView errorText;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(Color.WHITE);

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
        errorText.setTextColor(Color.BLACK);
        errorText.setTextSize(16);
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(32, 32, 32, 32);
        errorText.setVisibility(View.GONE);

        webView = new WebView(this);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setSupportZoom(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
            ) {
                if (request.isForMainFrame()) {
                    errorText.setText(
                        "Unable to load SquadChat.\n\n" +
                        "Check your internet connection, then reopen the app."
                    );
                    errorText.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                errorText.setVisibility(View.GONE);
                progressBar.setVisibility(View.GONE);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
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
                    Intent intent = fileChooserParams.createIntent();
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
                "https://squadchat-ew2b04.v2.appdeploy.ai/"
            );
        } catch (Exception e) {
            errorText.setText("Unable to start SquadChat: " + e.getMessage());
            errorText.setVisibility(View.VISIBLE);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback != null) {
                Uri[] results = WebChromeClient.FileChooserParams.parseResult(
                    resultCode, data
                );
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
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
