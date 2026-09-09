package com.pixelcraft.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.VibratorManager;
import android.os.Vibrator;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.LinkedList;
import java.util.Queue;

public class MainActivity extends Activity {
    private static final String TAG = "PixelCraft";
    private static final int REQ_CREATE = 1001;
    private static final int REQ_OPEN = 1002;

    private WebView web;
    private final Queue<PendingSave> pendingSaves = new LinkedList<>();
    private String pendingOpenMime = "*/*";

    static class PendingSave {
        String name, mime, b64, reqId;
        PendingSave(String name, String mime, String b64, String reqId) {
            this.name = name; this.mime = mime; this.b64 = b64; this.reqId = reqId;
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemUi();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        web.setBackgroundColor(0xFF14151A);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "PixelBridge");
        // the app owns long-press gestures: suppress Android's native text-selection
        // context menus (keep them working only inside editable inputs)
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                try {
                    WebView.HitTestResult hr = web.getHitTestResult();
                    if (hr != null && hr.getType() == WebView.HitTestResult.EDIT_TEXT_TYPE) return false;
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.e(TAG, "webview error " + errorCode + " " + description + " @ " + failingUrl);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, "[js:" + cm.lineNumber() + "] " + cm.message());
                return true;
            }
        });

        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
        // DIAGNOSTIC (temporary): one buzz straight from Java on every launch.
        // If this is felt but the in-app Test vibration is not, the native
        // vibrator path is fine and the JS bridge is the problem.
        web.postDelayed(new Runnable() {
            @Override public void run() { new Bridge().vibrate(90); }
        }, 900);
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // ensure the WebView re-lays out so CSS media queries (portrait/landscape)
        // re-evaluate after a rotation
        if (web != null) web.post(new Runnable() {
            @Override public void run() {
                web.requestLayout();
                web.invalidate();
            }
        });
    }

    private void eval(final String js) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web != null) web.evaluateJavascript(js, null);
            }
        });
    }

    private final class Bridge {
        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String base64data, final String reqId) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    pendingSaves.add(new PendingSave(name, mime, base64data, reqId));
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                    i.putExtra(Intent.EXTRA_TITLE, name);
                    try {
                        startActivityForResult(i, REQ_CREATE);
                    } catch (Exception e) {
                        pendingSaves.poll();
                        eval("window.dispatchEvent(new CustomEvent('pcsave',{detail:JSON.parse('{\"ok\":false,\"err\":\"intent\"}')}))");
                    }
                }
            });
        }

        @JavascriptInterface
        public void openFile(final String mime) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    pendingOpenMime = (mime == null || mime.isEmpty()) ? "*/*" : mime;
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(pendingOpenMime);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_OPEN);
                    } catch (Exception e) {
                        eval("window.dispatchEvent(new CustomEvent('pcopen',{detail:{ok:false}}))");
                    }
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** the vibrator to use: VibratorManager on API 31+, the legacy service
         *  below that (the deprecated constant still works, but the manager is
         *  the documented path and is what some OEMs honour) */
        private Vibrator defaultVibrator() {
            try {
                if (android.os.Build.VERSION.SDK_INT >= 31) {
                    VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                    if (vm != null) return vm.getDefaultVibrator();
                }
            } catch (Throwable ignored) { /* fall through */ }
            try {
                return (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            } catch (Throwable ignored) {
                return null;
            }
        }

        @JavascriptInterface
        public boolean hasVibrator() {
            try {
                Vibrator v = defaultVibrator();
                return v != null && v.hasVibrator();
            } catch (Throwable ignored) {
                return false;
            }
        }

        /** Run one pulse right now and report whether the vibrator accepted
         *  it. Called synchronously from JS (no UI-thread hop) so the page can
         *  tell the difference between "no vibrator" and "it worked". */
        @JavascriptInterface
        public boolean vibrate(final long ms) {
            try {
                Vibrator v = defaultVibrator();
                if (v == null || !v.hasVibrator()) return false;
                long d = Math.max(10, Math.min(ms, 200));
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    try {
                        // full amplitude: DEFAULT_AMPLITUDE can be imperceptible
                        // for very short pulses on some ROMs
                        v.vibrate(VibrationEffect.createOneShot(d, 255));
                    } catch (Throwable e) {
                        v.vibrate(d);
                    }
                } else {
                    v.vibrate(d);
                }
                return true;
            } catch (Throwable ignored) {
                return false;
            }
        }

        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CREATE) {
            PendingSave ps = pendingSaves.poll();
            if (resultCode == RESULT_OK && data != null && data.getData() != null && ps != null) {
                try {
                    Uri uri = data.getData();
                    OutputStream os = getContentResolver().openOutputStream(uri, "w");
                    byte[] bytes = Base64.decode(ps.b64, Base64.DEFAULT);
                    os.write(bytes);
                    os.flush();
                    os.close();
                    eval("window.dispatchEvent(new CustomEvent('pcsave',{detail:JSON.parse('{\"ok\":true,\"reqId\":\"" + jsSafe(ps.reqId) + "\",\"name\":\"" + jsSafe(ps.name) + "\"}')}))");
                    return;
                } catch (Exception e) {
                    Log.e(TAG, "save fail", e);
                }
            }
            eval("window.dispatchEvent(new CustomEvent('pcsave',{detail:JSON.parse('{\"ok\":false,\"reqId\":\"" + (ps != null ? jsSafe(ps.reqId) : "") + "\"}')}))");
        } else if (requestCode == REQ_OPEN) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                try {
                    Uri uri = data.getData();
                    InputStream is = getContentResolver().openInputStream(uri);
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                    is.close();
                    String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                    String name = queryDisplayName(uri);
                    String mime = getContentResolver().getType(uri);
                    eval("window.dispatchEvent(new CustomEvent('pcopen',{detail:JSON.parse('{\"ok\":true,\"name\":\"" + jsSafe(name) + "\",\"mime\":\"" + jsSafe(mime) + "\",\"data\":\"" + b64 + "\"}')}))");
                    return;
                } catch (Exception e) {
                    Log.e(TAG, "open fail", e);
                }
            }
            eval("window.dispatchEvent(new CustomEvent('pcopen',{detail:{ok:false}}))");
        }
    }

    private String queryDisplayName(Uri uri) {
        try {
            String[] proj = {"_display_name"};
            android.database.Cursor c = getContentResolver().query(uri, proj, null, null, null);
            if (c != null) {
                if (c.moveToFirst()) return c.getString(0);
                c.close();
            }
        } catch (Exception ignored) { }
        String p = uri.getPath();
        int idx = p == null ? -1 : p.lastIndexOf('/');
        return idx >= 0 ? p.substring(idx + 1) : "file";
    }

    private static String jsSafe(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    @Override
    @SuppressLint("ObsoleteSdkInt")
    public void onBackPressed() {
        if (web != null) {
            // __pc_back() returns a REAL boolean: evaluateJavascript JSON-encodes
            // strings, so returning 'true' as a string arrives as "\"true\"" and
            // every press would fall through to finish(). Ask for a boolean and
            // still strip quotes in case the page returns one.
            web.evaluateJavascript(
                    "(function(){try{return window.__pc_back?window.__pc_back()===true:false;}catch(e){return false;}})()",
                    new ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) {
                            String v = value == null ? "" : value.trim().replace("\"", "");
                            if (!"true".equalsIgnoreCase(v)) finish();
                        }
                    });
        } else {
            finish();
        }
    }
}
